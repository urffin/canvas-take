// Opt-in private integration probe, not a package entry or production dependency.
import { createWebpController } from '/dist/internal/webp-controller.js';
import { createWebpWorkerEncoder } from '/dist/internal/webp-worker.js';
import { specs, jobFor } from './fixtures.mjs';
import { stressJob } from '../webp-libwebp/fixtures.mjs';
const check = (value, message) => { if (!value) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const NativeWorker = globalThis.Worker;
export const inventory = [];
globalThis.Worker = class extends NativeWorker {
    handlers = new Map(); posts = []; terminations = 0; stats = [];
    constructor(url, options) {
        super(url, options); this.url = String(url); inventory.push(this);
        this.probeListener = ({ data }) => { if (data.stats) this.stats.push({ action: data.action, ...data.stats }); };
        super.addEventListener('message', this.probeListener);
    }
    addEventListener(type, listener, options) { this.handlers.set(type, listener); return super.addEventListener(type, listener, options); }
    removeEventListener(type, listener, options) { if (this.handlers.get(type) === listener) this.handlers.delete(type); return super.removeEventListener(type, listener, options); }
    postMessage(message, transfer) {
        if (message.action === 'init' && globalThis.webpProbe) message.probe = globalThis.webpProbe;
        super.postMessage(message, transfer);
        const record = { action: message.action, id: message.id };
        if (message.action === 'frame') { record.detached = message.value.data.byteLength === 0; check(record.detached, 'owned snapshot really transferred'); }
        this.posts.push(record);
    }
    terminate() { super.removeEventListener('message', this.probeListener); this.terminations++; return super.terminate(); }
};
function makeCanvas(job, offscreen = false) {
    const canvas = offscreen ? new OffscreenCanvas(job.width, job.height) : Object.assign(document.createElement('canvas'), { width: job.width, height: job.height });
    const context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true }); check(context, 'real 2D canvas');
    return { canvas, context };
}
export async function decode(bytes) {
    const decoder = new ImageDecoder({ data: Uint8Array.from(bytes), type: 'image/webp', preferAnimation: true });
    try {
        await decoder.tracks.ready; const track = decoder.tracks.selectedTrack, frames = [];
        for (let i = 0; i < track.frameCount; i++) {
            const { image } = await decoder.decode({ frameIndex: i });
            try {
                const rgba = new Uint8Array(image.allocationSize({ format: 'RGBA' })); await image.copyTo(rgba, { format: 'RGBA' });
                frames.push({ timestamp: image.timestamp, duration: image.duration, width: image.displayWidth, height: image.displayHeight, rgba: [...rgba] });
            } finally { image.close(); }
        }
        return { count: track.frameCount, repetitions: String(track.repetitionCount), frames };
    } finally { decoder.close(); }
}
export async function capture(spec, options = {}, offscreen = false) {
    const job = jobFor(spec), { canvas, context } = makeCanvas(job, offscreen), frames = [], progress = [];
    const exporter = createWebpController({ encoder: createWebpWorkerEncoder({ lossless: job.lossless, quality: job.quality, ...options }), plays: spec.plays, onProgress: p => progress.push(p) });
    try {
        for (const f of job.frames) {
            const caller = new ImageData(new Uint8ClampedArray(f.data), job.width, job.height, { colorSpace: 'srgb' }); context.putImageData(caller, 0, 0);
            const readback = context.getImageData(0, 0, job.width, job.height, { colorSpace: 'srgb' }).data;
            frames.push({ duration: f.duration, data: [...readback] });
            const pending = exporter.addFrame(canvas, f.duration);
            context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = 'magenta'; context.fillRect(0, 0, canvas.width, canvas.height);
            await pending; check(caller.data.byteLength === job.width * job.height * 4 && readback.byteLength === caller.data.byteLength, 'caller storage stays attached');
        }
        const pending = exporter.finish(); check(exporter.finish() === pending, 'finish Promise identity'); const blob = await pending; exporter.dispose();
        const bytes = [...new Uint8Array(await blob.arrayBuffer())];
        check(blob.type === 'image/webp' && progress.at(-1).phase === 'finished', 'successful Blob after dispose');
        return { name: spec.name, width: job.width, height: job.height, lossless: job.lossless, quality: job.quality, plays: spec.plays, frames, bytes, progress, decoded: await decode(bytes) };
    } catch (error) {
        const details = []; for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth++) details.push(current.name + ': ' + current.message);
        throw new Error(spec.name + ': ' + details.join(' / '), { cause: error });
    } finally { exporter.dispose(); }
}
export async function runMatrix() {
    check(!crossOriginIsolated, 'ordinary export must not require COOP/COEP/SAB');
    const cases = []; for (const spec of specs) cases.push(await capture(spec));
    cases.push(await capture({ ...specs[0], name: 'offscreen-canvas' }, {}, true));
    const relocated = { workerUrl: '/relocated/runtime.js', wasmUrl: '/separate-assets/codec.wasm' };
    cases.push(await capture({ ...specs[0], name: 'independently-relocated-assets' }, relocated));
    cases.push(await capture({ ...specs[0], name: 'worker-only-override' }, { workerUrl: relocated.workerUrl }));
    cases.push(await capture({ ...specs[0], name: 'wasm-only-override' }, { wasmUrl: relocated.wasmUrl }));
    const wrongPixels = await capture({ ...specs[0], name: 'wrong-pixels', colors: [[0, 0, 255, 255], specs[0].colors[1]] });
    return { cases, wrongPixels, inventory: snapshot() };
}
export function snapshot() {
    return { objects: inventory.length, terminated: inventory.filter(w => w.terminations === 1).length,
        handlers: inventory.reduce((sum, w) => sum + w.handlers.size, 0), transfers: inventory.flatMap(w => w.posts).filter(p => p.action === 'frame' && p.detached).length,
        stats: inventory.flatMap(w => w.stats) };
}
export async function runFaults(corsOrigin) {
    const faults = [];
    for (const [name, options] of [['missing-worker', { workerUrl: '/missing-worker.js' }], ['missing-wasm', { wasmUrl: '/missing.wasm' }],
        ['html-as-wasm', { wasmUrl: '/html.wasm' }], ['wrong-profile', { workerUrl: '/wrong-profile-worker.js' }],
        ['cors-wasm', { wasmUrl: corsOrigin + '/codec.wasm' }], ['worker-connect-csp', { workerUrl: '/deny-connect/runtime.js' }]]) {
        const e = createWebpController({ encoder: createWebpWorkerEncoder({ timeoutMs: 5000, ...options }) }); let failure;
        try { await e.addFrame(makeCanvas(jobFor(specs[0])).canvas, 55); await e.finish(); } catch (error) { failure = error; }
        finally { e.dispose(); }
        check(failure, name + ' must fail'); faults.push({ name, error: failure.message, cause: failure.cause?.message });
    }
    return { faults, inventory: snapshot() };
}
export async function runCancellation() {
    const results = [];
    for (const stage of ['before-init', 'loading', 'capture-yield', 'finalizing']) {
        if (stage === 'loading') await fetch('/reset-slow');
        const abort = new AbortController(), reason = new Error(stage), job = jobFor(specs[0]), { canvas } = makeCanvas(job), events = [];
        const e = createWebpController({ encoder: createWebpWorkerEncoder(stage === 'loading' ? { wasmUrl: '/slow.wasm' } : {}), signal: abort.signal,
            onProgress(p) { events.push(p); if (stage === 'finalizing' && p.phase === 'finalizing') abort.abort(reason); } });
        let pending;
        if (stage === 'capture-yield' || stage === 'finalizing') await e.addFrame(canvas, 55);
        pending = stage === 'finalizing' ? e.finish() : e.addFrame(canvas, 55);
        const observed = pending.then(() => ({ succeeded: true }), error => ({ error }));
        if (stage === 'loading') {
            const deadline = performance.now() + 10000;
            while (!(await (await fetch('/slow-seen')).json()).seen) { check(performance.now() < deadline, 'WASM fetch entered'); await sleep(5); }
        }
        abort.abort(reason); const result = await observed; check(result.error === reason && !result.succeeded, 'cancel preserves reason: ' + stage);
        e.dispose(); check(events.at(-1).phase === 'aborted' && !events.some(p => p.phase === 'finished'), 'no cancelled success');
        results.push({ stage, framesAccepted: events.at(-1).framesAccepted, errorIdentity: true });
        const retry = await capture({ ...specs[0], name: 'retry-' + stage }); check(retry.bytes.length, 'fresh export after cancellation');
    }
    return { results, inventory: snapshot() };
}
export async function runNativeProbe() {
    check(crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined', 'test-only native pause needs isolated page');
    const flags = new Int32Array(new SharedArrayBuffer(8)); globalThis.webpProbe = { shared: flags.buffer }; globalThis.webpProbeFlags = flags;
    const job = stressJob(), { canvas, context } = makeCanvas(job); context.putImageData(new ImageData(new Uint8ClampedArray(job.frames[0].data), job.width, job.height), 0, 0);
    const abort = new AbortController(), reason = new Error('native pause'), phases = [];
    const e = createWebpController({ encoder: createWebpWorkerEncoder({ workerUrl: '/scripts/webp-integration/browser-probe-worker.mjs' }), signal: abort.signal, onProgress: p => phases.push(p.phase) });
    try {
        await e.addFrame(canvas, 55); const pending = e.finish(), observed = pending.then(() => ({ succeeded: true }), error => ({ error }));
        const deadline = performance.now() + 20000;
        while (!Atomics.load(flags, 0)) { check(performance.now() < deadline, 'actual native progress entered'); await sleep(1); }
        abort.abort(reason); const result = await observed; check(result.error === reason && !result.succeeded, 'native cancellation reason');
        check(!phases.includes('finished'), 'no Blob after native cancellation');
    } finally { e.dispose(); globalThis.webpProbe = undefined; }
    const retries = [];
    for (let i = 0; i < 3; i++) retries.push(await capture({ ...specs[0], name: 'native-retry-' + i }, { workerUrl: '/scripts/webp-integration/browser-probe-worker.mjs' }));
    check(snapshot().stats.filter(s => s.action === 'finish').every(s => s.liveBytes === 0 && s.liveAllocations === 0), 'native success allocations released');
    return { retries: retries.length, phaseAtSettlement: Atomics.load(flags, 0), phases, inventory: snapshot() };
}
