/**
 * Workaround for an ONNX Runtime WebGPU code-generation bug (seen in onnxruntime-web
 * 1.30.0 and 1.31.0-dev) that breaks BEN2-ONNX on GPUs without the `subgroups` feature.
 *
 * BEN2-ONNX's LayerNormalization nodes take fp16 `x` but fp32 `scale`, `bias` and `y`.
 * ORT's generic (non-subgroup) LayerNorm shader writes the f16 input straight into the
 * f32 output and mixes f16/f32 in the final expression, which WGSL rejects:
 *   "cannot assign 'vec4<f16>' to 'vec4<f32>'  y[offset + i] = input_value;"
 *
 * The rewrite only adds the missing f32 conversions; the arithmetic is unchanged and
 * now runs in f32 (as the output type intends). It applies solely to shaders that match
 * this exact mixed-precision pattern and leaves every other shader untouched.
 * BEN2 masks produced with this fix are compared against the CPU backend in tests.
 */
export function fixLayerNormMixedPrecision(code: string): string {
  if (!code.includes('y[offset + i] = input_value;')) return code;
  if (!/alias x_element_t = f16;/.test(code)) return code;
  if (!/var<storage, read_write> y: array<(vec[234]<f32>|f32)>/.test(code)) return code;
  return code
    .replace('y[offset + i] = input_value;', 'y[offset + i] = f32_val_t(input_value);')
    .replaceAll('x_element_t(mean)', 'f32(mean)')
    .replaceAll('x_element_t(inv_std_dev)', 'f32(inv_std_dev)');
}

let installed = false;

/** Patch `GPUDevice.createShaderModule` in the current (worker) global scope. */
export function installOrtShaderFix(): void {
  if (installed) return;
  const proto = (globalThis as { GPUDevice?: { prototype: { createShaderModule(desc: { code: string }): unknown } } }).GPUDevice?.prototype;
  if (!proto) return;
  const original = proto.createShaderModule;
  proto.createShaderModule = function (this: unknown, descriptor: { code: string }) {
    const code = fixLayerNormMixedPrecision(descriptor.code);
    return original.call(this, code === descriptor.code ? descriptor : { ...descriptor, code });
  };
  installed = true;
}
