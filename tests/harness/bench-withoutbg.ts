// Dev-only evaluation of the withoutBG open-weights ONNX model in the browser, following
// the model card's documented contract: letterbox to 448 (top-left, black), float32 [0,1]
// NCHW input "rgb", output "alpha" [1,1,448,448] -> crop -> resize to original size.
import * as ort from 'onnxruntime-web/webgpu';
import { cachedFetch, openModelCache } from '../../src/lib/models/cachedFetch';
import { ORT_WASM_PATHS } from '../../src/config';

const REVISION = 'cfae4da1ee09b27c45af2af2096d4d14721508ba';
const MODEL_URL = `https://huggingface.co/withoutbg/withoutbg-openweights-onnx/resolve/${REVISION}/withoutbg-open-weights.onnx`;
const CANVAS = 448;

ort.env.wasm.wasmPaths = { ...ORT_WASM_PATHS };
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let session: ort.InferenceSession | null = null;

async function load(device: 'webgpu' | 'wasm') {
  const cache = await openModelCache('withoutbg-eval-cfae4da', 'withoutbg-eval-');
  const t0 = performance.now();
  const bytes = await cachedFetch(MODEL_URL, cache, () => undefined);
  const downloadMs = performance.now() - t0;
  const t1 = performance.now();
  session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: [device], graphOptimizationLevel: 'all' });
  return { downloadMs: Math.round(downloadMs), sessionMs: Math.round(performance.now() - t1), inputs: session.inputNames, outputs: session.outputNames };
}

/** Returns the alpha matte (0..255) at the source image size, plus timings. */
async function matte(source: CanvasImageSource & { width: number; height: number }) {
  if (!session) throw new Error('not loaded');
  const { width, height } = source;
  const t0 = performance.now();
  const scale = CANVAS / Math.max(width, height);
  const newW = Math.max(1, Math.round(width * scale));
  const newH = Math.max(1, Math.round(height * scale));
  const box = new OffscreenCanvas(CANVAS, CANVAS);
  const bctx = box.getContext('2d', { willReadFrequently: true })!;
  bctx.fillStyle = '#000';
  bctx.fillRect(0, 0, CANVAS, CANVAS);
  bctx.drawImage(source, 0, 0, newW, newH);
  const px = bctx.getImageData(0, 0, CANVAS, CANVAS).data;
  const plane = CANVAS * CANVAS;
  const input = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    input[i] = px[i * 4] / 255;
    input[plane + i] = px[i * 4 + 1] / 255;
    input[2 * plane + i] = px[i * 4 + 2] / 255;
  }
  const t1 = performance.now();
  const out = await session.run({ rgb: new ort.Tensor('float32', input, [1, 3, CANVAS, CANVAS]) });
  const alpha448 = (await out.alpha.getData()) as Float32Array;
  out.alpha.dispose();
  const t2 = performance.now();
  // Crop the letterboxed region and scale back up with the GPU canvas (bilinear).
  const small = new OffscreenCanvas(newW, newH);
  const img = new ImageData(newW, newH);
  for (let y = 0; y < newH; y++) for (let x = 0; x < newW; x++) {
    const v = Math.max(0, Math.min(255, alpha448[y * CANVAS + x] * 255));
    const o = (y * newW + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
    img.data[o + 3] = v;
  }
  small.getContext('2d')!.putImageData(img, 0, 0);
  const full = new OffscreenCanvas(width, height);
  const fctx = full.getContext('2d', { willReadFrequently: true })!;
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(small, 0, 0, width, height);
  const fullData = fctx.getImageData(0, 0, width, height).data;
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = fullData[i * 4 + 3];
  return { alpha, width, height, preMs: t1 - t0, inferMs: t2 - t1, postMs: performance.now() - t2 };
}

export async function evalWithoutbg(device: 'webgpu' | 'wasm', imageUrl: string, runs = 3) {
  const loadInfo = session ? null : await load(device);
  const bitmap = await createImageBitmap(await (await fetch(imageUrl)).blob());
  const times: { pre: number; infer: number; post: number }[] = [];
  let last: Awaited<ReturnType<typeof matte>> | null = null;
  for (let i = 0; i < runs; i++) {
    last = await matte(bitmap);
    times.push({ pre: Math.round(last.preMs), infer: Math.round(last.inferMs), post: Math.round(last.postMs) });
  }
  return { loadInfo, times, width: last!.width, height: last!.height, mask: Array.from(last!.alpha) };
}

/** Matte N consecutive video frames (read by the page from a <video>), for speed and flicker. */
export async function evalWithoutbgVideo(device: 'webgpu' | 'wasm', videoUrl: string, frames = 30, width = 1280) {
  if (!session) await load(device);
  const video = document.createElement('video');
  video.muted = true;
  video.src = videoUrl;
  await video.play();
  video.pause();
  const height = Math.round((video.videoHeight / video.videoWidth) * width);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  let prev: Uint8Array | null = null;
  let flicker = 0;
  const inferMs: number[] = [];
  for (let f = 0; f < frames; f++) {
    video.currentTime = f / 30;
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
    ctx.drawImage(video, 0, 0, width, height);
    const m = await matte(canvas);
    inferMs.push(m.inferMs + m.preMs + m.postMs);
    if (prev) {
      let d = 0;
      for (let i = 0; i < m.alpha.length; i++) d += Math.abs(m.alpha[i] - prev[i]);
      flicker += d / m.alpha.length;
    }
    prev = m.alpha;
  }
  inferMs.sort((a, b) => a - b);
  return { medianMsPerFrame: Math.round(inferMs[Math.floor(inferMs.length / 2)]), meanAbsAlphaChangePerFrame: flicker / (frames - 1) };
}

(window as unknown as { evalWithoutbg: typeof evalWithoutbg; evalWithoutbgVideo: typeof evalWithoutbgVideo }).evalWithoutbg = evalWithoutbg;
(window as unknown as { evalWithoutbgVideo: typeof evalWithoutbgVideo }).evalWithoutbgVideo = evalWithoutbgVideo;
