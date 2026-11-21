import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { createGifExporter } from '../dist/gif.js';
import { createGifencEncoder } from '../dist/gifenc.js';
import { createGifWorkerEncoder } from '../dist/gif-worker.js';
import { applyBayerPalette } from '../dist/internal/gif-bayer.js';
import { createGifencEncoder as baseline } from './fixtures/gifenc-legacy.mjs';
import { createGifWorkerEncoder as legacyAdapter } from './fixtures/gif-worker-legacy-adapter.mjs';
import { NodeModuleWorker } from './fixtures/node-module-worker.mjs';

const defaultRuntime = new URL('../dist/gif-worker-runtime.js', import.meta.url);
const oldRuntime = new URL('./fixtures/gif-worker-legacy-runtime.mjs', import.meta.url);
const oldCodec = new URL('./fixtures/gifenc-legacy.mjs', import.meta.url);
const rawKey = Symbol.for('@grundyjs/canvas-take/gif/raw-preparation/v1');

function installWorker(t) {
    const instances = [];
    const Worker = class extends NodeModuleWorker {
        actions = [];
        transfers = 0;
        terminations = 0;
        constructor(url) {
            super(url);
            instances.push(this);
            this.addEventListener('message', ({ data }) => {
                if (data.id === 1) this.initReply = data;
            });
        }
        postMessage(message, transfer) {
            this.actions.push(message.action);
            if (message.action === 'init') this.init = message.value;
            super.postMessage(message, transfer);
            if (transfer.length) {
                this.transfers++;
                assert.equal(message.value.data.byteLength, 0);
            }
        }
        terminate() {
            this.terminations++;
            super.terminate();
        }
    };
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    Object.defineProperty(globalThis, 'Worker', { value: Worker, configurable: true, writable: true });
    t.after(() => {
        if (saved) Object.defineProperty(globalThis, 'Worker', saved);
        else delete globalThis.Worker;
    });
    return () => instances.at(-1);
}

function makeSource(width, height, phase) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
        const x = p % width, y = Math.floor(p / width);
        data.set([x * 11, y * 18, (x * 4 + y * 12 + phase * 23) % 256, [255, 128, 254, 0, 1][p % 5]], p * 4);
    }
    return { width, height, data, getContext: () => ({ getImageData: () => ({ data }) }) };
}

async function exportGif(factory) {
    const gif = createGifExporter({ encoder: factory, repeat: 3, background: [20, 40, 60] });
    try {
        for (const [phase, delay] of [[0, 54], [1, 2000]]) {
            const source = makeSource(23, 13, phase);
            const original = source.data.slice();
            await gif.addFrame(source, delay);
            assert.deepEqual(source.data, original);
        }
        return new Uint8Array(await (await gif.finish()).arrayBuffer());
    } finally { gif.dispose(); }
}

function decode(bytes) {
    const parsed = parseGIF(bytes.buffer);
    const frames = decompressFrames(parsed, true);
    assert.deepEqual([parsed.lsd.width, parsed.lsd.height], [23, 13]);
    assert.deepEqual(frames.map(frame => frame.delay), [50, 2000]);
    assert.equal(parsed.frames.find(frame => frame.application).application.blocks[1], 3);
    for (const { patch } of frames) {
        assert.equal(patch.length, 23 * 13 * 4);
        assert.ok(patch.every((value, i) => i % 4 !== 3 || value === 255));
    }
    return frames.map(frame => frame.colorTable);
}

test('invalid dither values fail synchronously at both adapter factories', () => {
    for (const invalid of [null, '', 'bayer', true, 0, {}]) {
        for (const factory of [createGifencEncoder, createGifWorkerEncoder]) {
            assert.throws(() => factory({ dither: invalid }), { name: 'TypeError', message: /dither/ });
        }
    }
});

test('Bayer preserves exact colors within a shared bucket and anchors a partial 4×4 tile', () => {
    for (const format of ['rgb565', 'rgb444']) {
        const data = new Uint8ClampedArray([3, 0, 0, 255, 7, 0, 0, 255, 0, 0, 0, 255]);
        const palette = [[0, 0, 0], [7, 0, 0], [0, 0, 0]];
        assert.deepEqual([...applyBayerPalette(data, palette, format, 3, 1)], [2, 1, 2]);
        assert.deepEqual([...applyBayerPalette(data, [[1, 0, 0]], format, 3, 1)], [0, 0, 0]);

        const width = 5, height = 5;
        const midpoint = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) =>
            i % 4 === 0 ? 127 : i % 4 === 3 ? 255 : 0);
        const original = midpoint.slice();
        assert.deepEqual([...applyBayerPalette(midpoint, [[0, 0, 0], [255, 0, 0]], format, width, height)], [
            1, 0, 1, 0, 1,
            0, 1, 0, 1, 0,
            1, 0, 1, 0, 1,
            0, 1, 0, 1, 0,
            1, 0, 1, 0, 1
        ]);
        assert.deepEqual(midpoint, original);
    }
});

