// Post-build step for Cloudflare hosting, which rejects any file over 25 MiB.
// 1. Removes the ONNX Runtime .wasm that Vite copies into dist/_astro from the package's
//    `new URL(..., import.meta.url)` fallback. The app never requests it: wasmPaths
//    points at the CDN copy (ORT_WASM_PATHS in src/config.ts).
// 2. Fails the build if any remaining file is over the limit.
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

const LIMIT = 25 * 1024 * 1024;
const dist = join(process.cwd(), 'dist');

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const tooBig = [];
for (const file of walk(dist)) {
  const name = relative(dist, file).replaceAll('\\', '/');
  if (/^_astro\/ort-wasm-.*\.wasm$/.test(name)) {
    unlinkSync(file);
    console.log(`Removed unused ${name}`);
    continue;
  }
  const size = statSync(file).size;
  if (size > LIMIT) tooBig.push(`${name} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
}

if (tooBig.length) {
  console.error(`These files are over Cloudflare's 25 MiB per-file limit:\n  ${tooBig.join('\n  ')}`);
  process.exit(1);
}
console.log('All files in dist/ are under 25 MiB.');
