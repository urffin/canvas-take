import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import gifenc from 'gifenc';
import {parseGIF} from 'gifuct-js';
import {makePaletteFrames, paletteScenes} from '../benchmarks/gif-palette-scenes.mjs';
import {createGifExporter} from '../dist/gif.js';
import {createGifencEncoder} from '../dist/gifenc.js';
import {writeGifContactSheet} from './lib/gif-contact-sheet.mjs';
import {measureGifQuality} from './lib/gif-quality-metrics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--quick'), 'Use [--quick]');
const quick = args.includes('--quick');
const settings = quick ? {width:160, height:96, frames:4, repeats:1}
    : {width:640, height:360, frames:24, repeats:8};
const {width, height} = settings;
const colorLimits = [32, 64, 128, 256];
const format = 'rgb565';
const calibration = {width:320, height:180, frames:12, frameIndices:[1, 4, 8, 11], stride:4};
const startedAt = new Date().toISOString();
const output = join(root, 'benchmark-results/gif-shared-palette',
    (quick ? 'quick-' : '') + startedAt.replace(/[:.]/g, '-'));
await mkdir(output, {recursive:true});
console.log(`Writing shared palette results to ${output}`);

const hash = data => createHash('sha256').update(data).digest('hex');
function hashFrames(frames) {
    const digest = createHash('sha256');
    for (const {data} of frames) digest.update(data);
    return digest.digest('hex');
}

// Build fixtures before constructing any measured input. Every scene gets an equal
// number of sampled pixels and all measured clips reuse the same palette for a limit.
function makePaletteFixtures() {
    const {width, height, frames, frameIndices, stride} = calibration;
    const samples = new Uint8ClampedArray(width * height * 4 * paletteScenes.length * frameIndices.length / stride ** 2);
    let dest = 0;
    for (const scene of paletteScenes) {
        const input = makePaletteFrames(scene, width, height, frames).frames;
        for (const [phase, index] of frameIndices.entries()) {
            const {data} = input[index];
            for (let y = phase; y < height; y += stride) {
                for (let x = (phase + Math.floor(y / stride)) % stride; x < width; x += stride) {
                    const start = (y * width + x) * 4;
                    samples.set(data.subarray(start, start + 4), dest);
                    dest += 4;
                }
            }
        }
    }
    assert.equal(dest, samples.length);
    return colorLimits.map(maxColors => {
        const entries = gifenc.quantize(samples, maxColors, {format});
        assert.equal(entries.length, maxColors);
        return {maxColors, entries, sha256:hash(JSON.stringify(entries))};
    });
}

// Both timed paths use the same gifenc build and match the shipped writer settings.
// The first frame supplies the global table when a shared palette is provided.
function createBenchmarkEncoder(maxColors, palette) {
    return ({repeat}) => {
        let encoder = gifenc.GIFEncoder(), firstFrame = true;
        return {
            addFrame({data, width, height, durationMs}) {
                const colors = palette ?? gifenc.quantize(data, maxColors, {format});
                encoder.writeFrame(gifenc.applyPalette(data, colors, format), width, height, {
                    palette:palette && !firstFrame ? undefined : colors, delay:durationMs, repeat, dispose:1
                });
                firstFrame = false;
            },
            finish() {
                encoder.finish();
                const bytes = encoder.bytes();
                encoder = undefined;
                return bytes;
            },
            dispose() { encoder = undefined; }
        };
    };
}

async function encode(sources, durations, factory) {
    const start = performance.now();
    const gif = createGifExporter({encoder:factory(), repeat:0});
    try {
        for (const [index, source] of sources.entries()) await gif.addFrame(source, durations[index]);
        const blob = await gif.finish();
        const exportMs = performance.now() - start;
        return {bytes:new Uint8Array(await blob.arrayBuffer()), exportMs};
    } finally { gif.dispose(); }
}

function inspectTables(bytes, frames, maxColors, shared) {
    const gif = parseGIF(bytes.buffer);
    const images = gif.frames.filter(frame => frame.image).map(frame => frame.image);
    assert.equal(images.length, frames);
    assert.ok(gif.lsd.gct.exists);
    assert.equal(gif.frames.find(frame => frame.application).application.blocks[1], 0);
    const localTables = images.filter(image => image.descriptor.lct.exists).map(image => image.lct);
    assert.equal(localTables.length, shared ? 0 : frames - 1);
    assert.ok([gif.gct, ...localTables].every(table => table.length <= maxColors));
    if (shared) assert.deepEqual(gif.gct.map(color => Array.from(color)), shared);
    return {globalEntries:gif.gct.length, localTables:localTables.length,
        colorTableBytes:3 * (gif.gct.length + localTables.reduce((sum, table) => sum + table.length, 0))};
}

