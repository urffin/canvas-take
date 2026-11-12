// Opt-in feasibility experiment, NOT a CanvasTake backend or a production acceptance suite.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium, firefox } from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import { root, output, codecDirectory, sha256, prepare } from './webp-spike/prepare.mjs';
import { loadEncoder, encode } from './webp-spike/encoder.mjs';
import { specs, makeJob } from './webp-spike/fixtures.mjs';
import { inspect, checkExactTimeline, comparePixels, extractStill } from './webp-spike/oracle.mjs';

globalThis.require = createRequire(import.meta.url); // Generated upstream Node branch expects require.
const provenance = await prepare(process.argv.includes('--install'));
const module = await loadEncoder(pathToFileURL(resolve(codecDirectory, 'webp-wasm.js')).href,
    await readFile(resolve(codecDirectory, 'webp-wasm.wasm')));
const results = { date: new Date().toISOString(), base: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    node: process.version, platform: process.platform, arch: process.arch, provenance,
    encoderVersion: module.encoder_version(), fixtures: [], browsers: [], controls: [], ffmpeg: {} };
assert.equal(results.encoderVersion, '1.3.2');
for (const spec of specs) {
    const job = makeJob(spec), hashes = job.frames.map(f => sha256(f.data));
    const bytes = encode(module, job); assert.deepEqual(job.frames.map(f => sha256(f.data)), hashes, 'unmodified input');
    const envelope = inspect(bytes);
    await writeFile(resolve(output, 'files', spec.name + '.webp'), bytes);
    let exactTimeline = true;
    try { checkExactTimeline(envelope, spec); } catch { exactTimeline = false; }
    results.fixtures.push({ name: spec.name, width: spec.width, height: spec.height, lossless: job.lossless, quality: job.quality,
        expectedDelaysMs: spec.delays, expectedDurationMs: spec.delays.reduce((a, b) => a + b), bytes: bytes.length, sha256: sha256(bytes),
        envelope, exactTimeline, inputUnchanged: true });
}
// Freeze the discovered regression as an observation, not a passing backend acceptance test.
assert.deepEqual(results.fixtures[0].envelope.frames.map(f => f.durationMs), [55, 55]);
assert.equal(results.fixtures.find(f => f.name === 'single').envelope.animated, false);
assert.equal(results.fixtures.find(f => f.name === 'identical').envelope.animated, false);
const original = await readFile(resolve(output, 'files/final-hold.webp'));
for (const [name, bad] of [['truncated RIFF', original.subarray(0, original.length - 1)],
    ['wrong RIFF length', Buffer.from(original)]]) {
    if (name === 'wrong RIFF length') bad.writeUInt32LE(original.length, 4);
    assert.throws(() => inspect(bad)); results.controls.push({ name, detected: true });
}
const wrongDelay = Buffer.from(original);
wrongDelay.writeUIntLE(77, inspect(original).frames[0].durationOffset, 3);
assert.throws(() => checkExactTimeline(inspect(wrongDelay), specs[0]));
await writeFile(resolve(output, 'files/wrong-duration.webp'), wrongDelay);
const wrongPixels = makeJob(specs[0]); wrongPixels.frames[0].data.set([0, 0, 255, 255]);
await writeFile(resolve(output, 'files/wrong-pixels.webp'), encode(module, wrongPixels));
// Our installed FFmpeg cannot demux ANIM, but can independently decode copied VP8L payloads.
// This separates encoded straight-RGBA correctness from native animation-decoder conversions.
const decodeStill = bytes => execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'webp_pipe', '-i', 'pipe:0',
    '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], { input: bytes, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
results.ffmpeg.extractedFrames = [];
for (const fixture of results.fixtures.filter(f => f.lossless)) {
    const bytes = await readFile(resolve(output, 'files', fixture.name + '.webp')), spec = specs.find(s => s.name === fixture.name), job = makeJob(spec);
    let start = 0;
    const frames = [];
    for (let i = 0; i < Math.max(fixture.envelope.frames.length, 1); i++) {
        // Alpha-bearing cases use full-canvas NO_BLEND; remaining cases are fully opaque.
        let reference = 0, end = spec.delays[0];
        while (start >= end && reference < spec.delays.length - 1) end += spec.delays[++reference];
        const pixels = comparePixels(decodeStill(extractStill(bytes, fixture.envelope, i)), job.frames[reference].data, true);
        assert.equal(pixels.matches, true, 'independent still pixels: ' + fixture.name + ' frame ' + i);
        frames.push({ referenceFrame: reference, ...pixels });
        start += fixture.envelope.frames[i]?.durationMs ?? 0;
    }
    results.ffmpeg.extractedFrames.push({ name: fixture.name, frames });
}
const badPixels = await readFile(resolve(output, 'files/wrong-pixels.webp'));
assert.equal(comparePixels(decodeStill(extractStill(badPixels, inspect(badPixels), 0)), makeJob(specs[0]).frames[0].data, true).matches, false);
results.controls.push({ name: 'FFmpeg extracted-payload wrong-pixel control', detected: true });

