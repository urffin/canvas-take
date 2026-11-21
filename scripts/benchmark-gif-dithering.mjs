import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ffmpeg from 'ffmpeg-static';
import gifenc from 'gifenc';
import {decompressFrames, parseGIF} from 'gifuct-js';
import {floydSteinberg, makeFrames, orderedBayer} from '../benchmarks/gif-dithering.mjs';
import {createGifExporter} from '../dist/gif.js';
import {createGifencEncoder} from '../dist/gifenc.js';
import {createGifWorkerEncoder} from '../dist/gif-worker.js';
import {NodeModuleWorker} from '../test/fixtures/node-module-worker.mjs';

const {GIFEncoder, applyPalette, quantize} = gifenc;
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(new Set(args).size === args.length && args.every(arg => ['--quick', '--adapters'].includes(arg)),
    'Use [--quick] [--adapters]');
const quick = args.includes('--quick');
const adapters = args.includes('--adapters');
const settings = quick
    ? {width: 160, height: 96, frames: 4, maxColors: [16, 64], repeats: 1}
    : {width: 640, height: 360, frames: 24, maxColors: [16, 64, 256], repeats: adapters ? 8 : 6};
const commands = [
    ['none', 'bayer', 'floyd'], ['bayer', 'floyd', 'none'], ['floyd', 'none', 'bayer'],
    ['none', 'floyd', 'bayer'], ['floyd', 'bayer', 'none'], ['bayer', 'none', 'floyd']
];
const mappers = {
    none: (data, palette) => applyPalette(data, palette, 'rgb565'),
    bayer: orderedBayer,
    floyd: floydSteinberg
};
const factories = {
    'sync-none': createGifencEncoder,
    'worker-bayer': createGifWorkerEncoder,
    'sync-bayer': createGifencEncoder,
    'worker-none': createGifWorkerEncoder
};
const adapterMethods = Object.keys(factories);
const rotations = adapterMethods.map((_, i) => adapterMethods.slice(i).concat(adapterMethods.slice(0, i)));
const adapterOrder = [...rotations, ...rotations.map(order => [...order].reverse())];
let activeWorker;
if (adapters) globalThis.Worker = class extends NodeModuleWorker {
    constructor(url) {
        super(url);
        activeWorker = this;
    }
};
const hash = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const startedAt = new Date().toISOString();
const output = join(root, adapters ? 'benchmark-results/gif-dithering-adapters' : 'benchmark-results/gif-dithering',
    (quick ? 'quick-' : '') + startedAt.replace(/[:.]/g, '-'));
await mkdir(output, {recursive: true});
const report = {
    metadata: {
        startedAt, node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model,
        logicalCpus: cpus().length, baseline: git('rev-parse', 'HEAD'), packageVersion: lock.version,
        gifenc: lock.packages['node_modules/gifenc'].version, gifuct: lock.packages['node_modules/gifuct-js'].version,
        settings, order: (adapters ? adapterOrder : commands).slice(0, settings.repeats),
        ...(adapters ? {transport: 'Node worker_threads', timingBoundary: 'exporter creation to finalized Blob'} : {})
    },
    cases: []
};

function encode(frames, maxColors, method) {
    const start = performance.now();
    const encoder = GIFEncoder();
    let quantizeMs = 0, indexMs = 0;
    for (const {data, width, height, durationMs} of frames) {
        const frameStart = performance.now();
        const palette = quantize(data, maxColors, {format: 'rgb565'});
        const mappingStart = performance.now();
        const indices = mappers[method](data, palette, width, height);
        const encodeStart = performance.now();
        quantizeMs += mappingStart - frameStart;
        indexMs += encodeStart - mappingStart;
        encoder.writeFrame(indices, width, height, {palette, delay: durationMs, repeat: 0, dispose: 1});
    }
    encoder.finish();
    const bytes = encoder.bytes();
    const exportMs = performance.now() - start;
    return {bytes, timing: {exportMs, quantizeMs, indexMs, gifMs: exportMs - quantizeMs - indexMs}};
}

