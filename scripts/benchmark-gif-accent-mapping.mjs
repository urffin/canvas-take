import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {makePaletteFrames, paletteScenes} from '../benchmarks/gif-palette-scenes.mjs';
import {createGifExporter} from '../dist/gif.js';
import {createBenchmarkEncoder, createBlueFilteredAccentMapper, createExactAccentMapper, inspectTables} from './lib/gif-palette-codec.mjs';
import {measureGifQuality} from './lib/gif-quality-metrics.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--quick'), 'Use [--quick]');
const quick = args.includes('--quick');
const settings = quick ? {width:160, height:96, count:4, repeats:2}
    : {width:640, height:360, count:24, repeats:8};
const {width, height, count, repeats} = settings;
const prior = JSON.parse(await readFile(join(root, 'docs/gif-accent-palette-benchmark-results.json'), 'utf8'));
const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
const accents = prior.namedAccents.map(color => color.rgb);
const modes = {reference:createExactAccentMapper, filtered:createBlueFilteredAccentMapper};
const hash = data => createHash('sha256').update(data).digest('hex');
function hashFrames(frames) {
    const digest = createHash('sha256');
    for (const {data} of frames) digest.update(data);
    return digest.digest('hex');
}

function readPalette(hex) {
    const bytes = Buffer.from(hex, 'hex');
    return Array.from({length:bytes.length / 3}, (_, index) => Array.from(bytes.subarray(index * 3, index * 3 + 3)));
}

async function encode(sources, maxColors, palette, createMapper, colors = accents) {
    let mappingMs = 0;
    const start = performance.now();
    const mapper = createMapper(palette, colors);
    const encoder = createBenchmarkEncoder(maxColors, palette, (data, table) => {
        const before = performance.now();
        const indices = mapper(data, table);
        mappingMs += performance.now() - before;
        return indices;
    });
    const gif = createGifExporter({encoder, repeat:0});
    try {
        for (const {canvas, durationMs} of sources) await gif.addFrame(canvas, durationMs);
        const blob = await gif.finish();
        const encodeMs = performance.now() - start;
        return {bytes:new Uint8Array(await blob.arrayBuffer()), encodeMs, mappingMs};
    } finally { gif.dispose(); }
}

const toSources = frames => frames.map(({data, width, height, durationMs}) => ({
    canvas:{width, height, getContext:() => ({getImageData:() => ({data})})}, durationMs
}));

async function checkControls() {
    const {neighbor, accent, rows} = prior.collision;
    const palette = [[0, 0, 0], neighbor, accent];
    const frames = [neighbor, accent].map(first => {
        const data = new Uint8ClampedArray(8 * 8 * 4);
        for (let offset = 3; offset < data.length; offset += 4) data[offset] = 255;
        data.set(first, 0);
        data.set(accent, (8 * 8 - 1) * 4);
        return {width:8, height:8, durationMs:80, data};
    });
    const legacy = await encode(toSources(frames), 4, palette, modes.reference, [accent]);
    const filtered = await encode(toSources(frames), 4, palette, modes.filtered, [accent]);
    assert.deepEqual(filtered.bytes, legacy.bytes);
    const collisionSha256 = hash(filtered.bytes);
    assert.equal(collisionSha256, rows.find(row => row.mode === 'exact').sha256);
    const {accentMetrics} = measureGifQuality(filtered.bytes, frames, {accents:[accent]});
    assert.equal(accentMetrics.exact, 3);
    assert.equal(accentMetrics.staticPixelDelta, 0);

    const first = [242, 245, 249], last = [14, 23, 249], sameBlue = [240, 244, 249];
    const largePalette = Array.from({length:256}, (_, i) => [i, i * 37 & 255, 17]);
    largePalette[0] = first;
    largePalette[1] = sameBlue;
    largePalette[255] = last;
    const data = Uint8ClampedArray.from([
        ...sameBlue, 255, ...first, 1, ...last, 127, 14, 24, 249, 0, ...first, 255
    ]);
    const sharedBlue = [first, last];
    const expected = modes.reference(largePalette, sharedBlue)(data, largePalette);
    const actual = modes.filtered(largePalette, sharedBlue)(data, largePalette);
    assert.deepEqual(actual, expected);
    assert.equal(actual[0], 1);
    assert.equal(actual[1], 0);
    assert.equal(actual[2], 255);
    assert.equal(actual[4], 0);
    assert.deepEqual(modes.filtered(largePalette, [])(data, largePalette), modes.reference(largePalette, [])(data, largePalette));
    return {collisionSha256, accentMetrics, sharedBlueIndices:Array.from(actual)};
}

