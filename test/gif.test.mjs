import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { build } from 'esbuild';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { createGifExporter } from '../dist/gif.js';
import { createGifencEncoder } from '../dist/gifenc.js';

function canvas(width = 2, height = 2, color = [255, 0, 0, 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(color, i);
    return { width, height, data, getContext: () => ({ getImageData: () => ({ data }) }) };
}
const create = options => createGifExporter({ encoder: createGifencEncoder(), ...options });
async function decode(blob) { const parsed = parseGIF(await blob.arrayBuffer()); return { parsed, frames: decompressFrames(parsed, true) }; }
function spy(overrides = {}) {
    const calls = { disposed: 0, frames: [], options: undefined };
    const encoder = options => {
        calls.options = options;
        const real = createGifencEncoder()(options);
        return {
            addFrame(frame) { calls.frames.push(frame); return real.addFrame(frame); },
            finish: () => real.finish(),
            ...overrides,
            dispose() { calls.disposed++; real.dispose(); }
        };
    };
    return { calls, encoder };
}
test('GIF independently decodes distinct frames, dimensions, timings, final hold and repeat', async () => {
    for (const repeat of [-1, 0, 3, 65535]) {
        const gif = create({ repeat });
        const source = canvas();
        const first = gif.addFrame(source, 50);
        source.data.fill(0); // Snapshot must precede the async yield.
        await first;
        await gif.addFrame(canvas(2, 2, [0, 255, 0, 255]), 54);
        await gif.addFrame(canvas(2, 2, [0, 0, 255, 255]), 2000);
        const blob = await gif.finish();
        assert.equal(blob.type, 'image/gif'); assert.equal(gif.state, 'finished');
        const { parsed, frames } = await decode(blob);
        assert.equal(parsed.lsd.width, 2); assert.equal(parsed.lsd.height, 2);
        assert.deepEqual(frames.map(f => f.delay), [50, 50, 2000]);
        for (let i = 0; i < 3; i++) {
            const expected = [0, 0, 0, 255]; expected[i] = 255;
            for (let p = 0; p < 16; p += 4) assert.deepEqual([...frames[i].patch.slice(p, p + 4)], expected);
        }
        const app = parsed.frames.find(f => f.application)?.application;
        if (repeat === -1) assert.equal(app, undefined);
        else { assert.equal(app.id, 'NETSCAPE2.0'); assert.equal(app.blocks[1] + 256 * app.blocks[2], repeat); }
        await assert.rejects(gif.finish(), /finished/);
        await assert.rejects(gif.addFrame(source, 50), /finished/);
        gif.dispose(); gif.dispose();
        assert.equal((await decode(blob)).frames.length, 3);
    }
});
test('palette settings and alpha composition survive decoding without modifying canvas', async () => {
    for (const quality of ['high', 'fast']) {
        const gif = create({ encoder: createGifencEncoder({ maxColors: 2, quality }), background: [0, 0, 255] });
        const source = canvas(2, 1, [255, 0, 0, 0]);
        source.data.set([255, 0, 0, 128], 4);
        const original = source.data.slice();
        await gif.addFrame(source, 100);
        const { frames } = await decode(await gif.finish());
        assert.deepEqual(source.data, original);
        assert.ok(frames[0].colorTable.length <= 2);
        assert.deepEqual([...frames[0].patch], [0, 0, 255, 255, 128, 0, 127, 255]);
    }
});
test('injected async encoder receives normalized frames; concurrent operations are rejected', async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const { calls, encoder } = spy({ addFrame: async () => { entered(); await new Promise(resolve => { release = resolve; }); } });
    const gif = create({ encoder, repeat: 2 });
    const pending = gif.addFrame(canvas(), 50);
    await started;
    assert.equal(gif.state, 'encoding');
    await assert.rejects(gif.addFrame(canvas(), 50), /encoding/);
    await assert.rejects(gif.finish(), /encoding/);
    release(); await pending;
    assert.deepEqual(calls.options, { repeat: 2 });
    gif.dispose(); assert.equal(calls.disposed, 1);
});
test('abort before creation avoids allocating encoder', () => {
    const controller = new AbortController(); controller.abort();
    let created = false;
    assert.throws(() => create({ signal: controller.signal, encoder: () => { created = true; } }), { name: 'AbortError' });
    assert.equal(created, false);
});
test('abort/dispose during a pending adapter operation rejects immediately and disposes once', async () => {
    for (const stage of ['frame', 'finish']) for (const cancellation of ['abort', 'dispose']) {
        const controller = new AbortController();
        let entered, reject;
        const started = new Promise(resolve => { entered = resolve; });
        const hang = () => { entered(); return new Promise((_, no) => { reject = no; }); };
        const { calls, encoder } = spy(stage === 'frame' ? { addFrame: hang } : { finish: hang });
        const gif = create({ encoder, signal: controller.signal });
        if (stage === 'finish') await gif.addFrame(canvas(), 50);
        const pending = stage === 'frame' ? gif.addFrame(canvas(), 50) : gif.finish();
        await started;
        if (cancellation === 'abort') controller.abort(); else gif.dispose();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(calls.disposed, 1);
        reject(new Error('late adapter rejection'));
        await new Promise(resolve => setTimeout(resolve, 0));
        gif.dispose(); assert.equal(calls.disposed, 1);
    }
});
test('abort during initial yield never sends a frame; successful finish detaches signal', async () => {
    const controller = new AbortController(); const { encoder, calls } = spy();
    const gif = create({ encoder, signal: controller.signal });
    const pending = gif.addFrame(canvas(), 50); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls.frames.length, 0); assert.equal(calls.disposed, 1);
    const secondController = new AbortController(); const second = spy();
    const successful = create({ encoder: second.encoder, signal: secondController.signal });
    await successful.addFrame(canvas(), 50); await successful.finish();
    secondController.abort(); assert.equal(successful.state, 'finished');
    successful.dispose(); assert.equal(second.calls.disposed, 1);
});
test('invalid inputs, resizing, tainted canvas and codec failures release owned resources', async () => {
    for (const reason of ['empty', 'duration', 'dimensions', 'resize', 'tainted', 'context', 'frameError', 'finishError', 'invalidBytes']) {
        const overrides = reason === 'frameError' ? { addFrame() { throw new Error('codec failed'); } }
            : reason === 'finishError' ? { finish: async () => { throw new Error('finish failed'); } }
            : reason === 'invalidBytes' ? { finish: () => new Uint8Array() } : {};
        const { calls, encoder } = spy(overrides); const gif = create({ encoder });
        const source = canvas();
        if (reason === 'resize') { await gif.addFrame(source, 50); source.width++; }
        if (reason === 'dimensions') source.width = 0;
        if (reason === 'tainted') source.getContext = () => ({ getImageData() { throw new DOMException('Tainted', 'SecurityError'); } });
        if (reason === 'context') source.getContext = () => null;
        if (['finishError', 'invalidBytes'].includes(reason)) await gif.addFrame(source, 50);
        await assert.rejects(['empty', 'finishError', 'invalidBytes'].includes(reason) ? gif.finish() : gif.addFrame(source, reason === 'duration' ? Infinity : 50));
        assert.equal(gif.state, 'failed'); assert.equal(calls.disposed, 1);
        gif.dispose(); assert.equal(calls.disposed, 1);
    }
    for (const repeat of [-2, 1.5, 65536, NaN]) assert.throws(() => create({ repeat }));
    for (const maxColors of [1, 257, NaN, 2.5]) assert.throws(() => createGifencEncoder({ maxColors }));
    assert.throws(() => createGifencEncoder({ quality: 'unknown' }));
    assert.throws(() => create({ background: [256, 0, 0] }));
});
test('video and injected GIF core bundles contain no codec; adapter has no external runtime imports', async () => {
    for (const entry of ['dist/index.js', 'dist/gif.js', 'dist/gifenc.js', 'dist/gif-worker.js']) {
        const bundle = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser' });
        assert.deepEqual(Object.keys(bundle.metafile.inputs), [entry]);
        assert.deepEqual(Object.values(bundle.metafile.outputs)[0].imports, []);
    }
    const core = await import('../dist/gif.js');
    assert.deepEqual(Object.keys(core), ['createGifExporter']);
});

