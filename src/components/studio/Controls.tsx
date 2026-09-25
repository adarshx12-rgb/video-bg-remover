import { Fragment, useRef } from 'react';
import { EDGE_SOFTNESS_MAX, MODEL_MIRROR, MODELS, type ModelId } from '../../config';
import { FORMAT_OPTIONS, type OutputFormatId, type OutputFormatOption } from '../../lib/capabilities';

export type BackgroundChoice =
  | { kind: 'color'; preset: 'white' | 'black' | 'green' | 'custom'; color: string }
  | { kind: 'image'; file: File; thumbUrl: string }
  | { kind: 'transparent' };

export type ModelStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; backend: string; backendNote: string | null }
  | { status: 'error' };

const PRESETS = [
  { preset: 'white', color: '#ffffff', label: 'White' },
  { preset: 'black', color: '#000000', label: 'Black' },
  { preset: 'green', color: '#00b140', label: 'Green' },
] as const;

export function ModelPicker(props: {
  value: ModelId;
  onChange(id: ModelId): void;
  status: ModelStatus;
  disabled: boolean;
  slowConnection: boolean;
}) {
  const { value, onChange, status, disabled, slowConnection } = props;
  const selectedBase = MODELS[value].variantOf ?? value;
  return (
    <fieldset className="step" disabled={disabled}>
      <legend className="step-title">
        <span className="step-number" aria-hidden="true">1</span>
        What is in your video?
      </legend>
      <div className="model-options">
        {(Object.keys(MODELS) as ModelId[])
          .filter((id) => !MODELS[id].variantOf)
          .map((id) => {
            const selected = selectedBase === id;
            // Show the file that will actually be downloaded: the smaller variant when it is chosen.
            const model = selected ? MODELS[value] : MODELS[id];
            const small = smallVariantOf(id);
            return (
              <Fragment key={id}>
                <label className={`model-option${selected ? ' is-selected' : ''}`}>
                  <input type="radio" name="model" value={id} checked={selected} onChange={() => onChange(small && value === small ? small : id)} />
                  <span className="model-name">{MODELS[id].name}</span>
                  <span className="model-description">{MODELS[id].description}</span>
                  <span className="model-meta">
                    {model.shortLabel}, {model.approxDownload} download
                    {model.attribution && <>. {model.attribution}</>}
                  </span>
                  {selected && status.status === 'ready' && (
                    <span className="model-ready">Ready, running on {status.backend}</span>
                  )}
                </label>
                {selected && small && (
                  <label className="model-variant">
                    <input type="checkbox" checked={value === small} onChange={(e) => onChange(e.target.checked ? small : id)} />
                    <span>
                      Smaller download ({MODELS[small].approxDownload.replace('about ', '')} instead of{' '}
                      {MODELS[id].approxDownload.replace('about ', '')}). Edges can differ very slightly.
                    </span>
                  </label>
                )}
              </Fragment>
            );
          })}
      </div>
      {slowConnection && selectedBase !== 'rvm' && (
        <p className="inline-note">
          Your connection looks slow. This model is a large one-time download ({MODELS[value].approxDownload}). For videos
          of people, {MODELS.rvm.name} needs only {MODELS.rvm.approxDownload.replace('about ', '')}.
        </p>
      )}
      {status.status === 'ready' && status.backendNote && <p className="inline-note">{status.backendNote}</p>}
    </fieldset>
  );
}

/** The smaller-download variant of a model, if one exists and its files are hosted. */
export function smallVariantOf(id: ModelId): ModelId | null {
  if (!MODEL_MIRROR) return null;
  return (Object.keys(MODELS) as ModelId[]).find((v) => MODELS[v].variantOf === id) ?? null;
}

