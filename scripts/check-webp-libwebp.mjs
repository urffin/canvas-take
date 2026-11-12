// Backend-only acceptance experiment; never imported by production entry points.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium, firefox } from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import { root, output, sha256 } from './webp-libwebp/toolchain.mjs';
import { encode, validate, stats } from './webp-libwebp/backend.mjs';
import { specs, jobFor, stressJob } from './webp-libwebp/fixtures.mjs';
import { verify, inspect, comparePixels } from './webp-libwebp/oracle.mjs';
import { checkWorkers } from './webp-libwebp/node-client.mjs';

const build = JSON.parse(await readFile(resolve(output, 'build-results.json'), 'utf8'));
assert.equal(build.reproducible, true);
for (const entry of build.builds) for (const asset of entry.assets) assert.equal(sha256(await readFile(resolve(output, entry.name, asset.file))), asset.sha256);
const bindingInputs = {};
for (const file of ['backend.c', 'tracking.h']) {
    const bytes = await readFile(resolve(root, 'scripts/webp-libwebp', file)); bindingInputs[file] = sha256(bytes);
    for (const entry of build.builds) assert.equal(sha256(await readFile(resolve(output, entry.name, file))), bindingInputs[file], 'compiled binding matches current source');
}
const { default: factory } = await import(pathToFileURL(resolve(output, 'build-a/backend.mjs')).href);
const module = await factory({ wasmBinary: await readFile(resolve(output, 'build-a/backend.wasm')) });
assert.equal(module._ct_version(), 0x010600);
const initial = stats(module);
const results = { date: new Date().toISOString(), base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version,
    checkerSha256: sha256(await readFile(new URL(import.meta.url))),
    build, bindingInputs, initial, cases: [], controls: [], invalidInputs: [], errors: [], memory: {}, browsers: [], nodeWorkers: {},
    ffmpeg: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0] };
