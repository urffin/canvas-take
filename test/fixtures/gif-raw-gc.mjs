import assert from 'node:assert/strict';
import { createGifExporter } from '../../dist/gif.js';
import { createGifWorkerEncoder } from '../../dist/gif-worker.js';
const NativePixels = Uint8ClampedArray, retained = [], snapshots = [];
for (const mode of ['init-abort', 'raw-abort', 'failure', 'finish']) {
    const controller = new AbortController(); let terminated = 0;
    globalThis.Worker = class extends EventTarget {
        postMessage(message, transfer) {
            const reply = { id: message.id };
            if (message.action === 'init') { if (mode === 'init-abort') return; reply.rawPreparationVersion = 1; }
            if (message.action === 'raw-frame-v1') {
                structuredClone(message, { transfer });
                if (mode === 'raw-abort') { queueMicrotask(() => controller.abort()); return; }
                if (mode === 'failure') reply.error = 'raw failure'; else reply.rawFrameEncoded = 1;
            }
            if (message.action === 'finish') reply.bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: reply })));
        }
        terminate() { terminated++; }
    };
    const data = new NativePixels(1920 * 1080 * 4).fill(128);
    const canvas = { width: 1920, height: 1080, getContext: () => ({ getImageData: () => ({ data }) }) };
    const gif = createGifExporter({ encoder: createGifWorkerEncoder(), signal: controller.signal });
    globalThis.Uint8ClampedArray = function (value) { const owned = new NativePixels(value); snapshots.push(new WeakRef(owned)); return owned; };
    let work;
    try { work = gif.addFrame(canvas, 50); } finally { globalThis.Uint8ClampedArray = NativePixels; }
    if (mode === 'init-abort') {
        const timer = setTimeout(() => controller.abort(), 3); await assert.rejects(work, { name: 'AbortError' }); clearTimeout(timer);
    } else if (mode === 'raw-abort') await assert.rejects(work, { name: 'AbortError' });
    else if (mode === 'failure') await assert.rejects(work, /raw failure/);
    else { await work; await gif.finish(); }
    assert.equal(terminated, 1); retained.push(gif);
}
for (let i = 0; i < 10; i++) { await new Promise(setImmediate); globalThis.gc(); }
assert.equal(snapshots.length, 4); assert(snapshots.every(ref => ref.deref() === undefined), 'raw operation retained a snapshot');
assert.deepEqual(retained.map(g => g.state), ['aborted', 'aborted', 'failed', 'finished']);
console.log('Raw snapshots collectible with retained exporters');
