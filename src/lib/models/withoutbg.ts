import * as ort from 'onnxruntime-web/webgpu';
import { ORT_WASM_PATHS, WITHOUTBG_MODEL, withoutbgFile } from '../../config';
import { cachedFetch, openModelCache } from './cachedFetch';
import { GpuBackendError } from './errors';
import type { AdapterOptions, DownloadProgress, MatteResult, MattingAdapter } from './types';

// Load the ONNX Runtime WASM runtime from the pinned CDN copy (see ORT_WASM_PATHS).
ort.env.wasm.wasmPaths = { ...ORT_WASM_PATHS };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

type Device = 'webgpu' | 'wasm';

/**
 * withoutBG open-weights model via ONNX Runtime Web, following the publisher's
 * documented contract: letterbox the frame into a black 448×448 canvas (top-left),
 * float32 NCHW in [0,1] as "rgb"; the "alpha" output is cropped to the letterboxed
 * area and scaled back to the frame size. Frames are independent (no state).
 */
export class WithoutbgAdapter implements MattingAdapter {
  readonly id: 'withoutbg' | 'withoutbg-small';
  readonly isTemporal = false;
  readonly backendNote = null;
  backend = 'not loaded';
  stageTimings: Record<string, number> = {};

  private session: ort.InferenceSession | null = null;
  private readonly box = new OffscreenCanvas(WITHOUTBG_MODEL.canvasSize, WITHOUTBG_MODEL.canvasSize);
  private readonly input = new Float32Array(3 * WITHOUTBG_MODEL.canvasSize * WITHOUTBG_MODEL.canvasSize);
  private small: OffscreenCanvas | null = null;
  private smallImage: ImageData | null = null;
  private maskCanvas: OffscreenCanvas | null = null;
  private readonly options: AdapterOptions;

  constructor(options: AdapterOptions = {}, id: 'withoutbg' | 'withoutbg-small' = 'withoutbg') {
    this.options = options;
    this.id = id;
  }

  async load(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    const device = (this.options.backendOverride as Device | undefined) ?? (await pickDevice());
    const file = withoutbgFile(this.id);
    const cache = await openModelCache(file.cacheName, 'withoutbg-onnx-');
    let fromCache = false;
    let bytes: ArrayBuffer | null = await cachedFetch(file.url, cache, (p) => {
      fromCache = p.fromCache;
      onProgress({ loaded: p.loaded, total: p.total, initialising: false, fromCache: p.fromCache });
    });
    onProgress({ loaded: bytes.byteLength, total: bytes.byteLength, initialising: true, fromCache });

    // Integrity check against the pinned SHA-256 (also catches a truncated cache entry).
    const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
    if (digest !== file.sha256) {
      await cache?.delete(file.url).catch(() => undefined);
      throw new Error('The downloaded model file is incomplete or damaged. Select Try again to download it again.');
    }

    try {
      this.session = await ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: [device],
        graphOptimizationLevel: 'all',
        // The 8-bit file stores weights as int8 + DequantizeLinear. Without this, ONNX
        // Runtime keeps those nodes for QDQ fusion and dequantizes every frame (about
        // 35% slower on CPU); with it they are constant-folded once at load.
        extra: { session: { disable_quant_qdq: '1' } },
      });
      bytes = null; // release the downloaded copy; the session owns the weights now
      await this.warmUp();
    } catch (error) {
      await this.session?.release().catch(() => undefined);
      this.session = null;
      const detail = error instanceof Error ? error.message : String(error);
      if (device === 'webgpu') throw new GpuBackendError(detail);
      throw new Error(`The Any subject model could not start: ${detail.slice(0, 300)}. Close other heavy tabs and try again.`);
    }
    this.backend = device === 'webgpu' ? 'WebGPU' : 'WebAssembly (CPU)';
  }

  resetState(): void {
    // Frames are independent.
  }

  async process(frame: OffscreenCanvas): Promise<MatteResult> {
    if (!this.session) throw new Error('The Any subject model is not loaded.');
    const { width, height } = frame;
    const size = WITHOUTBG_MODEL.canvasSize;
    const t0 = performance.now();

    // Letterbox: longest side to 448, top-left on black.
    const scale = size / Math.max(width, height);
    const newW = Math.max(1, Math.round(width * scale));
    const newH = Math.max(1, Math.round(height * scale));
    const bctx = this.box.getContext('2d', { willReadFrequently: true })!;
    bctx.fillStyle = '#000';
    bctx.fillRect(0, 0, size, size);
    bctx.drawImage(frame, 0, 0, newW, newH);
    const px = bctx.getImageData(0, 0, size, size).data;
    const plane = size * size;
    const input = this.input;
    for (let i = 0; i < plane; i++) {
      input[i] = px[i * 4] / 255;
      input[plane + i] = px[i * 4 + 1] / 255;
      input[2 * plane + i] = px[i * 4 + 2] / 255;
    }
    const t1 = performance.now();

    const tensor = new ort.Tensor('float32', input, [1, 3, size, size]);
    const outputs = await this.session.run({ [WITHOUTBG_MODEL.inputName]: tensor });
    const alphaTensor = outputs[WITHOUTBG_MODEL.outputName];
    const alpha = (await alphaTensor.getData()) as Float32Array;
    alphaTensor.dispose();
    const t2 = performance.now();

    // Crop the letterboxed region into a small alpha image, then scale it up on the canvas.
    if (!this.small || this.small.width !== newW || this.small.height !== newH) {
      this.small = new OffscreenCanvas(newW, newH);
      this.smallImage = new ImageData(newW, newH);
      this.smallImage.data.fill(255);
    }
    const data = this.smallImage!.data;
    for (let y = 0; y < newH; y++) {
      const row = y * size;
      for (let x = 0; x < newW; x++) data[(y * newW + x) * 4 + 3] = alpha[row + x] * 255;
    }
    this.small.getContext('2d')!.putImageData(this.smallImage!, 0, 0);
    if (!this.maskCanvas || this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
      this.maskCanvas = new OffscreenCanvas(width, height);
    }
    const mctx = this.maskCanvas.getContext('2d')!;
    mctx.globalCompositeOperation = 'copy';
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(this.small, 0, 0, width, height);

    const t3 = performance.now();
    this.stageTimings.letterbox = (this.stageTimings.letterbox ?? 0) + t1 - t0;
    this.stageTimings.inference = (this.stageTimings.inference ?? 0) + t2 - t1;
    this.stageTimings.maskResize = (this.stageTimings.maskResize ?? 0) + t3 - t2;
    return { mask: this.maskCanvas, foreground: null };
  }

  async dispose(): Promise<void> {
    await this.session?.release().catch(() => undefined);
    this.session = null;
    this.small = this.maskCanvas = null;
    this.smallImage = null;
  }

  private async warmUp() {
    const size = WITHOUTBG_MODEL.canvasSize;
    const tensor = new ort.Tensor('float32', new Float32Array(3 * size * size).fill(0.5), [1, 3, size, size]);
    const out = await this.session!.run({ [WITHOUTBG_MODEL.inputName]: tensor });
    const alpha = out[WITHOUTBG_MODEL.outputName];
    if (!alpha || alpha.dims[2] !== size) throw new Error('warm-up produced an unexpected output');
    alpha.dispose();
  }
}

/** fp32 model: any WebGPU adapter will do (no shader-f16 needed). */
async function pickDevice(): Promise<Device> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  try {
    return gpu && (await gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}
