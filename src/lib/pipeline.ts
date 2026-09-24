import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  CanvasSink,
  Conversion,
  ConversionCanceledError,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  type AudioCodec,
  type VideoCodec,
  type VideoSample,
} from 'mediabunny';
import { FORMAT_OPTIONS } from './capabilities';
import { Compositor, type BackgroundSpec } from './compositing/compositor';
import { MattePackWriter } from './compositing/mattePack';
import { primeVp9DecodeWorkaround } from './video/decoderWorkaround';
import type { MattingAdapter } from './models/types';
import type { AudioOutcome, JobSettings, JobStats } from '../worker/protocol';

export class JobCancelledError extends Error {
  constructor() {
    super('Processing was cancelled.');
    this.name = 'JobCancelledError';
  }
}

export interface CancelToken {
  cancelled: boolean;
  /** Set by the pipeline so a cancel request can abort in-flight work immediately. */
  onCancel?: () => void;
}

interface ProcessCallbacks {
  onPhase(phase: 'processing' | 'finalizing'): void;
  onProgress(fraction: number, framesDone: number, msPerFrame: number): void;
  /** Called with a small preview frame roughly every `previewIntervalMs`. Ownership passes to the callee. */
  onPreview(bitmap: ImageBitmap): void;
}

const PREVIEW_INTERVAL_MS = 400;
const PREVIEW_MAX_SIDE = 640;

/**
 * Timestamp-driven export: every decoded source frame is matted, composited and
 * re-encoded with its original timestamp and duration. Slow inference only slows
 * the job down (backpressure); it cannot drop frames or shift audio. Audio packets are
 * copied when the container supports the source codec, otherwise transcoded.
 */
export async function processVideo(
  file: File,
  adapter: MattingAdapter,
  settings: JobSettings,
  token: CancelToken,
  callbacks: ProcessCallbacks,
  options: { recordMatte?: boolean } = {},
): Promise<{ buffer: ArrayBuffer; mimeType: string; stats: JobStats; matte: { buffer: ArrayBuffer; mimeType: string } | null }> {
  const formatInfo = FORMAT_OPTIONS[settings.format];
  const isMp4 = formatInfo.extension === 'mp4';
  const videoCodec: VideoCodec = isMp4 ? 'avc' : 'vp9';
  const audioCodec: AudioCodec = isMp4 ? 'aac' : 'opus';
  const { width, height } = settings.output;

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const output = new Output({
    format: isMp4 ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const compositor = new Compositor(width, height, toBackgroundSpec(settings), settings.edgeSoftness);
  const frameCanvas = new OffscreenCanvas(width, height);
  const frameCtx = frameCanvas.getContext('2d', { alpha: false, willReadFrequently: adapter.id === 'ben2' })!;

  for (const key of Object.keys(adapter.stageTimings)) delete adapter.stageTimings[key];
  adapter.resetState(); // new video / restart: RVM recurrent state must not leak across jobs
  let conversion: Conversion | null = null;
  // Recording the cut-out is optional: if it can't be created or fails, the export still succeeds.
  let pack = options.recordMatte ? await MattePackWriter.create(width, height).catch(() => null) : null;

  try {
    const duration = await input.computeDuration();
    const videoTrack = await input.getPrimaryVideoTrack();
    if (videoTrack) await primeVp9DecodeWorkaround(await videoTrack.getDecoderConfig());
    const inputAudio = await input.getPrimaryAudioTrack();

    let frames = 0;
    let inferenceMs = 0;
    let decodeWaitMs = 0;
    let composeMs = 0;
    let lastReturn = -1;
    let lastPreview = 0;
    let finalizing = false;
    const started = performance.now();

    const process = async (sample: VideoSample) => {
      if (token.cancelled) throw new JobCancelledError();
      const t0 = performance.now();
      // Time between returning a frame and receiving the next: decode + encode backpressure.
      if (lastReturn >= 0) decodeWaitMs += t0 - lastReturn;
      frameCtx.globalCompositeOperation = 'copy';
      sample.draw(frameCtx, 0, 0, width, height);
      const matte = await adapter.process(frameCanvas, sample.timestamp);
      if (token.cancelled) throw new JobCancelledError();
      const tc = performance.now();
      const composed = compositor.compose(frameCanvas, matte);
      composeMs += performance.now() - tc;
      if (pack) {
        try {
          await pack.add(frameCanvas, matte, sample.timestamp, sample.duration);
        } catch (error) {
          console.warn('Could not save the cut-out; changing the background later will need a full run.', error);
          void pack.cancel();
          pack = null;
        }
      }
      frames++;
      inferenceMs += performance.now() - t0;

      const now = performance.now();
      if (now - lastPreview > PREVIEW_INTERVAL_MS) {
        lastPreview = now;
        const scale = Math.min(1, PREVIEW_MAX_SIDE / Math.max(width, height));
        createImageBitmap(composed, {
          resizeWidth: Math.round(width * scale),
          resizeHeight: Math.round(height * scale),
          resizeQuality: 'medium',
        }).then(
          (bitmap) => (token.cancelled ? bitmap.close() : callbacks.onPreview(bitmap)),
          () => undefined,
        );
      }
      const endTime = sample.timestamp + sample.duration;
      callbacks.onProgress(Math.min(1, endTime / duration), frames, inferenceMs / frames);
      if (!finalizing && endTime >= duration - 1e-3) {
        finalizing = true;
        callbacks.onPhase('finalizing');
      }
      lastReturn = performance.now();
      return composed;
    };

    conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      video: {
        width,
        height,
        fit: 'fill',
        // Bake rotation into the pixels so portrait phone videos stay upright everywhere.
        allowTransformationMetadata: false,
        codec: videoCodec,
        quality: QUALITY_HIGH,
        alpha: formatInfo.transparent ? 'keep' : 'discard',
        frameRate: settings.frameRate ?? undefined,
        forceTranscode: true,
        process,
      },
      audio: { codec: audioCodec },
    });

    if (!conversion.isValid) {
      const videoIssue = conversion.discardedTracks.find((d) => d.track.type === 'video');
      throw new Error(
        videoIssue
          ? `The video can't be converted to ${formatInfo.label} in this browser (${describeDiscard(videoIssue.reason)}). Try another output format.`
          : `The video can't be converted to ${formatInfo.label} in this browser.`,
      );
    }

    let audio: AudioOutcome = { status: 'none' };
    if (inputAudio) {
      const dropped = conversion.discardedTracks.find((d) => d.track.type === 'audio');
      audio = dropped
        ? { status: 'dropped', reason: describeDiscard(dropped.reason) }
        : { status: 'kept', codec: audioCodec, transcoded: inputAudio.codec !== audioCodec };
    }

    token.onCancel = () => {
      void conversion?.cancel();
    };
    callbacks.onPhase('processing');
    await conversion.execute();
    if (token.cancelled) throw new JobCancelledError();

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('The encoder produced no output.');
    let matte: { buffer: ArrayBuffer; mimeType: string } | null = null;
    if (pack) {
      matte = await pack.finish().catch((error) => {
        console.warn('Could not finish the saved cut-out.', error);
        return null;
      });
      pack = null;
    }
    return {
      buffer,
      matte,
      mimeType: formatInfo.mimeType,
      stats: {
        frames,
        processingSeconds: (performance.now() - started) / 1000,
        msPerFrame: frames ? inferenceMs / frames : 0,
        stageMsPerFrame: perFrame({ ...adapter.stageTimings, compose: composeMs, decodeEncodeWait: decodeWaitMs }, frames),
        backend: adapter.backend,
        audio,
        videoCodec,
        width,
        height,
      },
    };
  } catch (error) {
    if (token.cancelled || error instanceof ConversionCanceledError || error instanceof JobCancelledError) {
      if (conversion) await conversion.cancel().catch(() => undefined);
      throw new JobCancelledError();
    }
    throw error;
  } finally {
    token.onCancel = undefined;
    if (pack) void pack.cancel();
    adapter.resetState();
    compositor.dispose();
    input.dispose();
  }
}

