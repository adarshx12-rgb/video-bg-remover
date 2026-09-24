import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableVideoCodec,
} from 'mediabunny';
import type { MatteResult } from '../models/types';

/**
 * A "matte pack" records what the model produced so the background can be replaced
 * later without running the model again. Each frame is stored side by side:
 *
 *   [ foreground colours | matte as greyscale ]
 *
 * using an ordinary opaque codec (VP9, else H.264), so it works wherever export works
 * and stays compressed (bounded memory). Timestamps are identical to the export.
 *
 * The pack is padded to multiples of 16 pixels (content at the top-left). Chrome's
 * VP9 decoding returned corrupted (green-tinted) top rows for a 1920×540 pack on the
 * test machine but decoded the same content padded to 1920×544 correctly.
 */
export const packSize = (width: number, height: number) => ({ width: align16(width * 2), height: align16(height) });
const align16 = (n: number) => Math.ceil(n / 16) * 16;

export class MattePackWriter {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly maskLayer: OffscreenCanvas;
  private readonly maskCtx: OffscreenCanvasRenderingContext2D;
  private readonly output: Output<Mp4OutputFormat | WebMOutputFormat, BufferTarget>;
  private readonly source: CanvasSource;
  readonly mimeType: string;

  private constructor(width: number, height: number, codec: 'vp9' | 'avc') {
    const size = packSize(width, height);
    this.canvas = new OffscreenCanvas(size.width, size.height); // opaque: padding stays black
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.maskLayer = new OffscreenCanvas(width, height);
    this.maskCtx = this.maskLayer.getContext('2d')!;
    const isWebm = codec === 'vp9';
    this.mimeType = isWebm ? 'video/webm' : 'video/mp4';
    this.output = new Output({
      format: isWebm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    this.source = new CanvasSource(this.canvas, { codec, quality: QUALITY_HIGH });
    this.output.addVideoTrack(this.source);
  }

  /** Returns null when no suitable encoder exists; the job then runs without recording. */
  static async create(width: number, height: number): Promise<MattePackWriter | null> {
    const codec = await getFirstEncodableVideoCodec(['vp9', 'avc'], packSize(width, height)).catch(() => null);
    if (codec !== 'vp9' && codec !== 'avc') return null;
    const writer = new MattePackWriter(width, height, codec);
    await writer.output.start();
    return writer;
  }

  async add(frame: OffscreenCanvas, matte: MatteResult, timestamp: number, duration: number): Promise<void> {
    const w = this.maskLayer.width;
    const h = this.maskLayer.height;
    const ctx = this.ctx;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(matte.foreground ?? frame, 0, 0, w, h);

    // Matte alpha -> greyscale: white masked by the matte, over black.
    const m = this.maskCtx;
    m.globalCompositeOperation = 'copy';
    m.fillStyle = '#ffffff';
    m.fillRect(0, 0, w, h);
    m.globalCompositeOperation = 'destination-in';
    m.drawImage(matte.mask, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000000';
    ctx.fillRect(w, 0, w, h);
    ctx.drawImage(this.maskLayer, w, 0);

    await this.source.add(timestamp, duration);
  }

  async finish(): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
    this.source.close();
    await this.output.finalize();
    const buffer = this.output.target.buffer;
    if (!buffer) throw new Error('The saved cut-out could not be written.');
    return { buffer, mimeType: this.mimeType };
  }

  async cancel(): Promise<void> {
    await this.output.cancel().catch(() => undefined);
  }
}
