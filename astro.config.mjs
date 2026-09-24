// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

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
      exclude: ['@huggingface/transformers', 'onnxruntime-web'],
    },
  },
});
