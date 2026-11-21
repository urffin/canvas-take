import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { createGifExporter } from '../dist/gif.js';
import { createGifWorkerEncoder } from '../dist/gif-worker.js';
import { createSampledGifWorkerEncoder } from '../dist/internal/gif-sampled-worker.js';
import { createSampledGifencEncoder } from '../dist/internal/gif-sampled-encoder.js';
import { createGifencEncoder } from '../dist/gifenc.js';
import { createGifWorkerEncoder as legacyAdapter } from './fixtures/gif-worker-legacy-adapter.mjs';
import { NodeModuleWorker } from './fixtures/node-module-worker.mjs';
import { sampleCanvas } from './fixtures/gif-sampled-sync-reference.mjs';

const runtime = new URL('../dist/gif-worker-runtime.js', import.meta.url);
const legacyRuntime = new URL('./fixtures/gif-worker-legacy-runtime.mjs', import.meta.url);
const entryProbe = new URL('./fixtures/gif-worker-sampled-entry.mjs', import.meta.url);
const paletteMode = 'sampled-v1';
const sampleAction = 'palette-sample-v1';
const background = [230, 240, 250];
const accent = [242, 245, 249];
const color = Uint8ClampedArray.of(242, 245, 249, 255);
const black = sampleCanvas(1, 1, Uint8ClampedArray.of(0, 0, 0, 255));
const makeDescriptor = (readFrame, frameCount = 1, accentColors = [accent]) =>
    ({ mode: 'sampled', source: { frameCount, readFrame }, accentColors });

function recordWorkers(t) {
    const original = globalThis.Worker;
    const instances = [];
    let intercept = {};
    class RecordedWorker extends NodeModuleWorker {
        actions = [];
        transfers = [];
        init;
        terminated = 0;
        pendingListeners = new Set();

        constructor(url) {
            super(url);
            this.intercept = intercept;
            instances.push(this);
        }
        addEventListener(type, listener, options) {
            if (['message', 'error', 'messageerror'].includes(type)) this.pendingListeners.add(listener);
            super.addEventListener(type, listener, options);
        }
        removeEventListener(type, listener, options) {
            this.pendingListeners.delete(listener);
            super.removeEventListener(type, listener, options);
        }
        dispatchEvent(event) {
            if (event.type === 'message') {
                const reply = this.intercept.reply ? this.intercept.reply(event.data) : event.data;
                if (reply === undefined) return true;
                return super.dispatchEvent(new MessageEvent('message', { data: reply }));
            }
            return super.dispatchEvent(event);
        }
        postMessage(message, transfer) {
            this.actions.push(message.action);
            if (message.action === 'init') this.init = message.value;
            this.intercept.beforeSend?.(message.action);
            if (!transfer.length) { super.postMessage(message, transfer); return; }
            const { data } = message.value;
            assert.equal(transfer.length, 1);
            assert.equal(transfer[0], data.buffer);
            const bytes = data.byteLength;
            if (message.action === sampleAction || message.action === 'frame') {
                assert.ok(data.every((value, i) => i % 4 !== 3 || value === 255));
            }
            super.postMessage(message, transfer);
            assert.equal(data.buffer.byteLength, 0);
            assert.throws(() => new Uint8Array(data.buffer), TypeError);
            this.transfers.push([message.action, bytes]);
        }
        terminate() { this.terminated++; super.terminate(); }
    }
    globalThis.Worker = RecordedWorker;
    t.after(async () => {
        globalThis.Worker = original;
        for (const worker of instances) {
            if (!worker.exited) worker.terminate();
            await worker.exited;
        }
    });
    return { latest: () => instances.at(-1), count: () => instances.length, use: options => { intercept = options; } };
}

async function closed(worker) {
    await worker.exited;
    assert.equal(worker.node.threadId, -1);
    assert.equal(worker.terminated, 1);
    assert.equal(worker.pendingListeners.size, 0);
}

async function encode(factory, timeline = [[black, 80]], options = {}) {
    const gif = createGifExporter({ encoder: factory, background, repeat: 3, ...options });
    try {
        for (const [canvas, durationMs] of timeline) await gif.addFrame(canvas, durationMs);
        return new Uint8Array(await (await gif.finish()).arrayBuffer());
    } finally { gif.dispose(); }
}

