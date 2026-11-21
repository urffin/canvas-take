import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import gifenc from 'gifenc';
import { decompressFrames, parseGIF } from 'gifuct-js';
import { createGifExporter } from '../dist/gif.js';
import { createGifencEncoder } from '../dist/gifenc.js';
import { createSampledGifencEncoder } from '../dist/internal/gif-sampled-encoder.js';
import { collectGifPaletteSample, gifPaletteSampleIndices, normalizeGifPaletteSampling } from '../dist/internal/gif-palette-sampling.js';
import { buildSampledGifPalette, createGifAccentCorrection } from '../dist/internal/gif-sampled-palette.js';
import { makePaletteFrames, paletteScenes } from '../benchmarks/gif-palette-scenes.mjs';
import { sampleCanvas, collectDefaultGifCases, sha256 } from './fixtures/gif-sampled-sync-reference.mjs';

const rgba = colors => Uint8ClampedArray.from(colors.flatMap(color => color.length === 4 ? color : [...color, 255]));
const makeCanvas = colors => sampleCanvas(colors.length, 1, rgba(colors));
const descriptor = (readFrame, frameCount = 1, accentColors) => ({ mode: 'sampled', source: { frameCount, readFrame }, accentColors });
const black = makeCanvas([[0, 0, 0]]);
const accent = [242, 245, 249];
const near = [243, 245, 249];
const translucent = [254, 250, 248, 128];
const background = [230, 240, 250];

async function exportGif(encoder, frames, options) {
    const exporter = createGifExporter({ encoder, ...options });
    try {
        for (const [canvas, delay] of frames) await exporter.addFrame(canvas, delay);
        const blob = await exporter.finish();
        assert.equal(blob.type, 'image/gif');
        return new Uint8Array(await blob.arrayBuffer());
    } finally { exporter.dispose(); }
}

function inspect(bytes, { dimensions, delays, repeat, maxColors }) {
    const gif = parseGIF(bytes.buffer);
    assert.deepEqual([gif.lsd.width, gif.lsd.height], dimensions);
    assert.ok(gif.gct.length >= 2 && gif.gct.length <= maxColors);
    const images = gif.frames.filter(frame => frame.image);
    assert.ok(images.every(frame => !frame.image.lct));
    const loops = gif.frames.find(frame => frame.application)?.application.blocks;
    if (repeat === -1) assert.equal(loops, undefined);
    else assert.deepEqual(Array.from(loops), [1, repeat & 255, repeat >> 8]);
    const frames = decompressFrames(gif, true);
    assert.deepEqual(frames.map(frame => frame.delay), delays);
    assert.ok(frames.every(frame => frame.disposalType === 1 &&
        frame.patch.every((value, i) => i % 4 !== 3 || value === 255)));
    return { gif, frames };
}

test('G1 sync: default and Bayer GIF bytes, snapshots and progress match the frozen 0.10.0 build', async () => {
    const { order, cases } = JSON.parse(await readFile(new URL('./fixtures/gif-sampled-sync-reference.json', import.meta.url)));
    assert.deepEqual(await collectDefaultGifCases({ createGifExporter, createGifencEncoder }), { order, cases });
});

test('G1 sync: a third-party Proxy can reject private probes and still receive owned opaque pixels', async () => {
    const pixels = rgba([translucent]);
    const events = [];
    const recipe = { addFrame({ data, durationMs }) {
        assert.deepEqual(data, rgba([accent]));
        events.push(['frame', durationMs]);
    }, finish() { return new TextEncoder().encode('GIF89a'); }, dispose() { events.push('dispose'); } };
    const proxy = new Proxy(recipe, {
        getOwnPropertyDescriptor(target, key) {
            if (typeof key === 'symbol') throw new Error('Public encoder only');
            return Reflect.getOwnPropertyDescriptor(target, key);
        },
        get(target, key, receiver) {
            if (typeof key === 'symbol') throw new Error('Public encoder only');
            return Reflect.get(target, key, receiver);
        }
    });
    await exportGif(() => proxy, [[sampleCanvas(1, 1, pixels), 23]], { background });
    assert.deepEqual(events, [['frame', 20], 'dispose']);
    assert.deepEqual(pixels, rgba([translucent]));
});