function blueHitPercent(frames) {
    const known = new Uint8Array(256);
    for (const color of accents) known[color[2]] = 1;
    let total = 0, hits = 0;
    for (const {data} of frames) {
        total += data.length / 4;
        for (let offset = 2; offset < data.length; offset += 4) hits += known[data[offset]];
    }
    return 100 * hits / total;
}

const startedAt = new Date().toISOString();
const output = join(root, 'benchmark-results/gif-accent-mapping',
    (quick ? 'quick-' : '') + startedAt.replace(/[:.]/g, '-'));
await mkdir(output, {recursive:true});
console.log(`Writing exact mapping results to ${output}`);
const report = {
    metadata:{
        startedAt, node:process.version, os:`${platform()} ${release()}`, cpu:cpus()[0]?.model.trim(),
        baseline:execFileSync('git', ['rev-parse','HEAD'], {cwd:root, encoding:'utf8'}).trim(),
        packageVersion:lock.version, gifenc:lock.packages['node_modules/gifenc'].version,
        gifuct:lock.packages['node_modules/gifuct-js'].version, settings, quality:'high', dither:'none'
    },
    namedAccents:prior.namedAccents, controls:await checkControls(), sources:[], cases:[]
};
console.log('Verified RGB565 collision, shared blue values and palette indices 0 and 255');

for (const scene of [...paletteScenes, 'same-blue']) {
    const stress = scene === 'same-blue';
    const sourceScene = stress ? 'scene-cut' : scene;
    const {frames, cutFrame} = makePaletteFrames(sourceScene, width, height, count);
    if (stress) {
        // Force every pixel past the blue prefilter to measure the cost when it cannot skip any lookup.
        for (const {data} of frames) {
            for (let offset = 2; offset < data.length; offset += 4) data[offset] = accents[0][2];
        }
    }
    const sha256 = hashFrames(frames);
    if (!quick && !stress) assert.equal(sha256, prior.sources.find(source => source.scene === scene).sha256);
    const hitPercent = blueHitPercent(frames);
    if (stress) assert.equal(hitPercent, 100);
    const sources = toSources(frames), limits = stress ? [64] : [32, 64, 128, 256];
    const recorded = new Map(), executionOrder = [];

    for (const maxColors of limits) {
        const archived = prior.cases.find(row =>
            row.scene === sourceScene && row.maxColors === maxColors && row.mode === 'exact');
        const palette = readPalette(archived.paletteRgbHex);
        const reference = await encode(sources, maxColors, palette, modes.reference);
        const filtered = await encode(sources, maxColors, palette, modes.filtered);
        assert.deepEqual(filtered.bytes, reference.bytes, `${scene}/${maxColors} differs from the reference`);
        const gifSha256 = hash(reference.bytes);
        if (!quick && !stress) assert.equal(gifSha256, archived.sha256);
        const tables = inspectTables(filtered.bytes, count, maxColors, palette);
        const {metrics, accentMetrics, paletteSha256, temporal} = measureGifQuality(filtered.bytes, frames, {cutFrame, accents, previewFrames:[]});
        assert.ok(accentMetrics.pixels > 0);
        assert.equal(accentMetrics.exact, accentMetrics.pixels);
        assert.equal(accentMetrics.staticPixelDelta, 0);
        if (!quick && !stress) assert.deepEqual(accentMetrics, archived.accentMetrics);
        const file = `${scene}-${maxColors}.gif`;
        await writeFile(join(output, file), filtered.bytes);
        recorded.set(maxColors, {palette, row:{
            scene, maxColors, file, sizeBytes:filtered.bytes.length, sha256:gifSha256, paletteSha256,
            paletteRgbHex:archived.paletteRgbHex, ...tables, ...metrics, ...temporal, accentMetrics,
            timings:{reference:[], filtered:[]}
        }});
    }

    for (let round = 0; round < repeats; round++) {
        const pattern = stress ? [0] : [0, 1, 3, 2];
        const order = pattern.map(index => limits[(index + round) % limits.length]);
        const laneOrder = round % 2 ? ['filtered','reference'] : ['reference','filtered'];
        executionOrder.push({limits:order, modes:laneOrder});
        for (const maxColors of order) for (const mode of laneOrder) {
            const {palette, row} = recorded.get(maxColors);
            const {bytes, encodeMs, mappingMs} = await encode(sources, maxColors, palette, modes[mode]);
            assert.equal(hash(bytes), row.sha256, `${scene}/${maxColors}/${mode} changed on repeat`);
            row.timings[mode].push({encodeMs, mappingMs});
        }
        console.log(`${scene}: completed round ${round + 1}/${repeats}`);
    }
    assert.equal(hashFrames(frames), sha256);
    report.sources.push({scene, sha256, blueHitPercent:hitPercent, executionOrder});
    report.cases.push(...[...recorded.values()].map(({row}) => row));
}

await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Results: ${output}`);
