export type BrowserCapabilities = {
  webAssembly: boolean
  webWorkers: boolean
  indexedDb: boolean
  sharedArrayBuffer: boolean
  crossOriginIsolated: boolean
  webGpu: boolean
  audioContext: boolean
  wasmFallback: boolean
}

export function detectBrowserCapabilities(): BrowserCapabilities {
  return {
    webAssembly: typeof WebAssembly === 'object',
    webWorkers: typeof Worker !== 'undefined',
    indexedDb: typeof indexedDB !== 'undefined',
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    webGpu: typeof navigator !== 'undefined' && 'gpu' in navigator,
    audioContext: typeof AudioContext !== 'undefined' || 'webkitAudioContext' in globalThis,
    wasmFallback: typeof WebAssembly === 'object',
  }
}

export function getCapabilityWarnings(capabilities: BrowserCapabilities): string[] {
  const warnings: string[] = []

  if (!capabilities.webAssembly) {
    warnings.push('WebAssembly is unavailable, so FFmpeg.wasm and Transformers.js cannot run.')
  }

  if (!capabilities.webWorkers) {
    warnings.push('Web Workers are unavailable, so transcription would block the interface.')
  }

  if (!capabilities.webGpu) {
    warnings.push('WebGPU is unavailable. The app will try a WebAssembly or CPU fallback.')
  }

  if (!capabilities.indexedDb) {
    warnings.push('IndexedDB is unavailable, so model and project caching may be limited.')
  }

  if (!capabilities.crossOriginIsolated) {
    warnings.push('Cross-origin isolation is off. Some threaded browser execution paths may be unavailable.')
  }

  return warnings
}
