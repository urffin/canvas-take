import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker as NodeWorker } from 'node:worker_threads';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { createGifExporter } from '../dist/gif.js';
import { createGifWorkerEncoder } from '../dist/gif-worker.js';
import { createGifencEncoder } from '../dist/gifenc.js';
const canvas = { width: 2, height: 1, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([255,0,0,255,0,255,0,255]) }) }) };
class BrowserWorker extends EventTarget {
    static instances = [];
    terminated = 0;
    constructor(url, options) {
        super(); assert.equal(options.type, 'module');
        this.node = new NodeWorker(new URL('./fixtures/browser-worker.mjs', import.meta.url), { workerData: String(url) });
        this.node.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
        this.node.on('error', error => { const e = new Event('error'); e.message = error.message; this.dispatchEvent(e); });
        BrowserWorker.instances.push(this);
    }
    postMessage(message, transfer) { this.node.postMessage(message, transfer); }
    terminate() { this.terminated++; this.exited = this.node.terminate(); }
}
test('ready-made Worker adapter encodes, transfers, reports progress and terminates', async () => {
    const previous = globalThis.Worker; globalThis.Worker = BrowserWorker;
    const events = [];
    const gif = createGifExporter({ encoder: createGifWorkerEncoder({ maxColors: 2 }), totalFrames: 2, repeat: 3, onProgress: p => events.push(p) });
    try {
        await gif.addFrame(canvas, 54); await gif.addFrame(canvas, 2000);
        const parsed = parseGIF(await (await gif.finish()).arrayBuffer());
        assert.deepEqual(decompressFrames(parsed, true).map(f => f.delay), [50, 2000]);
        assert.deepEqual([...decompressFrames(parsed, true)[0].patch], [255,0,0,255,0,255,0,255]);
        assert.equal(parsed.frames.find(f => f.application).application.blocks[1], 3);
        assert.deepEqual(events.map(p => [p.phase,p.framesEncoded,p.durationMs,p.totalFrames]), [
            ['encoding',1,50,2],['encoding',2,2050,2],['finalizing',2,2050,2],['finished',2,2050,2]
        ]);
        assert.ok(events.every(Object.isFrozen));
    } finally { gif.dispose(); globalThis.Worker = previous; }
    const worker = BrowserWorker.instances.at(-1); await worker.exited;
    assert.equal(worker.terminated, 1); assert.equal(worker.node.threadId, -1);
});
test('Worker cancellation during startup, failure, malformed message and timeout clean up', async () => {
    const previous = globalThis.Worker;
    class FakeWorker extends EventTarget {
        static instance; terminated = 0;
        constructor() { super(); FakeWorker.instance = this; }
        postMessage() {}
        terminate() { this.terminated++; }
    }
    globalThis.Worker = FakeWorker;
    try {
        for (const mode of ['abort','dispose','error','messageerror','timeout','post']) {
            const controller = new AbortController(); const progress = [];
            const gif = createGifExporter({ encoder: createGifWorkerEncoder({ timeoutMs: 20 }), signal: controller.signal, onProgress: p => progress.push(p) });
            const pending = gif.addFrame(canvas, 50); const worker = FakeWorker.instance;
            if (mode === 'abort') controller.abort();
            if (mode === 'dispose') gif.dispose();
            if (mode === 'error' || mode === 'messageerror') worker.dispatchEvent(new Event(mode));
            if (mode === 'post') {
                worker.postMessage = () => { throw new Error('transfer failed'); };
                worker.dispatchEvent(new MessageEvent('message', { data: { id: 1 } }));
            }
            await assert.rejects(pending);
            gif.dispose(); assert.equal(worker.terminated, 1);
            assert.equal(progress.length, 1); assert.equal(progress[0].framesEncoded, 0);
            assert.equal(progress[0].phase, mode === 'abort' ? 'aborted' : mode === 'dispose' ? 'disposed' : 'failed');
        }
    } finally { globalThis.Worker = previous; }
});
test('progress observer can throw or cancel without corrupting counters', async () => {
    const gif = createGifExporter({ encoder: createGifencEncoder(), onProgress() { throw Error('UI failed'); } });
    await gif.addFrame(canvas, 50); assert.ok((await gif.finish()).size); gif.dispose();
    const disposing = createGifExporter({ encoder: createGifencEncoder(), onProgress(p) { if (p.phase === 'finished') disposing.dispose(); } });
    await disposing.addFrame(canvas, 50); assert.ok((await disposing.finish()).size);
    const controller = new AbortController(); const phases = [];
    const cancelled = createGifExporter({ encoder: createGifencEncoder(), signal: controller.signal,
        onProgress(p) { phases.push(p.phase); if (p.phase === 'finalizing') controller.abort(); } });
    await cancelled.addFrame(canvas, 50); await assert.rejects(cancelled.finish());
    assert.deepEqual(phases, ['encoding','finalizing','aborted']);
    for (const totalFrames of [0, -1, 1.5, Infinity]) assert.throws(() => createGifExporter({ encoder: createGifencEncoder(), totalFrames }));
    for (const timeoutMs of [0, Infinity, 2147483648]) assert.throws(() => createGifWorkerEncoder({ timeoutMs }));
});
