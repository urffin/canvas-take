// Opt-in Node/independent full-animation verification; never starts a browser or publishes.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { nodeWorkers } from '../test/fixtures/webp-node-client.mjs';
import { specs, jobFor, canvasFor } from './webp-integration/fixtures.mjs';
import { preparePillow } from './webp-integration/prepare-pillow.mjs';
import { inspect, verify, comparePixels, decodePayload } from './webp-libwebp/oracle.mjs';
import { createWebpController } from '../dist/internal/webp-controller.js';
import { createWebpWorkerEncoder } from '../dist/internal/webp-worker.js';
import { createWebpNativeEncoder } from '../dist/internal/webp-native.js';
import { validateWebpEnvelope } from '../dist/internal/webp-envelope.js';
import factory from '../dist/internal/webp-codec.js';
import { limits } from '../test/fixtures/webp-worker.mjs';
const pin = await preparePillow(process.argv.includes('--prepare-pillow'));
const out = resolve('benchmark-results/webp-integration'); await mkdir(out, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const records = [], h = nodeWorkers({ probe: true }), previous = globalThis.Worker; globalThis.Worker = h.Worker;
try {
    for (const spec of specs) {
        const job = jobFor(spec), before = job.frames.map(f => hash(f.data)), events = [];
        const exporter = createWebpController({ encoder: createWebpWorkerEncoder({ lossless: job.lossless, quality: job.quality }), plays: spec.plays, onProgress: p => events.push(p) });
        for (const frame of job.frames) await exporter.addFrame(canvasFor(job, frame), frame.duration);
        const blob = await exporter.finish(); exporter.dispose(); const bytes = new Uint8Array(await blob.arrayBuffer());
        assert.deepEqual(job.frames.map(f => hash(f.data)), before); assert.equal(events.at(-1).framesAccepted, job.frames.length);
        await writeFile(resolve(out, spec.name + '.webp'), bytes); records.push({ spec, job, bytes, events });
    }
} finally { for (const worker of h.workers) if (!worker.terminated) worker.terminate(); await h.drain(); globalThis.Worker = previous; }
assert.ok(h.workers.every(w => w.listeners.size === 0 && w.terminated === 1 && w.exitCode !== undefined));
assert.ok(h.workers.every(w => w.stats.at(-1).liveBytes === 0 && w.stats.at(-1).liveAllocations === 0));
assert.ok(h.workers.every(w => w.messages.filter(m => m.action === 'frame').every(m => m.detached)));
const first = records[0], controls = [];
const wrongHold = Buffer.from(first.bytes), parsed = inspect(wrongHold);
wrongHold.writeUIntLE(75, parsed.frames[0].durationOffset, 3); wrongHold.writeUIntLE(1980, parsed.frames[1].durationOffset, 3);
await validateWebpEnvelope(wrongHold, { width: first.job.width, height: first.job.height, plays: first.spec.plays, durationMs: 2055 }, async () => {}, () => {});
controls.push({ name: 'total-preserving-wrong-hold', bytes: wrongHold, reference: first });
const wrongPlays = Buffer.from(first.bytes);
for (let p = 12; p < wrongPlays.length;) { const size = wrongPlays.readUInt32LE(p + 4); if (wrongPlays.toString('ascii', p, p + 4) === 'ANIM') { wrongPlays.writeUInt16LE(2, p + 12); break; } p += 8 + size + (size & 1); }
controls.push({ name: 'wrong-plays', bytes: wrongPlays, reference: first });
const m = await factory({ wasmBinary: await readFile('dist/internal/webp-codec.wasm') });
const e = createWebpNativeEncoder(m, first.spec.plays, limits, { lossless: true, quality: 100, method: 4 });
first.job.frames.forEach((f, i) => { const data = new Uint8ClampedArray(f.data); if (!i) data.set([0, 0, 255, 255]); e.addFrame({ width: first.job.width, height: first.job.height, data, durationMs: f.duration }); });
controls.push({ name: 'wrong-pixels', bytes: e.finish(), reference: first });
assert.equal(m._ct_live_bytes(), 0); assert.equal(m._ct_live_allocations(), 0);
const erasure = records.find(r => r.spec.name === 'transparent-erasure'), ghost = Buffer.from(erasure.bytes), ghostFrames = inspect(ghost).frames;
ghost[ghostFrames[0].durationOffset + 3] &= ~1; ghost[ghostFrames[1].durationOffset + 3] &= ~2;
controls.push({ name: 'wrong-blend-ghost', bytes: ghost, reference: erasure });
for (const control of controls) await writeFile(resolve(out, control.name + '.webp'), control.bytes);
const input = [...records.map(r => ({ name: r.spec.name, bytes: Buffer.from(r.bytes).toString('base64') })), ...controls.map(c => ({ name: c.name, bytes: Buffer.from(c.bytes).toString('base64') }))];
const decoded = JSON.parse(execFileSync(resolve('benchmark-results/webp-libwebp/toolchain/python/python.exe'),
    ['scripts/webp-integration/pillow-oracle.py', resolve('benchmark-results/webp-pillow/site')], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 8388608, timeout: 30000 }));