const served = new Map([
    ...['browser-client.mjs', 'worker.mjs', 'encoder.mjs', 'fixtures.mjs'].map(name => ['/spike/' + name, resolve(root, 'scripts/webp-spike', name)]),
    ['/codec.mjs', resolve(codecDirectory, 'webp-wasm.js')], ['/codec.wasm', resolve(codecDirectory, 'webp-wasm.wasm')],
    ...[...specs.map(s => s.name), 'wrong-duration', 'wrong-pixels'].map(name => ['/files/' + name + '.webp', resolve(output, 'files', name + '.webp')])
]);
const server = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>WebP research</title>');
        const file = served.get(path); if (!file) return res.writeHead(404).end();
        const type = path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.webp') ? 'image/webp' : 'text/javascript';
        res.writeHead(200, { 'Content-Type': type }).end(await readFile(file));
    } catch { res.writeHead(500).end(); }
});
await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
try {
    // One page at a time; each browser and all Worker handles close before starting the next.
    for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
        const browser = await engine.launch();
        try {
            const page = await browser.newPage(); await page.goto('http://127.0.0.1:' + server.address().port);
            const raw = await page.evaluate(async () => (await import('/spike/browser-client.mjs')).run());
            await writeFile(resolve(output, name + '-raw.json'), JSON.stringify(raw, null, 2) + '\n');
            const workerCases = raw.cases.map(c => {
                const fixture = results.fixtures.find(f => f.name === (c.sourceName ?? c.name));
                assert.equal(sha256(Uint8Array.from(c.bytes)), fixture.sha256, 'Node/real Worker bytes');
                assert.equal(c.outputs, 1);
                return { name: c.name, sha256: fixture.sha256, matchesNode: true };
            });
            const decoded = raw.decoded.map(c => {
                const spec = specs.find(s => s.name === c.name), job = makeJob(spec), fixture = results.fixtures.find(f => f.name === c.name);
                assert.equal(c.frameCount, fixture.envelope.animated ? fixture.envelope.frames.length : 1);
                let rawStart = 0;
                const frames = c.frames.map((frame, i) => {
                    assert.equal(frame.width, spec.width); assert.equal(frame.height, spec.height);
                    // Map optimized encoded frames using RIFF time, avoiding viewer short-delay clamps.
                    let reference = 0, end = spec.delays[0];
                    while (rawStart >= end && reference < spec.delays.length - 1) end += spec.delays[++reference];
                    const pixels = comparePixels(frame.rgba, job.frames[reference].data, job.lossless);
                    rawStart += fixture.envelope.frames[i]?.durationMs ?? 0;
                    return { timestampUs: frame.timestamp, durationUs: frame.duration, referenceFrame: reference, pixels };
                });
                return { name: c.name, frameCount: c.frameCount, repetitionCount: c.repetitionCount, frames };
            });
            const delayControl = raw.controls.find(c => c.name === 'wrong-duration');
            assert.equal(delayControl.frames[0].duration, 77000, 'independent decoder observes duration mutation');
            assert.notEqual(delayControl.frames[0].duration, specs[0].delays[0] * 1000);
            const pixelControl = raw.controls.find(c => c.name === 'wrong-pixels');
            assert.equal(comparePixels(pixelControl.frames[0].rgba, makeJob(specs[0]).frames[0].data, true).matches, false);
            for (const c of raw.cancellations) { assert.equal(c.outputs, 0); if (c.cancel === 'encode-boundary') assert.equal(c.boundary, true); }
            assert.equal(raw.workers.opened, raw.workers.terminated); assert.equal(raw.workers.opened, raw.workers.handlersCleared);
            results.browsers.push({ name, version: browser.version(), workers: raw.workers, workerCases, decoded, cancellations: raw.cancellations,
                negativeControls: { durationMutationDetected: true, pixelMutationDetected: true } });
            console.log(name + ': ' + decoded.length + ' independently decoded fixtures; ' + raw.workers.terminated + ' Workers terminated');
        } finally { await browser.close(); }
    }
} finally { await new Promise(yes => server.close(yes)); }
results.ffmpeg.version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0];
try {
    const decoded = execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'warning', '-i', resolve(output, 'files/final-hold.webp'), '-pix_fmt', 'rgba', '-vsync', '0', '-f', 'rawvideo', 'pipe:1'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    results.ffmpeg.animationDecode = { success: true, bytes: decoded.length };
} catch (error) { results.ffmpeg.animationDecode = { success: false, exitCode: error.status, stderr: error.stderr?.toString().slice(-1600) }; }
results.limitations = [
    'This intentionally records rejected-candidate behavior; exit 0 is NOT WebP backend acceptance.',
    'Finite loop configuration is absent from the tested wrapper. Only the default infinite loop is observed.',
    'Static one-frame and identical-frame results lose timing/loop metadata; static repetitionCount differs between decoders.',
    'Cancellation is Worker termination at a call boundary, not certified interruption inside native compression.',
    'Worker handles/handlers are closed; physical memory reclamation, persistent native heap leaks and peak RSS are not measured.',
    'Decoded alpha is compared exactly; lossless RGB is compared only where alpha > 0; hidden RGB is not certified.',
    'Native animation ImageDecoder RGBA conversions are recorded verbatim, including RGB differences at partial alpha. Exact lossless payload pixels are separately verified with FFmpeg; extraction does not certify generic animation compositing.',
    'No production API, integration, throughput benchmark, Safari or package/bundler compatibility is certified.'
];
await writeFile(resolve(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
console.log('Research observations saved to benchmark-results/webp-research/results.json');
