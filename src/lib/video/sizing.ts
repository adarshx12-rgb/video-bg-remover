/**
 * Fit (width, height) inside a `max` × `max` box, preserving aspect ratio and never
 * upscaling. Dimensions are rounded to even numbers because H.264/VP9 encoders
 * with 4:2:0 chroma subsampling require them.
 */
export function computeOutputSize(width: number, height: number, max: number): { width: number; height: number } {
  if (!(width > 0 && height > 0)) throw new Error('Video has invalid dimensions.');
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: toEven(width * scale),
    height: toEven(height * scale),
  };
}

function toEven(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * RVM downsample ratio following the official README table (0.375 for 1280×720,
 * 0.25 for 1920×1080, 1 for ≤512 px): an internal long side of about 480 px.
 */
export function rvmDownsampleRatio(width: number, height: number): number {
  const ratio = 480 / Math.max(width, height);
  return Math.min(1, Math.max(0.125, ratio));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'unknown';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)} s`;
}