const clean = () => { const value = stats(module); assert.equal(value.liveBytes, initial.liveBytes); assert.equal(value.liveAllocations, initial.liveAllocations); return value; };
await mkdir(resolve(output, 'files'), { recursive: true });
for (const spec of specs) {
    const job = jobFor(spec), before = job.frames.map(frame => sha256(frame.data));
    const bytes = encode(module, job), resource = clean(); assert.deepEqual(job.frames.map(frame => sha256(frame.data)), before);
    const decoded = verify(bytes, spec, job);
    await writeFile(resolve(output, 'files', spec.name + '.webp'), bytes);
    results.cases.push({ name: spec.name, width: spec.width, height: spec.height, plays: spec.plays, delays: spec.delays,
        bytes: bytes.length, sha256: sha256(bytes), decoded, resource });
    console.log('Decoded ' + spec.name + ': ' + decoded.frames.length + ' frames, ' + decoded.envelope.durationMs + ' ms');
}
const spec = specs[0], job = jobFor(spec), original = await readFile(resolve(output, 'files', spec.name + '.webp'));
const corrupt = Buffer.from(original); corrupt.writeUInt32LE(original.length, 4); assert.throws(() => inspect(corrupt));
results.controls.push('wrong RIFF length detected');
const wrongDelay = Buffer.from(original); wrongDelay.writeUIntLE(77, inspect(original).frames[0].durationOffset, 3);
assert.throws(() => verify(wrongDelay, spec, job)); results.controls.push('valid wrong duration detected');
await writeFile(resolve(output, 'files/wrong-delay.webp'), wrongDelay);
const wrongPlays = Buffer.from(original); let p = 12;
while (wrongPlays.toString('ascii', p, p + 4) !== 'ANIM') { const length = wrongPlays.readUInt32LE(p + 4); p += 8 + length + (length & 1); }
wrongPlays.writeUInt16LE(2, p + 12); assert.throws(() => verify(wrongPlays, spec, job)); results.controls.push('valid wrong plays detected');
await writeFile(resolve(output, 'files/wrong-plays.webp'), wrongPlays);
const wrongPixels = jobFor(spec); wrongPixels.frames[0].data.set([0, 0, 255, 255]);
const wrongBytes = encode(module, wrongPixels);
assert.throws(() => verify(wrongBytes, spec, job), /presentation pixels/); clean(); results.controls.push('valid wrong RGBA detected');
await writeFile(resolve(output, 'files/wrong-pixels.webp'), wrongBytes);
const wrongBlend = Buffer.from(original); wrongBlend[inspect(original).frames[1].durationOffset + 3] = 0;
assert.throws(() => verify(wrongBlend, spec, job), /OVER/); results.controls.push('unsupported partial-alpha OVER rejected');
await writeFile(resolve(output, 'files/wrong-blend.webp'), wrongBlend);
const invalid = [
    ['dimensions', { ...job, width: 0 }], ['pixel limit', { ...job, maxPixels: 0 }], ['frame limit', { ...job, maxFrames: 1 }],
    ['input limit', { ...job, maxInputBytes: 7 }], ['duration limit', { ...job, maxDurationMs: 55 }],
    ['RGBA length', { ...job, frames: [{ data: new Uint8Array(3), duration: 10 }] }],
    ['empty frames', { ...job, frames: [] }], ['oversized pixels', { ...jobFor(specs[1]), maxPixels: 17 }],
    ['quality infinity', { ...job, quality: Infinity }], ['invalid lossless', { ...job, lossless: 1 }],
    ['invalid method', { ...job, method: 7 }], ['output limit configuration', { ...job, maxOutputBytes: 0 }],
    ...[-1, 65536, 1.5, NaN].map(plays => ['plays ' + plays, { ...job, plays }]),
    ...[0, 16777216, 1.5, NaN].map(duration => ['delay ' + duration, { ...job, frames: [{ data: job.frames[0].data, duration }] }]),
    ['signed timestamp overflow', { ...job, frames: Array.from({ length: 129 }, () => ({ data: job.frames[0].data, duration: 16777215 })) }]
];
for (const [name, bad] of invalid) { const calls = stats(module).allocationCalls; assert.throws(() => encode(module, bad)); clean(); assert.equal(stats(module).allocationCalls, calls); results.invalidInputs.push(name); }
assert.equal(module._ct_open(0, 1, 1, 1, 100, 4, 1000), 0); clean(); results.errors.push('native configuration guard');
let nativeSession = 0, nativeInput = 0;
try {
    nativeSession = module._ct_open(1, 1, 1, 1, 100, 4, 1000); assert.ok(nativeSession);
    nativeInput = module._ct_malloc(4); assert.ok(nativeInput); module.HEAPU8.set([255, 0, 0, 255], nativeInput);
    assert.equal(module._ct_finish(nativeSession), 0, 'empty native finish');
    assert.equal(module._ct_add(nativeSession, nativeInput, 3, 55), 0, 'native RGBA length');
    assert.equal(module._ct_add(nativeSession, nativeInput, 4, 0), 0, 'native duration');
} finally { module._ct_free(nativeInput); module._ct_close(nativeSession); }
clean(); results.errors.push('native empty-finish/length/duration guards release session');
assert.throws(() => encode(module, { ...job, maxOutputBytes: 1 }), /Output byte limit/); clean(); results.errors.push('output byte limit releases assembled data');
const abort = new AbortController(), reason = new Error('abort reason'); abort.abort(reason);
assert.throws(() => encode(module, job, { signal: abort.signal }), error => error === reason); clean(); results.errors.push('pre-abort retains original reason');
const mid = new AbortController();
assert.throws(() => encode(module, job, { signal: mid.signal, onFrame() { mid.abort(reason); } }), error => error === reason); clean(); results.errors.push('between-frame abort cleanup');
assert.throws(() => encode(module, job, { nativeProgress() { throw reason; } }), error => error === reason); clean(); results.errors.push('native progress exception returns through C cleanup');
const callStart = stats(module).allocationCalls; encode(module, job); clean(); const calls = stats(module).allocationCalls - callStart;
const indices = [...new Set([0, 1, 2, 3, ...Array.from({ length: Math.min(calls, 128) }, (_, i) => Math.floor(i * calls / Math.min(calls, 128))), calls])];
const faults = [];
for (const index of indices) {
    module._ct_fail_after(index); let failed = false;
    try { encode(module, job); } catch { failed = true; } finally { module._ct_fail_after(-1); }
    clean(); faults.push({ index, failed });
}
assert.ok(faults.some(f => f.failed)); assert.equal(faults.at(-1).failed, false);
results.errors.push({ allocationFaults: faults, normalAllocationCalls: calls });
const samples = [];
for (let i = 0; i < 50; i++) { encode(module, jobFor(specs.find(spec => spec.name === 'alpha-ramp'))); const value = clean(); if (i % 5 === 0 || i === 49) { globalThis.gc?.(); samples.push({ iteration: i + 1, ...value, process: process.memoryUsage() }); } }
assert.equal(new Set(samples.slice(1).map(s => s.allocatorUsed)).size, 1, 'stable allocator used bytes after warm-up');
results.memory = { repetitions: 50, gcAvailable: typeof globalThis.gc === 'function', samples };
// Exercise successful high-water allocation as well as the cancellation/error paths.
const largeJob = { ...stressJob(), plays: 1 }, largeSamples = [];
let largeHash, largeDecoded;
for (let i = 0; i < 3; i++) {
    const bytes = encode(module, largeJob), resource = clean(), hash = sha256(bytes);
    if (i === 0) {
        largeHash = hash;
        largeDecoded = verify(bytes, { name: 'large-repeat', plays: 1 }, largeJob);
        await writeFile(resolve(output, 'files/large-repeat.webp'), bytes);
    } else assert.equal(hash, largeHash, 'deterministic repeated megapixel output');
    globalThis.gc?.(); largeSamples.push({ iteration: i + 1, ...resource, process: process.memoryUsage() });
    console.log('Megapixel repeat ' + (i + 1) + ': allocations released, ' + bytes.length + ' bytes');
}
assert.equal(new Set(largeSamples.map(sample => sample.allocatorUsed)).size, 1);
assert.equal(new Set(largeSamples.map(sample => sample.wasmCapacity)).size, 1, 'megapixel capacity stable after first export');
results.largeMemory = { width: largeJob.width, height: largeJob.height, repetitions: 3, sha256: largeHash, decoded: largeDecoded, samples: largeSamples };
const workers = await checkWorkers();
for (const retry of workers.retries) { assert.equal(sha256(retry.bytes), results.cases[0].sha256); assert.equal(retry.stats.liveBytes, 0); retry.sha256 = sha256(retry.bytes); delete retry.bytes; }
results.nodeWorkers = workers;
await writeFile(resolve(output, 'results-node.json'), JSON.stringify(results, null, 2) + '\n');

