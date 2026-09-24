import type { ModelId } from '../config';
import type { OutputFormatId } from '../lib/capabilities';
import type { DownloadProgress } from '../lib/models/types';

export type BackgroundMessage =
  | { kind: 'transparent' }
  | { kind: 'color'; color: string }
  | { kind: 'image'; image: ImageBitmap };

export interface JobSettings {
  format: OutputFormatId;
  background: BackgroundMessage;
  /** Matte blur radius in pixels, 0 = off. */
  edgeSoftness: number;
  /** Target frame rate, or null to keep the original timing exactly. */
  frameRate: number | null;
  output: { width: number; height: number };
}

export type AudioOutcome =
  | { status: 'none' }
  | { status: 'kept'; codec: string; transcoded: boolean }
  | { status: 'dropped'; reason: string };

export interface JobStats {
  frames: number;
  processingSeconds: number;
  msPerFrame: number;
  /** Average milliseconds per frame for each stage (model-specific plus compose). */
  stageMsPerFrame: Record<string, number>;
  backend: string;
  audio: AudioOutcome;
  videoCodec: string;
  width: number;
  height: number;
}

export type ToWorker =
  | { type: 'load'; model: ModelId; backendOverride?: string }
  | { type: 'process'; jobId: number; file: File; settings: JobSettings }
  /** Re-composite from a saved cut-out (matte pack) without running a model. */
  | { type: 'reapply'; jobId: number; file: File; matte: Blob; model: ModelId; settings: JobSettings }
  | { type: 'preview-frame'; jobId: number; file: File; timeSeconds: number; settings: JobSettings }
  | { type: 'cancel'; jobId: number };

export type FromWorker =
  | { type: 'load-progress'; progress: DownloadProgress }
  | { type: 'loaded'; backend: string; backendNote: string | null }
  | { type: 'load-error'; message: string; gpuFailed: boolean }
  | { type: 'phase'; jobId: number; phase: 'processing' | 'finalizing' }
  | { type: 'progress'; jobId: number; fraction: number; framesDone: number; msPerFrame: number }
  | { type: 'preview'; jobId: number; bitmap: ImageBitmap }
  | { type: 'done'; jobId: number; buffer: ArrayBuffer; mimeType: string; stats: JobStats; matte: { buffer: ArrayBuffer; mimeType: string } | null }
  | { type: 'preview-done'; jobId: number; bitmap: ImageBitmap; frames: number }
  | { type: 'cancelled'; jobId: number }
  | { type: 'error'; jobId: number; message: string };