function checkCurrentAdapter(frames, maxColors, expected) {
    const adapter = createGifencEncoder({maxColors, quality: 'high'})({repeat: 0});
    try {
        for (const frame of frames) adapter.addFrame(frame);
        assert.deepEqual(adapter.finish(), expected);
    } finally { adapter.dispose(); }
}

async function encodeWithAdapter(frames, maxColors, method) {
    activeWorker = undefined;
    const dither = method.endsWith('-bayer') ? 'bayer-4x4' : 'none';
    const start = performance.now();
    const exporter = createGifExporter({ encoder: factories[method]({ maxColors, dither }), repeat: 0 });
    try {
        for (const {source, durationMs} of frames) await exporter.addFrame(source, durationMs);
        const blob = await exporter.finish();
        const exportMs = performance.now() - start;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {bytes, timing: {exportMs}};
    } finally {
        exporter.dispose();
        if (method.startsWith('worker-')) {
            assert.ok(activeWorker?.exited, 'Worker was not terminated');
            await activeWorker.exited;
        }
    }
}

function measure(bytes, frames) {
    const gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const decoded = decompressFrames(gif, true);
    const {width, height} = frames[0];
    assert.equal(gif.lsd.width, width);
    assert.equal(gif.lsd.height, height);
    assert.equal(decoded.length, frames.length);

    const blocksAcross = width / 8, blocksDown = height / 8;
    let squared = 0, blockSquared = 0, staticError = 0, staticPixels = 0, exact = 0;
    for (const [i, frame] of decoded.entries()) {
        const original = frames[i].data;
        const previousOriginal = frames[i - 1]?.data;
        const previousPatch = decoded[i - 1]?.patch;
        const {patch, dims} = frame;
        assert.deepEqual([dims.left, dims.top, dims.width, dims.height], [0, 0, width, height]);
        assert.equal(frame.delay, frames[i].durationMs);
        assert.equal(patch.length, original.length);
        const blocks = new Int32Array(blocksAcross * blocksDown * 3);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = (y * width + x) * 4;
                const block = (Math.floor(y / 8) * blocksAcross + Math.floor(x / 8)) * 3;
                assert.equal(patch[offset + 3], 255);
                const isStatic = previousOriginal && original[offset] === previousOriginal[offset] &&
                    original[offset + 1] === previousOriginal[offset + 1] && original[offset + 2] === previousOriginal[offset + 2];
                let same = true;
                for (let c = 0; c < 3; c++) {
                    const error = patch[offset + c] - original[offset + c];
                    squared += error * error;
                    blocks[block + c] += error;
                    if (error !== 0) same = false;
                    if (isStatic) staticError += Math.abs(patch[offset + c] - previousPatch[offset + c]);
                }
                if (same) exact++;
                if (isStatic) staticPixels++;
            }
        }
        for (const block of blocks) blockSquared += (block / 64) ** 2;
    }
    const pixels = width * height * frames.length;
    return {
        metrics: {
            rgbRmse: Math.sqrt(squared / (pixels * 3)),
            block8Rmse: Math.sqrt(blockSquared / (pixels * 3 / 64)),
            exactPixelPercent: 100 * exact / pixels,
            staticPixelDelta: staticError / (staticPixels * 3)
        },
        paletteSha256: hash(JSON.stringify(decoded.map(frame => frame.colorTable))),
        preview: decoded[Math.floor(decoded.length / 2)].patch
    };
}

