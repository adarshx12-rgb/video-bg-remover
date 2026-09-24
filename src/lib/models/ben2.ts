import { env, pipeline, RawImage, type BackgroundRemovalPipeline, type ProgressCallback, type ProgressInfo } from '@huggingface/transformers';
import { BEN2_MODEL } from '../../config';
import { installOrtShaderFix } from './ortShaderFix';
import type { AdapterOptions, DownloadProgress, MatteResult, MattingAdapter } from './types';

// Serve the ONNX Runtime WASM runtime from this app (copied by scripts/copy-ort-wasm.mjs)
// instead of the default third-party CDN.
env.allowLocalModels = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs', self.location.origin).href,
    wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', self.location.origin).href,
  };
  env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
}

// Must run before ONNX Runtime compiles any WebGPU shader (see ortShaderFix.ts).
installOrtShaderFix();

type Device = 'webgpu' | 'wasm';

/**
 * BEN2 Base (community ONNX conversion) through the documented Transformers.js
 * `background-removal` pipeline. Frames are independent, so there is no state.
 */
export class Ben2Adapter implements MattingAdapter {
  readonly id = 'ben2' as const;
  readonly isTemporal = false;
  backend = 'not loaded';
  readonly backendNote = null;
  stageTimings: Record<string, number> = {};

  private segmenter: BackgroundRemovalPipeline | null = null;
  private maskCanvas: OffscreenCanvas | null = null;
  private readonly options: AdapterOptions;

  constructor(options: AdapterOptions = {}) {
    this.options = options;
  }

  async load(onProgress: (progress: DownloadProgress) => void): Promise<void> {
    const device = (this.options.backendOverride as Device | undefined) ?? (await pickDevice());
    let sawModelFile = false;
    const progress_callback: ProgressCallback = (info: ProgressInfo) => {
      if (info.status === 'progress_total') {
        // Small config files finish first; only report a total once the model file is known.
        sawModelFile ||= Object.keys(info.files ?? {}).some((f) => f.endsWith('.onnx'));
        onProgress({ loaded: info.loaded, total: sawModelFile ? info.total : null, initialising: false, fromCache: false });
      } else if (info.status === 'done' && sawModelFile) {
        onProgress({ loaded: 0, total: null, initialising: true, fromCache: false });
      }
    };

    try {
      await this.createAndWarmUp(device, progress_callback);
    } catch (error) {
      if (device === 'webgpu') {
        // Some GPUs/drivers cannot compile BEN2's fp16 shaders. ONNX Runtime keeps WebGPU
        // state per worker, so the client retries the same model in a fresh worker on WASM.
        throw new GpuBackendError(error instanceof Error ? error.message : String(error));
      }
      throw loadError(device, error);
    }
  }

  private async createAndWarmUp(device: Device, progress_callback: ProgressCallback) {
    await this.segmenter?.dispose();
    this.segmenter = (await pipeline('background-removal', BEN2_MODEL.repo, {
      revision: BEN2_MODEL.revision,
      dtype: BEN2_MODEL.dtype,
      device,
      progress_callback,
    })) as BackgroundRemovalPipeline;
    try {
      // One real inference validates that every shader/kernel works on this device.
      const canvas = new OffscreenCanvas(64, 64);
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, 64, 64);
      await this.segmenter(new RawImage(ctx.getImageData(0, 0, 64, 64).data, 64, 64, 4));
    } catch (error) {
      await this.segmenter.dispose();
      this.segmenter = null;
      throw error;
    }
    this.backend = device === 'webgpu' ? 'WebGPU' : 'WebAssembly (CPU)';
  }

  resetState(): void {
    // BEN2 processes every frame independently.
  }

  async process(frame: OffscreenCanvas): Promise<MatteResult> {
    if (!this.segmenter) throw new Error('BEN2 model is not loaded.');
    const { width, height } = frame;
    const t0 = performance.now();
    const pixels = frame.getContext('2d')!.getImageData(0, 0, width, height);
    const image = new RawImage(pixels.data, width, height, 4);
    const t1 = performance.now();
    const output = (await this.segmenter(image)) as RawImage;
    const t2 = performance.now();

    if (!this.maskCanvas || this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
      this.maskCanvas = new OffscreenCanvas(width, height);
    }
    // The pipeline returns the input image with the predicted matte in its alpha channel.
    const rgba = output.channels === 4 ? output.data : output.rgba().data;
    const pixelsOut = new ImageData(width, height);
    pixelsOut.data.set(rgba);
    this.maskCanvas.getContext('2d')!.putImageData(pixelsOut, 0, 0);
    const t3 = performance.now();
    this.stageTimings.readPixels = (this.stageTimings.readPixels ?? 0) + t1 - t0;
    this.stageTimings.pipeline = (this.stageTimings.pipeline ?? 0) + t2 - t1;
    this.stageTimings.maskUpload = (this.stageTimings.maskUpload ?? 0) + t3 - t2;
    return { mask: this.maskCanvas, foreground: null };
  }

  async dispose(): Promise<void> {
    await this.segmenter?.dispose();
    this.segmenter = null;
    this.maskCanvas = null;
  }
}

export class GpuBackendError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'GpuBackendError';
  }
}

function loadError(device: Device, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `The General subjects model could not start on ${device === 'webgpu' ? 'WebGPU' : 'the processor (WebAssembly)'}: ${detail.slice(0, 300)}. ` +
      'Close other heavy tabs and try again, or use an up-to-date Chrome or Edge.',
  );
}

/**
 * The only published weights are fp16. ONNX Runtime's WebGPU backend needs the
 * adapter's `shader-f16` feature for fp16 models; otherwise use WASM (much slower).
 */
async function pickDevice(): Promise<Device> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (!gpu) return 'wasm';
  try {
    const adapter = await gpu.requestAdapter();
    return adapter?.features.has('shader-f16') ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}
