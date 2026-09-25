/**
 * Provisional, configurable limits. These are starting points to test against real
 * devices, not performance guarantees.
 */
export const LIMITS = {
  maxDurationSeconds: 30,
  maxInputBytes: 100 * 1024 * 1024,
  /** Output must fit inside this square box. Aspect ratio is kept and video is never upscaled. */
  maxOutputDimension: 1280,
} as const;

export type ModelId = 'rvm' | 'withoutbg' | 'withoutbg-small' | 'ben2';

export interface ModelInfo {
  id: ModelId;
  name: string;
  shortLabel: string;
  description: string;
  approxDownload: string;
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
  /** Extra attribution the licence requires to be shown, if any. */
  attribution?: string;
  /** Set on a smaller-download variant of another model; the picker shows it as an option of that model. */
  variantOf?: ModelId;
}

/**
 * RVM MobileNetV3 TensorFlow.js graph model from the official repository's `tfjs`
 * branch, pinned to a commit so cached files never change underneath us.
 */
export const RVM_MODEL = {
  commit: '72ed518756950796f10eea6eb6b301df97cef277',
  get baseUrl() {
    return `https://raw.githubusercontent.com/PeterL1n/RobustVideoMatting/${this.commit}/model/`;
  },
  files: ['model.json', 'group1-shard1of1.bin'],
  cacheName: 'rvm-tfjs-72ed518',
} as const;

/** Community ONNX conversion of the public BEN2 Base model, pinned to a revision. */
export const BEN2_MODEL = {
  repo: 'onnx-community/BEN2-ONNX',
  revision: 'c552aa82688edce09f0ac9d2e31ad53d9d629010',
  /** The repository only publishes `onnx/model_fp16.onnx`; no other quantizations exist. */
  dtype: 'fp16',
} as const;

/**
 * withoutBG open-weights model (v10, "oss" variant): one fp32 ONNX graph with a fixed
 * 448×448 letterboxed input. Pinned to a revision; the SHA-256 comes from the
 * publisher's sidecar metadata and is checked after download.
 */
export const WITHOUTBG_MODEL = {
  revision: 'cfae4da1ee09b27c45af2af2096d4d14721508ba',
  get url() {
    return `https://huggingface.co/withoutbg/withoutbg-openweights-onnx/resolve/${this.revision}/withoutbg-open-weights.onnx`;
  },
  sha256: '29930e48e9d5ecc56d6486c53c35a4c1470566c2a3359fa180b08c8d3c34ef0f',
  canvasSize: 448,
  inputName: 'rgb',
  outputName: 'alpha',
  cacheName: 'withoutbg-onnx-cfae4da',
} as const;

/**
 * Where the compressed withoutBG files are hosted (Hugging Face, Cloudflare R2 or any
 * CORS-enabled host), as a base URL ending in "/". Set PUBLIC_MODEL_MIRROR at build
 * time; .env.development points it at the local model-files/ folder. When it is empty,
 * the app uses the publisher's full-size file and offers no smaller download.
 */
export const MODEL_MIRROR: string = import.meta.env.PUBLIC_MODEL_MIRROR ?? '';

export interface WithoutbgFile {
  url: string;
  sha256: string;
  cacheName: string;
  approxDownload: string;
}

/**
 * Weight-only compressed copies of the same withoutBG model, made by
 * scripts/model-compression/compress.py (compute stays float32):
 * - fp16 (217 MB): output matched the full model to within 0.01/255 on average.
 * - int8 (110 MB): about 0.05–0.33/255 average difference; at most 0.13% of pixels
 *   changed foreground/background, mostly at ambiguous edges.
 */
export const WITHOUTBG_COMPRESSED = {
  fp16: { file: 'withoutbg-open-weights-fp16w.onnx', sha256: 'ff64a826146600e3fb097f24f1147b031b149d9d6d0cd9ecadac8d9873c2cb65', approxDownload: 'about 217 MB' },
  int8: { file: 'withoutbg-open-weights-int8w.onnx', sha256: '3826c9339a946fff7098723bfc1e2f199de5e041cb90bb0d8c3ea8d002bcc809', approxDownload: 'about 110 MB' },
} as const;