function writePreview(path, panels, width, height) {
    const gutter = 8;
    const sheetWidth = width * 2 + gutter, sheetHeight = height * 2 + gutter;
    const sheet = Buffer.alloc(sheetWidth * sheetHeight * 4, Buffer.from([39, 43, 48, 255]));
    for (const [index, panel] of panels.entries()) {
        const startX = (index % 2) * (width + gutter);
        const startY = Math.floor(index / 2) * (height + gutter);
        for (let y = 0; y < height; y++) {
            sheet.set(panel.subarray(y * width * 4, (y + 1) * width * 4), ((startY + y) * sheetWidth + startX) * 4);
        }
    }
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba',
        '-s', `${sheetWidth}x${sheetHeight}`, '-i', 'pipe:0', '-frames:v', '1', '-threads', '1', '-y', path], {input: sheet});
}

const median = values => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const {width, height} = settings;

for (const scene of ['flat', 'gradient']) {
    const {frames, colorCount} = makeFrames(scene, width, height, settings.frames);
    if (adapters) {
        for (const frame of frames) {
            frame.data = new Uint8ClampedArray(frame.data.buffer);
            frame.source = {width, height, getContext: () => ({getImageData: () => ({data: frame.data})})};
        }
    }
    const sourceHash = () => {
        const digest = createHash('sha256');
        for (const frame of frames) digest.update(frame.data);
        return digest.digest('hex');
    };
    const originalHash = sourceHash();
    for (const maxColors of settings.maxColors) {
        const methods = adapters ? adapterMethods : Object.keys(mappers);
        const run = adapters ? encodeWithAdapter : encode;
        const samples = new Map(methods.map(method => [method, []]));
        const outputs = new Map();
        for (const method of samples.keys()) {
            const {bytes} = await run(frames, maxColors, method);
            if (method === 'none') checkCurrentAdapter(frames, maxColors, bytes);
            outputs.set(method, {bytes, sha256: hash(bytes)});
        }
        let prototype;
        if (adapters) {
            assert.deepEqual(outputs.get('sync-none').bytes, encode(frames, maxColors, 'none').bytes);
            assert.equal(outputs.get('worker-none').sha256, outputs.get('sync-none').sha256);
            assert.equal(outputs.get('worker-bayer').sha256, outputs.get('sync-bayer').sha256);
            const {bytes} = encode(frames, maxColors, 'bayer');
            prototype = {bytes, ...measure(bytes, frames)};
        }
        for (const order of report.metadata.order) {
            for (const method of order) {
                const {bytes, timing} = await run(frames, maxColors, method);
                assert.equal(hash(bytes), outputs.get(method).sha256, 'GIF changed between repeats');
                samples.get(method).push(timing);
            }
        }
        let expectedPalette;
        const panels = [frames[Math.floor(frames.length / 2)].data];
        for (const [method, {bytes, sha256}] of outputs) {
            const {metrics, paletteSha256, preview} = measure(bytes, frames);
            expectedPalette ??= paletteSha256;
            assert.equal(paletteSha256, expectedPalette, 'Dithering changed the shared palettes');
            if (!adapters || method.startsWith('sync-')) panels.push(preview);
            const timings = samples.get(method);
            const medianMs = median(timings.map(row => row.exportMs));
            const name = `${scene}-${maxColors}-${method}.gif`;
            await writeFile(join(output, name), bytes);
            report.cases.push({scene, sourceColors: colorCount, maxColors, method, file: name, bytes: bytes.length,
                sha256, paletteSha256, medianMs, timings, ...metrics});
            console.log(`${scene}/${maxColors}/${method}: ${bytes.length} bytes, ${medianMs.toFixed(1)} ms, block RMSE ${metrics.block8Rmse.toFixed(3)}`);
        }
        if (prototype) {
            assert.equal(prototype.paletteSha256, expectedPalette, 'Prototype used a different palette');
            report.prototype ??= [];
            report.prototype.push({scene, maxColors, bytes: prototype.bytes.length, sha256: hash(prototype.bytes), ...prototype.metrics});
            panels.push(prototype.preview);
        }
        if (maxColors < 256) writePreview(join(output, `${scene}-${maxColors}-comparison.png`), panels, width, height);
    }
    assert.equal(sourceHash(), originalHash, 'Encoder mutated source RGBA');
}
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Results: ${output}`);
