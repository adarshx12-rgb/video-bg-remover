// Dev-only RVM micro-benchmark (main thread) to choose resolution / downsample settings.
import * as tf from '@tensorflow/tfjs-core';
import '@tensorflow/tfjs-backend-webgpu';
import '@tensorflow/tfjs-backend-webgl';
import { loadGraphModel } from '@tensorflow/tfjs-converter';
import { RVM_MODEL } from '../../src/config';

export async function benchRvm(backend: string, configs: { w: number; h: number; ratio: number; readFgr: boolean }[], iters = 8) {
  await tf.setBackend(backend);
  await tf.ready();
  const model = await loadGraphModel(RVM_MODEL.baseUrl + 'model.json');
  const results = [];
  for (const c of configs) {
    let state: tf.Tensor[] = [tf.scalar(0), tf.scalar(0), tf.scalar(0), tf.scalar(0)];
    const ratio = tf.scalar(c.ratio);
    const src = tf.randomUniform([1, c.h, c.w, 3]);
    const times: number[] = [];
    for (let i = 0; i < iters + 2; i++) {
      const t0 = performance.now();
      const [fgr, pha, ...next] = (await model.executeAsync(
        { src, r1i: state[0], r2i: state[1], r3i: state[2], r4i: state[3], downsample_ratio: ratio },
        ['fgr', 'pha', 'r1o', 'r2o', 'r3o', 'r4o'],
      )) as tf.Tensor[];
      if (c.readFgr) await fgr.data();
      await pha.data();
      tf.dispose([fgr, pha, ...state]);
      state = next;
      if (i >= 2) times.push(performance.now() - t0);
    }
    tf.dispose([...state, ratio, src]);
    times.sort((a, b) => a - b);
    results.push({ ...c, medianMs: Math.round(times[Math.floor(times.length / 2)]) });
  }
  model.dispose();
  return results;
}

(window as unknown as { benchRvm: typeof benchRvm }).benchRvm = benchRvm;
