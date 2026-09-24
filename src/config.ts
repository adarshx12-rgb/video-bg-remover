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

export type ModelId = 'rvm' | 'ben2';

export interface ModelInfo {
  id: ModelId;
  name: string;
  shortLabel: string;
  description: string;
  approxDownload: string;
  licence: string;
  licenceUrl: string;
  sourceUrl: string;
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
  ben2: {
    id: 'ben2',
    name: 'General subjects',
    shortLabel: 'BEN2 Base',
    description:
      'For people, animals and objects. Each frame is processed on its own. A much larger download and usually slower per frame.',
    approxDownload: 'about 220 MB',
    licence: 'MIT',
    licenceUrl: 'https://huggingface.co/PramaLLC/BEN2',
    sourceUrl: 'https://github.com/PramaLLC/BEN2',
  },
};

export const EDGE_SOFTNESS_MAX = 3;
