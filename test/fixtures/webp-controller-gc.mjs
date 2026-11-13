import assert from 'node:assert/strict';
import { createWebpController } from '../../dist/internal/webp-controller.js';
import { source, file, deferred } from './webp-controller.mjs';
const NativePixels = Uint8ClampedArray, refs = [], callers = [], retained = [];
async function run(mode) {
    const canvas = source(512, 512), abort = new AbortController(), entered = deferred(), gate = deferred();
    callers.push({ canvas: new WeakRef(canvas), pixels: new WeakRef(canvas.data) });
    let owned, disposed = 0;
    const backend = { addFrame(frame) { owned = frame; entered.resolve(); if (mode === 'failure') throw new Error('codec'); if (mode === 'input-abort') return gate.promise; },
        finish() { if (mode === 'finish-abort') return gate.promise; return file([owned], 0); },
        dispose() { disposed++; owned = undefined; gate.reject(new Error('cleanup rejection')); } };
    void gate.promise.catch(() => {});
    const exporter = createWebpController({ encoder: () => backend, signal: abort.signal });
    globalThis.Uint8ClampedArray = new Proxy(NativePixels, { construct(ctor, args) {
        const data = Reflect.construct(ctor, args, ctor); refs.push({ array: new WeakRef(data), buffer: new WeakRef(data.buffer) }); return data;
    } });
    let frame; try { frame = exporter.addFrame(canvas, 55); } finally { globalThis.Uint8ClampedArray = NativePixels; }
    let blob;
    if (mode === 'yield-abort') { abort.abort(); await assert.rejects(frame, { name: 'AbortError' }); }
    else if (mode === 'failure') await assert.rejects(frame, /addFrame/);
    else if (mode === 'input-abort') { await entered.promise; abort.abort(); await assert.rejects(frame, { name: 'AbortError' }); }
    else { await frame; const finish = exporter.finish(); if (mode === 'finish-abort') { abort.abort(); await assert.rejects(finish, { name: 'AbortError' }); } else blob = await finish; }
    assert.equal(disposed, 1); assert.equal(canvas.data.byteLength, 512 * 512 * 4); retained.push({ exporter, backend, blob });
}
for (const mode of ['yield-abort', 'input-abort', 'failure', 'finish-abort', 'success']) await run(mode);
for (let i = 0; i < 20; i++) {
    await new Promise(setImmediate); globalThis.gc(); await new Promise(setImmediate);
    if (refs.every(r => !r.array.deref() && !r.buffer.deref()) && callers.every(r => !r.canvas.deref() && !r.pixels.deref())) break;
}
assert.equal(refs.length, 5);
assert.ok(refs.every(r => !r.array.deref() && !r.buffer.deref()), 'retained owned input');
assert.ok(callers.every(r => !r.canvas.deref() && !r.pixels.deref()), 'retained caller canvas/readback');
assert.equal(retained.length, 5); assert.equal(Buffer.from(await retained.at(-1).blob.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
console.log('Five retained WebP controllers released owned snapshots and buffers');
