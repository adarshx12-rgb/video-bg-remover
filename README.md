# Matte: video background remover (runs in your browser)

Matte removes or replaces the background of a short video. Everything happens **inside
your browser**: the video and its sound are never uploaded, there is no server-side
AI, and no paid inference API. The only downloads are the AI model files, fetched the
first time you use a model and then kept by your browser.

It offers two models:

| Choice in the app | Model | Good for | Download |
| --- | --- | --- | --- |
| **People** | [Robust Video Matting](https://github.com/PeterL1n/RobustVideoMatting) MobileNetV3 (official TensorFlow.js model) | Videos of people. Uses previous frames (recurrent state) for steadier edges. | ~4 MB |
| **General subjects** | [BEN2 Base](https://github.com/PramaLLC/BEN2) via [onnx-community/BEN2-ONNX](https://huggingface.co/onnx-community/BEN2-ONNX) and Transformers.js | People, animals, objects. Each frame on its own. Not guaranteed to work for every subject. | ~220 MB |

## Quick start

You need [Node.js](https://nodejs.org/) 20 or newer (tested with Node 24) and an
up-to-date **Chrome or Edge** on a computer.

```bash
npm install
npm run dev
```

Open <http://localhost:4321> and choose a video.

Other commands:

| Command | What it does |
| --- | --- |
| `npm run build` | Type-checks and builds the static site into `dist/` |
| `npm run preview` | Serves the built site locally (with the required headers) |
| `npm test` | Unit tests (sizing rules, shader workaround) |
| `npm run typecheck` | TypeScript check only |
| `npm run make-test-videos` | Creates test clips in `test-media/` (needs `ffmpeg` on PATH) |
| `npm run e2e` | Drives the real UI in your local Chrome and checks every downloaded file with `ffprobe` (needs `npm run dev` running, test videos, ffmpeg) |

> **Headers.** The app sends `Cross-Origin-Opener-Policy: same-origin` and
> `Cross-Origin-Embedder-Policy: credentialless` (see `astro.config.mjs`). They make
> multi-threaded WebAssembly possible. `npm run dev` and `npm run preview` already send
> them; any other server you use must send them too.

## How to use it

1. Drop a video on the dark area, or select **Choose a video** (MP4, MOV or WebM).
2. Pick **People** or **General subjects**.
3. Pick a background: white, black, green, any colour, an image from your computer, or
   **None** (transparent).
4. Optionally select **Preview this frame** to check the result, and the estimated time,
   before processing the whole video. Drag the divider to compare.
5. Select **Remove background**, then **Download**.

## Features

- Drag and drop or file picker, with duration, size, dimensions and sound shown.
- Original / Result / Compare (draggable before/after divider, keyboard accessible).
- White, black, green, custom colour and image backgrounds; checkerboard transparency preview.
- Start, cancel, try again, download, choose another video.
- Real progress: model download bytes, frames processed, time left; separate states for
  downloading the model, preparing it, processing, finishing the file, done and errors.
- Clear error messages with a next step (too long, too big, unsupported codec, download
  failure, out of memory, GPU failure).
- Optional lower frame rate (24/15/10/5 fps) that keeps the full duration and sound.
- Conservative edge softness (0–3 px blur of the matte only; no temporal smoothing, so no
  motion ghosting).
- Responsive layout, light and dark mode, visible focus, reduced-motion support.

### Download formats

Formats are offered only if this browser can actually produce them (checked at runtime):

| Format | When offered | Sound |
| --- | --- | --- |
| **MP4 (H.264)** | Browser can encode H.264 | Original AAC copied unchanged; other codecs converted to AAC |
| **WebM (VP9)** | Browser can encode VP9 | Original Opus copied; others converted to Opus |
| **Transparent WebM (VP9 + alpha)** | Only if a start-up self-test encodes a half-transparent frame, decodes it again and finds the alpha intact | Opus |

MP4 is never labelled transparent. The checkerboard is only a preview and is never saved
into the file.

## Limits (provisional, configurable)

Set in `src/config.ts`:

- Maximum **30 seconds** and **100 MB** per video.
- Output fits within **1280 × 1280**, keeps the aspect ratio and is never enlarged
  (dimensions rounded down to even numbers, as video encoders require).

These are starting points to test, not performance promises.

## How it works

```
File ─► Mediabunny demux + WebCodecs decode (timestamped frames, rotation baked in)
     ─► Web Worker: model adapter (RVM or BEN2) ─► matte
     ─► Canvas compositor (foreground × matte over background)
     ─► WebCodecs encode ─► Mediabunny mux (+ audio copied or re-encoded) ─► Blob ─► download
```

- **Timestamp-driven export.** Every decoded frame keeps its original timestamp and
  duration. Slow inference only slows the job down (backpressure); it cannot drop frames
  or shift the audio. No screen recording or `requestAnimationFrame` capture.
- **One worker per model.** Only the selected model's runtime is loaded (TensorFlow.js
  for RVM, ONNX Runtime Web for BEN2, via dynamic imports). Switching models terminates
  the worker, which releases its GPU, WASM and tensor memory. The app never switches
  model on its own.
- **RVM recurrent state** is reset for every new video, restart and preview (preview
  runs the preceding 0.5 s to warm it up). Frames are always fed in order.
- **Bounded memory.** Frames are processed one at a time; no frame list is kept.
  VideoFrames, tensors, ImageBitmaps and object URLs are closed or revoked after use.
  Cancelling stops the conversion; late messages from a cancelled job are ignored, and
  if the worker doesn't confirm within 4 s it is terminated.
- **Backends.** RVM tries WebGPU, then WebGL, using a real warm-up inference to confirm
  the backend works. BEN2 uses WebGPU when the GPU supports `shader-f16` (the only
  published weights are fp16). Otherwise, or if WebGPU fails its warm-up, it restarts on
  WebAssembly (CPU), and the app says so, because it is much slower.

### Source layout

| Path | Responsibility |
| --- | --- |
| `src/config.ts` | Limits, pinned model versions, model descriptions |
| `src/lib/capabilities.ts` | Browser capability detection, format checks, alpha self-test |
| `src/lib/video/probe.ts`, `sizing.ts` | Metadata, validation, output size |
| `src/lib/models/` | `MattingAdapter` interface, RVM and BEN2 adapters, cached downloads, ONNX Runtime shader workaround |
| `src/lib/compositing/compositor.ts` | Matte + background compositing |
| `src/lib/pipeline.ts` | Decode → matte → composite → encode → mux, frame preview |
| `src/worker/` | Worker entry point and message protocol |
| `src/lib/processorClient.ts` | Main-thread worker owner (jobs, cancel, model switching, GPU fallback) |
| `src/components/` | React UI (Astro island) |
| `src/pages/index.astro` | Page shell and static content |
| `tests/` | Unit tests, e2e UI tests, dev-only pipeline harness |

## Model downloads and caching

| Model | Files | Downloaded from | Cached in |
| --- | --- | --- | --- |
| RVM | `model.json`, `group1-shard1of1.bin` (~4.4 MB) | `raw.githubusercontent.com`, pinned to commit `72ed518` | Cache API, cache `rvm-tfjs-72ed518` (older versions removed automatically) |
| BEN2 | `config.json`, `preprocessor_config.json`, `onnx/model_fp16.onnx` (~219 MB) | `huggingface.co`, pinned to revision `c552aa8` | Cache API, Transformers.js cache `transformers-cache` |

- Downloads start only when you first preview or process with that model.
- The progress bar shows real byte counts when the server reports sizes, and an
  indeterminate bar otherwise.
- If caching is unavailable (for example in some private windows, or storage is full),
  the model still loads but will be downloaded again next time.
- The ONNX Runtime WebAssembly files are served by this app from `public/ort/` (copied from
  `node_modules` by `npm run prepare-assets`), not from a third-party CDN.
- To clear cached models: browser settings → site data for `localhost` → clear.

## Licences

- **This app's source code: GPL-3.0-only**, because it uses the GPL-3.0 RVM model. If
  you distribute it (for example by hosting it), you must provide the complete source,
  including your changes, under GPL-3.0, and keep the licence notices.
- **RVM model:** GPL-3.0, © its authors (Lin, Yang, Saleemi, Sengupta), from the official repository.
- **BEN2 Base / BEN2-ONNX:** MIT, © 2025 Prama LLC. This is the public Base model, not
  Prama's commercial model.
- Libraries keep their own licences (Apache-2.0, MIT, MPL-2.0, OFL-1.1); not everything
  is GPL. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Known limitations

- **Speed depends heavily on the GPU.** Measured on the development machine (Intel UHD
  Gen9 integrated GPU, Chrome 153, Windows 11):
  - People (RVM), 1280×720, WebGPU: about **0.5 s per frame**; WebGL: about 1.4 s per frame.
  - General subjects (BEN2), WebGPU: about **30–40 s per frame**; WebAssembly: about 47 s
    per frame. A 30-second video at 30 fps would take hours. Use a lower frame rate and
    short clips, or the People model.

  These numbers come from one machine. They are not a general comparison of the models.
- **BEN2 can crash the tab on weak integrated GPUs.** On the test machine, long BEN2 GPU
  workloads occasionally crashed the browser tab (the driver resets GPUs that stay busy
  too long). A page cannot recover from this; reload and use a lower frame rate or the
  People model.
- **ONNX Runtime workaround.** ONNX Runtime Web 1.30.0 / 1.31.0-dev generates an
  invalid WebGPU shader for BEN2-ONNX's mixed-precision LayerNorm on GPUs without
  the WebGPU `subgroups` feature. `src/lib/models/ortShaderFix.ts` adds the missing type
  conversions to that one shader pattern only. Its output was checked against the CPU
  backend (mean mask difference 0.3/255; 0.03% of pixels changed foreground/background
  classification). The project pins `onnxruntime-web` to 1.30.0 through `overrides`.
- Browser support: built for current Chrome and Edge on desktop. Firefox and Safari may
  lack WebCodecs encoders, WebGPU or `OffscreenCanvas` features; the app detects this and
  explains it, but those browsers were not tested.
- Transparent WebM plays with transparency in Chrome, Edge and Firefox, but not in Safari or most phone galleries.
- Variable-frame-rate input keeps its exact timestamps. Choosing a lower frame rate
  produces constant-rate output.
- `dist/` is about 55 MB: the ONNX Runtime WASM file (26 MB) appears twice, in `ort/`
  (used) and as an unused fallback copy that Vite bundles into `_astro/`. Browsers only
  download the one they need, and only when BEN2 is used.
- Subtitle and extra tracks are dropped; only the main video and audio tracks are kept.
- No temporal smoothing is applied, so a mask may flicker on hard frames (BEN2
  especially, since it processes frames independently).

## Tests

See [TESTING.md](TESTING.md) for what was verified automatically, the measured results,
and the manual checks that remain.
