import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makePaletteFrames, paletteScenes} from '../benchmarks/gif-palette-scenes.mjs';
import {createGifExporter} from '../dist/gif.js';
import {writeGifContactSheet} from './lib/gif-contact-sheet.mjs';
import {createBenchmarkEncoder, createExactAccentMapper, inspectTables} from './lib/gif-palette-codec.mjs';
import {measureGifQuality} from './lib/gif-quality-metrics.mjs';
import {prepareSampledPalette, sampling} from './lib/gif-sampled-palette.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--quick'), 'Use [--quick]');
const quick = args.includes('--quick');
const settings = quick ? {width:160, height:96, count:4, repeats:1}
    : {width:640, height:360, count:24, repeats:6};
const {width, height, count, repeats} = settings;
const limits = [32, 64, 128, 256];
const modes = ['sampled', 'reserved', 'exact'];
const namedAccents = [
    {name:'title', rgb:[242, 245, 249]},
    {name:'counter', rgb:[98, 212, 185]},
    {name:'footer', rgb:[173, 194, 215]},
    {name:'highlight', rgb:[249, 218, 112]}
];
const accents = namedAccents.map(color => color.rgb);
const hash = data => createHash('sha256').update(data).digest('hex');
function hashFrames(frames) {
    const digest = createHash('sha256');
    for (const {data} of frames) digest.update(data);
    return digest.digest('hex');
}
const rgbHex = palette => Buffer.from(palette.flat()).toString('hex');

async function encode(frames, encoder) {
    const gif = createGifExporter({encoder, repeat:0});
    try {
        for (const {data, width, height, durationMs} of frames) {
            await gif.addFrame({width, height, getContext:() => ({getImageData:() => ({data})})}, durationMs);
        }
        return await gif.finish();
    } finally { gif.dispose(); }
}

async function runCase(clip, frames, maxColors, mode) {
    const start = performance.now();
    const prepared = await prepareSampledPalette(clip, maxColors, {
        accents:mode === 'sampled' ? undefined : accents
    });
    const encodeStart = performance.now();
    const mapper = mode === 'exact' ? createExactAccentMapper(prepared.palette, accents) : undefined;
    const blob = await encode(frames, createBenchmarkEncoder(maxColors, prepared.palette, mapper));
    const end = performance.now();
    return {
        ...prepared, bytes:new Uint8Array(await blob.arrayBuffer()),
        encodeMs:end - encodeStart, totalMs:end - start
    };
}

async function checkCollision() {
    const black = [0, 0, 0], neighbor = [240, 244, 248], accent = accents[0];
    const palette = [black, neighbor, accent];
    const frames = [neighbor, accent].map(first => {
        const data = new Uint8ClampedArray(8 * 8 * 4);
        for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
        data.set(first, 0);
        data.set(accent, (8 * 8 - 1) * 4);
        return {width:8, height:8, data, durationMs:80};
    });
    const rows = [];
    for (const mode of ['reserved', 'exact']) {
        const mapper = mode === 'exact' ? createExactAccentMapper(palette, [accent]) : undefined;
        const blob = await encode(frames, createBenchmarkEncoder(4, palette, mapper));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        inspectTables(bytes, frames.length, 4, palette);
        const {accentMetrics} = measureGifQuality(bytes, frames, {accents:[accent]});
        rows.push({mode, sha256:hash(bytes), ...accentMetrics});
    }
    assert.equal(rows[0].pixels, 3);
    assert.equal(rows[0].exact, 2);
    assert.equal(rows[0].staticPairs, 1);
    assert.equal(rows[0].staticPixelDelta, 4 / 3);
    assert.equal(rows[1].exact, 3);
    assert.equal(rows[1].staticPixelDelta, 0);
    assert.equal(rows[0].otherRgbRmse, 0);
    assert.equal(rows[1].otherRgbRmse, 0);
    return {neighbor, accent, rows};
}

