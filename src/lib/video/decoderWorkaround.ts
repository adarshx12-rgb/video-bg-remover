/**
 * Workaround for corrupted hardware VP9 decoding.
 *
 * On the test machine (Chrome 153, Intel Gen9 GPU) hardware VP9 decoding of a 960×540
 * video returned frames whose top rows were wrong (green-tinted), while software
 * decoding of the same packets was correct. Frames whose coded size is a multiple of
 * 16 decoded correctly with hardware. Mediabunny's Conversion API does not expose the
 * decoder's hardware preference, so `VideoDecoder.configure` is patched in the current
 * (worker) scope: VP9 configs with a coded size that is not a multiple of 16 use
 * `prefer-software`, but only if `primeVp9DecodeWorkaround` confirmed beforehand that
 * the browser supports that config. Every other config passes through unchanged.
 */
const softwareSupported = new Map<string, boolean>();
let installed = false;

export function needsSoftwareDecode(config: Pick<VideoDecoderConfig, 'codec' | 'codedWidth' | 'codedHeight' | 'hardwareAcceleration'>): boolean {
  const w = config.codedWidth ?? 0;
  const h = config.codedHeight ?? 0;
  return /^vp0?9/i.test(config.codec) && w > 0 && h > 0 && (w % 16 !== 0 || h % 16 !== 0) && config.hardwareAcceleration !== 'prefer-hardware';
}

const keyOf = (config: VideoDecoderConfig) => `${config.codec}|${config.codedWidth}x${config.codedHeight}`;

export function installVp9DecodeWorkaround(): void {
  if (installed || typeof VideoDecoder === 'undefined') return;
  installed = true;
  const original = VideoDecoder.prototype.configure;
  VideoDecoder.prototype.configure = function (this: VideoDecoder, config: VideoDecoderConfig) {
    const useSoftware = needsSoftwareDecode(config) && softwareSupported.get(keyOf(config)) === true;
    return original.call(this, useSoftware ? { ...config, hardwareAcceleration: 'prefer-software' } : config);
  };
}

/**
 * configure() is synchronous, so support must be checked before decoding starts.
 * Call this with the track's decoder config before creating decoders for it.
 */
export async function primeVp9DecodeWorkaround(config: VideoDecoderConfig | null): Promise<void> {
  if (!config || !needsSoftwareDecode(config) || softwareSupported.has(keyOf(config))) return;
  try {
    const result = await VideoDecoder.isConfigSupported({ ...config, hardwareAcceleration: 'prefer-software' });
    softwareSupported.set(keyOf(config), result.supported === true);
  } catch {
    softwareSupported.set(keyOf(config), false);
  }
}