export function withoutbgFile(id: 'withoutbg' | 'withoutbg-small', mirror = MODEL_MIRROR): WithoutbgFile {
  if (!mirror) {
    return { url: WITHOUTBG_MODEL.url, sha256: WITHOUTBG_MODEL.sha256, cacheName: WITHOUTBG_MODEL.cacheName, approxDownload: 'about 455 MB' };
  }
  const variant = id === 'withoutbg-small' ? WITHOUTBG_COMPRESSED.int8 : WITHOUTBG_COMPRESSED.fp16;
  return {
    url: mirror + variant.file,
    sha256: variant.sha256,
    cacheName: `withoutbg-onnx-${variant.sha256.slice(0, 8)}`,
    approxDownload: variant.approxDownload,
  };
}

/**
 * ONNX Runtime Web WASM runtime (used by withoutBG and BEN2), loaded from jsDelivr.
 * The .wasm file is about 25.5 MiB, over Cloudflare's 25 MiB per-file limit, so it
 * cannot be served from this site. jsDelivr sends CORS and CORP headers, so it loads
 * under cross-origin isolation. The version must match the installed onnxruntime-web
 * (pinned in package.json `overrides`); a unit test checks this.
 */
export const ORT_VERSION = '1.30.0';
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const ORT_WASM_PATHS = {
  mjs: `${ORT_CDN}ort-wasm-simd-threaded.asyncify.mjs`,
  wasm: `${ORT_CDN}ort-wasm-simd-threaded.asyncify.wasm`,
} as const;

export const MODELS: Record<ModelId, ModelInfo> = {
  rvm: {
    id: 'rvm',
    name: 'People',
    shortLabel: 'RVM MobileNetV3',
    description:
      'Made for videos of people. It remembers previous frames, which helps keep edges steady as people move.',
    approxDownload: 'about 4 MB',
    licence: 'GPL-3.0',
    licenceUrl: 'https://github.com/PeterL1n/RobustVideoMatting/blob/master/LICENSE',
    sourceUrl: 'https://github.com/PeterL1n/RobustVideoMatting',
  },
  withoutbg: {
    id: 'withoutbg',
    name: 'Any subject',
    shortLabel: 'withoutBG open weights',
    description:
      'For people, animals and objects. Each frame is processed on its own. Hair and fur edges are a little softer than Any subject, fine detail.',
    approxDownload: withoutbgFile('withoutbg').approxDownload,
    licence: 'Apache-2.0, with DINOv3 License terms for its backbone',
    licenceUrl: 'https://withoutbg.com/open-model/license',
    sourceUrl: 'https://github.com/withoutbg/withoutbg-python',
    attribution: 'Built with DINOv3',
  },
  'withoutbg-small': {
    id: 'withoutbg-small',
    name: 'Any subject',
    shortLabel: 'withoutBG open weights, 8-bit',
    description:
      'Same model with its weights stored in 8 bits: half the download. Edges can differ very slightly on some frames.',
    approxDownload: withoutbgFile('withoutbg-small').approxDownload,
    licence: 'Apache-2.0, with DINOv3 License terms for its backbone',
    licenceUrl: 'https://withoutbg.com/open-model/license',
    sourceUrl: 'https://github.com/withoutbg/withoutbg-python',
    attribution: 'Built with DINOv3',
    variantOf: 'withoutbg',
  },
  ben2: {
    id: 'ben2',
    name: 'Any subject, fine detail',
    shortLabel: 'BEN2 Base',
    description:
      'For people, animals and objects, with crisper hair and fur edges. Much slower per frame than Any subject.',
    approxDownload: 'about 220 MB',
    licence: 'MIT',
    licenceUrl: 'https://huggingface.co/PramaLLC/BEN2',
    sourceUrl: 'https://github.com/PramaLLC/BEN2',
  },
};

export const EDGE_SOFTNESS_MAX = 3;