function inspect(bytes, delays) {
    const parsed = parseGIF(bytes.buffer);
    assert.ok(parsed.gct.length >= 2);
    assert.ok(parsed.frames.filter(frame => frame.image).every(frame => !frame.image.lct));
    assert.deepEqual([...parsed.frames.find(frame => frame.application).application.blocks], [1, 3, 0]);
    const frames = decompressFrames(parsed, true);
    assert.deepEqual(frames.map(frame => frame.delay), delays);
    return frames;
}

test('sampled Worker raw and prepared output match sync and transfer one bounded sample', async t => {
    const records = recordWorkers(t);
    const width = 81, height = 66;
    const sampleReads = [];
    const make = phase => {
        const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) =>
            i % 4 === 3 ? [0, 1, 127, 254, 255][Math.floor(i / 4) % 5] : (i * 43 + phase * 101) % 251);
        data.set([243, 245, 249, 255, ...color, 254, 250, 248, 128], 0);
        return sampleCanvas(width, height, data);
    };
    const first = make(0), last = make(1);
    const originals = [first.data.slice(), last.data.slice()];
    const timeline = [[first, 54], [last, 2004]];
    const spec = makeDescriptor(index => {
        sampleReads.push(index);
        return index < 12 ? first : last;
    }, 24, [accent, [...accent]]);
    for (const [maxColors, quality, dither] of [
        [2, 'high', 'none'], [32, 'fast', 'none'], [64, 'high', 'bayer-4x4'],
        [128, 'fast', 'bayer-4x4'], [256, 'high', 'none']
    ]) {
        const options = { maxColors, quality, dither };
        const expected = await encode(createSampledGifencEncoder(options, spec), timeline);
        for (const raw of [true, false]) {
            records.use({ reply: msg => !raw && msg.activePalette ? { ...msg, rawPreparationVersion: 85 } : msg });
            const progress = [];
            const bytes = await encode(createSampledGifWorkerEncoder(options, spec), timeline, {
                totalFrames: 2, maxFrames: 2, maxDurationMs: 2050, onProgress: p => progress.push(p.phase)
            });
            assert.deepEqual(bytes, expected);
            assert.deepEqual(progress, ['encoding', 'encoding', 'finalizing', 'finished']);
            const worker = records.latest(), action = raw ? 'raw-frame-v1' : 'frame';
            assert.deepEqual(worker.actions, ['init', sampleAction, action, action, 'finish']);
            assert.deepEqual(worker.init, { repeat: 3, maxColors, quality,
                ...(dither === 'none' ? {} : { dither }), paletteMode, accentColors: [accent] });
            assert.deepEqual(worker.transfers, [[sampleAction, 64 * 1024], [action, width * height * 4], [action, width * height * 4]]);
            await closed(worker);
            for (const { patch } of inspect(bytes, [50, 2000])) {
                assert.deepEqual([...patch.subarray(4, 12)], [...color, ...color]);
            }
        }
        assert.deepEqual([first.data, last.data], originals);
    }
    assert.equal(sampleReads.length, 5 * 3 * 4);
    for (let i = 0; i < sampleReads.length; i += 4) assert.deepEqual(sampleReads.slice(i, i + 4), [0, 8, 15, 23]);
});

test('full accent budget transfers a legal empty sample and never reads the replay source', async t => {
    const records = recordWorkers(t);
    const spec = makeDescriptor(() => { throw new Error('Sample reads must be skipped'); }, 24, [accent, [0, 0, 0]]);
    const maxColors = 2;
    const expected = await encode(createSampledGifencEncoder({ maxColors }, spec));
    const actual = await encode(createSampledGifWorkerEncoder({ maxColors }, spec));
    assert.deepEqual(actual, expected);
    const worker = records.latest();
    await closed(worker);
    assert.deepEqual(worker.transfers, [[sampleAction, 0], ['raw-frame-v1', 4]]);
});

