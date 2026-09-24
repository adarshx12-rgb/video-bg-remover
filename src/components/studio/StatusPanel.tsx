import type { DownloadProgress } from '../../lib/models/types';
import { formatBytes } from '../../lib/video/sizing';
import type { JobStats } from '../../worker/protocol';
import type { FriendlyError } from './errors';

export type JobState =
  | { status: 'idle' }
  | { status: 'loading-model'; progress: DownloadProgress | null; modelName: string }
  | { status: 'processing'; phase: 'processing' | 'finalizing'; fraction: number; framesDone: number; msPerFrame: number; totalFrames: number }
  | { status: 'cancelling' }
  | { status: 'cancelled' }
  | { status: 'done'; url: string; fileName: string; size: number; stats: JobStats; formatLabel: string; stale: boolean }
  | { status: 'error'; error: FriendlyError };

export function StatusPanel({ job }: { job: JobState }) {
  switch (job.status) {
    case 'idle':
      return null;

    case 'loading-model': {
      const p = job.progress;
      const determinate = p && !p.initialising && p.total;
      return (
        <div className="status" role="status" aria-live="polite">
          <p className="status-title">
            {p?.initialising ? `Preparing the ${job.modelName} model` : `Downloading the ${job.modelName} model`}
          </p>
          <Progress value={determinate ? p.loaded / p.total! : null} label="Model download" />
          <p className="status-detail">
            {p?.initialising
              ? 'Setting up your graphics chip. This can take a little while.'
              : determinate
                ? `${formatBytes(p.loaded)} of ${formatBytes(p.total!)}. Saved for next time.`
                : p && p.loaded > 0
                  ? `${formatBytes(p.loaded)} downloaded`
                  : 'Starting download…'}
          </p>
        </div>
      );
    }

    case 'processing': {
      const remainingFrames = Math.max(0, job.totalFrames - job.framesDone);
      const etaSeconds = job.msPerFrame > 0 ? (remainingFrames * job.msPerFrame) / 1000 : null;
      return (
        <div className="status" role="status" aria-live="polite">
          <p className="status-title">{job.phase === 'finalizing' ? 'Finishing the video file' : 'Removing the background'}</p>
          <Progress value={job.phase === 'finalizing' ? null : job.fraction} label="Processing" />
          <p className="status-detail">
            {job.phase === 'finalizing'
              ? 'Writing the last frames and the sound.'
              : `${Math.round(job.fraction * 100)}%, frame ${job.framesDone} of about ${job.totalFrames}${
                  etaSeconds !== null && job.framesDone >= 3 ? `. About ${formatEta(etaSeconds)} left.` : '.'
                }`}
          </p>
        </div>
      );
    }

    case 'cancelling':
      return (
        <div className="status" role="status" aria-live="polite">
          <p className="status-title">Stopping…</p>
          <Progress value={null} label="Stopping" />
        </div>
      );

    case 'cancelled':
      return (
        <div className="status" role="status" aria-live="polite">
          <p className="status-title">Stopped</p>
          <p className="status-detail">Nothing was saved. Select Try again to start over.</p>
        </div>
      );

    case 'done': {
      const { stats } = job;
      return (
        <div className="status status-done" role="status" aria-live="polite">
          <p className="status-title">Your video is ready</p>
          <p className="status-detail">
            {job.formatLabel}, {stats.width} × {stats.height}, {formatBytes(job.size)}. Took {formatEta(stats.processingSeconds)} on{' '}
            {stats.backend}.
          </p>
          <AudioNote stats={stats} />
          {job.stale && <p className="inline-note">You changed the settings. Select Remove background again to apply them.</p>}
        </div>
      );
    }

    case 'error':
      return (
        <div className="status status-error" role="alert">
          <p className="status-title">{job.error.title}</p>
          <p className="status-detail">{job.error.message}</p>
          <p className="status-recovery">{job.error.recovery}</p>
        </div>
      );
  }
}

function AudioNote({ stats }: { stats: JobStats }) {
  const audio = stats.audio;
  if (audio.status === 'none') return <p className="status-detail">The original had no sound.</p>;
  if (audio.status === 'dropped') {
    return (
      <p className="inline-note">
        The sound could not be kept ({audio.reason}). Try the other file type to keep it.
      </p>
    );
  }
  return (
    <p className="status-detail">
      {audio.transcoded ? `Sound converted to ${audio.codec.toUpperCase()} to fit this file type, kept in sync.` : 'Original sound kept unchanged.'}
    </p>
  );
}

function Progress({ value, label }: { value: number | null; label: string }) {
  return (
    <div
      className={`progress${value === null ? ' is-indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(value * 100)}
    >
      <div className="progress-bar" style={value === null ? undefined : { width: `${Math.max(1, value * 100)}%` }} />
    </div>
  );
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}
