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

/**
 * Workaround for H.264 files whose avcC header disagrees with their SPS.
 *
 * Some encoders (seen in a Telegram export) write an invalid level into the avcC
 * header, for example 4 instead of 40 (level 4.0), while the SPS inside it is correct.
 * Mediabunny builds the codec string from the header ("avc1.640004"), and Chrome
 * rejects that string as unsupported although it decodes the stream fine. The SPS is
 * what the decoder actually uses, so the codec string is rebuilt from it.
 */
export function avcCodecFromDescription(codec: string, description: AllowSharedBufferSource | undefined): string {
  const prefix = /^(avc[13])\./.exec(codec)?.[1];
  if (!prefix || !description) return codec;
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  // avcC: version(1) profile compat level lengthSize numSps, spsLength(2), then the SPS NAL.
  if (bytes.length < 12 || bytes[0] !== 1 || (bytes[5] & 0x1f) < 1) return codec;
  const spsLength = (bytes[6] << 8) | bytes[7];
  if (spsLength < 4 || bytes.length < 8 + spsLength || (bytes[8] & 0x1f) !== 7) return codec;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `${prefix}.${hex(bytes[9])}${hex(bytes[10])}${hex(bytes[11])}`;
}

function fixAvcConfig<T extends VideoDecoderConfig>(config: T): T {
  const codec = avcCodecFromDescription(config.codec, config.description);
  return codec === config.codec ? config : { ...config, codec };
}

let avcFixInstalled = false;

/** Patches VideoDecoder in the current scope (window or worker). Safe to call more than once. */
export function installAvcCodecFix(): void {
  if (avcFixInstalled || typeof VideoDecoder === 'undefined') return;
  avcFixInstalled = true;
  const isConfigSupported = VideoDecoder.isConfigSupported.bind(VideoDecoder);
  VideoDecoder.isConfigSupported = (config: VideoDecoderConfig) => isConfigSupported(fixAvcConfig(config));
  const configure = VideoDecoder.prototype.configure;
  VideoDecoder.prototype.configure = function (this: VideoDecoder, config: VideoDecoderConfig) {
    return configure.call(this, fixAvcConfig(config));
  };
}