const palettes = makePaletteFixtures();
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const previous = JSON.parse(await readFile(join(root, 'docs/gif-palette-benchmark-results.json'), 'utf8'));
const report = {
    metadata: {
        startedAt, node:process.version, os:`${platform()} ${release()}`, cpu:cpus()[0]?.model.trim(),
        logicalCpus:cpus().length, baseline:execFileSync('git', ['rev-parse','HEAD'], {cwd:root, encoding:'utf8'}).trim(),
        packageVersion:lock.version, gifenc:lock.packages['node_modules/gifenc'].version,
        gifuct:lock.packages['node_modules/gifuct-js'].version, settings, quality:'high', dither:'none',
        adapter:'sync', timingBoundary:'exporter creation to finalized Blob, with palette fixtures already available',
        calibration
    },
    palettes, sources:[], cases:[]
};

for (const scene of paletteScenes) {
    const {frames, cutFrame} = makePaletteFrames(scene, width, height, settings.frames);
    const previewFrames = cutFrame === undefined ? [Math.floor(frames.length / 2)] : [cutFrame - 1, cutFrame];
    const durations = frames.map(frame => frame.durationMs);
    const sources = frames.map(({data}) => ({width, height, getContext:() => ({getImageData:() => ({data})})}));
    const sourceSha256 = hashFrames(frames);
    const recorded = new Map(), executionOrder = [];
    if (!quick) assert.equal(sourceSha256, previous.sources.find(source => source.scene === scene).sha256);
    for (const {maxColors, entries} of palettes) {
        const factories = {
            'per-frame':() => createBenchmarkEncoder(maxColors),
            shared:() => createBenchmarkEncoder(maxColors, entries)
        };
        const shipped = await encode(sources, durations, () => createGifencEncoder({maxColors, quality:'high', dither:'none'}));
        for (const [mode, factory] of Object.entries(factories)) {
            const {bytes} = await encode(sources, durations, factory);
            const sha256 = hash(bytes);
            if (mode === 'per-frame') {
                assert.deepEqual(bytes, shipped.bytes, 'The per-frame control differs from the shipped adapter');
                if (!quick) {
                    const reference = previous.cases.find(row =>
                        row.scene === scene && row.maxColors === maxColors && row.quality === 'high' && row.dither === 'none');
                    assert.equal(sha256, reference.sha256, 'The shipped reference differs from the earlier benchmark');
                }
            }
            recorded.set(`${maxColors}/${mode}`, {factory, bytes, sha256, timingsMs:[]});
        }
    }

    for (let round = 0; round < settings.repeats; round++) {
        const order = [0, 1, 3, 2].map(index => colorLimits[(index + round) % colorLimits.length]);
        const modes = round % 2 ? ['shared', 'per-frame'] : ['per-frame', 'shared'];
        executionOrder.push({colorLimits:order, modes});
        for (const maxColors of order) {
            for (const mode of modes) {
                const record = recorded.get(`${maxColors}/${mode}`);
                const {bytes, exportMs} = await encode(sources, durations, record.factory);
                assert.equal(hash(bytes), record.sha256, `${scene}/${maxColors}/${mode} changed on repeat`);
                record.timingsMs.push(exportMs);
            }
        }
        console.log(`${scene}: completed round ${round + 1}/${settings.repeats}`);
    }

    const previews = new Map();
    let temporal;
    for (const {maxColors, entries} of palettes) {
        for (const mode of ['per-frame', 'shared']) {
            const {bytes, sha256, timingsMs} = recorded.get(`${maxColors}/${mode}`);
            const tables = inspectTables(bytes, frames.length, maxColors, mode === 'shared' ? entries : undefined);
            const measured = measureGifQuality(bytes, frames, {cutFrame, previewFrames});
            temporal ??= measured.temporal;
            if (maxColors === 64) previews.set(mode, measured.previews);
            const file = `${scene}-${maxColors}-${mode}.gif`;
            await writeFile(join(output, file), bytes);
            report.cases.push({scene, maxColors, mode, file, sizeBytes:bytes.length, sha256,
                paletteSha256:measured.paletteSha256, ...tables, ...measured.metrics,
                cutStaticPixelDelta:measured.temporal.cutStaticPixelDelta, timingsMs});
        }
    }
    assert.ok(temporal.staticPixels > 0);
    if (cutFrame !== undefined) assert.ok(temporal.cutStaticPixels > 0);
    assert.equal(hashFrames(frames), sourceSha256, 'Encoder mutated source RGBA');
    const preview = `${scene}-64-comparison.png`;
    const panels = previewFrames.flatMap((frame, i) => [frames[frame].data, previews.get('per-frame')[i], previews.get('shared')[i]]);
    writeGifContactSheet(join(output, preview), panels, width, height, 3);
    report.sources.push({scene, sha256:sourceSha256, cutFrame:cutFrame ?? null,
        staticPixels:temporal.staticPixels, cutStaticPixels:temporal.cutStaticPixels, preview, previewFrames, executionOrder});
}

assert.deepEqual(palettes.map(palette => hash(JSON.stringify(palette.entries))), palettes.map(palette => palette.sha256));
await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Results: ${output}`);
