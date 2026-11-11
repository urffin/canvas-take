import assert from 'node:assert/strict';
import { storageHarness, mediaInput, writeInput } from './muxer-storage.mjs';

assert.equal(typeof global.gc, 'function');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function setup() {
    const retained = [], pages = [];
    for (const kind of ['mp4', 'webm']) for (const mode of ['success', 'failure', 'abort', 'dispose']) {
        const h = await storageHarness(kind, { maxOutputBytes: 200000 }), input = mediaInput(kind, false, true);
        let muxer, blob;
        if (mode === 'success') ({ muxer, blob } = await writeInput(h, input));
        else {
            muxer = await h.factory.create(input.config, h.context);
            for (const event of input.events.slice(0, 3)) await muxer.write(event);
            if (mode === 'failure') { h.target.emit(200001); await assert.rejects(muxer.finalize(input.timeline), /maxOutputBytes/); }
            if (mode === 'abort') h.signal.abort(new Error('original abort'));
        }
        muxer.dispose(); h.sink.write({ position: 200000, data: new Uint8Array([1]) }); await turn();
        assert.equal(h.pages.length, 2); assert.equal(h.outputs[0].closed, true);
        retained.push({ h, muxer, blob }); pages.push(...h.pages);
    }
    return { retained, pages };
}
const { retained, pages } = await setup(); assert.equal(pages.length, 16);
for (let attempt = 0; attempt < 15; attempt++) {
    await turn(); global.gc(); await turn();
    if (pages.every(page => !page.array.deref() && !page.buffer.deref())) break;
}
assert.ok(pages.every(page => !page.array.deref() && !page.buffer.deref()), 'retained adapter still owns a page or its ArrayBuffer');
assert.equal(retained.length, 8);
for (const item of retained) if (item.blob) assert.equal(item.blob.size, 73312);
console.log('All 16 owned pages and buffers collectible with retained adapters');
