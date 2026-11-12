import assert from 'node:assert/strict';
import { createApngWorkerEncoder } from '../../dist/internal/apng-worker.js';
const retained = [], refs = [];
class Worker {
    listeners = new Map();
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    terminate() {}
    postMessage(message) {
        try {
            if (message.action === 'init') queueMicrotask(() => this.listeners.get('message')?.({ data: { version: 1, action: 'init', id: 1 } }));
            else throw new Error('native-like transport failure');
        } finally { message = undefined; }
    }
}
globalThis.Worker = Worker;
async function run(mode) {
    const controller = new AbortController(), encoder = createApngWorkerEncoder()({ plays: 0 }, { signal: controller.signal, maxInputBytes: 1024 * 1024 });
    const data = new Uint8ClampedArray(512 * 512 * 4), frame = { width: 512, height: 512, data, durationMs: 55 };
    refs.push({ frame: new WeakRef(frame), data: new WeakRef(data), buffer: new WeakRef(data.buffer) });
    const pending = encoder.addFrame(frame); if (mode === 'abort') controller.abort();
    await assert.rejects(pending); retained.push({ encoder, pending });
}
for (const mode of ['abort', 'post']) await run(mode);
for (let i = 0; i < 15; i++) {
    await new Promise(setImmediate); globalThis.gc(); await new Promise(setImmediate);
    if (refs.every(ref => !ref.frame.deref() && !ref.data.deref() && !ref.buffer.deref())) break;
}
assert.ok(refs.every(ref => !ref.frame.deref() && !ref.data.deref() && !ref.buffer.deref()), 'retained Worker transport holds an owned frame');
assert.equal(retained.length, 2); console.log('Retained APNG transports released frames after abort and post failure');
