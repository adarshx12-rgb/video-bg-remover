# Testing

All results below come from one machine: **Windows 11, Chrome 153, Intel UHD
(Gen9) integrated GPU, 16 GB RAM**. The browser was driven headlessly by Playwright
using the installed Chrome, and real WebGPU and WebCodecs were used, not software
emulation.

## How to rerun

```bash
npm run make-test-videos      # needs ffmpeg + ffprobe on PATH
npm run build && npm run preview   # or: npm run dev
npm run e2e                   # RVM scenarios (~15 min on the test machine)
E2E_BEN2=1 node tests/e2e/run-e2e.mjs ben2   # BEN2 scenario (slow; downloads 219 MB once)
npm test && npm run typecheck
```

`npm run e2e` drives the real interface: it uploads, chooses options and processes. It
then reads the exact file behind the **Download** link (checking its file name) and
checks it with `scripts/verify-output.mjs`
(ffprobe). Each file is compared with its source: container duration, per-frame
timestamps, frame count, aspect ratio, rotation, audio presence, audio start, and the
audio/video offset.

## Automated results (production build via `astro preview`)

The final run of the whole suite, `E2E_BEN2=1 npm run e2e`, passed 12/12 checks in one go.

| Scenario | Result | Evidence |
| --- | --- | --- |
| Type check (`tsc -b`) and production build (`astro build`) | Pass | |
| Unit tests (sizing, RVM ratio, shader workaround) | Pass (9/9) | `tests/unit` |
| People (RVM): 6 s 1280×720 H.264+AAC → MP4, green background | Pass | 180/180 frames, per-frame timestamps identical (max delta 0.00 ms), duration 6.000 s, AAC copied, audio start 0.000 s |
| RVM: silent 960×540 → WebM, local image background | Pass | No audio track in output, timestamps identical |
| RVM: portrait phone video (stored 1280×720 + 90° rotation) → transparent WebM | Pass | Output 720×1280 upright, no rotation metadata, `alpha_mode=1`, alpha plane decoded with libvpx: 19% transparent, 77% opaque |
| RVM: audio starting 0.48 s after video → MP4 | Pass | Audio start 0.479 s in both, offset delta 0.0 ms |
| RVM: reduced frame rate (10 fps) → MP4 | Pass | 60 frames for 6 s, duration and audio kept |
| Cancel while processing, then Try again | Pass | "Stopped" state, no download offered, no stale updates after 3 s; retry completes |
| Model switching | Pass | Worker count dropped from 1 to 0 when switching (previous model released); People reloads only when used |
| Too-long video (35 s) | Pass | Rejected with "Trim the video to 30 seconds or less" |
| Unsupported codec (MPEG-4 Part 2 in AVI) | Pass | Rejected with a suggestion to re-export as MP4 (H.264) |
| Repeated use (3 full runs, same tab) | Pass | Main-thread JS heap 5 MB → 5 MB → 5 MB after GC; one worker alive |
| No upload of video/audio | Pass | Final full run (RVM + BEN2, 11 scenarios): 142 requests, all GET, none with a body; hosts: `localhost`, `huggingface.co`, `us.aws.cdn.hf.co` (RVM model already cached; `raw.githubusercontent.com` in runs without it) |
| Transparent-export self-test (encode + decode alpha) | Pass | Transparent WebM offered only after the round trip succeeds |

### General subjects (BEN2)

| Scenario | Result | Evidence |
| --- | --- | --- |
| BEN2 on WebGPU through the pipeline harness: 1 s VP9+Opus WebM → MP4 at 5 fps | Pass | 5 frames, duration 1.024 s vs 1.021 s, Opus transcoded to AAC, audio start 0.000 s |
| General subjects (BEN2) through the UI: 1 s VP9+Opus WebM → MP4, black background, 5 fps | Pass | Ran on WebGPU; 5 frames; duration 1.024 s vs 1.021 s; Opus → AAC; audio start 0.000 s; network: only `localhost`, `huggingface.co`, `us.aws.cdn.hf.co`, all GET |
| BEN2 WebGPU mask vs CPU (WASM) mask on the same image | Match | Mean difference 0.32/255; 0.03% of pixels changed foreground/background classification |
| BEN2 automatic CPU fallback when WebGPU fails | Pass | Before the shader workaround, WebGPU failed, the worker restarted on WASM and the UI note was produced |

