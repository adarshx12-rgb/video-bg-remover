// Dev-only Vite server for the automated test harness (harness.html). The real site is
// built by Astro (astro.config.mjs); this config never produces production output.
import { defineConfig } from 'vite';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

export default defineConfig({
  // No HMR: long-running automated tests must not be reloaded by source edits.
  server: { headers: isolationHeaders, port: 5173, strictPort: true, hmr: false, watch: null },
  worker: { format: 'es' },
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
});
