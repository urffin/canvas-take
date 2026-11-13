// Test bridge only: production uses native browser Worker/fetch/close, never node: imports.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
globalThis.self = globalThis;
globalThis.close = () => parentPort.close();
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
const queue = [];
parentPort.on('message', data => { if (globalThis.onmessage) globalThis.onmessage({ data }); else queue.push(data); });
if (workerData?.probe) {
    const { default: factory } = await import('../../dist/internal/webp-codec.js');
    const { startWebpWorker } = await import('../../dist/internal/webp-worker-core.js');
    let module;
    const flags = workerData.shared ? new Int32Array(workerData.shared) : undefined;
    globalThis.postMessage = (message, transfer) => {
        const stats = module ? { liveBytes: module._ct_live_bytes(), liveAllocations: module._ct_live_allocations(), allocatorUsed: module._ct_allocator_used(), capacity: module.HEAPU8.buffer.byteLength } : undefined;
        parentPort.postMessage({ ...message, stats }, transfer);
    };
    startWebpWorker(globalThis, async (url, signal) => {
        if (workerData.waitLoad) await delay(30000, undefined, { signal });
        module = await factory({ wasmBinary: await readFile(new URL(url)) });
        if (workerData.failAfter !== undefined) module._ct_fail_after(workerData.failAfter);
        module.nativeProgress = percent => {
            if (flags && percent >= 1) {
                Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
                Atomics.wait(flags, 1, 0, 15000);
                if (workerData.cooperative) return false;
            }
            return true;
        };
        return module;
    });
} else {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('file:')) { options?.signal?.throwIfAborted(); return new Response(await readFile(new URL(url))); }
        return realFetch(url, options);
    };
    await import('../../dist/internal/webp-worker-runtime.js');
}
for (const data of queue) globalThis.onmessage?.({ data }); queue.length = 0;