test('default GIF bytes match 0.9.0, and Bayer matches across sync, raw and prepared Worker', async t => {
    const currentWorker = installWorker(t);
    for (const quality of ['high', 'fast']) for (const maxColors of [16, 64, 256]) {
        const options = { quality, maxColors };
        const expected = await exportGif(baseline(options));
        const palettes = decode(expected);
        for (const dither of [undefined, 'none']) {
            assert.deepEqual(await exportGif(createGifencEncoder({ ...options, dither })), expected);
            assert.deepEqual(await exportGif(createGifWorkerEncoder({ ...options, dither })), expected);
            const instance = currentWorker();
            assert.deepEqual(instance.init, { repeat: 3, maxColors, quality });
            assert.deepEqual(instance.initReply, { id: 1, rawPreparationVersion: 1 });
            await instance.exited;
            assert.equal(instance.terminations, 1);
        }

        const bayer = await exportGif(createGifencEncoder({ ...options, dither: 'bayer-4x4' }));
        assert.deepEqual(decode(bayer), palettes);
        if (maxColors === 16) assert.notDeepEqual(bayer, expected);
        const factory = createGifWorkerEncoder({ ...options, dither: 'bayer-4x4' });
        for (const prepared of [false, true]) {
            const encoder = prepared ? config => {
                const worker = factory(config);
                return { addFrame: worker.addFrame, finish: worker.finish, dispose: worker.dispose };
            } : factory;
            assert.deepEqual(await exportGif(encoder), bayer);
            const instance = currentWorker();
            await instance.exited;
            const action = prepared ? 'frame' : 'raw-frame-v1';
            assert.deepEqual(instance.actions, ['init', action, action, 'finish']);
            assert.deepEqual(instance.init, { repeat: 3, maxColors, quality, dither: 'bayer-4x4' });
            assert.deepEqual(instance.initReply, { id: 1, rawPreparationVersion: 1, activeDither: 'bayer-4x4' });
            assert.equal(instance.transfers, 2);
            assert.equal(instance.terminations, 1);
        }
    }
});

test('mixed Worker assets preserve defaults and reject unconfirmed Bayer before frame transfer', async t => {
    const currentWorker = installWorker(t);
    const directory = await mkdtemp(join(tmpdir(), 'canvastake-gif-dither-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const mixedRuntime = pathToFileURL(join(directory, 'gif-worker-runtime.mjs'));
    await copyFile(defaultRuntime, mixedRuntime);
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(join(directory, 'gifenc.js'), `export { createGifencEncoder } from ${JSON.stringify(oldCodec.href)};`);
    async function runtimeWithPatchedReply(name, fields) {
        const workerUrl = pathToFileURL(join(directory, name + '.mjs'));
        await writeFile(workerUrl, `
            import ${JSON.stringify(defaultRuntime.href)};
            const post = globalThis.postMessage;
            globalThis.postMessage = (reply, transfer) => post(
                reply.rawPreparationVersion === 1 ? { ...reply, ...${JSON.stringify(fields)} } : reply, transfer
            );`);
        return workerUrl;
    }
    const unknownRaw = await runtimeWithPatchedReply('unknown-raw', { rawPreparationVersion: 99 });
    const wrongMode = await runtimeWithPatchedReply('wrong-mode', { activeDither: 'none' });
    const quality = 'high', maxColors = 16;
    const expected = await exportGif(baseline({ quality, maxColors }));
    for (const workerUrl of [oldRuntime, mixedRuntime]) {
        assert.deepEqual(await exportGif(createGifWorkerEncoder({ workerUrl, quality, maxColors, dither: 'none' })), expected);
        assert.deepEqual(currentWorker().init, { repeat: 3, quality, maxColors });
        await currentWorker().exited;
        const encoder = createGifWorkerEncoder({ workerUrl, quality, maxColors, dither: 'bayer-4x4' })({ repeat: 3 });
        const frame = { ...makeSource(23, 13, 0), durationMs: 50 };
        const original = frame.data.slice();
        try {
            await assert.rejects(encoder[rawKey](frame, [20, 40, 60]), workerUrl === oldRuntime
                ? { name: 'NotSupportedError' } : /codec does not support bayer-4x4/);
            await assert.rejects(encoder.addFrame(frame));
            await assert.rejects(encoder.finish());
        } finally { encoder.dispose(); }
        assert.deepEqual(frame.data, original);
        const rejected = currentWorker();
        await rejected.exited;
        assert.deepEqual(rejected.actions, ['init']);
        assert.equal(rejected.transfers, 0);
        assert.equal(rejected.terminations, 1);
    }

    assert.deepEqual(await exportGif(legacyAdapter({ workerUrl: defaultRuntime, quality, maxColors })), expected);
    await currentWorker().exited;
    const dither = 'bayer-4x4';
    await assert.rejects(exportGif(createGifWorkerEncoder({ workerUrl: wrongMode, dither })), { name: 'NotSupportedError' });
    const rejected = currentWorker();
    await rejected.exited;
    assert.deepEqual(rejected.actions, ['init']);
    assert.equal(rejected.transfers, 0);
    assert.equal(rejected.terminations, 1);

    const bayer = await exportGif(createGifencEncoder({ quality, maxColors, dither }));
    assert.deepEqual(await exportGif(createGifWorkerEncoder({ workerUrl: unknownRaw, quality, maxColors, dither })), bayer);
    const fresh = currentWorker();
    await fresh.exited;
    assert.deepEqual(fresh.actions, ['init', 'frame', 'frame', 'finish']);
    assert.equal(fresh.transfers, 2);
    assert.equal(fresh.terminations, 1);
});
