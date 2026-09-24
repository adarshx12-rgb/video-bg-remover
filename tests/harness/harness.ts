// Dev-only harness exposing the real processing pipeline to Playwright.
import { detectCapabilities, type OutputFormatId } from '../../src/lib/capabilities';
import { ProcessorClient } from '../../src/lib/processorClient';
import { probeVideo } from '../../src/lib/video/probe';
import type { ModelId } from '../../src/config';
import type { BackgroundMessage } from '../../src/worker/protocol';

const client = new ProcessorClient();

async function fetchFile(url: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  return new File([await res.blob()], url.split('/').pop()!, { type: res.headers.get('content-type') ?? '' });
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

interface RunOptions {
  format: OutputFormatId;
  background?: { kind: 'color'; color: string } | { kind: 'image'; url: string } | { kind: 'transparent' };
  edgeSoftness?: number;
  frameRate?: number | null;
  cancelAfterMs?: number;
}

async function makeBackground(spec: RunOptions['background']): Promise<BackgroundMessage> {
  if (!spec) return { kind: 'color', color: '#00b140' };
  if (spec.kind === 'image') return { kind: 'image', image: await createImageBitmap(await (await fetch(spec.url)).blob()) };
  return spec;
}

const harness = {
  crossOriginIsolated: () => self.crossOriginIsolated,
  caps: () => detectCapabilities(),
  probe: async (url: string) => probeVideo(await fetchFile(url)),
  load: async (model: ModelId, backendOverride?: string) => {
    const t0 = performance.now();
    const events: unknown[] = [];
    const backend = await client.loadModel(model, (p) => events.push(p), backendOverride);
    return { backend, ms: performance.now() - t0, progressEvents: events.length, lastProgress: events.at(-1) };
  },
  run: async (url: string, options: RunOptions) => {
    const file = await fetchFile(url);
    const meta = await probeVideo(file);
    const t0 = performance.now();
    let previews = 0;
    const phases: string[] = [];
    let lastFraction = 0;
    const job = client.process(
      file,
      {
        format: options.format,
        background: await makeBackground(options.background),
        edgeSoftness: options.edgeSoftness ?? 0,
        frameRate: options.frameRate ?? null,
        output: meta.output,
      },
      {
        onPhase: (p) => phases.push(p),
        onProgress: (f, frames, ms) => {
          lastFraction = f;
          (window as unknown as { __progress: unknown }).__progress = { fraction: f, frames, msPerFrame: Math.round(ms), at: Math.round(performance.now() - t0) };
        },
        onPreview: (b) => {
          previews++;
          b.close();
        },
      },
    );
    if (options.cancelAfterMs !== undefined) {
      setTimeout(() => void client.cancel(job.jobId), options.cancelAfterMs);
      try {
        await job.result;
        return { cancelled: false };
      } catch (error) {
        return { cancelled: (error as Error).name === 'CancelledError', message: (error as Error).message, lastFraction };
      }
    }
    const { blob, stats, matte } = await job.result;
    return {
      ms: performance.now() - t0,
      stats,
      phases,
      previews,
      lastFraction,
      size: blob.size,
      type: blob.type,
      meta,
      base64: await toBase64(blob),
      matteBase64: matte ? await toBase64(matte) : null,
      matteType: matte?.type ?? null,
    };
  },
  preview: async (url: string, time: number, background: RunOptions['background']) => {
    const file = await fetchFile(url);
    const meta = await probeVideo(file);
    const job = client.previewFrame(
      file,
      { format: 'mp4', background: await makeBackground(background), edgeSoftness: 0, frameRate: null, output: meta.output },
      time,
    );
    const { bitmap } = await job.result;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();
    return toBase64(await canvas.convertToBlob({ type: 'image/png' }));
  },
  memory: () => {
    const perf = performance as Performance & { memory?: { usedJSHeapSize: number } };
    return perf.memory?.usedJSHeapSize ?? null;
  },
  terminate: () => client.terminate(),
};

(window as unknown as { harness: typeof harness }).harness = harness;
document.body.dataset.ready = 'true';

// Decode a file with Mediabunny's CanvasSink (as the saved-matte adapter does) and
// return the mean RGB of the top rows of the frame at `time`.
import { ALL_FORMATS as FORMATS, BlobSource as BSource, CanvasSink as CSink, Input as MInput } from 'mediabunny';
(window as unknown as { decodeTopRows: unknown }).decodeTopRows = async (url: string, time: number, rows = 3) => {
  const input = new MInput({ source: new BSource(await (await fetch(url)).blob()), formats: FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  const sink = new CSink(track, { poolSize: 1 });
  const wrapped = (await sink.getCanvas(time))!;
  const c = wrapped.canvas as OffscreenCanvas;
  const read = new OffscreenCanvas(c.width, rows);
  const ctx = read.getContext('2d')!;
  ctx.drawImage(c, 0, 0, c.width, rows, 0, 0, c.width, rows);
  const d = ctx.getImageData(0, 0, c.width, rows).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  input.dispose();
  return { size: [c.width, c.height], rgb: [r / n, g / n, b / n].map(Math.round) };
};

// Decode the first frame with raw WebCodecs (no Mediabunny drawing) to isolate decoder
// behaviour: reports frame geometry and the mean RGB of its top rows.
import { EncodedPacketSink as PSink } from 'mediabunny';
(window as unknown as { decodeRaw: unknown }).decodeRaw = async (url: string, hardwareAcceleration: HardwareAcceleration, rows = 3) => {
  const input = new MInput({ source: new BSource(await (await fetch(url)).blob()), formats: FORMATS });
  const track = (await input.getPrimaryVideoTrack())!;
  const config = { ...(await track.getDecoderConfig())!, hardwareAcceleration };
  const packet = (await new PSink(track).getFirstPacket())!;
  const frame = await new Promise<VideoFrame>((resolve, reject) => {
    const decoder = new VideoDecoder({ output: resolve, error: reject });
    decoder.configure(config);
    decoder.decode(packet.toEncodedVideoChunk());
    void decoder.flush();
  });
  const info = { coded: [frame.codedWidth, frame.codedHeight], visible: frame.visibleRect && [frame.visibleRect.x, frame.visibleRect.y, frame.visibleRect.width, frame.visibleRect.height], display: [frame.displayWidth, frame.displayHeight], format: frame.format };
  const c = new OffscreenCanvas(frame.displayWidth, frame.displayHeight);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(frame, 0, 0);
  frame.close();
  const d = ctx.getImageData(0, 0, c.width, rows).data;
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
  const n = d.length / 4;
  input.dispose();
  return { ...info, rgb: [r / n, g / n, b / n].map(Math.round) };
};
