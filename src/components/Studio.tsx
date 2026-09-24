import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MODELS, type ModelId } from '../config';
import { detectCapabilities, FORMAT_OPTIONS, type Capabilities, type OutputFormatId } from '../lib/capabilities';
import { CancelledError, ProcessorClient } from '../lib/processorClient';
import { probeVideo, type VideoMetadata } from '../lib/video/probe';
import { formatBytes, formatDuration } from '../lib/video/sizing';
import type { BackgroundMessage, JobSettings } from '../worker/protocol';
import { BackgroundPicker, ModelPicker, OutputPicker, formatsFor, type BackgroundChoice, type ModelStatus } from './studio/Controls';
import { toFriendlyError, type FriendlyError } from './studio/errors';
import { Stage, type StageView } from './studio/Stage';
import { StatusPanel, formatEta, type JobState } from './studio/StatusPanel';
import './studio/studio.css';

interface LoadedFile {
  file: File;
  url: string;
  meta: VideoMetadata;
}

interface SavedMatte {
  blob: Blob;
  model: ModelId;
  frameRate: number | null;
}

type PreviewState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'ready'; time: number; msPerFrame: number }
  | { status: 'error'; error: FriendlyError };

export default function Studio() {
  const clientRef = useRef<ProcessorClient | null>(null);
  clientRef.current ??= new ProcessorClient();
  const client = clientRef.current;

  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [loaded, setLoaded] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState<FriendlyError | null>(null);
  const [probing, setProbing] = useState(false);

  const [modelId, setModelId] = useState<ModelId>('rvm');
  const [model, setModel] = useState<ModelStatus>({ status: 'idle' });
  const [background, setBackground] = useState<BackgroundChoice>({ kind: 'color', preset: 'white', color: '#ffffff' });
  const [format, setFormat] = useState<OutputFormatId>('mp4');
  const [softness, setSoftness] = useState(0);
  const [frameRate, setFrameRate] = useState<number | null>(null);

  const [job, setJob] = useState<JobState>({ status: 'idle' });
  const [preview, setPreview] = useState<PreviewState>({ status: 'idle' });
  const [resultKind, setResultKind] = useState<'none' | 'canvas' | 'video'>('none');
  /** Cut-out saved by the last full run, so the background can be replaced without the model. */
  const [savedMatte, setSavedMatte] = useState<SavedMatte | null>(null);
  const lastMode = useRef<'full' | 'reapply'>('full');
  const [view, setView] = useState<StageView>('original');

  const originalRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const downloadRef = useRef<HTMLAnchorElement>(null);
  const activeJob = useRef<number | null>(null);
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;

  useEffect(() => {
    let alive = true;
    detectCapabilities().then((c) => alive && setCaps(c));
    client.onWorkerReset = () => setModel({ status: 'idle' });
    return () => {
      alive = false;
      client.unload();
    };
  }, [client]);

  const formats = useMemo(() => (caps ? formatsFor(caps.outputFormats, background) : []), [caps, background]);
  useEffect(() => {
    if (formats.length && !formats.some((f) => f.id === format)) setFormat(formats[0].id);
  }, [formats, format]);

  const settingsKey = JSON.stringify([
    modelId,
    background.kind,
    background.kind === 'color' ? background.color : background.kind === 'image' ? background.thumbUrl : '',
    format,
    softness,
    frameRate,
  ]);
  const doneKey = useRef<string | null>(null);

  // Mark a finished result as stale when settings change afterwards.
  useEffect(() => {
    setJob((j) => (j.status === 'done' && !j.stale && doneKey.current !== settingsKey ? { ...j, stale: true } : j));
  }, [settingsKey]);

  // Warn before leaving while work is in progress.
  const busy = job.status === 'loading-model' || job.status === 'processing' || job.status === 'cancelling' || preview.status === 'working';
  useEffect(() => {
    if (!busy) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [busy]);

  // Revoke object URLs when they are replaced or on unmount.
  useEffect(() => () => void (loaded && URL.revokeObjectURL(loaded.url)), [loaded]);
  const doneUrl = job.status === 'done' ? job.url : null;
  useEffect(() => () => void (doneUrl && URL.revokeObjectURL(doneUrl)), [doneUrl]);
  const thumbUrl = background.kind === 'image' ? background.thumbUrl : null;
  useEffect(() => () => void (thumbUrl && URL.revokeObjectURL(thumbUrl)), [thumbUrl]);

  const drawToCanvas = useCallback((bitmap: ImageBitmap) => {
    const canvas = canvasRef.current;
    if (canvas) {
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    }
    bitmap.close();
  }, []);

  const resetResult = useCallback(() => {
    setJob({ status: 'idle' });
    setPreview({ status: 'idle' });
    setResultKind('none');
    setView('original');
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const stopActive = useCallback(async () => {
    const id = activeJob.current;
    activeJob.current = null;
    if (id !== null) await client.cancel(id);
  }, [client]);

  const openFile = useCallback(
    async (files: FileList) => {
      const file = files[0];
      if (!file) return;
      await stopActive();
      setFileError(null);
      setProbing(true);
      try {
        const meta = await probeVideo(file);
        resetResult();
        setSavedMatte(null);
        setFrameRate(null);
        setLoaded({ file, url: URL.createObjectURL(file), meta });
      } catch (error) {
        setFileError(toFriendlyError(error, 'file'));
      } finally {
        setProbing(false);
      }
    },
    [resetResult, stopActive],
  );

  const chooseAnother = useCallback(async () => {
    await stopActive();
    resetResult();
    setSavedMatte(null);
    setLoaded(null);
    setFileError(null);
  }, [resetResult, stopActive]);

  const changeModel = useCallback(
    (id: ModelId) => {
      if (id === modelIdRef.current) return;
      // Release the previous model (its worker, GPU memory and tensors) right away.
      client.unload();
      setModel({ status: 'idle' });
      setModelId(id);
    },
    [client],
  );

  /** Load the selected model if needed. Returns false if loading failed or was abandoned. */
  const ensureModel = useCallback(async (): Promise<boolean> => {
    const id = modelIdRef.current;
    if (model.status === 'ready' && client.loadedModel === id) return true;
    setModel({ status: 'loading' });
    setJob({ status: 'loading-model', progress: null, modelName: MODELS[id].name });
    try {
      const result = await client.loadModel(id, (progress) => {
        // Only while loading: late progress events must never replace a finished or running job.
        if (modelIdRef.current === id) setJob((j) => (j.status === 'loading-model' ? { ...j, progress } : j));
      });
      if (modelIdRef.current !== id) return false;
      setModel({ status: 'ready', ...result });
      return true;
    } catch (error) {
      if (modelIdRef.current !== id) return false;
      if (error instanceof CancelledError) {
        setModel({ status: 'idle' });
        setJob({ status: 'cancelled' });
        return false;
      }
      setModel({ status: 'error' });
      setJob({ status: 'error', error: toFriendlyError(error, 'model') });
      return false;
    }
  }, [client, model.status]);

  const buildSettings = useCallback(
    async (forPreview: boolean): Promise<JobSettings> => {
      if (!loaded) throw new Error('No video selected.');
      let bg: BackgroundMessage;
      if (background.kind === 'image') bg = { kind: 'image', image: await createImageBitmap(background.file) };
      else if (background.kind === 'color') bg = { kind: 'color', color: background.color };
      else bg = { kind: 'transparent' };
      return {
        format: forPreview ? 'mp4' : format,
        background: bg,
        edgeSoftness: softness,
        frameRate: forPreview ? null : frameRate,
        output: loaded.meta.output,
      };
    },
    [background, format, frameRate, loaded, softness],
  );

  /**
   * 'full' runs the AI model and saves the cut-out; 'reapply' re-composites from the
   * saved cut-out (new background, softness or file type) without running the model.
   */
  const runExport = useCallback(
    async (mode: 'full' | 'reapply') => {
      if (!loaded) return;
      const saved = savedMatte;
      if (mode === 'reapply' && !saved) return;
      lastMode.current = mode;
      await stopActive();
      if (mode === 'full' && !(await ensureModel())) return;
      let settings: JobSettings;
      try {
        settings = await buildSettings(false);
      } catch (error) {
        setJob({ status: 'error', error: toFriendlyError(error, 'process') });
        return;
      }
      const fps = frameRate ?? loaded.meta.frameRate ?? 30;
      const totalFrames = Math.max(1, Math.round(loaded.meta.durationSeconds * fps));
      const key = settingsKey;
      const runModel = modelId;
      setJob({ status: 'processing', mode, phase: 'processing', fraction: 0, framesDone: 0, msPerFrame: 0, totalFrames });
      setPreview({ status: 'idle' });
      originalRef.current?.pause();

      const handlers = {
        onPhase: (phase: 'processing' | 'finalizing') => setJob((j) => (j.status === 'processing' ? { ...j, phase } : j)),
        onProgress: (fraction: number, framesDone: number, msPerFrame: number) =>
          setJob((j) => (j.status === 'processing' ? { ...j, fraction, framesDone, msPerFrame } : j)),
        onPreview: (bitmap: ImageBitmap) => {
          drawToCanvas(bitmap);
          setResultKind((k) => (k === 'none' ? 'canvas' : k));
          setView((v) => (v === 'original' ? 'result' : v));
        },
      };
      const { jobId, result } =
        mode === 'reapply' && saved
          ? client.reapply(loaded.file, saved.blob, saved.model, settings, handlers)
          : client.process(loaded.file, settings, handlers);
      activeJob.current = jobId;
      setResultKind('canvas');
      setView('result');
      try {
        const { blob, stats, matte } = await result;
        if (activeJob.current !== jobId) return;
        activeJob.current = null;
        if (mode === 'full') setSavedMatte(matte ? { blob: matte, model: runModel, frameRate } : null);
        const info = FORMAT_OPTIONS[settings.format];
        const base = loaded.file.name.replace(/.[^.]+$/, '') || 'video';
        doneKey.current = key;
        setJob({
          status: 'done',
          mode,
          url: URL.createObjectURL(blob),
          fileName: `${base}-${info.transparent ? 'transparent' : 'new-background'}.${info.extension}`,
          size: blob.size,
          stats,
          formatLabel: info.label,
          stale: false,
        });
        setResultKind('video');
        setView('result');
        requestAnimationFrame(() => downloadRef.current?.focus());
      } catch (error) {
        if (activeJob.current !== jobId && !(error instanceof CancelledError)) return;
        activeJob.current = null;
        if (error instanceof CancelledError) setJob({ status: 'cancelled' });
        else setJob({ status: 'error', error: toFriendlyError(error, 'process') });
        setResultKind('none');
        setView('original');
      }
    },
    [buildSettings, client, drawToCanvas, ensureModel, frameRate, loaded, modelId, savedMatte, settingsKey, stopActive],
  );
  const start = useCallback(() => runExport('full'), [runExport]);
  const applyNewBackground = useCallback(() => runExport('reapply'), [runExport]);

  const cancel = useCallback(async () => {
    if (job.status === 'loading-model') {
      client.unload();
      setModel({ status: 'idle' });
      setJob({ status: 'cancelled' });
      return;
    }
    const id = activeJob.current;
    if (id === null) return;
    setJob({ status: 'cancelling' });
    activeJob.current = null;
    await client.cancel(id);
    setJob({ status: 'cancelled' });
    setResultKind('none');
    setView('original');
  }, [client, job.status]);

  const previewFrame = useCallback(async () => {
    if (!loaded) return;
    const video = originalRef.current;
    video?.pause();
    const time = video?.currentTime ?? 0;
    if (!(await ensureModel())) return;
    setJob((j) => (j.status === 'loading-model' ? { status: 'idle' } : j));
    setPreview({ status: 'working' });
    const t0 = performance.now();
    try {
      const { jobId, result } = client.previewFrame(loaded.file, await buildSettings(true), time);
      activeJob.current = jobId;
      const { bitmap, frames } = await result;
      if (activeJob.current !== jobId) {
        bitmap.close();
        return;
      }
      activeJob.current = null;
      drawToCanvas(bitmap);
      setResultKind('canvas');
      setView('compare');
      setPreview({ status: 'ready', time, msPerFrame: (performance.now() - t0) / Math.max(1, frames) });
    } catch (error) {
      activeJob.current = null;
      if (error instanceof CancelledError) setPreview({ status: 'idle' });
      else setPreview({ status: 'error', error: toFriendlyError(error, 'preview') });
    }
  }, [buildSettings, client, drawToCanvas, ensureModel, loaded]);

  // ----- Render -----------------------------------------------------------------

  const unsupported = caps && (!caps.webCodecs || !caps.workers || !caps.offscreenCanvas);
  const processing = job.status === 'processing' || job.status === 'cancelling' || job.status === 'loading-model';
  const locked = processing || preview.status === 'working';
  const transparentExportable = !!caps?.outputFormats.some((f) => f.transparent);
  const canStart = !!loaded && !!caps && !unsupported && formats.some((f) => f.id === format) && !locked;
  const meta = loaded?.meta;
  // The saved cut-out stays valid while the model and frame rate are unchanged.
  const canReapply = canStart && !!savedMatte && savedMatte.model === modelId && savedMatte.frameRate === frameRate;
  const staleDone = job.status === 'done' && job.stale;
  const staleNote = !staleDone
    ? undefined
    : canReapply
      ? 'Your cut-out is saved, so the new background, edge softness or file type can be applied without running the AI again.'
      : savedMatte
        ? 'Changing the model or frame rate needs the AI to run again. Select Remove background again.'
        : 'Select Remove background again to apply the new settings.';
  const retry = lastMode.current === 'reapply' && canReapply ? applyNewBackground : start;
  const estimate =
    preview.status === 'ready' && meta
      ? preview.msPerFrame * Math.round(meta.durationSeconds * (frameRate ?? meta.frameRate ?? 30))
      : null;

  return (
    <section className="studio" aria-label="Background remover">
      {unsupported && (
        <div className="banner banner-error" role="alert">
          <p className="banner-title">This browser can’t process video here</p>
          <p>{caps!.notes.join(' ')}</p>
          <p>Open this page in an up-to-date Chrome or Edge on a computer.</p>
        </div>
      )}

      <div className="studio-grid">
        <div className="studio-main">
          <Stage
            aspect={meta ? meta.output.width / meta.output.height : null}
            originalUrl={loaded?.url ?? null}
            originalRef={originalRef}
            canvasRef={canvasRef}
            resultUrl={job.status === 'done' ? job.url : null}
            resultKind={resultKind === 'video' && job.status !== 'done' ? 'none' : resultKind}
            resultLabel={job.status === 'done' ? 'Processed video' : 'Processed frame preview'}
            transparent={background.kind === 'transparent'}
            view={view}
            onViewChange={setView}
            onFiles={openFile}
            busy={locked}
          />

          {probing && (
            <p className="stage-caption" role="status">
              Reading the video…
            </p>
          )}
          {fileError && (
            <div className="banner banner-error" role="alert">
              <p className="banner-title">{fileError.title}</p>
              <p>{fileError.message}</p>
              <p>{fileError.recovery}</p>
            </div>
          )}

          {meta && (
            <div className="file-info">
              <dl className="file-facts">
                <div>
                  <dt>File</dt>
                  <dd className="file-name" title={meta.fileName}>
                    {meta.fileName}
                  </dd>
                </div>
                <div>
                  <dt>Length</dt>
                  <dd>{formatDuration(meta.durationSeconds)}</dd>
                </div>
                <div>
                  <dt>Size</dt>
                  <dd>
                    {meta.width} × {meta.height}
                    {(meta.output.width !== meta.width || meta.output.height !== meta.height) && (
                      <span className="fact-note">
                        {' '}
                        (result {meta.output.width} × {meta.output.height})
                      </span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>File size</dt>
                  <dd>{formatBytes(meta.sizeBytes)}</dd>
                </div>
                <div>
                  <dt>Sound</dt>
                  <dd>{meta.hasAudio ? (meta.audioDecodable ? 'Yes' : 'Yes, but can’t be read') : 'None'}</dd>
                </div>
              </dl>
              <button type="button" className="text-button" onClick={chooseAnother} disabled={job.status === 'cancelling'}>
                Choose another video
              </button>
            </div>
          )}
          {meta?.hasAudio && !meta.audioDecodable && (
            <p className="inline-note">This browser can’t read the video’s sound, so the result will be silent.</p>
          )}
          {preview.status === 'ready' && (
            <p className="stage-caption">
              Showing a preview of the frame at {formatDuration(preview.time)}. Drag the divider to compare.
              {estimate !== null && ` At this speed the whole video takes about ${formatEta(estimate / 1000)}.`}
            </p>
          )}
          {preview.status === 'error' && (
            <div className="banner banner-error" role="alert">
              <p className="banner-title">{preview.error.title}</p>
              <p>{preview.error.message}</p>
              <p>{preview.error.recovery}</p>
            </div>
          )}
        </div>

        <aside className="rail" aria-label="Settings">
          <ModelPicker value={modelId} onChange={changeModel} status={model} disabled={locked} />
          <BackgroundPicker
            value={background}
            onChange={setBackground}
            transparentExportable={transparentExportable}
            disabled={locked}
          />
          <OutputPicker
            formats={formats}
            format={format}
            onFormat={setFormat}
            softness={softness}
            onSoftness={setSoftness}
            frameRate={frameRate}
            onFrameRate={setFrameRate}
            sourceFps={meta?.frameRate ?? null}
            disabled={locked}
          />

          <div className="actions">
            <StatusPanel job={job} staleNote={staleNote} />
            {job.status === 'done' && !job.stale && savedMatte && (
              <p className="inline-hint">
                Want a different background? Choose one above. Your cut-out is saved, so the AI doesn’t need to run again.
              </p>
            )}
            {preview.status === 'working' && (
              <p className="status-detail" role="status">
                Making a preview of this frame…
              </p>
            )}

            {processing ? (
              <button type="button" className="button button-secondary button-large" onClick={cancel} disabled={job.status === 'cancelling'}>
                Cancel
              </button>
            ) : job.status === 'done' && staleDone && canReapply ? (
              <>
                <button type="button" className="button button-primary button-large" onClick={applyNewBackground}>
                  Apply new background
                </button>
                <a ref={downloadRef} className="button button-secondary" href={job.url} download={job.fileName}>
                  Download previous version
                </a>
              </>
            ) : job.status === 'done' ? (
              <a ref={downloadRef} className="button button-primary button-large" href={job.url} download={job.fileName}>
                Download {job.fileName.endsWith('.mp4') ? 'MP4' : 'WebM'}
              </a>
            ) : job.status === 'error' || job.status === 'cancelled' ? (
              <button type="button" className="button button-primary button-large" onClick={retry} disabled={!canStart}>
                Try again
              </button>
            ) : (
              <button type="button" className="button button-primary button-large" onClick={start} disabled={!canStart}>
                Remove background
              </button>
            )}

            {!processing && loaded && (
              <div className="secondary-actions">
                <button type="button" className="button button-secondary" onClick={previewFrame} disabled={locked || !caps || !!unsupported}>
                  Preview this frame
                </button>
                {job.status === 'done' && (
                  <button type="button" className="button button-secondary" onClick={start} disabled={!canStart}>
                    Remove background again
                  </button>
                )}
              </div>
            )}
            {!loaded && <p className="inline-hint">Choose a video to begin.</p>}
            {loaded && formats.length === 0 && background.kind === 'transparent' && (
              <p className="inline-hint">To download, choose a colour or image background.</p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
