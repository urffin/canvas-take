import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {cpus, platform, release} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {makePaletteFrame, makePaletteFrames, paletteScenes} from '../benchmarks/gif-palette-scenes.mjs';
import {createGifExporter} from '../dist/gif.js';
import {writeGifContactSheet} from './lib/gif-contact-sheet.mjs';
import {createBenchmarkEncoder, inspectTables} from './lib/gif-palette-codec.mjs';
import {measureGifQuality} from './lib/gif-quality-metrics.mjs';
import {prepareSampledPalette, sampling} from './lib/gif-sampled-palette.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const modes = ['per-frame', 'fixed', 'sampled'];
const colorLimits = [32, 64, 128, 256];
const previous = JSON.parse(await readFile(join(root, 'docs/gif-shared-palette-benchmark-results.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');

const lazyClip = ({scene, width, height, count}) => ({
    width, height, count, readFrame: index => makePaletteFrame(scene, width, height, count, index)
});

async function paletteFor(mode, clip, maxColors, options) {
    if (mode === 'sampled') return prepareSampledPalette(clip, maxColors, options);
    const palette = mode === 'fixed' ? previous.palettes.find(row => row.maxColors === maxColors).entries : undefined;
    return {palette, prepMs:0, sampleMs:0, quantizeMs:0, sampleBytes:0, indices:[]};
}

async function exportClip(clip, encoder, options) {
    const gif = createGifExporter({encoder, repeat:0, ...options});
    try {
        for (let index = 0; index < clip.count; index++) {
            const {data, width, height, durationMs} = clip.readFrame(index);
            await gif.addFrame({width, height, getContext:() => ({getImageData:() => ({data})})}, durationMs);
        }
        return await gif.finish();
    } finally { gif.dispose(); }
}

async function runCase(clip, maxColors, mode) {
    const start = performance.now();
    const prepared = await paletteFor(mode, clip, maxColors);
    const encodeStart = performance.now();
    const blob = await exportClip(clip, createBenchmarkEncoder(maxColors, prepared.palette));
    const end = performance.now();
    return {
        ...prepared, bytes:new Uint8Array(await blob.arrayBuffer()),
        encodeMs:end - encodeStart, totalMs:end - start
    };
}

function memorySnapshot() {
    const {rss, heapUsed, external, arrayBuffers} = process.memoryUsage();
    return {rss, heapUsed, external, arrayBuffers, peakRssKiB:process.resourceUsage().maxRSS};
}

async function measureMemory(settings) {
    assert.equal(typeof globalThis.gc, 'function');
    const clip = lazyClip(settings);
    await yieldTurn();
    globalThis.gc();
    const baseline = memorySnapshot();
    const prepared = await paletteFor(settings.mode, clip, settings.maxColors);
    const afterPreparation = memorySnapshot();
    let output = await exportClip(clip, createBenchmarkEncoder(settings.maxColors, prepared.palette));
    const afterExport = memorySnapshot();
    const sizeBytes = output.size;
    output = undefined;
    await yieldTurn();
    globalThis.gc();
    return {...settings, baseline, afterPreparation, afterExport, afterGc:memorySnapshot(),
        sampleBytes:prepared.sampleBytes, sampleIndices:prepared.indices, sizeBytes};
}

async function checkCancel(clip, expectedHash, repeats) {
    const rows = [];
    for (const stage of ['pre-aborted', 'sampling', 'quantizing', 'encoding']) {
        for (let repeat = 0; repeat < repeats; repeat++) {
            const controller = new AbortController();
            const reason = new DOMException(`Benchmark cancellation at ${stage}`, 'AbortError');
            let requested, sampledPixels = 0, senderBytes, disposed = 0, encoded = 0;
            const readIndices = [], closedThreads = [], progress = [];
            const observedClip = {...clip, readFrame(index) { readIndices.push(index); return clip.readFrame(index); }};
            const abort = () => { requested = performance.now(); controller.abort(reason); };
            const observe = event => {
                if (event.phase === 'sampling') {
                    sampledPixels = event.sampledPixels;
                    if (stage === 'sampling') setImmediate(abort);
                }
                if (event.phase === 'quantizing') {
                    senderBytes = event.senderBytes;
                    if (stage === 'quantizing') abort();
                }
                if (event.phase === 'worker-closed') closedThreads.push(event.threadId);
            };
            if (stage === 'pre-aborted') abort();
            const run = async () => {
                const {palette} = await prepareSampledPalette(observedClip, 64, {signal:controller.signal, observe});
                assert.equal(stage, 'encoding');
                const factory = createBenchmarkEncoder(64, palette);
                await exportClip(observedClip, options => {
                    const encoder = factory(options);
                    return {...encoder, dispose() { disposed++; encoder.dispose(); }};
                }, {
                    signal:controller.signal,
                    onProgress(event) {
                        progress.push(event.phase);
                        if (event.phase === 'encoding') {
                            encoded = event.framesEncoded;
                            abort();
                        }
                    }
                });
            };
            await assert.rejects(run, error => error === reason);
            const settleMs = performance.now() - requested;
            assert.ok(Number.isFinite(settleMs) && settleMs >= 0);
            assert.deepEqual(closedThreads, stage === 'quantizing' || stage === 'encoding' ? [-1] : []);
            if (stage === 'pre-aborted') assert.equal(readIndices.length, 0);
            if (stage === 'sampling') {
                assert.deepEqual(readIndices, [0]);
                assert.equal(sampledPixels, sampling.gridSide * sampling.rowsPerTurn);
            }
            if (stage === 'quantizing' || stage === 'encoding') {
                assert.equal(senderBytes, 0);
                assert.equal(readIndices.length, sampling.maxFrames + (stage === 'encoding' ? 1 : 0));
                assert.equal(sampledPixels, sampling.maxFrames * sampling.gridSide ** 2);
            }
            assert.equal(disposed, stage === 'encoding' ? 1 : 0);
            assert.equal(encoded, stage === 'encoding' ? 1 : 0);
            assert.deepEqual(progress, stage === 'encoding' ? ['encoding', 'aborted'] : []);
            const retry = await runCase(clip, 64, 'sampled');
            assert.equal(hash(retry.bytes), expectedHash);
            rows.push({stage, repeat, settleMs, sampledPixels, readIndices, senderBytes:senderBytes ?? null,
                closedThreads, encoded, disposed, progress, retrySha256:expectedHash});
        }
    }
    return rows;
}

async function benchmark(quick) {
    const settings = quick ? {width:160, height:96, count:4, repeats:1}
        : {width:640, height:360, count:24, repeats:6};
    const startedAt = new Date().toISOString();
    const output = join(root, 'benchmark-results/gif-sampled-palette',
        (quick ? 'quick-' : '') + startedAt.replace(/[:.]/g, '-'));
    await mkdir(output, {recursive:true});
    console.log(`Writing sampled palette results to ${output}`);
    const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
    const report = {
        metadata:{
            startedAt, node:process.version, os:`${platform()} ${release()}`, cpu:cpus()[0]?.model.trim(),
            baseline:execFileSync('git', ['rev-parse','HEAD'], {cwd:root, encoding:'utf8'}).trim(),
            packageVersion:lock.version, gifenc:lock.packages['node_modules/gifenc'].version,
            gifuct:lock.packages['node_modules/gifuct-js'].version, settings, sampling, quality:'high', dither:'none'
        },
        sources:[], cases:[], memory:[], cancellation:[]
    };
    const {width, height, count, repeats} = settings;

    for (const scene of paletteScenes) {
        const {frames, cutFrame} = makePaletteFrames(scene, width, height, count);
        const clip = {width, height, count, readFrame:index => frames[index]};
        const digest = () => {
            const hasher = createHash('sha256');
            for (const {data} of frames) hasher.update(data);
            return hasher.digest('hex');
        };
        const sourceSha256 = digest(), executionOrder = [];
        if (!quick) assert.equal(sourceSha256, previous.sources.find(source => source.scene === scene).sha256);
        const previewFrames = cutFrame === undefined ? [Math.floor(count / 2)] : [cutFrame - 1, cutFrame];
        const cases = new Map(), previews = new Map();
        for (const maxColors of colorLimits) for (const mode of modes) {
            const {bytes, palette, indices, sampleBytes} = await runCase(clip, maxColors, mode);
            const sha256 = hash(bytes);
            if (!quick && mode !== 'sampled') {
                const priorMode = mode === 'fixed' ? 'shared' : mode;
                const reference = previous.cases.find(row =>
                    row.scene === scene && row.maxColors === maxColors && row.mode === priorMode);
                assert.equal(sha256, reference.sha256);
            }
            const tables = inspectTables(bytes, count, maxColors, palette);
            const quality = measureGifQuality(bytes, frames, {cutFrame, previewFrames});
            if (maxColors === 64) previews.set(mode, quality.previews);
            const file = `${scene}-${maxColors}-${mode}.gif`;
            await writeFile(join(output, file), bytes);
            cases.set(`${maxColors}/${mode}`, {
                scene, maxColors, mode, file, sizeBytes:bytes.length, sha256, paletteSha256:quality.paletteSha256,
                ...tables, ...quality.metrics, ...quality.temporal, sampleBytes, sampleIndices:indices,
                ...(mode === 'sampled' ? {sampledPalette:palette, sampledPaletteSha256:hash(JSON.stringify(palette))} : {}),
                timings:[]
            });
        }

        const orders = [
            ['per-frame','fixed','sampled'], ['fixed','sampled','per-frame'], ['sampled','per-frame','fixed'],
            ['sampled','fixed','per-frame'], ['per-frame','sampled','fixed'], ['fixed','per-frame','sampled']
        ];
        for (let round = 0; round < repeats; round++) {
            const limits = [0, 1, 3, 2].map(index => colorLimits[(index + round) % colorLimits.length]);
            executionOrder.push({limits, modes:orders[round]});
            for (const maxColors of limits) for (const mode of orders[round]) {
                const {bytes, prepMs, sampleMs, quantizeMs, encodeMs, totalMs} = await runCase(clip, maxColors, mode);
                const record = cases.get(`${maxColors}/${mode}`);
                assert.equal(hash(bytes), record.sha256);
                record.timings.push({prepMs, sampleMs, quantizeMs, encodeMs, totalMs});
            }
            console.log(`${scene}: completed round ${round + 1}/${repeats}`);
        }
        assert.equal(digest(), sourceSha256);
        const preview = `${scene}-64-comparison.png`;
        const panels = previewFrames.flatMap((index, i) => [frames[index].data, ...modes.map(mode => previews.get(mode)[i])]);
        writeGifContactSheet(join(output, preview), panels, width, height, 4);
        report.sources.push({scene, sha256:sourceSha256, cutFrame:cutFrame ?? null, preview, previewFrames, executionOrder});
        report.cases.push(...cases.values());
        if (scene === 'scene-cut') report.cancellation = await checkCancel(clip, cases.get('64/sampled').sha256, quick ? 1 : 4);
    }
    console.log(`Verified ${report.cancellation.length} cancellation and retry cases`);

    const memoryProfiles = (quick ? ['scene-cut'] : paletteScenes).map(scene => ({scene, width, height, count}));
    if (!quick) memoryProfiles.push({scene:'scene-cut', width:1280, height:720, count:48});
    for (const profile of memoryProfiles) {
        for (let repeat = 0; repeat < (quick ? 1 : 3); repeat++) for (const mode of modes) {
            const input = JSON.stringify({...profile, maxColors:64, mode, repeat});
            const result = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--memory-case', input],
                {cwd:root, encoding:'utf8', timeout:60000});
            report.memory.push(JSON.parse(result));
        }
        console.log(`${profile.scene} ${profile.width}×${profile.height}/${profile.count}: finished peak memory checks`);
    }

    await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`Results: ${output}`);
}

if (args.length === 2 && args[0] === '--memory-case') {
    console.log(JSON.stringify(await measureMemory(JSON.parse(args[1]))));
} else {
    assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--quick'), 'Use [--quick]');
    await benchmark(args.includes('--quick'));
}
