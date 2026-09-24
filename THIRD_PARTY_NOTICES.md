# Third-party notices

Matte's own source code is released under the **GNU General Public License v3.0**
(`GPL-3.0-only`). That choice follows from its use of the RVM model (below). Every
dependency keeps its own licence; they are **not** all GPL.

## AI models (downloaded at runtime, not bundled)

| Model | Source | Licence | Notes |
| --- | --- | --- | --- |
| Robust Video Matting, MobileNetV3, TensorFlow.js graph model | [PeterL1n/RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting), `tfjs` branch, commit `72ed518756950796f10eea6eb6b301df97cef277` | [GPL-3.0](https://github.com/PeterL1n/RobustVideoMatting/blob/master/LICENSE) | Lin, Yang, Saleemi, Sengupta, *Robust High-Resolution Video Matting with Temporal Guidance*, WACV 2022. |
| BEN2 Base, ONNX conversion (`onnx/model_fp16.onnx`) | [onnx-community/BEN2-ONNX](https://huggingface.co/onnx-community/BEN2-ONNX), revision `c552aa82688edce09f0ac9d2e31ad53d9d629010`, converted from [PramaLLC/BEN2](https://huggingface.co/PramaLLC/BEN2) | MIT (model card metadata and [PramaLLC/BEN2 LICENSE](https://github.com/PramaLLC/BEN2), © 2025 Prama LLC) | This is the public **Base** model. Prama LLC's separate commercial model is not used. |

### GPL-3.0 obligations for RVM (summary, not legal advice)

- Anyone who distributes this app (for example by hosting it) must make the
  **complete corresponding source code** available under GPL-3.0, including any
  modifications, and keep the licence and copyright notices.
- The RVM licence text and attribution must remain available to users (the app's
  "Models and licences" section links to them).
- If you need different licensing terms for RVM, contact its authors; this project
  cannot grant them.

## JavaScript libraries (bundled)

| Package | Version | Licence |
| --- | --- | --- |
| mediabunny | 1.59.1 | MPL-2.0 |
| @huggingface/transformers | 4.3.0 | Apache-2.0 |
| onnxruntime-web (via Transformers.js; WASM files copied to `public/ort`) | 1.30.0 | MIT |
| @tensorflow/tfjs-core, -converter, -backend-webgl, -backend-webgpu | 4.22.0 | Apache-2.0 |
| react, react-dom | 19.3.0 | MIT |
| astro, @astrojs/react | 7.3.5 / 7.0.0 | MIT |
| @fontsource-variable/schibsted-grotesk (Schibsted Grotesk font) | 5.3.0 | SIL Open Font License 1.1 |

Transitive dependencies carry their own licences; run `npx license-checker --production`
(or inspect `node_modules/*/package.json`) for the full list.

## Test media

`npm run make-test-videos` downloads two sample images from the public
[Xenova/transformers.js-docs](https://huggingface.co/datasets/Xenova/transformers.js-docs)
dataset to build local test clips. They are not part of the app.
