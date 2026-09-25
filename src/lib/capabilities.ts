import {
  BufferSource,
  BufferTarget,
  CanvasSink,
  Input,
  Output,
  VideoSample,
  VideoSampleSource,
  WEBM,
  WebMOutputFormat,
  QUALITY_HIGH,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';

export type OutputFormatId = 'mp4' | 'webm' | 'webm-alpha';

export interface OutputFormatOption {
  id: OutputFormatId;
  label: string;
  extension: 'mp4' | 'webm';
  mimeType: string;
  transparent: boolean;
  description: string;
}

export interface Capabilities {
  webCodecs: boolean;
  workers: boolean;
  offscreenCanvas: boolean;
  webgpu: boolean;
  webgpuF16: boolean;
  webgl2: boolean;
  crossOriginIsolated: boolean;
  /** Formats this browser can actually produce, in order of preference. */
  outputFormats: OutputFormatOption[];
  /** Human readable reasons why a format or feature is unavailable. */
  notes: string[];
}

export const FORMAT_OPTIONS: Record<OutputFormatId, OutputFormatOption> = {
  mp4: {
    id: 'mp4',
    label: 'MP4 (H.264)',
    extension: 'mp4',
    mimeType: 'video/mp4',
    transparent: false,
    description: 'Plays almost everywhere. Background is replaced, not transparent.',
  },
  webm: {
    id: 'webm',
    label: 'WebM (VP9)',
    extension: 'webm',
    mimeType: 'video/webm',
    transparent: false,
    description: 'Good for the web. Background is replaced, not transparent.',
  },
  'webm-alpha': {
    id: 'webm-alpha',
    label: 'Transparent WebM (VP9 + alpha)',
    extension: 'webm',
    mimeType: 'video/webm',
    transparent: true,
    description: 'Keeps real transparency. Works in Chrome, Edge, Firefox and many video editors, not in Safari or most phone galleries.',
  },
};

/**
 * True when the browser reports a slow connection or data saver. Only Chromium
 * browsers expose this (Network Information API); elsewhere it returns false.
 */
export function connectionLooksSlow(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!connection) return false;
  return connection.saveData === true || ['slow-2g', '2g', '3g'].includes(connection.effectiveType ?? '');
}

export async function detectCapabilities(): Promise<Capabilities> {
  const notes: string[] = [];
  const webCodecs = typeof VideoEncoder !== 'undefined' && typeof VideoDecoder !== 'undefined' && typeof AudioEncoder !== 'undefined';
  const workers = typeof Worker !== 'undefined';
  const offscreenCanvas = typeof OffscreenCanvas !== 'undefined';
  let webgpu = false;
  let webgpuF16 = false;
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
    const adapter = gpu ? await gpu.requestAdapter() : null;
    webgpu = !!adapter;
    webgpuF16 = !!adapter?.features.has('shader-f16');
  } catch {
    /* WebGPU unavailable */
  }
  let webgl2 = false;
  try {
    webgl2 = !!(offscreenCanvas && new OffscreenCanvas(1, 1).getContext('webgl2'));
  } catch {
    /* WebGL2 unavailable */
  }

  const outputFormats: OutputFormatOption[] = [];
  if (webCodecs) {
    // Checked at a typical output size; the exact size is re-checked before export.
    const [avc, vp9, aac, opus] = await Promise.all([
      canEncodeVideo('avc', { width: 1280, height: 720 }).catch(() => false),
      canEncodeVideo('vp9', { width: 1280, height: 720 }).catch(() => false),
      canEncodeAudio('aac').catch(() => false),
      canEncodeAudio('opus').catch(() => false),
    ]);
    if (avc) outputFormats.push(FORMAT_OPTIONS.mp4);
    else notes.push('This browser cannot encode H.264, so MP4 download is unavailable.');
    if (!aac && avc) notes.push('AAC audio encoding is unavailable; MP4 audio can only be kept when the original is already AAC.');
    if (vp9) {
      outputFormats.push(FORMAT_OPTIONS.webm);
      if (await verifyAlphaRoundTrip()) outputFormats.push(FORMAT_OPTIONS['webm-alpha']);
      else notes.push('Transparent video export failed a self-test in this browser, so it is disabled.');
    } else {
      notes.push('This browser cannot encode VP9, so WebM and transparent downloads are unavailable.');
    }
    if (vp9 && !opus) notes.push('Opus audio encoding is unavailable; WebM audio may be dropped.');
  } else {
    notes.push('This browser does not support WebCodecs, which is required to create the video.');
  }
  if (!webgpu && !webgl2) notes.push('No GPU acceleration (WebGPU or WebGL2) is available.');

  return {
    webCodecs,
    workers,
    offscreenCanvas,
    webgpu,
    webgpuF16,
    webgl2,
    crossOriginIsolated: self.crossOriginIsolated === true,
    outputFormats,
    notes,
  };
}

/**
 * Encodes two semi-transparent frames to VP9 WebM, decodes them again and checks
 * the alpha survived. This guards against offering "transparent" output that the
 * pipeline would silently flatten.
 */
export async function verifyAlphaRoundTrip(): Promise<boolean> {
  try {
    const size = 64;
    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext('2d')!;
    const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
    const source = new VideoSampleSource({ codec: 'vp9', quality: QUALITY_HIGH, alpha: 'keep' });
    output.addVideoTrack(source, { frameRate: 10 });
    await output.start();
    for (let i = 0; i < 2; i++) {
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = 'rgba(255, 0, 0, 1)';
      ctx.fillRect(0, 0, size / 2, size); // left half opaque, right half fully transparent
      const sample = new VideoSample(canvas, { timestamp: i / 10, duration: 1 / 10 });
      await source.add(sample);
      sample.close();
    }
    await output.finalize();
    const buffer = output.target.buffer;
    if (!buffer) return false;

    const input = new Input({ source: new BufferSource(buffer), formats: [WEBM] });
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canBeTransparent())) return false;
    const sink = new CanvasSink(track, { alpha: true, poolSize: 1 });
    const wrapped = await sink.getCanvas(0);
    input.dispose?.();
    if (!wrapped) return false;
    const read = (wrapped.canvas as OffscreenCanvas).getContext('2d')!.getImageData(0, 0, size, size).data;
    const alphaAt = (x: number, y: number) => read[(y * size + x) * 4 + 3];
    return alphaAt(8, 32) > 230 && alphaAt(size - 8, 32) < 25;
  } catch (error) {
    console.warn('Alpha round-trip self-test failed', error);
    return false;
  }
}
