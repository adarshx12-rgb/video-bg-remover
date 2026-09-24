import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { LIMITS } from '../../config';

export type StageView = 'original' | 'result' | 'compare';

interface StageProps {
  /** Output-sized aspect ratio (width / height); null before a file is chosen. */
  aspect: number | null;
  originalUrl: string | null;
  originalRef: RefObject<HTMLVideoElement | null>;
  /** Canvas for single-frame previews and live processing frames. */
  canvasRef: RefObject<HTMLCanvasElement | null>;
  resultUrl: string | null;
  resultKind: 'none' | 'canvas' | 'video';
  resultLabel: string;
  transparent: boolean;
  view: StageView;
  onViewChange(view: StageView): void;
  onFiles(files: FileList): void;
  busy: boolean;
}

export function Stage(props: StageProps) {
  const { aspect, originalUrl, originalRef, canvasRef, resultUrl, resultKind, resultLabel, transparent, view, onViewChange, onFiles } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const resultVideoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [wipe, setWipe] = useState(50);

  const hasResult = resultKind !== 'none';
  const effectiveView: StageView = hasResult ? view : 'original';

  // Compare mode with a finished video: the original follows the result's playback.
  useEffect(() => {
    const result = resultVideoRef.current;
    const original = originalRef.current;
    if (!result || !original || resultKind !== 'video') return;
    if (effectiveView !== 'compare') return;
    original.muted = true; // the result carries the sound
    const sync = () => {
      if (Math.abs(original.currentTime - result.currentTime) > 0.08) original.currentTime = result.currentTime;
    };
    const onPlay = () => {
      sync();
      void original.play().catch(() => undefined);
    };
    const onPause = () => {
      original.pause();
      sync();
    };
    result.addEventListener('play', onPlay);
    result.addEventListener('pause', onPause);
    result.addEventListener('seeked', sync);
    result.addEventListener('timeupdate', sync);
    original.pause();
    sync();
    return () => {
      result.removeEventListener('play', onPlay);
      result.removeEventListener('pause', onPause);
      result.removeEventListener('seeked', sync);
      result.removeEventListener('timeupdate', sync);
      original.muted = false;
    };
  }, [effectiveView, resultKind, resultUrl, originalRef]);

  const moveWipe = useCallback((clientX: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWipe(Math.min(100, Math.max(0, ((clientX - rect.left) / rect.width) * 100)));
  }, []);

  const onHandleKey = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'ArrowLeft') setWipe((w) => Math.max(0, w - step));
    else if (event.key === 'ArrowRight') setWipe((w) => Math.min(100, w + step));
    else if (event.key === 'Home') setWipe(0);
    else if (event.key === 'End') setWipe(100);
    else return;
    event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    moveWipe(event.clientX);
  };

  if (!originalUrl) {
    return (
      <div
        className={`stage stage-empty${dragging ? ' is-dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) onFiles(e.dataTransfer.files);
        }}
      >
        <div className="drop-copy">
          <p className="drop-title">{dragging ? 'Drop the video to open it' : 'Drop a video here'}</p>
          <button type="button" className="button button-primary button-large" onClick={() => inputRef.current?.click()}>
            Choose a video
          </button>
          <p className="drop-hint">
            MP4, MOV or WebM, up to {LIMITS.maxDurationSeconds} seconds and {LIMITS.maxInputBytes / 1024 / 1024} MB.
          </p>
        </div>
        <input
          ref={inputRef}
          className="visually-hidden"
          type="file"
          accept="video/*,.mp4,.mov,.webm,.mkv"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
    );
  }

  const resultLayer =
    resultKind === 'video' ? (
      <video
        ref={resultVideoRef}
        className="stage-media"
        src={resultUrl ?? undefined}
        controls={effectiveView !== 'original'}
        playsInline
        aria-label={resultLabel}
      />
    ) : (
      <canvas ref={canvasRef} className="stage-media" role="img" aria-label={resultLabel} />
    );

  return (
    <div className="stage-wrap">
      <div className="stage">
        <div className="stage-frame" ref={frameRef} style={aspect ? ({ '--a': aspect } as CSSProperties) : undefined}>
          <video
            ref={originalRef}
            className="stage-media"
            src={originalUrl}
            controls={effectiveView === 'original'}
            playsInline
            preload="auto"
            aria-label="Original video"
            aria-hidden={effectiveView === 'result'}
            style={{ visibility: effectiveView === 'result' ? 'hidden' : 'visible' }}
          />
          <div
            className={`stage-result${transparent ? ' checker' : ''}`}
            hidden={!hasResult || effectiveView === 'original'}
            style={effectiveView === 'compare' ? { clipPath: `inset(0 0 0 ${wipe}%)` } : undefined}
          >
            {resultLayer}
          </div>
          {/* The canvas must stay mounted so live frames can be drawn before the view switches. */}
          {resultKind === 'video' && <canvas ref={canvasRef} hidden />}
          {effectiveView === 'compare' && (
            <div className="wipe" onPointerDown={onPointerDown} onPointerMove={(e) => e.buttons && moveWipe(e.clientX)}>
              <div
                className="wipe-handle"
                style={{ left: `${wipe}%` }}
                role="slider"
                tabIndex={0}
                aria-label="Comparison divider: original on the left, result on the right"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(wipe)}
                aria-valuetext={`${Math.round(wipe)}% original`}
                onKeyDown={onHandleKey}
              >
                <span className="wipe-grip" aria-hidden="true" />
              </div>
              <span className="wipe-label wipe-label-left" aria-hidden="true">
                Original
              </span>
              <span className="wipe-label wipe-label-right" aria-hidden="true">
                Result
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="view-switch" role="group" aria-label="What to show">
        {(['original', 'result', 'compare'] as const).map((v) => (
          <button
            key={v}
            type="button"
            className="view-option"
            aria-pressed={effectiveView === v}
            disabled={v !== 'original' && !hasResult}
            onClick={() => onViewChange(v)}
          >
            {v === 'original' ? 'Original' : v === 'result' ? 'Result' : 'Compare'}
          </button>
        ))}
      </div>
    </div>
  );
}
