/// <reference lib="webworker" />
import type { ModelId } from '../config';
import { SavedMatteAdapter } from '../lib/models/savedMatte';
import type { MattingAdapter } from '../lib/models/types';
import { installAvcCodecFix, installVp9DecodeWorkaround } from '../lib/video/decoderWorkaround';
import { JobCancelledError, previewFrame, processVideo, type CancelToken } from '../lib/pipeline';
import type { BackgroundMessage, FromWorker, ToWorker } from './protocol';

/**
 * One worker hosts exactly one model. Switching models terminates the worker, which
 * is the most reliable way to release all GPU, WASM and tensor memory.
 */
const scope = self as unknown as DedicatedWorkerGlobalScope;
installVp9DecodeWorkaround();
installAvcCodecFix();

let adapter: MattingAdapter | null = null;
let loading: Promise<MattingAdapter> | null = null;
const tokens = new Map<number, CancelToken>();
/** Jobs run one at a time so a preview can never interleave with an export (RVM state is shared). */
let jobQueue: Promise<void> = Promise.resolve();

function enqueue(job: () => Promise<void>) {
  jobQueue = jobQueue.then(job, job);
  return jobQueue;
}

function post(message: FromWorker, transfer: Transferable[] = []) {
  scope.postMessage(message, transfer);
}

async function createAdapter(model: ModelId, backendOverride?: string): Promise<MattingAdapter> {
  // Dynamic imports: only the selected model's runtime (TF.js or ONNX Runtime) is loaded.
  switch (model) {
    case 'rvm': {
      const { RvmAdapter } = await import('../lib/models/rvm');
      return new RvmAdapter({ backendOverride });
    }
    case 'withoutbg': {
      const { WithoutbgAdapter } = await import('../lib/models/withoutbg');
      return new WithoutbgAdapter({ backendOverride });
    }
    case 'ben2': {
      const { Ben2Adapter } = await import('../lib/models/ben2');
      return new Ben2Adapter({ backendOverride });
    }
    default: {
      // Exhaustiveness check: never silently fall back to a different model.
      const unknown: never = model;
      throw new Error(`Unknown model: ${String(unknown)}`);
    }
  }
}

async function load(model: ModelId, backendOverride?: string) {
  if (loading) return loading;
  loading = (async () => {
    const instance = await createAdapter(model, backendOverride);
    await instance.load((progress) => post({ type: 'load-progress', progress }));
    adapter = instance;
    return instance;
  })();
  try {
    const instance = await loading;
    post({ type: 'loaded', backend: instance.backend, backendNote: instance.backendNote });
  } catch (error) {
    loading = null;
    post({ type: 'load-error', message: errorMessage(error), gpuFailed: error instanceof Error && error.name === 'GpuBackendError' });
  }
}

async function requireAdapter(): Promise<MattingAdapter> {
  if (adapter) return adapter;
  if (loading) return loading;
  throw new Error('No model is loaded.');
}

scope.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case 'load':
      await load(message.model, message.backendOverride);
      break;

    case 'cancel': {
      const token = tokens.get(message.jobId);
      if (token) {
        token.cancelled = true;
        token.onCancel?.();
      }
      break;
    }

    case 'process': {
      const { jobId } = message;
      const token: CancelToken = { cancelled: false };
      tokens.set(jobId, token);
      await enqueue(async () => {
      try {
        if (token.cancelled) throw new JobCancelledError();
        const model = await requireAdapter();
        const result = await processVideo(message.file, model, message.settings, token, jobCallbacks(jobId), { recordMatte: true });
        post({ type: 'done', jobId, buffer: result.buffer, mimeType: result.mimeType, stats: result.stats, matte: result.matte }, transfersOf(result));
      } catch (error) {
        if (error instanceof JobCancelledError || token.cancelled) post({ type: 'cancelled', jobId });
        else post({ type: 'error', jobId, message: errorMessage(error) });
      } finally {
        tokens.delete(jobId);
        closeBackground(message.settings.background);
      }
      });
      break;
    }

    case 'reapply': {
      const { jobId } = message;
      const token: CancelToken = { cancelled: false };
      tokens.set(jobId, token);
      await enqueue(async () => {
        // A separate, model-free adapter: works even if no model is loaded in this worker.
        const saved = new SavedMatteAdapter(message.model, message.matte);
        try {
          if (token.cancelled) throw new JobCancelledError();
          await saved.load();
          const result = await processVideo(message.file, saved, message.settings, token, jobCallbacks(jobId));
          post({ type: 'done', jobId, buffer: result.buffer, mimeType: result.mimeType, stats: result.stats, matte: null }, [result.buffer]);
        } catch (error) {
          if (error instanceof JobCancelledError || token.cancelled) post({ type: 'cancelled', jobId });
          else post({ type: 'error', jobId, message: errorMessage(error) });
        } finally {
          await saved.dispose();
          tokens.delete(jobId);
          closeBackground(message.settings.background);
        }
      });
      break;
    }

    case 'preview-frame': {
      const { jobId } = message;
      const token: CancelToken = { cancelled: false };
      tokens.set(jobId, token);
      await enqueue(async () => {
      try {
        if (token.cancelled) throw new JobCancelledError();
        const model = await requireAdapter();
        const { bitmap, frames } = await previewFrame(message.file, model, message.settings, message.timeSeconds, token);
        post({ type: 'preview-done', jobId, bitmap, frames }, [bitmap]);
      } catch (error) {
        if (error instanceof JobCancelledError || token.cancelled) post({ type: 'cancelled', jobId });
        else post({ type: 'error', jobId, message: errorMessage(error) });
      } finally {
        tokens.delete(jobId);
        closeBackground(message.settings.background);
      }
      });
      break;
    }
  }
};

function jobCallbacks(jobId: number) {
  return {
    onPhase: (phase: 'processing' | 'finalizing') => post({ type: 'phase', jobId, phase }),
    onProgress: (fraction: number, framesDone: number, msPerFrame: number) =>
      post({ type: 'progress', jobId, fraction, framesDone, msPerFrame }),
    onPreview: (bitmap: ImageBitmap) => post({ type: 'preview', jobId, bitmap }, [bitmap]),
  };
}

function transfersOf(result: { buffer: ArrayBuffer; matte: { buffer: ArrayBuffer } | null }): Transferable[] {
  return result.matte ? [result.buffer, result.matte.buffer] : [result.buffer];
}

function closeBackground(bg: BackgroundMessage) {
  if (bg.kind === 'image') bg.image.close();
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/out of memory|OOM|allocation failed|Aborted\(\)/i.test(text)) {
    return 'The device ran out of memory. Close other tabs or apps, try a shorter or smaller video, or use the People model.';
  }
  if (/device (was )?lost|context lost/i.test(text)) {
    return 'The graphics device was reset while processing. Select the model again and retry; if it repeats, restart the browser.';
  }
  return text;
}
