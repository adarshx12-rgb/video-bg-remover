import { ALL_FORMATS, BlobSource, CanvasSink, Input, type WrappedCanvas } from 'mediabunny';
import type { ModelId } from '../../config';
import type { MatteResult, MattingAdapter } from './types';
import { primeVp9DecodeWorkaround } from '../video/decoderWorkaround';

/**
 * Replays a matte pack (see compositing/mattePack.ts) instead of running a model, so
 * a new background can be applied quickly. Frames are matched by timestamp; export
 * requests them in presentation order, so a single forward pass through the pack is
 * enough (bounded memory, no seeking).
 */
export class SavedMatteAdapter implements MattingAdapter {
  readonly isTemporal = false;
  readonly backend = 'the saved cut-out, without the AI model';
  readonly backendNote = null;
  stageTimings: Record<string, number> = {};

  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private iterator: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private current: WrappedCanvas | null = null;
  private lookahead: WrappedCanvas | null = null;
  private fgCanvas: OffscreenCanvas | null = null;
  private maskCanvas: OffscreenCanvas | null = null;
  private readCanvas: OffscreenCanvas | null = null;
  private maskImage: ImageData | null = null;

  constructor(
    readonly id: ModelId,
    private readonly pack: Blob,
  ) {}

  async load(): Promise<void> {
    this.input = new Input({ source: new BlobSource(this.pack), formats: ALL_FORMATS });
    const track = await this.input.getPrimaryVideoTrack();
    if (track) await primeVp9DecodeWorkaround(await track.getDecoderConfig());
    if (!track || !(await track.canDecode())) throw new Error('The saved cut-out can’t be read. Select Remove background to process the video again.');
    // Pool of 3: the current frame, the look-ahead frame and one being decoded.
    this.sink = new CanvasSink(track, { poolSize: 3 });
    this.resetState();
  }

  resetState(): void {
    void this.iterator?.return(undefined);
    this.iterator = this.sink ? this.sink.canvases() : null;
    this.current = null;
    this.lookahead = null;
  }

  async process(frame: OffscreenCanvas, timestamp: number): Promise<MatteResult> {
    if (!this.iterator) throw new Error('The saved cut-out is not loaded.');
    const t0 = performance.now();
    if (!this.lookahead && !this.current) this.lookahead = (await this.iterator.next()).value ?? null;
    // Advance to the last pack frame that starts at or before this timestamp.
    while (this.lookahead && this.lookahead.timestamp <= timestamp + 1e-3) {
      this.current = this.lookahead;
      this.lookahead = (await this.iterator.next()).value ?? null;
    }
    const source = this.current ?? this.lookahead;
    if (!source) throw new Error('The saved cut-out ended early. Select Remove background to process the video again.');

    // The pack is padded; the output frame size tells us where each pane's content is.
    const { width, height } = frame;
    this.ensureBuffers(width, height);

    this.fgCanvas!.getContext('2d')!.drawImage(source.canvas, 0, 0, width, height, 0, 0, width, height);
    const read = this.readCanvas!.getContext('2d', { willReadFrequently: true })!;
    read.drawImage(source.canvas, width, 0, width, height, 0, 0, width, height);
    const grey = read.getImageData(0, 0, width, height).data;
    const alpha = this.maskImage!.data;
    for (let i = 3; i < alpha.length; i += 4) alpha[i] = grey[i - 3];
    this.maskCanvas!.getContext('2d')!.putImageData(this.maskImage!, 0, 0);

    this.stageTimings.unpack = (this.stageTimings.unpack ?? 0) + performance.now() - t0;
    return { mask: this.maskCanvas!, foreground: this.fgCanvas! };
  }

  async dispose(): Promise<void> {
    void this.iterator?.return(undefined);
    this.iterator = null;
    this.current = this.lookahead = null;
    this.sink = null;
    this.input?.dispose();
    this.input = null;
    this.fgCanvas = this.maskCanvas = this.readCanvas = null;
    this.maskImage = null;
  }

  private ensureBuffers(width: number, height: number) {
    if (this.fgCanvas?.width === width && this.fgCanvas.height === height) return;
    this.fgCanvas = new OffscreenCanvas(width, height);
    this.maskCanvas = new OffscreenCanvas(width, height);
    this.readCanvas = new OffscreenCanvas(width, height);
    this.maskImage = new ImageData(width, height);
  }
}