test('G2 sync: validate before use and snapshot the count, reader and ordered RGB bytes', async () => {
    let calls = 0;
    const source = { frameCount: 1, readFrame(index) {
        assert.equal(this, source);
        assert.equal(index, 0);
        calls++;
        return black;
    } };
    for (const [invalid, error] of [
        [null, TypeError], [{ mode: 'wrong', source }, TypeError], [{ mode: 'sampled' }, TypeError],
        [{ mode: 'sampled', source: { ...source, readFrame: false } }, TypeError],
        [{ mode: 'sampled', source: { ...source, frameCount: '4' } }, TypeError],
        [{ mode: 'sampled', source: { ...source, frameCount: 0 } }, RangeError],
        [{ mode: 'sampled', source: { ...source, frameCount: 2 ** 53 } }, RangeError],
        [{ mode: 'sampled', source, accentColors: null }, TypeError],
        [{ mode: 'sampled', source, accentColors: [[1, 2]] }, TypeError],
        [{ mode: 'sampled', source, accentColors: [[1, 2, '3']] }, TypeError],
        [{ mode: 'sampled', source, accentColors: [[1, 2, 256]] }, RangeError],
        [{ mode: 'sampled', source, accentColors: [[1, 2, 3], [4, 5, 6], [7, 8, 9]] }, RangeError]
    ]) {
        assert.throws(() => createSampledGifencEncoder({ maxColors: 2 }, invalid), error);
    }
    assert.throws(() => createSampledGifencEncoder({ quality: 'unknown' }, { mode: 'sampled', source }), TypeError);
    assert.throws(() => createSampledGifencEncoder({ dither: 'unknown' }, { mode: 'sampled', source }), TypeError);
    assert.throws(() => createSampledGifencEncoder({ maxColors: 1 }, { mode: 'sampled', source }), RangeError);
    const first = [91, 82, 73], second = [68, 51, 42];
    const spec = { mode: 'sampled', source, accentColors: [first, [...first], second] };
    const factory = createSampledGifencEncoder({ maxColors: 4 }, spec);
    spec.mode = 'invalid';
    source.frameCount = 50;
    source.readFrame = () => { throw new Error('Caller replaced the original reader'); };
    first.fill(0);
    spec.accentColors.reverse();
    assert.equal(calls, 0);
    const result = await exportGif(factory, [[black, 100]], { repeat: -1 });
    assert.equal(calls, 1);
    const { gif } = inspect(result, { dimensions: [1, 1], delays: [100], repeat: -1, maxColors: 4 });
    assert.deepEqual(gif.gct.slice(0, 3).map(color => [...color]), [[0, 0, 0], [91, 82, 73], [68, 51, 42]]);
});

test('G2 sync: reserve the budget, skip redundant reads and quantize only the compact prefix', async () => {
    const full = createSampledGifencEncoder({ maxColors: 2 }, descriptor(
        () => { throw new Error('No reads when the accents fill the budget'); }, 24, [accent, near]));
    const gif = await exportGif(full, [[makeCanvas([near, accent]), 100]], { repeat: 0 });
    assert.deepEqual(parseGIF(gif.buffer).gct.map(color => [...color]), [accent, near]);

    for (const format of ['rgb565', 'rgb444']) {
        assert.deepEqual(buildSampledGifPalette(rgba([accent, accent]), 2, [accent], format), [accent]);
        const sampled = [accent, accent, accent, [250, 10, 0], [20, 200, 15], accent, accent];
        const uncropped = rgba(sampled);
        const cropped = rgba(sampled.filter(color => color !== accent));
        const reference = gifenc.quantize(cropped, 1, { format });
        assert.notDeepEqual(gifenc.quantize(uncropped, 1, { format }), reference);
        assert.deepEqual(buildSampledGifPalette(uncropped, 2, [accent], format), [...reference, accent]);
        assert.deepEqual(buildSampledGifPalette(rgba([near]), 256, [], format), [near]);
    }
    const empty = makeCanvas([[17, 81, 194]]);
    const missingAccents = createSampledGifencEncoder({}, descriptor(() => empty));
    const explicitEmpty = createSampledGifencEncoder({}, descriptor(() => empty, 1, []));
    assert.deepEqual(await exportGif(missingAccents, [[empty, 100]]), await exportGif(explicitEmpty, [[empty, 100]]));
});

