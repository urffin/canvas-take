import createModule from './webp-codec.js';
import { startWebpWorker, type WebpWorkerScope } from './webp-worker-core.js';
export function startWebpWorkerRuntime(): void {
startWebpWorker(self as unknown as WebpWorkerScope, async (url, signal) => {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('WebP WASM download failed: ' + response.status);
    const wasmBinary = new Uint8Array(await response.arrayBuffer()); signal.throwIfAborted();
    return createModule({ wasmBinary });
});
}
