import assert from 'node:assert/strict';
import { createWebpWorkerEncoder } from '../../dist/internal/webp-worker.js';
import { limits } from './webp-worker.mjs';
const retained = [], refs = [];
class Worker {
    listeners = new Map();
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    removeEventListener(name) { this.listeners.delete(name); }
    terminate() {}
    postMessage(message) {
        try {
            if (message.action === 'init') queueMicrotask(() => this.listeners.get('message')?.({ data: { format: 'webp', version: 1, action: 'init', id: 1, value: { bindingAbi: 1, profile: 'libwebp-batch-animation-v1' } } }));
            else throw new Error('post failed');
        } finally { message = undefined; }
    }
}
globalThis.Worker = Worker;
async function run(mode) {
    const abort = new AbortController(), encoder = createWebpWorkerEncoder()({ plays: 0 }, { signal: abort.signal, limits });
    const data = new Uint8ClampedArray(512 * 512 * 4), frame = { width: 512, height: 512, data, durationMs: 55 };
    refs.push({ frame: new WeakRef(frame), data: new WeakRef(data), buffer: new WeakRef(data.buffer) });
    const pending = encoder.addFrame(frame); if (mode === 'abort') abort.abort(); await assert.rejects(pending); retained.push({ encoder, pending });
}
for (const mode of ['abort', 'post']) await run(mode);
for (let i = 0; i < 20; i++) { await new Promise(setImmediate); globalThis.gc(); await new Promise(setImmediate); if (refs.every(r => !r.frame.deref() && !r.data.deref() && !r.buffer.deref())) break; }
assert.ok(refs.every(r => !r.frame.deref() && !r.data.deref() && !r.buffer.deref())); assert.equal(retained.length, 2);
console.log('Retained WebP transports released frames');
