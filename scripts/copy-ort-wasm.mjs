// Copies the ONNX Runtime Web WASM runtime (used by Transformers.js for BEN2) into
// public/ort so it is served from this app instead of a third-party CDN.
import { copyFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const candidates = [
  join(process.cwd(), 'node_modules', '@huggingface', 'transformers', 'node_modules', 'onnxruntime-web'),
  join(process.cwd(), 'node_modules', 'onnxruntime-web'),
];
const ortDir = candidates.find((dir) => existsSync(join(dir, 'package.json')));
if (!ortDir) throw new Error('onnxruntime-web not found. Run `npm install` first.');

const version = JSON.parse(readFileSync(join(ortDir, 'package.json'), 'utf8')).version;
const outDir = join(process.cwd(), 'public', 'ort');
mkdirSync(outDir, { recursive: true });

for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  const src = join(ortDir, 'dist', file);
  if (!existsSync(src)) throw new Error(`Missing ${src}. Reinstall dependencies.`);
  copyFileSync(src, join(outDir, file));
}
console.log(`Copied onnxruntime-web ${version} WASM files to public/ort`);
