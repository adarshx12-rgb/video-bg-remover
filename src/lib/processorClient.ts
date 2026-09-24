import type { ModelId } from '../config';
import type { DownloadProgress } from './models/types';
import type { FromWorker, JobSettings, JobStats, ToWorker } from '../worker/protocol';

export interface LoadedModel {
  backend: string;
  backendNote: string | null;
}

export interface JobHandlers {
  onPhase?(phase: 'processing' | 'finalizing'): void;
  onProgress?(fraction: number, framesDone: number, msPerFrame: number): void;
  onPreview?(bitmap: ImageBitmap): void;
}

export interface JobResult {
  blob: Blob;
  stats: JobStats;
  /** Saved cut-out for replacing the background later without the model; null if unavailable. */
  matte: Blob | null;
}

type DonePayload = { buffer: ArrayBuffer; mimeType: string; stats: JobStats; matte: { buffer: ArrayBuffer; mimeType: string } | null };

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  handlers: JobHandlers;
};

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

const CANCEL_GRACE_MS = 4000;

/**
 * Main-thread owner of the processing worker. Results are routed by job id; once a
 * job is cancelled its late messages are ignored, so stale output never reaches the UI.
 */
export class ProcessorClient {
  private worker: Worker | null = null;
  private model: ModelId | null = null;
  private loadPromise: Promise<LoadedModel> | null = null;
  private nextJobId = 1;
  /** Incremented per loadModel/unload so a stale load can't trigger a retry. */
  private generation = 0;
  private readonly pending = new Map<number, Pending>();
  private loadHandlers: { resolve(b: LoadedModel): void; reject(e: Error): void; onProgress(p: DownloadProgress): void } | null = null;

  /** Called if the worker had to be force-terminated; the model must be loaded again. */
  onWorkerReset: (() => void) | null = null;

  get loadedModel() {
    return this.model;
  }

  /**
   * Load a model, replacing (and fully releasing) any previously loaded one.
   * Loading the same model again is a no-op.
   */
  loadModel(model: ModelId, onProgress: (p: DownloadProgress) => void, backendOverride?: string): Promise<LoadedModel> {
    if (this.model === model && this.loadPromise) return this.loadPromise;
    const generation = ++this.generation;
    const attempt = this.spawn(model, onProgress, backendOverride);
    this.loadPromise = attempt.catch((error: Error & { gpuFailed?: boolean }) => {
      if (!error.gpuFailed || backendOverride || generation !== this.generation) throw error;
      // Same model on the CPU in a fresh worker; the note is shown to the user.
      console.warn('GPU backend failed, restarting worker on WebAssembly:', error.message);
      const retry = this.spawn(model, onProgress, 'wasm');
      this.loadPromise = retry;
      return retry.then((loaded) => ({
        ...loaded,
        backendNote: 'Your graphics chip could not run this model, so it runs on the processor instead. Expect it to be much slower.',
      }));
    });
    return this.loadPromise;
  }

  private spawn(model: ModelId, onProgress: (p: DownloadProgress) => void, backendOverride?: string): Promise<LoadedModel> {
    this.terminate();
    this.model = model;
    const worker = this.createWorker(`matting-${model}`);
    const promise = new Promise<LoadedModel>((resolve, reject) => {
      this.loadHandlers = { resolve, reject, onProgress };
    });
    this.loadPromise = promise;
    promise.catch(() => {
      if (this.worker === worker) this.terminate();
    });
    this.send({ type: 'load', model, backendOverride });
    return promise;
  }

  process(file: File, settings: JobSettings, handlers: JobHandlers): { jobId: number; result: Promise<JobResult> } {
    const jobId = this.nextJobId++;
    const result = this.startJob<DonePayload>(jobId, handlers, settings).then(toJobResult);
    this.send({ type: 'process', jobId, file, settings }, transferables(settings));
    return { jobId, result };
  }

  /**
   * Replace the background using a saved cut-out: no model is needed, so this works
   * even when none is loaded (a model-less worker is started if necessary).
   */
  reapply(file: File, matte: Blob, model: ModelId, settings: JobSettings, handlers: JobHandlers): { jobId: number; result: Promise<JobResult> } {
    if (!this.worker) this.createWorker('compositing');
    const jobId = this.nextJobId++;
    const result = this.startJob<DonePayload>(jobId, handlers, settings).then(toJobResult);
    this.send({ type: 'reapply', jobId, file, matte, model, settings }, transferables(settings));
    return { jobId, result };
  }

