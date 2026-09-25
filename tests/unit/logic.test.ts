import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { computeOutputSize, rvmDownsampleRatio } from '../../src/lib/video/sizing';
import { fixLayerNormMixedPrecision } from '../../src/lib/models/ortShaderFix';
import { needsSoftwareDecode } from '../../src/lib/video/decoderWorkaround';
import { packSize } from '../../src/lib/compositing/mattePack';
import { ORT_VERSION, ORT_WASM_PATHS } from '../../src/config';

describe('computeOutputSize', () => {
  it('keeps small videos unchanged (never upscales)', () => {
    expect(computeOutputSize(640, 360, 1280)).toEqual({ width: 640, height: 360 });
  });
  it('fits 1080p landscape inside 1280 and keeps aspect ratio', () => {
    expect(computeOutputSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
  });
  it('fits portrait video by its height', () => {
    expect(computeOutputSize(1080, 1920, 1280)).toEqual({ width: 720, height: 1280 });
  });
  it('rounds to even dimensions for 4:2:0 encoders', () => {
    const { width, height } = computeOutputSize(1001, 563, 1280);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
    expect(Math.abs(width / height - 1001 / 563)).toBeLessThan(0.01);
  });
  it('rejects invalid dimensions', () => {
    expect(() => computeOutputSize(0, 100, 1280)).toThrow();
  });
});

describe('rvmDownsampleRatio', () => {
  it('matches the official RVM guidance for common sizes', () => {
    expect(rvmDownsampleRatio(1280, 720)).toBeCloseTo(0.375);
    expect(rvmDownsampleRatio(1920, 1080)).toBeCloseTo(0.25);
    expect(rvmDownsampleRatio(480, 270)).toBe(1);
  });
});

const BROKEN_LAYERNORM = `enable f16;
@group(0) @binding(0) var<storage, read> x: array<vec4<f16>>;
@group(0) @binding(3) var<storage, read_write> y: array<vec4<f32>>;
alias x_value_t = vec4<f16>;
alias x_element_t = f16;
alias f32_val_t = vec4<f32>;
for (var i: u32 = 0; i < stride; i++) {
 let input_value = x[offset + i];
 y[offset + i] = input_value;
}
for (var i: u32 = 0; i < stride; i++) {
 y[offset + i] = (y[offset + i] - x_element_t(mean) ) * x_element_t(inv_std_dev) * scale[offset1d + i] + bias[offset1d + i] ;
};`;

describe('fixLayerNormMixedPrecision', () => {
  it('adds the missing f32 conversions to the mixed-precision LayerNorm shader', () => {
    const fixed = fixLayerNormMixedPrecision(BROKEN_LAYERNORM);
    expect(fixed).toContain('y[offset + i] = f32_val_t(input_value);');
    expect(fixed).toContain('(y[offset + i] - f32(mean) ) * f32(inv_std_dev)');
    expect(fixed).not.toContain('x_element_t(mean)');
  });
  it('leaves same-precision LayerNorm shaders untouched', () => {
    const f16Output = BROKEN_LAYERNORM.replace('array<vec4<f32>>', 'array<vec4<f16>>');
    expect(fixLayerNormMixedPrecision(f16Output)).toBe(f16Output);
  });
  it('leaves unrelated shaders untouched', () => {
    const other = 'enable f16; fn main() { let a = 1.0h; }';
    expect(fixLayerNormMixedPrecision(other)).toBe(other);
  });
});

describe('needsSoftwareDecode', () => {
  it('selects VP9 with a coded size that is not a multiple of 16', () => {
    expect(needsSoftwareDecode({ codec: 'vp09.00.10.08', codedWidth: 960, codedHeight: 540 })).toBe(true);
    expect(needsSoftwareDecode({ codec: 'vp9', codedWidth: 854, codedHeight: 480 })).toBe(true);
  });
  it('leaves aligned VP9 and other codecs alone', () => {
    expect(needsSoftwareDecode({ codec: 'vp09.00.10.08', codedWidth: 1280, codedHeight: 720 })).toBe(false);
    expect(needsSoftwareDecode({ codec: 'avc1.64001f', codedWidth: 960, codedHeight: 540 })).toBe(false);
  });
});

describe('packSize', () => {
  it('pads the side-by-side matte pack to multiples of 16', () => {
    expect(packSize(960, 540)).toEqual({ width: 1920, height: 544 });
    expect(packSize(1280, 720)).toEqual({ width: 2560, height: 720 });
  });
});

describe('ORT_VERSION', () => {
  it('matches the installed onnxruntime-web, so the CDN runtime fits the bundled JS', () => {
    const installed = JSON.parse(readFileSync('node_modules/onnxruntime-web/package.json', 'utf8')).version;
    expect(ORT_VERSION).toBe(installed);
    expect(ORT_WASM_PATHS.wasm).toContain(`onnxruntime-web@${installed}/`);
  });
});