export function BackgroundPicker(props: {
  value: BackgroundChoice;
  onChange(choice: BackgroundChoice): void;
  transparentExportable: boolean;
  disabled: boolean;
}) {
  const { value, onChange, transparentExportable, disabled } = props;
  const imageInput = useRef<HTMLInputElement>(null);
  const customColor = value.kind === 'color' && value.preset === 'custom' ? value.color : '#6d7fa3';

  return (
    <fieldset className="step" disabled={disabled}>
      <legend className="step-title">
        <span className="step-number" aria-hidden="true">2</span>
        New background
      </legend>
      <div className="swatches">
        {PRESETS.map((p) => (
          <label key={p.preset} className="swatch">
            <input
              type="radio"
              name="background"
              checked={value.kind === 'color' && value.preset === p.preset}
              onChange={() => onChange({ kind: 'color', preset: p.preset, color: p.color })}
            />
            <span className="swatch-chip" style={{ background: p.color }} aria-hidden="true" />
            <span className="swatch-label">{p.label}</span>
          </label>
        ))}
        <label className="swatch">
          <input
            type="radio"
            name="background"
            checked={value.kind === 'color' && value.preset === 'custom'}
            onChange={() => onChange({ kind: 'color', preset: 'custom', color: customColor })}
          />
          <span className="swatch-chip swatch-chip-custom" style={{ background: customColor }} aria-hidden="true" />
          <span className="swatch-label">Colour</span>
        </label>
        <label className="swatch">
          <input
            type="radio"
            name="background"
            checked={value.kind === 'image'}
            onChange={() => {
              if (value.kind !== 'image') imageInput.current?.click();
            }}
          />
          <span
            className="swatch-chip swatch-chip-image"
            style={value.kind === 'image' ? { backgroundImage: `url(${value.thumbUrl})` } : undefined}
            aria-hidden="true"
          />
          <span className="swatch-label">Image</span>
        </label>
        <label className="swatch">
          <input type="radio" name="background" checked={value.kind === 'transparent'} onChange={() => onChange({ kind: 'transparent' })} />
          <span className="swatch-chip checker" aria-hidden="true" />
          <span className="swatch-label">None</span>
        </label>
      </div>

      {value.kind === 'color' && value.preset === 'custom' && (
        <label className="field-row">
          <span>Pick a colour</span>
          <input
            type="color"
            value={value.color}
            onChange={(e) => onChange({ kind: 'color', preset: 'custom', color: e.target.value })}
          />
        </label>
      )}
      {value.kind === 'image' && (
        <p className="inline-hint">
          {value.file.name}.{' '}
          <button type="button" className="text-button" onClick={() => imageInput.current?.click()}>
            Choose a different image
          </button>
        </p>
      )}
      {value.kind === 'transparent' && (
        <p className="inline-hint">
          {transparentExportable
            ? 'The download keeps real transparency (WebM). The checkerboard only shows where it is see-through; it is not saved.'
            : 'This browser can show transparency here but cannot save a transparent video. Pick a colour or image to download.'}
        </p>
      )}
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onChange({ kind: 'image', file, thumbUrl: URL.createObjectURL(file) });
        }}
      />
    </fieldset>
  );
}

export function OutputPicker(props: {
  formats: OutputFormatOption[];
  format: OutputFormatId;
  onFormat(id: OutputFormatId): void;
  softness: number;
  onSoftness(value: number): void;
  frameRate: number | null;
  onFrameRate(value: number | null): void;
  sourceFps: number | null;
  disabled: boolean;
}) {
  const { formats, format, onFormat, softness, onSoftness, frameRate, onFrameRate, sourceFps, disabled } = props;
  const fpsChoices = [24, 15, 10, 5].filter((f) => !sourceFps || f < sourceFps - 0.5);

  return (
    <fieldset className="step" disabled={disabled}>
      <legend className="step-title">
        <span className="step-number" aria-hidden="true">3</span>
        Download settings
      </legend>

      <div className="field">
        <span className="field-label" id="format-label">
          File type
        </span>
        <div className="format-options" role="radiogroup" aria-labelledby="format-label">
          {formats.map((f) => (
            <label key={f.id} className="format-option">
              <input type="radio" name="format" checked={format === f.id} onChange={() => onFormat(f.id)} />
              <span>
                <span className="format-name">{f.label}</span>
                <span className="format-description">{f.description}</span>
              </span>
            </label>
          ))}
          {formats.length === 0 && <p className="inline-hint">No compatible download format is available for this background.</p>}
        </div>
      </div>

      <label className="field">
        <span className="field-label">Frame rate</span>
        <select value={frameRate ?? ''} onChange={(e) => onFrameRate(e.target.value ? Number(e.target.value) : null)}>
          <option value="">Same as original{sourceFps ? ` (${Math.round(sourceFps)} fps)` : ''}</option>
          {fpsChoices.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
        <span className="field-help">Fewer frames finish sooner. The video keeps its full length and sound.</span>
      </label>

      <label className="field">
        <span className="field-label">
          Edge softness <output className="field-value">{softness === 0 ? 'Off' : `${softness} px`}</output>
        </span>
        <input
          type="range"
          min={0}
          max={EDGE_SOFTNESS_MAX}
          step={0.5}
          value={softness}
          onChange={(e) => onSoftness(Number(e.target.value))}
        />
        <span className="field-help">Slightly softens the cut-out edge. Keep it low; it can’t fix a wrong outline.</span>
      </label>
    </fieldset>
  );
}

export function formatsFor(all: OutputFormatOption[], background: BackgroundChoice): OutputFormatOption[] {
  const wantTransparent = background.kind === 'transparent';
  return all.filter((f) => f.transparent === wantTransparent);
}

export { FORMAT_OPTIONS };