test('G3 sync: deterministic sample indices, grid centers and compact memory bound', async () => {
    for (const [n, indices] of [[1, [0]], [2, [0, 1]], [3, [0, 1, 2]], [4, [0, 1, 2, 3]], [24, [0, 8, 15, 23]],
        [Number.MAX_SAFE_INTEGER, [0, 3002399751580330, 6004799503160660, 9007199254740990]]]) {
        assert.deepEqual(gifPaletteSampleIndices(n), indices);
    }
    const width = 131, height = 145;
    const data = new Uint8ClampedArray(width * height * 4);
    let outstanding = 0, peak = 0;
    const calls = [];
    const reused = sampleCanvas(width, height, data, () => outstanding--);
    const source = normalizeGifPaletteSampling(descriptor(async index => {
        outstanding++;
        peak = Math.max(peak, outstanding);
        calls.push(index);
        await Promise.resolve();
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) data.set([x, y, index, 255], (x + y * width) * 4);
        }
        return reused;
    }, 24), 64);
    const sample = await collectGifPaletteSample(source, width, height, new AbortController().signal);
    assert.deepEqual(calls, [0, 8, 15, 23]);
    assert.equal(peak, 1);
    assert.equal(outstanding, 0);
    assert.equal(sample.byteLength, 64 * 1024);
    for (const [plane, index] of calls.entries()) {
        for (const [x, y] of [[0, 0], [1, 5], [63, 63]]) {
            const offset = (plane * 4096 + y * 64 + x) * 4;
            assert.deepEqual(Array.from(sample.subarray(offset, offset + 4)),
                [Math.floor((x + 0.5) * width / 64), Math.floor((y + 0.5) * height / 64), index, 255]);
        }
    }
    const tiny = makeCanvas([accent, translucent]);
    const tinySource = normalizeGifPaletteSampling(descriptor(() => tiny), 32);
    assert.deepEqual(await collectGifPaletteSample(tinySource, 2, 1, new AbortController().signal, background), rgba([accent, accent]));
    assert.deepEqual(tiny.data, rgba([accent, translucent]));
});

test('G3 sync: preserve the first snapshot and fail atomically on invalid replay', async () => {
    const canvas = makeCanvas([accent]);
    const order = [];
    const factory = createSampledGifencEncoder({ maxColors: 2 }, descriptor(() => {
        order.push('sample');
        return black;
    }, 1, [accent]));
    const exporter = createGifExporter({ encoder: factory, onProgress: p => order.push(p.phase) });
    const first = exporter.addFrame(sampleCanvas(1, 1, canvas.data, () => order.push('snapshot')), 25);
    assert.deepEqual(order, ['snapshot']);
    canvas.data.fill(0);
    await first;
    const bytes = new Uint8Array(await (await exporter.finish()).arrayBuffer());
    assert.deepEqual(order, ['snapshot', 'sample', 'encoding', 'finalizing', 'finished']);
    assert.deepEqual(decompressFrames(parseGIF(bytes.buffer), true)[0].patch, rgba([accent]));

    const taint = new DOMException('Tainted canvas', 'SecurityError');
    const rejecting = new Error('renderer failed');
    for (const [readFrame, expected] of [
        [() => makeCanvas([accent, near]), RangeError],
        [() => ({ width: 1, height: 1, getContext: () => ({ getImageData() { throw taint; } }) }), error => error === taint],
        [() => Promise.reject(rejecting), error => error === rejecting]
    ]) {
        const failed = createGifExporter({ encoder: createSampledGifencEncoder({}, descriptor(readFrame)) });
        await assert.rejects(failed.addFrame(black, 30), expected);
        assert.equal(failed.state, 'failed');
        await assert.rejects(failed.finish(), /failed/);
    }
    const direct = createSampledGifencEncoder({}, descriptor(() => black))({ repeat: -1 });
    await direct.addFrame({ width: 1, height: 1, data: rgba([accent]), durationMs: 30 });
    assert.ok(direct.finish() instanceof Uint8Array);
    const alpha = createSampledGifencEncoder({}, descriptor(() => makeCanvas([translucent])))({ repeat: -1 });
    await assert.rejects(alpha.addFrame({ width: 1, height: 1, data: rgba([accent]), durationMs: 30 }), /opaque/);
});

