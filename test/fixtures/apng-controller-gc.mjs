import assert from 'node:assert/strict';
import { createApngController } from '../../dist/internal/apng-controller.js';
import { source, file, deferred } from './apng-controller.mjs';
const NativePixels = Uint8ClampedArray, refs = [], callers = [], retained = [];
async function run(mode) {
    const canvas = source(512, 512), controller = new AbortController(), entered = deferred(), gate = deferred();
    callers.push({ canvas: new WeakRef(canvas), pixels: new WeakRef(canvas.data) });
    let owned, disposed = 0;
    const backend = { addFrame(frame) { owned = frame; entered.resolve(); if (mode === 'failure') throw new Error('codec'); if (mode === 'input-abort') return gate.promise; },
        finish() { if (mode === 'finish-abort') { entered.resolve(); return gate.promise; } return file([owned], 0); },
        dispose() { disposed++; owned = undefined; gate.reject(new Error('cleanup rejection')); } };
    // Some successful paths never await this gate; observe that test-owned rejection as well.
    void gate.promise.catch(() => {});
    const exporter = createApngController({ encoder: () => backend, signal: controller.signal });
    globalThis.Uint8ClampedArray = function(value) {
        const data = new NativePixels(value); refs.push({ array: new WeakRef(data), buffer: new WeakRef(data.buffer) }); return data;
    };
    let frame;
    try { frame = exporter.addFrame(canvas, 50); } finally { globalThis.Uint8ClampedArray = NativePixels; }
    let blob;
    if (mode === 'yield-abort') { controller.abort(); await assert.rejects(frame, { name: 'AbortError' }); }
    else if (mode === 'failure') await assert.rejects(frame, error => /addFrame/.test(error.message));
    else if (mode === 'input-abort') { await entered.promise; controller.abort(); await assert.rejects(frame, { name: 'AbortError' }); }
    else {
        await frame;
        const finish = exporter.finish();
        if (mode === 'finish-abort') { controller.abort(); await assert.rejects(finish, { name: 'AbortError' }); }
        else blob = await finish;
    }
    assert.equal(disposed, 1); assert.equal(canvas.data.byteLength, 512 * 512 * 4);
    retained.push({ exporter, backend, blob });
}
for (const mode of ['yield-abort', 'input-abort', 'failure', 'finish-abort', 'success']) await run(mode);
for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(setImmediate); globalThis.gc(); await new Promise(setImmediate);
    if (refs.every(ref => !ref.array.deref() && !ref.buffer.deref()) && callers.every(ref => !ref.canvas.deref() && !ref.pixels.deref())) break;
}
assert.equal(refs.length, 5); assert.ok(refs.every(ref => !ref.array.deref() && !ref.buffer.deref()), 'controller/adapter still retains owned input: ' + JSON.stringify(refs.map((ref, i) => ({ mode: ['yield-abort', 'input-abort', 'failure', 'finish-abort', 'success'][i], array: !!ref.array.deref(), buffer: !!ref.buffer.deref() }))));
assert.ok(callers.every(ref => !ref.canvas.deref() && !ref.pixels.deref()), 'controller/adapter still retains caller canvas/readback');
assert.equal(retained.length, 5);
assert.equal(new Uint8Array(await retained.at(-1).blob.arrayBuffer())[0], 137);
console.log('Five retained APNG controllers released owned snapshots and buffers');
