/**
 * Thrown when a model fails on WebGPU. ONNX Runtime keeps WebGPU state per worker, so
 * the client retries the same model in a fresh worker on WebAssembly and tells the user.
 */
export class GpuBackendError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'GpuBackendError';
  }
}
