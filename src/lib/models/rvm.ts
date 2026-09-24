import * as tf from '@tensorflow/tfjs-core';
import { loadGraphModel, type GraphModel } from '@tensorflow/tfjs-converter';
import { RVM_MODEL } from '../../config';
import { rvmDownsampleRatio } from '../video/sizing';
import { cachedFetch, openModelCache } from './cachedFetch';
import type { AdapterOptions, DownloadProgress, MatteResult, MattingAdapter } from './types';

const BACKEND_LABELS: Record<string, string> = { webgpu: 'WebGPU', webgl: 'WebGL' };

/**
 * Robust Video Matting (MobileNetV3) via TensorFlow.js, following the official `tfjs`
 * branch example: inputs {src, r1i..r4i, downsample_ratio}, outputs
 * {fgr, pha, r1o..r4o}. The r*o outputs are fed back as the next frame's r*i.
 */
export class RvmAdapter implements MattingAdapter {
  readonly id = 'rvm' as const;
  readonly isTemporal = true;
  backend = 'not loaded';
  readonly backendNote = null;
  stageTimings: Record<string, number> = {};

  private model: GraphModel | null = null;
  private recurrent: tf.Tensor[] | null = null;
  private downsample: tf.Tensor | null = null;
  private downsampleValue = -1;
  private maskCanvas: OffscreenCanvas | null = null;
  private fgCanvas: OffscreenCanvas | null = null;
  private maskImage: ImageData | null = null;
  private fgImage: ImageData | null = null;
  private readonly options: AdapterOptions;

  constructor(options: AdapterOptions = {}) {
    this.options = options;
  }

  async load(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    const cache = await openModelCache(RVM_MODEL.cacheName, 'rvm-tfjs-');
    const files = new Map<string, ArrayBuffer>();
    const totals = new Map<string, number | null>();
    const loadedBytes = new Map<string, number>();
    let allFromCache = true;

    // Download sequentially so progress totals become known file by file.
    for (const file of RVM_MODEL.files) {
      const url = RVM_MODEL.baseUrl + file;
      const buffer = await cachedFetch(url, cache, (p) => {
        totals.set(file, p.total);
        loadedBytes.set(file, p.loaded);
        allFromCache &&= p.fromCache;
        const known = RVM_MODEL.files.every((f) => totals.get(f) != null);
        onProgress({
          loaded: sum(loadedBytes.values()),
          total: known ? sum(totals.values() as Iterable<number>) : null,
          initialising: false,
          fromCache: allFromCache,
        });
      });
      files.set(url, buffer);
    }
    onProgress({ loaded: sum(loadedBytes.values()), total: sum(loadedBytes.values()), initialising: true, fromCache: allFromCache });

    const fetchFunc = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const buffer = files.get(url);
      if (!buffer) throw new Error(`Unexpected RVM model request: ${url}`);
      return new Response(buffer);
    };

