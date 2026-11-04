import assert from 'node:assert/strict';
import { createGifExporter } from '../../dist/gif.js';

const retained = [], snapshots = [];
const NativePixels = globalThis.Uint8ClampedArray;
for (const mode of ['abort', 'dispose', 'finish', 'failure']) {
    let submitted = 0, disposed = 0;
    const controller = new AbortController();
    const data = new NativePixels(1920 * 1080 * 4); data.fill(128);
    const canvas = { width: 1920, height: 1080, getContext: () => ({ getImageData: () => ({ data }) }) };
    const gif = createGifExporter({ signal: controller.signal, encoder: () => ({
        addFrame() { submitted++; if (mode === 'failure') throw new Error('codec failed'); },
        finish: () => new Uint8Array([71, 73, 70, 56, 57, 97]), dispose() { disposed++; }
    }) });
    globalThis.Uint8ClampedArray = function (value) {
        const pixels = new NativePixels(value); snapshots.push(new WeakRef(pixels)); return pixels;
    };
    let work;
    try { work = gif.addFrame(canvas, 50); } finally { globalThis.Uint8ClampedArray = NativePixels; }
    if (mode === 'abort' || mode === 'dispose') {
        const timer = setTimeout(() => mode === 'abort' ? controller.abort() : gif.dispose(), 1);
        await assert.rejects(work, { name: 'AbortError' }); clearTimeout(timer);
        assert.equal(submitted, 0);
    } else if (mode === 'failure') await assert.rejects(work, /codec failed/);
    else { await work; await gif.finish(); }
    assert.equal(disposed, 1);
    retained.push(gif); // Deliberately keep every exporter alive through collection.
}
for (let i = 0; i < 10; i++) { await new Promise(setImmediate); globalThis.gc(); }
assert.equal(snapshots.length, 4);
assert(snapshots.every(ref => ref.deref() === undefined), 'retained exporter kept an owned RGBA snapshot');
assert.deepEqual(retained.map(g => g.state), ['aborted', 'disposed', 'finished', 'failed']);
console.log('Four retained exporters released all owned snapshots');