test('mixed Worker assets preserve default traffic and reject an unconfirmed sampled mode before reading or transferring', async t => {
    const records = recordWorkers(t);
    const dir = await mkdtemp(join(tmpdir(), 'canvas-take-sampled-legacy-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await copyFile(runtime, join(dir, 'gif-worker-runtime.js'));
    const legacyCodec = new URL('./fixtures/gifenc-legacy.mjs', import.meta.url);
    await writeFile(join(dir, 'gifenc.js'), 'export { createGifencEncoder } from ' + JSON.stringify(legacyCodec.href) + ';');
    const mixed = pathToFileURL(join(dir, 'gif-worker-runtime.js'));
    let reads = 0;
    const spec = makeDescriptor(() => { reads++; return black; });
    assert.throws(() => createSampledGifWorkerEncoder({}, undefined), TypeError);
    assert.equal(records.count(), 0);

    const expected = await encode(createGifencEncoder({ maxColors: 32 }));
    for (const workerUrl of [legacyRuntime, mixed]) {
        assert.deepEqual(await encode(createGifWorkerEncoder({ workerUrl, maxColors: 32 })), expected);
        const defaultWorker = records.latest();
        assert.deepEqual(defaultWorker.init, { repeat: 3, maxColors: 32, quality: 'high' });
        await closed(defaultWorker);
        await assert.rejects(encode(createSampledGifWorkerEncoder({ workerUrl, maxColors: 32 }, spec)),
            { name: 'NotSupportedError' });
        const worker = records.latest();
        assert.equal(reads, 0);
        assert.deepEqual(worker.actions, ['init']);
        assert.deepEqual(worker.transfers, []);
        await closed(worker);
    }
    assert.deepEqual(await encode(legacyAdapter({ workerUrl: runtime, maxColors: 32 })), expected);
    await closed(records.latest());

    for (const reply of [
        msg => msg.activePalette ? { ...msg, activePalette: 'sampled-v2' } : msg,
        msg => msg.activePalette ? { ...msg, activeDither: 'unknown' } : msg
    ]) {
        records.use({ reply });
        await assert.rejects(encode(createSampledGifWorkerEncoder({ dither: 'bayer-4x4' }, spec)), { name: 'NotSupportedError' });
        const worker = records.latest();
        assert.deepEqual(worker.actions, ['init']);
        assert.deepEqual(worker.transfers, []);
        assert.equal(reads, 0);
        await closed(worker);
    }
});

test('malformed sample acknowledgement, timeout and transfer failure close the session without a frame', async t => {
    const records = recordWorkers(t);
    const spec = makeDescriptor(() => black);
    for (const [options, fault, message, detached] of [
        [{}, { reply: msg => msg.paletteReady ? { ...msg, paletteReady: '1' } : msg }, /invalid palette sample acknowledgement/, true],
        [{ timeoutMs: 2500 }, { reply: msg => msg.paletteReady ? undefined : msg }, /palette-sample-v1 timed out/, true],
        [{}, { beforeSend: action => { if (action === sampleAction) throw new DOMException('sample transfer failed', 'DataCloneError'); } },
            /sample transfer failed/, false]
    ]) {
        records.use(fault);
        const progress = [];
        const gif = createGifExporter({ encoder: createSampledGifWorkerEncoder(options, spec),
            onProgress: p => progress.push([p.phase, p.framesEncoded]) });
        await assert.rejects(gif.addFrame(black, 80), message);
        assert.equal(gif.state, 'failed');
        assert.deepEqual(progress, [['failed', 0]]);
        const worker = records.latest();
        assert.deepEqual(worker.actions, ['init', sampleAction]);
        assert.deepEqual(worker.transfers, detached ? [[sampleAction, 4]] : []);
        await closed(worker);
    }
});

test('runtime rejects early, duplicate and malformed sample requests and cannot restart the failed session', async () => {
    const init = { repeat: 3, maxColors: 32, quality: 'high', paletteMode, accentColors: [accent] };
    const opaque = Uint8ClampedArray.of(0, 0, 0, 255);
    const part = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]).subarray(4);
    const request = (worker, id, action, value) => new Promise((resolve, reject) => {
        function cleanup() {
            clearTimeout(timer);
            worker.removeEventListener('message', receive);
            worker.removeEventListener('error', failed);
        }
        function failed(event) { cleanup(); reject(new Error(event.message)); }
        function receive({ data }) { if (data.id === id) { cleanup(); resolve(data); } }
        const timer = setTimeout(() => failed({ message: 'No Worker reply for ' + action }), 10000);
        worker.addEventListener('message', receive);
        worker.addEventListener('error', failed);
        try { worker.postMessage({ id, action, value }, []); }
        catch (error) { cleanup(); reject(error); }
    });
    for (const scenario of [
        { action: sampleAction, value: { data: opaque }, early: true, error: /not initialized/ },
        { action: 'frame', error: /not ready/ },
        { action: 'finish', error: /not ready/ },
        { action: sampleAction, value: { data: opaque }, installed: true, error: /did not expect/ },
        ...[new Uint8Array(4), new Uint8ClampedArray(0), new Uint8ClampedArray(5), new Uint8ClampedArray(65540),
            new Uint8ClampedArray(new SharedArrayBuffer(4)), part].map(data =>
            ({ action: sampleAction, value: { data }, error: /Invalid GIF palette sample/ })),
        { action: sampleAction, value: { data: new Uint8ClampedArray(4) }, error: /must be opaque/ },
        { action: 'init', value: { ...init, accentColors: null }, early: true, error: /accentColors/ }
    ]) {
        const worker = new NodeModuleWorker(runtime);
        try {
            if (!scenario.early) assert.deepEqual(await request(worker, 1, 'init', init), { id: 1, rawPreparationVersion: 1, activePalette: paletteMode });
            if (scenario.installed) assert.deepEqual(await request(worker, 2, sampleAction, { data: opaque }), { id: 2, paletteReady: 1 });
            const failure = await request(worker, 3, scenario.action, scenario.value);
            assert.match(failure.error, scenario.error);
            assert.match((await request(worker, 4, 'init', init)).error, /session failed/);
        } finally { worker.terminate(); await worker.exited; }
    }
});

