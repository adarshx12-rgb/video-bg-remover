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

export type ModelId = 'rvm' | 'withoutbg' | 'ben2';

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
    approxDownload: 'about 455 MB',
    licence: 'Apache-2.0, with DINOv3 License terms for its backbone',
    licenceUrl: 'https://withoutbg.com/open-model/license',
    sourceUrl: 'https://github.com/withoutbg/withoutbg-python',
    attribution: 'Built with DINOv3',
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
