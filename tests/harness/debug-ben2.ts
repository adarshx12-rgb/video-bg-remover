// Dev-only: runs BEN2 on the main thread, optionally with the ORT shader fix, and
// returns the predicted mask so WebGPU and WASM results can be compared.
import { pipeline, RawImage } from '@huggingface/transformers';
import { BEN2_MODEL } from '../../src/config';
import { installOrtShaderFix } from '../../src/lib/models/ortShaderFix';

export async function debugBen2(device: 'webgpu' | 'wasm', imageUrl: string, withFix = true) {
  const errors: string[] = [];
  const proto = (globalThis as any).GPUDevice?.prototype;
  if (withFix) installOrtShaderFix();
  const { env } = await import('@huggingface/transformers');
  (env.backends.onnx as any).logLevel = 'warning';
  if (proto && !proto.__logged) {
    const original = proto.createShaderModule;
    proto.createShaderModule = function (desc: { code: string; label?: string }) {
      const mod = original.call(this, desc);
      mod.getCompilationInfo().then((info: { messages: { type: string; message: string; lineNum: number }[] }) => {
        for (const m of info.messages) if (m.type === 'error') errors.push(`${desc.label}: ${m.message} @${m.lineNum}`);
      });
      return mod;
    };
    proto.__logged = true;
  }
  const seg = await pipeline('background-removal', BEN2_MODEL.repo, { revision: BEN2_MODEL.revision, dtype: 'fp16', device });
  const image = await RawImage.fromURL(imageUrl);
  let ok = true, message = '', mask: number[] = [];
  const times: number[] = [];
  try {
    for (let i = 0; i < 1; i++) {
      const t0 = performance.now();
      const out = (await seg(image)) as RawImage;
      times.push(performance.now() - t0);
      mask = [];
      for (let p = 3; p < out.data.length; p += 4) mask.push(out.data[p]);
    }
  } catch (e) { ok = false; message = String(e).slice(0, 300); }
  await new Promise((r) => setTimeout(r, 300));
  await seg.dispose();
  return { ok, times: times.map(Math.round), message, errors: errors.slice(0, 5), width: image.width, height: image.height, mask };
}
(window as any).debugBen2 = debugBen2;