const served = new Map([
    ['/codec/backend.mjs', resolve(output, 'build-a/backend.mjs')], ['/codec/backend.wasm', resolve(output, 'build-a/backend.wasm')],
    ...['browser-client.mjs', 'browser-worker.mjs', 'worker-core.mjs', 'backend.mjs', 'fixtures.mjs'].map(name => ['/scripts/webp-libwebp/' + name, resolve(root, 'scripts/webp-libwebp', name)]),
    ['/scripts/webp-spike/fixtures.mjs', resolve(root, 'scripts/webp-spike/fixtures.mjs')],
    ...[...specs.map(spec => spec.name), 'wrong-delay', 'wrong-plays', 'wrong-pixels', 'wrong-blend'].map(name => ['/files/' + name + '.webp', resolve(output, 'files', name + '.webp')])
]);
const server = createServer(async (req, res) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    try {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>libwebp backend proof</title>');
        const file = served.get(path); if (!file) return res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.webp') ? 'image/webp' : 'text/javascript' }).end(await readFile(file));
    } catch { res.writeHead(500).end(); }
});
await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
try {
    for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
        const browser = await engine.launch();
        try {
            const page = await browser.newPage(), workerEvents = { opened: 0, closed: 0 };
            page.on('worker', worker => { workerEvents.opened++; worker.on('close', () => { workerEvents.closed++; }); });
            await page.goto('http://127.0.0.1:' + server.address().port);
            const raw = await page.evaluate(async () => (await import('/scripts/webp-libwebp/browser-client.mjs')).run());
            await writeFile(resolve(output, name + '-raw.json'), JSON.stringify(raw, null, 2) + '\n');
            for (const value of raw.cases) { const reference = results.cases.find(c => c.name === value.name) ?? results.cases[0]; assert.equal(sha256(Uint8Array.from(value.bytes)), reference.sha256); value.sha256 = reference.sha256; delete value.bytes; }
            const decoded = raw.decoded.map(value => {
                const reference = results.cases.find(c => c.name === value.name), fixture = specs.find(s => s.name === value.name), job = jobFor(fixture);
                assert.equal(value.count, reference.decoded.frames.length);
                assert.equal(value.repetitions, fixture.plays === 0 ? 'Infinity' : String(fixture.plays - 1), 'native finite/infinite repetitions including one frame');
                let start = 0, nativeStart = 0;
                const frames = value.frames.map((frame, i) => {
                    assert.equal(frame.width, job.width); assert.equal(frame.height, job.height);
                    let input = 0, end = job.frames[0].duration;
                    while (start >= end && input < job.frames.length - 1) end += job.frames[++input].duration;
                    const pixels = comparePixels(frame.rgba, job.frames[input].data, job.lossless);
                    assert.equal(pixels.alphaErrors, 0, name + ' native alpha: ' + value.name);
                    const fileDuration = reference.decoded.frames[i].durationMs;
                    const expectedNativeDuration = name === 'firefox' && fileDuration <= 10 ? 100 : fileDuration;
                    assert.equal(frame.duration, expectedNativeDuration * 1000, 'independent native duration: ' + value.name);
                    assert.equal(frame.timestamp, nativeStart * 1000, 'independent native timestamp: ' + value.name);
                    nativeStart += expectedNativeDuration;
                    start += reference.decoded.frames[i].durationMs;
                    return { durationUs: frame.duration, timestampUs: frame.timestamp, fileDurationMs: fileDuration, viewerClamped: expectedNativeDuration !== fileDuration, pixels };
                });
                return { name: value.name, count: value.count, repetitions: value.repetitions, frames };
            });
            assert.equal(raw.controls.find(c => c.name === 'wrong-delay').frames[0].duration, 77000);
            assert.equal(raw.controls.find(c => c.name === 'wrong-plays').repetitions, '1');
            assert.equal(comparePixels(raw.controls.find(c => c.name === 'wrong-pixels').frames[0].rgba, job.frames[0].data, true).matches, false);
            assert.ok(comparePixels(raw.controls.find(c => c.name === 'wrong-blend').frames[1].rgba, job.frames[1].data, true).alphaErrors > 0, 'native decoder detects transparent ghost from wrong blend');
            const closeStarted = performance.now();
            // The native callback's finite rendezvous is test instrumentation; wait for actual
            // close events rather than equating terminate()'s return with native teardown.
            for (let i = 0; i < 2000 && page.workers().length; i++) await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(page.workers().length, 0, 'Playwright Worker inventory empty: ' + page.workers().map(worker => worker.url()).join(', '));
            assert.equal(workerEvents.opened, workerEvents.closed, 'all observed Worker targets closed');
            results.browsers.push({ name, version: browser.version(), ...raw, decoded, liveWorkerInventory: 0, workerEvents, closeDrainMs: performance.now() - closeStarted });
            console.log(name + ': ' + decoded.length + ' independently decoded files; all ' + raw.workers.terminated + ' Workers terminated');
        } finally { await browser.close(); }
    }
} finally { await new Promise(yes => server.close(yes)); }
results.limitations = [
    'Reference source build is Windows x64 only; production API/build/exports and version are unchanged.',
    'Single-frame animation preservation requires two disclosed source guards; upstream defaults differ.',
    'Full keyframe policy deliberately avoids generic partial-alpha delta blending; no compression-ratio/performance claim.',
    'Browser native partial-alpha RGB conversions and short-delay/single-frame playback behavior are recorded separately from encoded file correctness.',
    'Allocator counters cover remapped libwebp and binding allocations, not browser/JS/system-library allocations. Capacity and process RSS need not shrink when all tracked allocations are freed.',
    'SAB/COOP/COEP are test instrumentation for deterministic in-codec cancellation, not a production deployment requirement or public adapter API.'
];
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log('Backend proof passed; results saved under benchmark-results/webp-libwebp');
