import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makePaletteFrames, paletteScenes} from '../benchmarks/gif-palette-scenes.mjs';
import {createGifExporter} from '../dist/gif.js';
import {createGifencEncoder} from '../dist/gifenc.js';
import {createGifWorkerEncoder} from '../dist/gif-worker.js';
import {NodeModuleWorker} from '../test/fixtures/node-module-worker.mjs';
import {writeGifContactSheet} from './lib/gif-contact-sheet.mjs';
import {measureGifQuality} from './lib/gif-quality-metrics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--quick'), 'Use [--quick]');
const quick = args.includes('--quick');
const settings = quick ? {width: 160, height: 96, frames: 4, repeats: 1}
    : {width: 640, height: 360, frames: 24, repeats: 8};
const {width, height} = settings;
const matrix = [32, 64, 128, 256].flatMap(maxColors =>
    ['high', 'fast'].map(quality => ({quality, maxColors, dither: 'none'})));
const bayerControl = {quality: 'high', maxColors: 64, dither: 'bayer-4x4'};
const settingName = ({quality, maxColors, dither}) => `${quality}-${maxColors}-${dither}`;
const factories = {sync: createGifencEncoder, worker: createGifWorkerEncoder};
// Rotate an eight-setting Williams order so each main setting occupies each position once.
const order = [0, 1, 7, 2, 6, 3, 5, 4];
const startedAt = new Date().toISOString();
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const output = join(root, 'benchmark-results/gif-palette', (quick ? 'quick-' : '') + startedAt.replace(/[:.]/g, '-'));
await mkdir(output, {recursive: true});
console.log(`Writing GIF palette results to ${output}`);

const hash = data => createHash('sha256').update(data).digest('hex');
function hashFrames(frames) {
    const digest = createHash('sha256');
    for (const {data} of frames) digest.update(data);
    return digest.digest('hex');
}

let worker;
globalThis.Worker = class extends NodeModuleWorker {
    terminations = 0;
    constructor(url) {
        super(url);
        worker = this;
    }
    terminate() {
        this.terminations++;
        super.terminate();
    }
};

async function encode(sources, durations, adapter, options) {
    worker = undefined;
    const start = performance.now();
    const gif = createGifExporter({encoder: factories[adapter](options), repeat: 0});
    try {
        for (const [index, source] of sources.entries()) await gif.addFrame(source, durations[index]);
        const blob = await gif.finish();
        const exportMs = performance.now() - start;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return {bytes, exportMs};
    } finally {
        gif.dispose();
        if (adapter === 'worker') {
            assert.equal(worker?.terminations, 1);
            await worker.exited;
            assert.equal(worker.node.threadId, -1);
        }
    }
}

const report = {
    metadata: {
        startedAt, node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model.trim(),
        logicalCpus: cpus().length,
        baseline: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
        packageVersion: lock.version, gifenc: lock.packages['node_modules/gifenc'].version,
        gifuct: lock.packages['node_modules/gifuct-js'].version,
        settings, transport: 'Node worker_threads', timingBoundary: 'exporter creation to finalized Blob'
    },
    sources: [],
    cases: []
};

for (const scene of paletteScenes) {
    const {frames, cutFrame} = makePaletteFrames(scene, width, height, settings.frames);
    const previewFrames = cutFrame === undefined ? [Math.floor(frames.length / 2)] : [cutFrame - 1, cutFrame];
    const durations = frames.map(frame => frame.durationMs);
    const sources = frames.map(({data}) => ({width, height, getContext: () => ({getImageData: () => ({data})})}));
    const sourceSha256 = hashFrames(frames);
    const hasBayerControl = scene === 'moving-gradient';
    const options = hasBayerControl ? [...matrix, bayerControl] : matrix;
    const encoded = new Map(), timings = new Map();
    const executionOrder = [];

    for (const setting of options) {
        const key = settingName(setting);
        const sync = await encode(sources, durations, 'sync', setting);
        const parallel = await encode(sources, durations, 'worker', setting);
        assert.deepEqual(parallel.bytes, sync.bytes, `${scene}/${key} sync/Worker mismatch`);
        encoded.set(key, {bytes: sync.bytes, sha256: hash(sync.bytes)});
        timings.set(key, {sync: [], worker: []});
    }

    for (let round = 0; round < settings.repeats; round++) {
        const settingsOrder = order.map(index => matrix[(index + round) % matrix.length]);
        const adapterOrder = round % 2 ? ['worker', 'sync'] : ['sync', 'worker'];
        if (hasBayerControl) {
            // Put the control at either end without disrupting the order of the undithered cases.
            if (round % 2) settingsOrder.unshift(bayerControl);
            else settingsOrder.push(bayerControl);
        }
        executionOrder.push({settings: settingsOrder.map(settingName), adapters: adapterOrder});
        for (const setting of settingsOrder) {
            const key = settingName(setting);
            for (const adapter of adapterOrder) {
                const {bytes, exportMs} = await encode(sources, durations, adapter, setting);
                assert.equal(hash(bytes), encoded.get(key).sha256, `${scene}/${key}/${adapter} changed on repeat`);
                timings.get(key)[adapter].push(exportMs);
            }
        }
        console.log(`${scene}: completed round ${round + 1}/${settings.repeats}`);
    }

    const previews = new Map();
    let staticPixels, cutStaticPixels;
    for (const setting of options) {
        const key = settingName(setting);
        const {bytes, sha256} = encoded.get(key);
        const measured = measureGifQuality(bytes, frames, {cutFrame, previewFrames});
        staticPixels ??= measured.temporal.staticPixels;
        cutStaticPixels ??= measured.temporal.cutStaticPixels;
        assert.ok(staticPixels > 0, 'Fixture must retain unchanged source pixels');
        if (cutFrame !== undefined) assert.ok(cutStaticPixels > 0, 'Scene cut must retain unchanged source pixels');
        previews.set(key, measured.previews);
        const file = `${scene}-${key}.gif`;
        await writeFile(join(output, file), bytes);
        report.cases.push({scene, ...setting, file, sizeBytes: bytes.length, sha256, paletteSha256: measured.paletteSha256,
            ...measured.metrics, cutStaticPixelDelta: measured.temporal.cutStaticPixelDelta, timingsMs: timings.get(key)});
    }

    const grid = [];
    for (const [index, frameIndex] of previewFrames.entries()) {
        grid.push(frames[frameIndex].data);
        for (const key of ['high-64-none', 'fast-64-none']) grid.push(previews.get(key)[index]);
    }
    const preview = `${scene}-64-comparison.png`;
    writeGifContactSheet(join(output, preview), grid, width, height, 3);
    if (hasBayerControl) {
        const byName = name => previews.get(name)[0];
        writeGifContactSheet(join(output, 'moving-gradient-bayer-control.png'), [
            frames[previewFrames[0]].data, byName('high-64-none'), byName('high-64-bayer-4x4'), byName('high-256-none')
        ], width, height);
    }
    assert.equal(hashFrames(frames), sourceSha256, 'Encoder mutated source RGBA');
    report.sources.push({scene, sha256: sourceSha256, cutFrame: cutFrame ?? null, staticPixels, cutStaticPixels,
        preview, previewFrames, executionOrder});
}

await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Results: ${output}`);