/**
 * Renders a single composited frame at `timeSeconds`. For temporal models the
 * preceding half second is run first so the recurrent state is representative.
 */
export async function previewFrame(
  file: File,
  adapter: MattingAdapter,
  settings: JobSettings,
  timeSeconds: number,
  token: CancelToken,
): Promise<{ bitmap: ImageBitmap; frames: number }> {
  const { width, height } = settings.output;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  // Previews may show transparency (over a checkerboard) even when the chosen download
  // format cannot store it; the export path uses toBackgroundSpec instead.
  const compositor = new Compositor(width, height, settings.background, settings.edgeSoftness);
  const frameCanvas = new OffscreenCanvas(width, height);
  const frameCtx = frameCanvas.getContext('2d', { alpha: false, willReadFrequently: adapter.id === 'ben2' })!;
  adapter.resetState();
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('This file has no video track.');
    await primeVp9DecodeWorkaround(await track.getDecoderConfig());
    const sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 1 });
    const start = adapter.isTemporal ? Math.max(0, timeSeconds - 0.5) : timeSeconds;
    let composed: OffscreenCanvas | null = null;
    let count = 0;
    const frames = adapter.isTemporal ? sink.canvases(start, timeSeconds + 1e-3) : singleFrame(sink, timeSeconds);
    for await (const wrapped of frames) {
      if (token.cancelled) throw new JobCancelledError();
      frameCtx.globalCompositeOperation = 'copy';
      frameCtx.drawImage(wrapped.canvas, 0, 0, width, height);
      const matte = await adapter.process(frameCanvas, wrapped.timestamp);
      composed = compositor.compose(frameCanvas, matte);
      count++;
    }
    if (!composed) throw new Error('No frame was found at this position.');
    return { bitmap: await createImageBitmap(composed), frames: count };
  } finally {
    adapter.resetState();
    compositor.dispose();
    input.dispose();
  }
}

async function* singleFrame(sink: CanvasSink, time: number) {
  const wrapped = await sink.getCanvas(time);
  if (wrapped) yield wrapped;
}

function perFrame(timings: Record<string, number>, frames: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, ms] of Object.entries(timings)) out[key] = frames ? Math.round((ms / frames) * 10) / 10 : 0;
  return out;
}

function toBackgroundSpec(settings: JobSettings): BackgroundSpec {
  // Transparent output keeps the alpha channel; replacement backgrounds are opaque.
  if (FORMAT_OPTIONS[settings.format].transparent) return { kind: 'transparent' };
  const bg = settings.background;
  if (bg.kind === 'transparent') return { kind: 'color', color: '#ffffff' };
  return bg;
}

function describeDiscard(reason: string): string {
  switch (reason) {
    case 'undecodable_source_codec':
      return 'this browser cannot decode the original track';
    case 'no_encodable_target_codec':
      return 'this browser cannot encode a compatible format';
    case 'unknown_source_codec':
      return 'the track uses an unknown format';
    default:
      return reason.replaceAll('_', ' ');
  }
}
