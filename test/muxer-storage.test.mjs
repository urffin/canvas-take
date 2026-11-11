import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { storageHarness, mediaInput, writeInput, traceSummary } from './fixtures/muxer-storage.mjs';

const golden = JSON.parse(await readFile(new URL('./fixtures/muxer-write-traces.json', import.meta.url), 'utf8'));
const turn = () => new Promise(resolve => setImmediate(resolve));

for (const kind of ['mp4', 'webm']) {
    for (const audio of [false, true]) test(`${kind}: real writer trace and final bytes preserve the pre-extraction baseline (${audio ? 'audio' : 'silent'})`, async () => {
        const h = await storageHarness(kind, { real: true }), input = mediaInput(kind, audio, true);
        const { muxer, blob } = await writeInput(h, input);
        try {
            const bytes = new Uint8Array(await blob.arrayBuffer()), summary = traceSummary(h.writes, bytes);
            assert.deepEqual(summary, golden.cases[kind + (audio ? '-audio' : '-silent')]);
            assert.ok(summary.bytes > 65536); assert.ok(summary.rewinds > 0, 'real writer must exercise rewinds');
            const reference = new Uint8Array(bytes.length);
            for (const write of h.writes) reference.set(write.data, write.position);
            assert.deepEqual(bytes, reference);
            muxer.dispose(); assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), reference);
        } finally { muxer.dispose(); }
    });

    test(`${kind}: exact output bound includes headers and Blob survives clearing/disposal`, async () => {
        const h = await storageHarness(kind, { maxOutputBytes: 10 }), input = mediaInput(kind);
        const { muxer, blob } = await writeInput(h, input);
        const beforeLate = h.pages.length;
        assert.equal(blob.size, 10); assert.equal(blob.type, 'video/' + kind); assert.equal(h.outputs[0].closed, true);
        muxer.dispose(); muxer.dispose();
        h.sink.write({ position: 65536, data: new Uint8Array([55]) }); assert.equal(h.pages.length, beforeLate);
        assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1,2,3,4,0,19,9,8,7,6]);
    });

    test(`${kind}: a rejected next-page write allocates nothing and keeps the first budget error`, async () => {
        const h = await storageHarness(kind, { maxOutputBytes: 65536 }), input = mediaInput(kind);
        const muxer = await h.factory.create(input.config, h.context);
        try {
            assert.equal(h.pages.length, 1);
            h.sink.write({ position: 65536, data: new Uint8Array([1]) }); assert.equal(h.pages.length, 1);
            let first;
            await assert.rejects(muxer.write(input.events[0]), error => { first = error; return error.name === 'RangeError' && error.message === `${kind === 'mp4' ? 'MP4' : 'WebM'} maxOutputBytes exceeded`; });
            h.target.emit(100000); h.sink.write({ position: 100000, data: new Uint8Array(65536) });
            assert.equal(h.pages.length, 1);
            await assert.rejects(muxer.write(input.events[0]), error => error === first);
            muxer.dispose(); await turn();
            assert.equal(h.outputs[0].closed, true); assert.equal(h.outputs[0].cancellations, 1);
            await assert.rejects(muxer.write(input.events[0]), error => error === first);
        } finally { muxer.dispose(); }
    });

    test(`${kind}: observer-reported failure drops late writes and still closes the owned stream`, async () => {
        const h = await storageHarness(kind, { maxOutputBytes: 10 }), input = mediaInput(kind);
        const muxer = await h.factory.create(input.config, h.context);
        try {
            h.target.emit(11); let first;
            await assert.rejects(muxer.write(input.events[0]), error => { first = error; return error.name === 'RangeError'; });
            h.target.emit(12); h.sink.write({ position: 65536, data: new Uint8Array(4) });
            assert.equal(h.pages.length, 1); await assert.rejects(muxer.finalize(input.timeline), error => error === first);
            muxer.dispose(); await turn(); assert.equal(h.outputs[0].closed, true);
        } finally { muxer.dispose(); }
    });

    test(`${kind}: abort/dispose suppress late sink writes and retain their primary outcome`, async () => {
        for (const mode of ['abort', 'dispose']) {
            const h = await storageHarness(kind), input = mediaInput(kind), reason = new Error('original abort');
            const muxer = await h.factory.create(input.config, h.context);
            if (mode === 'abort') h.signal.abort(reason); else muxer.dispose();
            muxer.dispose(); h.sink.write({ position: 65536, data: new Uint8Array(100) });
            assert.equal(h.pages.length, 1);
            await assert.rejects(muxer.write(input.events[0]), error => mode === 'abort' ? error === reason : error.name === 'AbortError');
            await turn(); assert.equal(h.outputs[0].closed, true); assert.equal(h.outputs[0].cancellations, 1);
        }
    });

    test(`${kind}: final header overflow remains an error while vendor stream closure completes`, async () => {
        const h = await storageHarness(kind, { maxOutputBytes: 65536, finalWrites: [{ position: 65536, data: new Uint8Array([1]) }] });
        await assert.rejects(writeInput(h, mediaInput(kind)), /maxOutputBytes/);
        assert.equal(h.pages.length, 1); assert.equal(h.outputs[0].closed, true); assert.equal(h.outputs[0].state, 'finalized');
        h.sink.write({ position: 100000, data: new Uint8Array(10) }); assert.equal(h.pages.length, 1);
    });

    test(`${kind}: startup header overflow allocates no pages and cleans the partial output`, async () => {
        const h = await storageHarness(kind, { maxOutputBytes: 3 });
        await assert.rejects(h.factory.create(mediaInput(kind).config, h.context), /maxOutputBytes/);
        h.sink.write({ position: 65536, data: new Uint8Array(10) }); assert.equal(h.pages.length, 0);
        await turn(); assert.equal(h.outputs[0].closed, true); assert.equal(h.outputs[0].cancellations, 1);
    });
}