test('G4 sync: exact corrections preserve stock nonaccent indices even when blue bytes or buckets collide', () => {
    const otherAccent = [20, 70, 249];
    const unpinned = [31, 82, 249];
    const unrelated = [10, 90, 19];
    const data = rgba([near, accent, unpinned, otherAccent, unrelated]);
    const palette = [near, accent, otherAccent, unrelated];
    for (const format of ['rgb565', 'rgb444']) {
        const indices = gifenc.applyPalette(data, palette, format);
        assert.equal(indices[1], 0);
        const before = Array.from(indices);
        createGifAccentCorrection([accent, otherAccent], 1)(data, indices);
        assert.deepEqual(Array.from(indices), [before[0], 1, before[2], 2, before[4]]);
    }
    const indices = Uint8Array.of(17, 22, 33);
    const two = rgba([accent, near, otherAccent]);
    createGifAccentCorrection([accent], 0)(two, indices);
    createGifAccentCorrection([otherAccent], 255)(two, indices);
    assert.deepEqual(Array.from(indices), [0, 22, 255]);
});

test('G4–G5 sync: both presets and dither modes preserve decoded accents, timing and one global palette', async () => {
    const frames = [makeCanvas([near, accent, translucent, [30, 80, 249], [7, 91, 42]]),
        makeCanvas([[227, 240, 238], accent, translucent, [21, 17, 249], [7, 91, 42]])];
    const source = frames.map(canvas => canvas.data.slice());
    for (const quality of ['high', 'fast']) {
        for (const dither of ['none', 'bayer-4x4']) {
            for (const maxColors of [2, 32, 64, 128, 256]) {
                const factory = createSampledGifencEncoder({ quality, dither, maxColors },
                    descriptor(index => frames[index], 2, [accent]));
                const progress = [];
                const timeline = [[frames[0], 23], [frames[1], 1804]];
                const options = { background, repeat: 513, totalFrames: 1, maxFrames: 2, maxFramePixels: 5, maxDurationMs: 1820 };
                const bytes = await exportGif(factory, timeline, { ...options, onProgress: p => progress.push(p) });
                const decoded = inspect(bytes, { dimensions: [5, 1], delays: [20, 1800], repeat: 513, maxColors });
                for (const frame of decoded.frames) {
                    assert.deepEqual(frame.patch.subarray(4, 12), rgba([accent, accent]));
                }
                assert.equal(decoded.gif.gct.filter(rgb => rgb.every((value, i) => value === accent[i])).length, 1);
                assert.deepEqual(progress.map(p => [p.phase, p.framesEncoded, p.durationMs, p.totalFrames]), [
                    ['encoding', 1, 20, 1], ['encoding', 2, 1820, 1], ['finalizing', 2, 1820, 1], ['finished', 2, 1820, 1]
                ]);
                assert.deepEqual(frames.map(canvas => canvas.data), source);
                assert.deepEqual(bytes, await exportGif(factory, timeline, options));
            }
        }
    }
});

test('G4 sync: matches archived exact GIFs for flat text, moving gradient and scene cut', async () => {
    const archived = JSON.parse(await readFile(new URL('../docs/gif-accent-palette-benchmark-results.json', import.meta.url)));
    const accents = archived.namedAccents.map(color => color.rgb);
    const { width, height, count } = archived.metadata.settings;
    for (const scene of paletteScenes) {
        const { frames } = makePaletteFrames(scene, width, height, count);
        const sources = frames.map(frame => sampleCanvas(width, height, frame.data));
        const timeline = frames.map((frame, i) => [sources[i], frame.durationMs]);
        for (const maxColors of [32, 64, 128, 256]) {
            const factory = createSampledGifencEncoder({ maxColors }, descriptor(index => sources[index], count, accents));
            const bytes = await exportGif(factory, timeline, { repeat: 0 });
            const reference = archived.cases.find(row => row.mode === 'exact' && row.maxColors === maxColors && row.scene === scene);
            assert.equal(sha256(bytes), reference.sha256, scene + '/' + maxColors);
        }
    }
});

