import type { MatteResult } from '../models/types';

export type BackgroundSpec =
  | { kind: 'transparent' }
  | { kind: 'color'; color: string }
  | { kind: 'image'; image: ImageBitmap };

/**
 * Canvas 2D compositor: foreground × matte over a background. The matte is only
 * blurred for the optional (conservative) edge softness; foreground colours are never
 * blurred. No temporal smoothing is applied, so there is no motion ghosting.
 */
export class Compositor {
  readonly output: OffscreenCanvas;
  private readonly layer: OffscreenCanvas;
  private readonly outCtx: OffscreenCanvasRenderingContext2D;
  private readonly layerCtx: OffscreenCanvasRenderingContext2D;
  private background: BackgroundSpec;
  private readonly edgeSoftness: number;

  constructor(width: number, height: number, background: BackgroundSpec, edgeSoftness: number) {
    this.output = new OffscreenCanvas(width, height);
    this.layer = new OffscreenCanvas(width, height);
    this.outCtx = this.output.getContext('2d', { alpha: true })!;
    this.layerCtx = this.layer.getContext('2d', { alpha: true })!;
    this.background = background;
    this.edgeSoftness = edgeSoftness;
  }

  compose(frame: OffscreenCanvas, matte: MatteResult): OffscreenCanvas {
    const { width, height } = this.output;
    const layer = this.layerCtx;
    layer.globalCompositeOperation = 'copy';
    layer.filter = 'none';
    layer.drawImage(matte.foreground ?? frame, 0, 0, width, height);
    layer.globalCompositeOperation = 'destination-in';
    if (this.edgeSoftness > 0) layer.filter = `blur(${this.edgeSoftness}px)`;
    layer.drawImage(matte.mask, 0, 0, width, height);
    layer.filter = 'none';
    layer.globalCompositeOperation = 'source-over';

    const out = this.outCtx;
    out.globalCompositeOperation = 'source-over';
    out.clearRect(0, 0, width, height);
    drawBackground(out, this.background, width, height);
    out.drawImage(this.layer, 0, 0);
    return this.output;
  }

  dispose() {
    if (this.background.kind === 'image') this.background.image.close();
    this.background = { kind: 'transparent' };
  }
}

function drawBackground(ctx: OffscreenCanvasRenderingContext2D, bg: BackgroundSpec, width: number, height: number) {
  if (bg.kind === 'color') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, width, height);
  } else if (bg.kind === 'image') {
    // "cover" fit, centred.
    const scale = Math.max(width / bg.image.width, height / bg.image.height);
    const w = bg.image.width * scale;
    const h = bg.image.height * scale;
    ctx.drawImage(bg.image, (width - w) / 2, (height - h) / 2, w, h);
  }
}
