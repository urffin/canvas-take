import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import gifenc from 'gifenc';
import {floydSteinberg, makeFrames, orderedBayer} from '../benchmarks/gif-dithering.mjs';
import {writeGifContactSheet} from './lib/gif-contact-sheet.mjs';
import {measureGifQuality} from './lib/gif-quality-metrics.mjs';
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
            prototype = {bytes, ...measureGifQuality(bytes, frames)};
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
            const {metrics, paletteSha256, previews: [preview]} = measureGifQuality(bytes, frames);
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
            panels.push(prototype.previews[0]);
        }
        if (maxColors < 256) writeGifContactSheet(join(output, `${scene}-${maxColors}-comparison.png`), panels, width, height);
    }
    assert.equal(sourceHash(), originalHash, 'Encoder mutated source RGBA');
}
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Results: ${output}`);