const previous = JSON.parse(await readFile(join(root, 'docs/gif-sampled-palette-benchmark-results.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const startedAt = new Date().toISOString();
const output = join(root, 'benchmark-results/gif-accent-palette',
    (quick ? 'quick-' : '') + startedAt.replace(/[:.]/g, '-'));
await mkdir(output, {recursive:true});
console.log(`Writing accent palette results to ${output}`);
const report = {
    metadata:{
        startedAt, node:process.version, os:`${platform()} ${release()}`, cpu:cpus()[0]?.model.trim(),
        baseline:execFileSync('git', ['rev-parse','HEAD'], {cwd:root, encoding:'utf8'}).trim(),
        packageVersion:lock.version, gifenc:lock.packages['node_modules/gifenc'].version,
        gifuct:lock.packages['node_modules/gifuct-js'].version, settings, sampling, quality:'high', dither:'none'
    },
    namedAccents, collision:await checkCollision(), sources:[], cases:[]
};
console.log('Verified exact accent mapping on a shared RGB565 bucket');

const orders = [
    ['sampled','reserved','exact'], ['reserved','exact','sampled'], ['exact','sampled','reserved'],
    ['exact','reserved','sampled'], ['sampled','exact','reserved'], ['reserved','sampled','exact']
];

for (const scene of paletteScenes) {
    const {frames, cutFrame} = makePaletteFrames(scene, width, height, count);
    const clip = {width, height, count, readFrame:index => frames[index]};
    const sourceSha256 = hashFrames(frames), executionOrder = [];
    if (!quick) assert.equal(sourceSha256, previous.sources.find(source => source.scene === scene).sha256);
    const previewFrames = cutFrame === undefined ? [Math.floor(count / 2)] : [cutFrame - 1, cutFrame];
    const cases = new Map(), previews = new Map();
    for (const maxColors of limits) for (const mode of modes) {
        const {bytes, palette, indices, sampleBytes, unreservedPixels} = await runCase(clip, frames, maxColors, mode);
        const sha256 = hash(bytes), paletteRgbHex = rgbHex(palette);
        if (!quick && mode === 'sampled') {
            assert.equal(sha256, previous.cases.find(row =>
                row.scene === scene && row.maxColors === maxColors && row.mode === 'sampled').sha256);
        }
        assert.ok(palette.length <= maxColors);
        if (mode !== 'sampled') {
            assert.deepEqual(palette.slice(-accents.length), accents);
            assert.equal(new Set(palette.map(color => color.join(','))).size, palette.length);
        }
        const tables = inspectTables(bytes, count, maxColors, palette);
        const quality = measureGifQuality(bytes, frames, {cutFrame, previewFrames, accents});
        assert.ok(quality.accentMetrics.pixels > 0 && quality.accentMetrics.staticPairs > 0);
        if (mode === 'exact') {
            assert.equal(quality.accentMetrics.exactPixelPercent, 100);
            assert.equal(quality.accentMetrics.staticPixelDelta, 0);
            const reserved = cases.get(`${maxColors}/reserved`);
            assert.equal(reserved.paletteRgbHex, paletteRgbHex);
            assert.equal(reserved.accentMetrics.otherRgbRmse, quality.accentMetrics.otherRgbRmse);
        }
        if (maxColors === 64) previews.set(mode, quality.previews);
        const file = `${scene}-${maxColors}-${mode}.gif`;
        await writeFile(join(output, file), bytes);
        cases.set(`${maxColors}/${mode}`, {
            scene, maxColors, mode, file, sizeBytes:bytes.length, sha256, paletteRgbHex, paletteSize:palette.length,
            paletteSha256:quality.paletteSha256, ...tables, ...quality.metrics, ...quality.temporal,
            accentMetrics:quality.accentMetrics, sampleIndices:indices, sampleBytes,
            unreservedPixels:unreservedPixels ?? sampleBytes / 4, timings:[]
        });
    }

    for (let round = 0; round < repeats; round++) {
        const order = [0, 1, 3, 2].map(index => limits[(index + round) % limits.length]);
        executionOrder.push({limits:order, modes:orders[round]});
        for (const maxColors of order) for (const mode of orders[round]) {
            const {bytes, palette, prepMs, sampleMs, quantizeMs, encodeMs, totalMs} = await runCase(clip, frames, maxColors, mode);
            const record = cases.get(`${maxColors}/${mode}`);
            assert.equal(hash(bytes), record.sha256);
            assert.equal(rgbHex(palette), record.paletteRgbHex);
            record.timings.push({prepMs, sampleMs, quantizeMs, encodeMs, totalMs});
        }
        console.log(`${scene}: completed round ${round + 1}/${repeats}`);
    }
    assert.equal(hashFrames(frames), sourceSha256);
    const preview = `${scene}-64-comparison.png`;
    const panels = previewFrames.flatMap((index, i) => [frames[index].data, ...modes.map(mode => previews.get(mode)[i])]);
    writeGifContactSheet(join(output, preview), panels, width, height, 4);
    report.sources.push({scene, sha256:sourceSha256, cutFrame:cutFrame ?? null, preview, previewFrames, executionOrder});
    report.cases.push(...cases.values());
}

await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Results: ${output}`);
