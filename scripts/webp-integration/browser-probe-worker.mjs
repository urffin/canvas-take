// Test-only loader: production runtime has no shared barriers or diagnostic messages.
import factory from '/dist/internal/webp-codec.js';
import { startWebpWorker } from '/dist/internal/webp-worker-core.js';
let module, probe;
const scope = {
    onmessage: null,
    postMessage(message, transfer) {
        const stats = module ? { liveBytes: module._ct_live_bytes(), liveAllocations: module._ct_live_allocations(), capacity: module.HEAPU8.buffer.byteLength } : undefined;
        self.postMessage({ ...message, stats }, transfer);
    },
    close() { module = undefined; probe = undefined; self.onmessage = null; self.close(); }
};
startWebpWorker(scope, async (url, signal) => {
    const response = await fetch(url, { signal }); if (!response.ok) throw new Error('WASM HTTP ' + response.status);
    module = await factory({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
    module.nativeProgress = percent => {
        const flags = probe?.shared ? new Int32Array(probe.shared) : undefined;
        if (flags && percent >= 1) {
            Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
            try { Atomics.wait(flags, 1, 0, 15000); } finally { Atomics.store(flags, 0, 0); }
        }
        return true;
    };
    return module;
});
self.onmessage = event => { if (event.data.action === 'init') probe = event.data.probe; scope.onmessage?.(event); };