  private createWorker(name: string): Worker {
    const worker = new Worker(new URL('../worker/processor.worker.ts', import.meta.url), { type: 'module', name });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.handleMessage(event.data);
    worker.onerror = (event) => {
      event.preventDefault();
      this.failEverything(new Error(`The processing worker crashed: ${event.message || 'unknown error'}. Select the model again to retry.`));
    };
    return worker;
  }

  previewFrame(file: File, settings: JobSettings, timeSeconds: number): { jobId: number; result: Promise<{ bitmap: ImageBitmap; frames: number }> } {
    const jobId = this.nextJobId++;
    const result = this.startJob<{ bitmap: ImageBitmap; frames: number }>(jobId, {}, settings);
    this.send({ type: 'preview-frame', jobId, file, timeSeconds, settings }, transferables(settings));
    return { jobId, result };
  }

  /**
   * Request cancellation. Resolves once the worker confirms, or force-terminates the
   * worker (releasing everything) if it does not respond in time.
   */
  async cancel(jobId: number): Promise<void> {
    const job = this.pending.get(jobId);
    if (!job) return;
    job.handlers = {}; // stop delivering progress/previews for this job right away
    this.send({ type: 'cancel', jobId });
    const confirmed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CANCEL_GRACE_MS);
      const originalReject = job.reject;
      job.reject = (error) => {
        clearTimeout(timer);
        originalReject(error);
        resolve(true);
      };
    });
    if (!confirmed) {
      this.terminate();
      this.onWorkerReset?.();
    }
  }

  /** Release the loaded model and its worker entirely. */
  unload() {
    this.generation++;
    this.terminate();
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.model = null;
    this.loadPromise = null;
    this.failEverything(new CancelledError());
  }

  private startJob<T>(jobId: number, handlers: JobHandlers, _settings: JobSettings): Promise<T> {
    if (!this.worker) return Promise.reject(new Error('Select a model first.'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(jobId, { resolve: resolve as (v: unknown) => void, reject, handlers });
    });
  }

  private send(message: ToWorker, transfer: Transferable[] = []) {
    this.worker?.postMessage(message, transfer);
  }

  private failEverything(error: Error) {
    const load = this.loadHandlers;
    this.loadHandlers = null;
    load?.reject(error);
    for (const [id, job] of this.pending) {
      this.pending.delete(id);
      job.reject(error);
    }
  }

  private handleMessage(message: FromWorker) {
    switch (message.type) {
      case 'load-progress':
        this.loadHandlers?.onProgress(message.progress);
        return;
      case 'loaded':
        this.loadHandlers?.resolve({ backend: message.backend, backendNote: message.backendNote });
        this.loadHandlers = null;
        return;
      case 'load-error':
        this.loadHandlers?.reject(Object.assign(new Error(message.message), { gpuFailed: message.gpuFailed }));
        this.loadHandlers = null;
        return;
    }

    const job = this.pending.get(message.jobId);
    if (!job) {
      // Stale message from a cancelled job: release transferred resources and ignore.
      if (message.type === 'preview' || message.type === 'preview-done') message.bitmap.close();
      return;
    }
    switch (message.type) {
      case 'phase':
        job.handlers.onPhase?.(message.phase);
        break;
      case 'progress':
        job.handlers.onProgress?.(message.fraction, message.framesDone, message.msPerFrame);
        break;
      case 'preview':
        if (job.handlers.onPreview) job.handlers.onPreview(message.bitmap);
        else message.bitmap.close();
        break;
      case 'done':
        this.pending.delete(message.jobId);
        job.resolve({ buffer: message.buffer, mimeType: message.mimeType, stats: message.stats, matte: message.matte });
        break;
      case 'preview-done':
        this.pending.delete(message.jobId);
        job.resolve({ bitmap: message.bitmap, frames: message.frames });
        break;
      case 'cancelled':
        this.pending.delete(message.jobId);
        job.reject(new CancelledError());
        break;
      case 'error':
        this.pending.delete(message.jobId);
        job.reject(new Error(message.message));
        break;
    }
  }
}

function toJobResult({ buffer, mimeType, stats, matte }: DonePayload): JobResult {
  return {
    blob: new Blob([buffer], { type: mimeType }),
    stats,
    matte: matte ? new Blob([matte.buffer], { type: matte.mimeType }) : null,
  };
}

function transferables(settings: JobSettings): Transferable[] {
  return settings.background.kind === 'image' ? [settings.background.image] : [];
}
