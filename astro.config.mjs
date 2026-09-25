// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

/**
 * Dev server only: serves model-files/ (git-ignored, made by
 * scripts/model-compression/compress.py) at /model-files/, so the compressed withoutBG
 * models can be tested locally. Production hosts them elsewhere (PUBLIC_MODEL_MIRROR),
 * because they are over Cloudflare's 25 MiB per-file limit.
 */
const serveModelFiles = {
  name: 'serve-model-files',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use('/model-files/', (req, res, next) => {
      const file = join(process.cwd(), 'model-files', basename(decodeURIComponent((req.url ?? '').split('?')[0])));
      if (!existsSync(file) || !statSync(file).isFile()) return next();
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(statSync(file).size));
      createReadStream(file).pipe(res);
    });
  },
};

// Cross-origin isolation enables SharedArrayBuffer, which lets ONNX Runtime Web use
// multi-threaded WASM when WebGPU is unavailable. `credentialless` still allows the
// CORS model downloads from Hugging Face and GitHub. Any future host must send the
// same two headers (see README).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  integrations: [react()],
  server: { headers: isolationHeaders },
  devToolbar: { enabled: false },
  vite: {
    plugins: [serveModelFiles],
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
    // Pre-bundle the worker's lazily imported dependencies at startup; otherwise Vite
    // discovers them on first use and reloads the page in the middle of a job.
    optimizeDeps: {
      include: [
        'mediabunny',
        '@tensorflow/tfjs-core',
        '@tensorflow/tfjs-converter',
        '@tensorflow/tfjs-backend-webgl',
        '@tensorflow/tfjs-backend-webgpu',
      ],
      exclude: ['@huggingface/transformers', 'onnxruntime-web', 'onnxruntime-web/webgpu'],
    },
  },
});