test('a supplied Worker adapter transfers pixels, returns decodable bytes and terminates', async () => {
    const worker = new Worker(new URL('./fixtures/gif-worker.mjs', import.meta.url));
    const exited = once(worker, 'exit');
    const pending = new Map(); let id = 0;
    worker.on('message', message => {
        const request = pending.get(message.id); pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error)); else request.resolve(message.bytes);
    });
    const send = (action, value) => new Promise((resolve, reject) => {
        const key = ++id; pending.set(key, { resolve, reject });
        worker.postMessage({ id: key, action, value }, action === 'frame' ? [value.data.buffer] : []);
    });
    const gif = create({ encoder: options => {
        const initialized = send('init', options);
        return {
            async addFrame(frame) { await initialized; await send('frame', frame); },
            finish: () => send('finish'),
            dispose() { for (const p of pending.values()) p.reject(new Error('Disposed')); pending.clear(); void worker.terminate(); }
        };
    } });
    try {
        const source = canvas(); await gif.addFrame(source, 50);
        assert.equal(source.data.byteLength, 16); // Only the owned snapshot was transferred.
        await gif.addFrame(canvas(2, 2, [0, 255, 0, 255]), 2000);
        const { frames } = await decode(await gif.finish());
        assert.deepEqual(frames.map(f => f.delay), [50, 2000]);
        assert.deepEqual([...frames[1].patch.slice(0, 4)], [0, 255, 0, 255]);
    } finally { gif.dispose(); await exited; }
    assert.equal(worker.threadId, -1);
});