    const candidates = this.options.backendOverride ? [this.options.backendOverride] : await preferredBackends();
    const failures: string[] = [];
    for (const name of candidates) {
      try {
        await registerBackend(name);
        if (!(await tf.setBackend(name))) throw new Error('backend unavailable');
        await tf.ready();
        this.model = await loadGraphModel(RVM_MODEL.baseUrl + 'model.json', { fetchFunc });
        await this.warmUp();
        this.backend = BACKEND_LABELS[name] ?? name;
        return;
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        this.model?.dispose();
        this.model = null;
        this.disposeState();
      }
    }
    throw new Error(
      `This browser could not run the People model with GPU acceleration (${failures.join('; ')}). ` +
        'Try an up-to-date Chrome or Edge with hardware acceleration enabled.',
    );
  }

  resetState(): void {
    tf.dispose(this.recurrent ?? []);
    this.recurrent = [tf.scalar(0), tf.scalar(0), tf.scalar(0), tf.scalar(0)];
  }

  async process(frame: OffscreenCanvas): Promise<MatteResult> {
    if (!this.model) throw new Error('RVM model is not loaded.');
    if (!this.recurrent) this.resetState();
    const { width, height } = frame;
    this.ensureBuffers(width, height);

    const ratio = rvmDownsampleRatio(width, height);
    if (ratio !== this.downsampleValue) {
      this.downsample?.dispose();
      this.downsample = tf.scalar(ratio);
      this.downsampleValue = ratio;
    }

    // OffscreenCanvas is canvas-like; tfjs uploads it directly as a texture.
    const pixels = frame as unknown as HTMLCanvasElement;
    let mark = performance.now();
    const src = tf.tidy(() => tf.div(tf.expandDims(tf.cast(tf.browser.fromPixels(pixels), 'float32'), 0), 255));
    const [r1i, r2i, r3i, r4i] = this.recurrent!;
    let outputs: tf.Tensor[];
    try {
      outputs = (await this.model.executeAsync(
        { src, r1i, r2i, r3i, r4i, downsample_ratio: this.downsample! },
        ['fgr', 'pha', 'r1o', 'r2o', 'r3o', 'r4o'],
      )) as tf.Tensor[];
    } finally {
      src.dispose();
    }
    mark = this.time('inference', mark);
    const [fgr, pha, ...nextState] = outputs;
    tf.dispose(this.recurrent!);
    this.recurrent = nextState;

    // Read back foreground colours and alpha as one [h, w, 4] tensor in 0..255.
    const rgba = tf.tidy(() => tf.mul(tf.squeeze(tf.concat([fgr, pha], -1), [0]), 255));
    tf.dispose([fgr, pha]);
    let values: Float32Array;
    try {
      values = (await rgba.data()) as Float32Array;
    } finally {
      rgba.dispose();
    }

    mark = this.time('readback', mark);
    const fg = this.fgImage!.data;
    const mask = this.maskImage!.data;
    for (let i = 0; i < values.length; i += 4) {
      fg[i] = values[i];
      fg[i + 1] = values[i + 1];
      fg[i + 2] = values[i + 2];
      mask[i + 3] = values[i + 3];
    }
    this.fgCanvas!.getContext('2d')!.putImageData(this.fgImage!, 0, 0);
    this.maskCanvas!.getContext('2d')!.putImageData(this.maskImage!, 0, 0);
    this.time('unpack', mark);
    return { mask: this.maskCanvas!, foreground: this.fgCanvas! };
  }

  private time(stage: string, since: number): number {
    const now = performance.now();
    this.stageTimings[stage] = (this.stageTimings[stage] ?? 0) + now - since;
    return now;
  }

  async dispose(): Promise<void> {
    this.disposeState();
    this.model?.dispose();
    this.model = null;
    this.maskCanvas = this.fgCanvas = null;
    this.maskImage = this.fgImage = null;
  }

  private disposeState() {
    tf.dispose(this.recurrent ?? []);
    this.recurrent = null;
    this.downsample?.dispose();
    this.downsample = null;
    this.downsampleValue = -1;
  }

  private ensureBuffers(width: number, height: number) {
    if (this.maskCanvas?.width === width && this.maskCanvas.height === height) return;
    this.maskCanvas = new OffscreenCanvas(width, height);
    this.fgCanvas = new OffscreenCanvas(width, height);
    this.maskImage = new ImageData(width, height);
    this.fgImage = new ImageData(width, height);
    this.fgImage.data.fill(255); // opaque; RGB is overwritten per frame
  }

  /** Runs one small frame so shader compilation happens during loading, and validates the backend. */
  private async warmUp() {
    const canvas = new OffscreenCanvas(256, 144);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 256, 144);
    this.resetState();
    const result = await this.process(canvas);
    if (result.mask.width !== 256) throw new Error('warm-up produced an unexpected output size');
    this.resetState();
  }
}

async function preferredBackends(): Promise<string[]> {
  const order: string[] = [];
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu) {
    try {
      if (await gpu.requestAdapter()) order.push('webgpu');
    } catch {
      /* no WebGPU adapter */
    }
  }
  order.push('webgl');
  return order;
}

async function registerBackend(name: string) {
  if (name === 'webgpu') await import('@tensorflow/tfjs-backend-webgpu');
  else if (name === 'webgl') await import('@tensorflow/tfjs-backend-webgl');
  else throw new Error(`Unsupported backend "${name}"`);
}

function sum(values: Iterable<number | null | undefined>): number {
  let total = 0;
  for (const v of values) total += v ?? 0;
  return total;
}
