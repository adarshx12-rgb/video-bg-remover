import type { ModelId } from '../../config';

export interface DownloadProgress {
  /** Bytes downloaded so far across all files, or null when unknown. */
  loaded: number;
  /** Total bytes across all files, or null when the server does not report sizes. */
  total: number | null;
  /** True once all files are downloaded and the model is being initialised. */
  initialising: boolean;
  fromCache: boolean;
}

/**
 * Result of matting one frame. Canvases are owned by the adapter and reused for the
 * next frame, so callers must consume them before calling `process` again.
 */
export interface MatteResult {
  /** Alpha channel holds the matte (0 = background, 255 = foreground). */
  mask: OffscreenCanvas;
  /**
   * Optional foreground colours to composite instead of the original frame. RVM
   * predicts these to reduce background colour spill at soft edges. Opaque.
   */
  foreground: OffscreenCanvas | null;
}

/**
 * Shared interface for every background-removal model. Temporal models (RVM) keep
 * recurrent state between consecutive `process` calls; `resetState` must be called
 * whenever frames stop being consecutive (new video, restart, seek).
 */
export interface MattingAdapter {
  readonly id: ModelId;
  /** Human-readable name of the inference backend actually in use, e.g. "WebGPU". */
  readonly backend: string;
  /** Plain-language note when a slower fallback backend is in use, otherwise null. */
  readonly backendNote: string | null;
  readonly isTemporal: boolean;
  /** Cumulative milliseconds per internal stage since the last reset, for diagnostics. */
  readonly stageTimings: Record<string, number>;
  load(onProgress: (progress: DownloadProgress) => void): Promise<void>;
  resetState(): void;
  /**
   * `frame` is an opaque RGB image already at output resolution; `timestamp` is its
   * presentation time in seconds (used by the saved-matte adapter to find its frame).
   */
  process(frame: OffscreenCanvas, timestamp: number): Promise<MatteResult>;
  dispose(): Promise<void>;
}

export interface AdapterOptions {
  /** Force a specific backend, used by automated tests and for troubleshooting. */
  backendOverride?: string;
}