assert.equal(decoded.pillow, pin.version);
function checkNative(actual, reference) {
    const { bytes, spec, job } = reference, envelope = inspect(bytes);
    assert.equal(actual.count, envelope.frames.length); assert.equal(actual.plays, spec.plays);
    let time = 0, comparisons = 0; const frames = [];
    actual.frames.forEach((f, i) => {
        assert.equal(f.width, job.width); assert.equal(f.height, job.height); assert.equal(f.timestamp, time); assert.equal(f.duration, envelope.frames[i].durationMs);
        let inputTime = 0, maxMeanError = 0;
        for (const input of job.frames) {
            const end = inputTime + input.duration;
            if (inputTime < time + f.duration && end > time) {
                const comparison = comparePixels(f.rgba, input.data, job.lossless); assert.equal(comparison.matches, true, 'independent presentation pixels'); comparisons++;
                let sum = 0, count = 0;
                for (let p = 0; p < input.data.length; p += 4) if (input.data[p + 3] >= 128) for (let c = 0; c < 3; c++) { sum += Math.abs(f.rgba[p + c] - input.data[p + c]); count++; }
                const mean = count ? sum / count : 0; maxMeanError = Math.max(maxMeanError, mean); if (!job.lossless) assert.ok(mean <= 100, 'declared lossy RGB MAE boundary');
            }
            inputTime = end;
        }
        frames.push({ durationMs: f.duration, timestampMs: f.timestamp, maxVisibleRgbMAE: maxMeanError }); time += f.duration;
    });
    assert.equal(time, job.frames.reduce((n, f) => n + f.duration, 0)); return { frames, intervalComparisons: comparisons };
}
const cases = records.map(record => {
    const actual = decoded.cases.find(c => c.name === record.spec.name), native = checkNative(actual, record);
    let ffmpeg;
    if (record.spec.name !== 'lossy-partial-alpha') ffmpeg = verify(record.bytes, record.spec, record.job);
    else {
        const frame = inspect(record.bytes).frames[0], pixels = decodePayload(record.bytes, frame);
        ffmpeg = { knownAlphaDiscrepancy: comparePixels(pixels, record.job.frames[0].data, false) };
        assert.equal(ffmpeg.knownAlphaDiscrepancy.alphaErrors, 6); assert.throws(() => verify(record.bytes, record.spec, record.job), /presentation pixels/);
    }
    return { name: record.spec.name, inputFrames: record.job.frames.length, bytes: record.bytes.length, sha256: hash(record.bytes), envelope: inspect(record.bytes), native, ffmpeg };
});
const negativeControls = controls.map(control => { assert.throws(() => checkNative(decoded.cases.find(c => c.name === control.name), control.reference)); return { name: control.name, independentlyRejected: true, envelopeAccepted: control.name === 'total-preserving-wrong-hold' }; });
const result = { date: new Date().toISOString(), base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), node: process.version,
    manifest: JSON.parse(await readFile('vendor/webp/manifest.json', 'utf8')), decoder: { pillow: decoded.pillow, libwebp: decoded.libwebp, pin, scope: 'Separate native Pillow/libwebp binary, not encoder WASM; same underlying codec family' },
    cases, negativeControls, workers: { opened: h.workers.length, exited: h.workers.filter(w => w.exitCode !== undefined).length, live: 0, framesTransferred: h.workers.flatMap(w => w.messages).filter(m => m.action === 'frame' && m.detached).length,
        finalNativeStats: h.workers.map(w => w.stats.at(-1)) }, browsersStarted: false, apiChanged: false, version: '0.7.0' };
await writeFile(resolve(out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`Verified ${cases.length} full animations, ${negativeControls.length} negative controls, ${h.workers.length} real Worker exits; native allocations zero. No browsers started.`);