test('G5 sync: empty and limited exports do not sample or advance counters for rejected frames', async () => {
    let reads = 0;
    const factory = createSampledGifencEncoder({}, descriptor(() => { reads++; return black; }));
    const empty = createGifExporter({ encoder: factory });
    await assert.rejects(empty.finish(), /at least one frame/);
    assert.equal(reads, 0);
    for (const options of [{ maxFrames: 1 }, { maxDurationMs: 30 }, { maxFramePixels: 1 }]) {
        reads = 0;
        const progress = [];
        const exporter = createGifExporter({ encoder: factory, ...options, onProgress: p => progress.push(p) });
        let liveReads = 0;
        if (!options.maxFramePixels) await exporter.addFrame(black, 30);
        const rejectedCanvas = options.maxFramePixels ? sampleCanvas(2, 1, rgba([accent, near]), () => liveReads++)
            : sampleCanvas(1, 1, rgba([accent]), () => liveReads++);
        await assert.rejects(exporter.addFrame(rejectedCanvas, 30), RangeError);
        assert.equal(exporter.state, 'failed');
        assert.equal(liveReads, 0);
        assert.equal(reads, options.maxFramePixels ? 0 : 1);
        assert.deepEqual([progress.at(-1).phase, progress.at(-1).framesEncoded, progress.at(-1).durationMs],
            ['failed', reads, reads * 30]);
    }
});

test('sync sampling abort settles an uncooperative reader, ignores its late rejection and permits retry', async () => {
    let startRead, rejectRead, activeSignal;
    let blocked = true;
    const started = new Promise(resolve => { startRead = resolve; });
    const factory = createSampledGifencEncoder({}, descriptor((_index, signal) => {
        if (!blocked) return black;
        activeSignal = signal;
        startRead();
        return new Promise((_resolve, reject) => { rejectRead = reject; });
    }));
    const abort = new AbortController();
    const events = [];
    const exporter = createGifExporter({ encoder: factory, signal: abort.signal, onProgress: p => events.push(p.phase) });
    const adding = exporter.addFrame(black, 50);
    await started;
    const reason = new Error('cancel during replay');
    abort.abort(reason);
    await assert.rejects(adding, error => error === reason);
    assert.ok(activeSignal.aborted);
    assert.equal(exporter.state, 'aborted');
    rejectRead(new Error('late renderer failure'));
    await setImmediate();
    assert.deepEqual(events, ['aborted']);
    blocked = false;
    const first = await exportGif(factory, [[black, 50]]);
    assert.deepEqual(first, await exportGif(factory, [[black, 50]]));
    inspect(first, { dimensions: [1, 1], delays: [50], repeat: 0, maxColors: 256 });
});

test('sync sampling disposal between grid chunks stops later source reads', async () => {
    const width = 70, height = 70;
    const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => i % 4 === 3 ? 255 : 0);
    const calls = [], progress = [];
    let signal, exporter;
    const encoder = createSampledGifencEncoder({}, descriptor((index, cancellation) => {
        calls.push(index);
        signal = cancellation;
        return sampleCanvas(width, height, data, () => setTimeout(() => exporter.dispose(), 0));
    }, 4));
    exporter = createGifExporter({ encoder, onProgress: p => progress.push(p.phase) });
    await assert.rejects(exporter.addFrame(sampleCanvas(width, height, data), 50), { name: 'AbortError' });
    assert.equal(exporter.state, 'disposed');
    assert.ok(signal.aborted);
    assert.deepEqual(calls, [0]);
    assert.deepEqual(progress, ['disposed']);
});