test('abort at real Worker request entry closes it once and a fresh export matches sync', async t => {
    const records = recordWorkers(t);
    const spec = makeDescriptor(() => black);
    const expected = await encode(createSampledGifencEncoder({}, spec));
    for (const stage of ['init', sampleAction, 'raw-frame-v1', 'finish']) {
        const abort = new AbortController();
        const reason = new Error('abort at ' + stage);
        records.use({ reply: msg => { if (msg.entered === stage) abort.abort(reason); return msg; } });
        const workerUrl = new URL(entryProbe);
        workerUrl.searchParams.set('block', stage);
        const progress = [];
        const gif = createGifExporter({ encoder: createSampledGifWorkerEncoder({ workerUrl }, spec),
            signal: abort.signal, onProgress: p => progress.push([p.phase, p.framesEncoded]) });
        let result;
        if (stage === 'finish') { await gif.addFrame(black, 80); result = gif.finish(); }
        else result = gif.addFrame(black, 80);
        await assert.rejects(result, error => error === reason);
        assert.equal(gif.state, 'aborted');
        assert.deepEqual(progress.at(-1), ['aborted', stage === 'finish' ? 1 : 0]);
        assert.equal(progress.filter(([phase]) => phase === 'aborted').length, 1);
        assert.ok(!progress.some(([phase]) => phase === 'finished'));
        const worker = records.latest();
        assert.equal(worker.actions.at(-1), stage);
        if (stage === sampleAction) assert.deepEqual(worker.transfers, [[sampleAction, 4]]);
        await closed(worker);
        records.use({});
        const retried = await encode(createSampledGifWorkerEncoder({}, spec));
        assert.deepEqual(retried, expected);
        await closed(records.latest());
        inspect(retried, [80]);
    }
});

test('dispose during local replay ignores a late sample and closes its Worker before handoff', async t => {
    const records = recordWorkers(t);
    let resolveRead, signal, notify, lateRead = 0;
    const started = new Promise(resolve => { notify = resolve; });
    const spec = makeDescriptor((_index, cancellation) => {
        signal = cancellation;
        const value = new Promise(resolve => { resolveRead = resolve; });
        notify();
        return value;
    });
    const preAborted = AbortSignal.abort(new Error('pre-aborted'));
    assert.throws(() => createGifExporter({ encoder: createSampledGifWorkerEncoder({}, spec), signal: preAborted }),
        error => error === preAborted.reason);
    assert.equal(records.count(), 0);
    const gif = createGifExporter({ encoder: createSampledGifWorkerEncoder({}, spec) });
    const pending = gif.addFrame(black, 80);
    await Promise.race([started, pending.then(() => assert.fail('Frame resolved before replay'))]);
    gif.dispose();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.ok(signal.aborted);
    resolveRead(sampleCanvas(1, 1, color, () => lateRead++));
    const worker = records.latest();
    await closed(worker);
    assert.deepEqual(worker.actions, ['init']);
    assert.deepEqual(worker.transfers, []);
    assert.equal(lateRead, 0);
});