### Measured speed (this machine only; not a general model comparison)

| Model / backend | Resolution | Time per frame |
| --- | --- | --- |
| RVM, WebGPU | 1280×720 | ~0.49–0.52 s |
| RVM, WebGL | 1280×720 | ~1.43 s |
| BEN2, WebGPU (with shader workaround) | any (model input is 1024×1024) | ~28–39 s |
| BEN2, WASM (CPU, 4 threads) | any | ~47 s |

Decoding, compositing and encoding add under 20 ms per frame.

## Issues found and fixed during testing

- **Race: a late model-download progress event could replace a finished result** (and
  revoke its file URL). Progress updates now only apply while a model is loading.
- **Test-infrastructure flakiness, not an app bug:** Playwright's `download.saveAs()`
  intermittently crashed headless Chrome 153 on this machine, even for a 5-byte blob
  from a plain `<a download>` in a fresh profile. This caused two BEN2 UI failures and
  one regression-run failure; the race fix above was made at the same time, so it can't
  be credited for the BEN2 pass. The suite now reads the bytes behind the Download link
  instead. **Manual check:** click Download in a normal (non-automated) Chrome and
  confirm the file saves (see below).

- **ONNX Runtime WebGPU shader bug** broke BEN2 on this GPU ("cannot assign
  `vec4<f16>` to `vec4<f32>`" in LayerNorm). It was reproduced on 1.31.0-dev and on
  stable 1.30.0, and fixed with a narrow shader rewrite (`ortShaderFix.ts`) that was
  validated against the CPU output.
- **Dev server reload mid-job:** Vite discovered the worker's TensorFlow.js
  dependencies on first use and reloaded the page. Fixed with `optimizeDeps.include`.
- **WASM fallback inside the same worker still used WebGPU** (ONNX Runtime state is
  per worker). The fallback now starts a fresh worker.

## Not verified. Manual checks needed

1. **Other GPUs and browsers.** Only one Intel integrated GPU, in Chrome on Windows, was
   tested. Check on a discrete NVIDIA/AMD GPU, Apple Silicon (Chrome/Edge on macOS),
   Firefox and Safari. Expected: unsupported features are reported in the UI instead of failing.
   - Steps: `npm run dev`, open the app, load `test-media/person-audio.mp4`, select
     **Preview this frame** for each model, then **Remove background** and play the
     download.
2. **BEN2 on GPUs with the WebGPU `subgroups` feature.** ONNX Runtime takes a different
   LayerNorm path there, which was not exercised.
3. **BEN2 tab crashes.** Long BEN2 GPU workloads intermittently crashed the tab on the
   test machine (the Chrome log showed "GPU state invalid", consistent with a Windows GPU
   timeout reset). Check whether this happens on stronger GPUs.
4. **Real phone footage.** The portrait test used ffmpeg-generated rotation metadata.
   Try a real iPhone (HEVC/MOV) and Android clip. HEVC decoding depends on the OS and
   hardware.
5. **Clicking Download in a normal browser window** (the automated suite reads the
   linked file directly; see above). Confirm the file saves with a sensible name and plays.
6. **Audio sync by ear.** The test clips beep once per second. Play
   `test-results/e2e/rvm-person-audio.mp4` in VLC or a browser and confirm the beeps line
   up with the originals. Timestamps were verified numerically, but listening was not.
7. **Downloaded files in other players.** MP4 in QuickTime or Windows Media Player;
   transparent WebM in a video editor (for example DaVinci Resolve or Premiere with WebM
   support) to confirm the alpha channel is imported.
8. **Screen reader pass** (NVDA or VoiceOver) through the whole flow. Keyboard use of the
   comparison divider was checked with a screenshot, not with assistive technology.
9. **Very low memory devices / 30 s at 1280 px.** Only clips up to 6 s were processed.
   Check a full 30 s, 1080p source to confirm the provisional limits are workable.
