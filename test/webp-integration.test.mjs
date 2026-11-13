import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { nodeWorkers } from './fixtures/webp-node-client.mjs';
import { createWebpController } from '../dist/internal/webp-controller.js';
import { createWebpWorkerEncoder } from '../dist/internal/webp-worker.js';
import { createWebpNativeEncoder } from '../dist/internal/webp-native.js';
import factory from '../dist/internal/webp-codec.js';
import { specs, jobFor, canvasFor } from '../scripts/webp-integration/fixtures.mjs';
import { stressJob } from '../scripts/webp-libwebp/fixtures.mjs';
import { verify, inspect } from '../scripts/webp-libwebp/oracle.mjs';
import { limits, codec, frame } from './fixtures/webp-worker.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = await readFile(new URL('../dist/internal/webp-codec.wasm', import.meta.url));
async function record(spec, options = {}) {
    const job = jobFor(spec), progress = [], exporter = createWebpController({ encoder: createWebpWorkerEncoder({ lossless: job.lossless, quality: job.quality, ...options }), plays: spec.plays, onProgress: p => progress.push(p) });
    let blob;
    try {
        for (const f of job.frames) await exporter.addFrame(canvasFor(job, f), f.duration);
        const pending = exporter.finish(); assert.equal(exporter.finish(), pending); blob = await pending;
    } catch (error) { exporter.dispose(); throw new Error(spec.name + ': ' + error.message + ' / ' + error.cause?.message, { cause: error }); }
    assert.equal(blob.type, 'image/webp'); assert.equal(progress.at(-1).framesAccepted, job.frames.length);
    assert.equal(progress.at(-1).durationMs, job.frames.reduce((n, f) => n + f.duration, 0));
    exporter.dispose(); return { bytes: new Uint8Array(await blob.arrayBuffer()), job };
}
test('real private WebP controller/adapter/runtime exports 20 fixtures and independently verifies 19 with FFmpeg', { timeout: 120000 }, async () => {
    const h = nodeWorkers(), previous = globalThis.Worker; globalThis.Worker = h.Worker;
    try {
        for (const spec of specs) {
            const { bytes, job } = await record(spec);
            // FFmpeg 6.1.1 ALPH decoding maps 254/255 to 253/254 on this ramp. The opt-in
            // full-file Pillow oracle checks its exact alpha; never weaken the shared oracle.
            if (spec.name === 'lossy-partial-alpha') { assert.equal(inspect(bytes).durationMs, 290); continue; }
            const result = verify(bytes, spec, job);
            assert.ok(result.presentationMatches); assert.equal(result.envelope.durationMs, spec.delays.reduce((a, b) => a + b));
            if (spec.name === 'duplicate-middle') assert.deepEqual(result.frames.map(f => f.durationMs), [50, 160, 200]);
            if (spec.name === 'identical-uint24-split') assert.ok(result.frames.length > 1);
        }
    } finally { for (const w of h.workers) if (!w.terminated) w.terminate(); await h.drain(); globalThis.Worker = previous; }
    assert.equal(h.workers.length, specs.length); assert.ok(h.workers.every(w => w.terminated === 1 && w.listeners.size === 0 && w.exitCode !== undefined));
});
test('real WebP adapter/native output errors release tracked allocations and permit deterministic fresh retries', { timeout: 60000 }, async () => {
    const expected = new Map();
    for (const mode of [{}, { failAfter: 0 }, { failAfter: 5 }, { outputLimit: 1 }]) {
        const h = nodeWorkers({ probe: true, ...mode }), previous = globalThis.Worker; globalThis.Worker = h.Worker;
        try {
            const spec = specs[0];
            if (mode.outputLimit) {
                const e = createWebpController({ encoder: createWebpWorkerEncoder(), maxOutputBytes: 1 }); const job = jobFor(spec);
                await e.addFrame(canvasFor(job, job.frames[0]), 55); await assert.rejects(e.finish(), error => /Output byte limit/.test(error.cause?.message));
            } else if (mode.failAfter !== undefined) await assert.rejects(record(spec), /./);
            else { const { bytes } = await record(spec); expected.set(spec.name, hash(bytes)); }
            await h.drain(); assert.ok(h.workers.every(w => w.stats.at(-1).liveBytes === 0 && w.stats.at(-1).liveAllocations === 0));
        } finally { for (const w of h.workers) if (!w.terminated) w.terminate(); await h.drain(); globalThis.Worker = previous; }
        const retry = nodeWorkers(), old = globalThis.Worker; globalThis.Worker = retry.Worker;
        try { assert.equal(hash((await record(specs[0])).bytes), expected.get(specs[0].name)); } finally { for (const w of retry.workers) if (!w.terminated) w.terminate(); await retry.drain(); globalThis.Worker = old; }
    }
});
test('real WebP cancellation during loading and native compression awaits actual thread exit and supports retry', { timeout: 60000 }, async () => {
    for (const stage of ['loading', 'native']) {
        const flags = new Int32Array(new SharedArrayBuffer(8)), h = nodeWorkers({ probe: true, shared: flags.buffer, waitLoad: stage === 'loading' }), previous = globalThis.Worker;
        globalThis.Worker = h.Worker; const abort = new AbortController(), reason = new Error(stage), job = stage === 'native' ? stressJob() : jobFor(specs[0]);
        try {
            const events = [], exporter = createWebpController({ encoder: createWebpWorkerEncoder(), signal: abort.signal, onProgress: p => events.push(p.phase) });
            let pending;
            if (stage === 'loading') pending = exporter.addFrame(canvasFor(job, job.frames[0]), job.frames[0].duration);
            else {
                await exporter.addFrame(canvasFor(job, job.frames[0]), job.frames[0].duration); pending = exporter.finish();
                const deadline = performance.now() + 20000;
                while (!Atomics.load(flags, 0)) { assert.ok(performance.now() < deadline, 'inside native progress hook'); await delay(1); }
            }
            const observed = assert.rejects(pending, e => e === reason); abort.abort(reason); await observed;
            await h.drain(); assert.equal(events.at(-1), 'aborted'); assert.ok(!events.includes('finished')); assert.equal(h.workers[0].listeners.size, 0); assert.equal(h.workers[0].terminated, 1);
            if (stage === 'native') assert.equal(Atomics.load(flags, 0), 1, 'terminated inside instrumented native callback');
        } finally { for (const w of h.workers) if (!w.terminated) w.terminate(); await h.drain(); globalThis.Worker = previous; }
        const retry = nodeWorkers(), old = globalThis.Worker; globalThis.Worker = retry.Worker;
        try { assert.ok((await record(specs[0])).bytes.length); } finally { for (const w of retry.workers) if (!w.terminated) w.terminate(); await retry.drain(); globalThis.Worker = old; }
    }
});
test('real WebP native module repeatedly returns allocations to baseline and refuses mismatched ABI', async () => {
    const module = await factory({ wasmBinary: binary }), samples = [];
    for (let i = 0; i < 12; i++) {
        const e = createWebpNativeEncoder(module, 1, limits, codec); e.addFrame(frame()); const bytes = e.finish(); assert.ok(bytes.length); e.dispose();
        samples.push([module._ct_live_bytes(), module._ct_live_allocations(), module._ct_allocator_used()]);
    }
    assert.ok(samples.every(sample => sample.every(value => value === 0)));
    assert.throws(() => createWebpNativeEncoder({ ...module, _ct_profile: () => 0 }, 0, limits, codec), /ABI\/profile/);
});
test('real WebP Worker rejects missing/non-WASM explicit assets without falling back and exits cleanly', { timeout: 30000 }, async () => {
    for (const wasmUrl of [new URL('../vendor/webp/missing.wasm', import.meta.url), new URL('../vendor/webp/COPYING', import.meta.url)]) {
        const h = nodeWorkers(), previous = globalThis.Worker; globalThis.Worker = h.Worker;
        try {
            const e = createWebpController({ encoder: createWebpWorkerEncoder({ wasmUrl }) });
            await assert.rejects(e.addFrame(canvasFor(jobFor(specs[0]), jobFor(specs[0]).frames[0]), 55), error => /ENOENT|magic|WebAssembly/i.test(error.cause?.message));
            await h.drain(); assert.equal(h.workers[0].terminated, 1); assert.equal(h.workers[0].listeners.size, 0);
        } finally { for (const w of h.workers) if (!w.terminated) w.terminate(); await h.drain(); globalThis.Worker = previous; }
    }
});
test('retained private WebP transports release owned frame references after abort and post failure', () => {
    const output = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/webp-worker-gc.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /Retained WebP transports released frames/);
});
