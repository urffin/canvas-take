import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Run the actual standalone controller with a deterministic clock/task queue, not a public test hook.
const { code } = await transform(await readFile(new URL('../dist/gif.js', import.meta.url), 'utf8'), { format: 'cjs' });
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function harness(channels = true) {
    const timers = new Map(), allCallbacks = [], ports = new Set(); let next = 0, clock = 0, clockError;
    const module = { exports: {} }, copies = [];
    function Pixels(value) {
        const data = new Uint8ClampedArray(value);
        copies.push(new WeakRef(data));
        return data;
    }
    class Channel {
        constructor() {
            let task;
            const close = () => { timers.delete(task); };
            this.port1 = { onmessage: null, close() { ports.delete(this); close(); } };
            this.port2 = { close() { ports.delete(this); close(); }, postMessage: () => {
                task = ++next; const callback = this.port1.onmessage;
                timers.set(task, callback); allCallbacks.push(callback);
            } };
            ports.add(this.port1); ports.add(this.port2);
        }
    }
    runInNewContext(code, { module, exports: module.exports, Uint8ClampedArray: Pixels, Uint8Array, MessageChannel: channels ? Channel : undefined,
        DOMException, Blob, performance: { now() { if (clockError) throw clockError; return ++clock; } },
        setTimeout(callback) { const id = ++next; timers.set(id, callback); allCallbacks.push(callback); return id; },
        clearTimeout(id) { timers.delete(id); } });
    return { create: module.exports.createGifExporter, timers, allCallbacks, copies, ports, failClock(error) { clockError = error; },
        async step() { const [id, callback] = timers.entries().next().value ?? []; assert.ok(callback, 'expected a pending task'); timers.delete(id); callback(); await microtasks(); } };
}
function source(width = 1024, height = 512) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 17) % 256;
    const original = data.slice();
    return { width, height, data, original, getContext: () => ({ getImageData: () => ({ data }) }) };
}
function adapter() {
    const stats = { frames: [], disposed: 0 };
    return { stats, factory: () => ({ addFrame(frame) { stats.frames.push(frame); },
        finish: () => new Uint8Array([71, 73, 70, 56, 57, 97]), dispose() { stats.disposed++; } }) };
}

for (const channels of [true, false]) test(`chunked preparation (${channels ? 'ports' : 'timer fallback'}) preserves the immediate snapshot and opaque adapter contract`, async () => {
    const h = harness(channels), a = adapter(), canvas = source(), background = [20, 40, 60];
    const events = [], gif = h.create({ encoder: a.factory, background, onProgress: p => events.push(p) });
    const work = gif.addFrame(canvas, 54);
    canvas.data.fill(0); canvas.width = 1; background.fill(255);
    assert.equal(h.copies.length, 1); assert.equal(a.stats.frames.length, 0);
    await assert.rejects(gif.addFrame(canvas, 50), /encoding/);
    await h.step();
    assert.equal(a.stats.frames.length, 0, 'one preparation task must not finish this frame');
    assert.equal(events.length, 0);
    let tasks = 1;
    while (h.timers.size) { await h.step(); assert.ok(++tasks < 100); }
    await work;
    assert.ok(tasks > 2);
    const frame = a.stats.frames[0];
    assert.deepEqual([frame.width, frame.height, frame.durationMs], [1024, 512, 50]);
    for (let i = 0; i < frame.data.length; i += 4) {
        const alpha = canvas.original[i + 3] / 255;
        for (let c = 0; c < 3; c++) assert.equal(frame.data[i + c], Math.round(canvas.original[i + c] * alpha + [20, 40, 60][c] * (1 - alpha)));
        assert.equal(frame.data[i + 3], 255);
    }
    assert.notEqual(frame.data.buffer, canvas.data.buffer);
    assert.equal(events.length, 1); assert.equal(events[0].framesEncoded, 1);
    await gif.finish(); gif.dispose();
    assert.equal(a.stats.disposed, 1); assert.equal(h.timers.size, 0); assert.equal(h.ports.size, 0);
});

test('abort/dispose between chunks clears the task, preserves the first reason and ignores late callbacks', async () => {
    for (const channels of [true, false]) for (const mode of ['abort', 'dispose']) for (const steps of [0, 1, 3]) {
        const h = harness(channels), a = adapter(), controller = new AbortController(), events = [];
        let listeners = 0;
        const signal = { get aborted() { return controller.signal.aborted; }, get reason() { return controller.signal.reason; },
            addEventListener(...args) { listeners++; controller.signal.addEventListener(...args); },
            removeEventListener(...args) { listeners--; controller.signal.removeEventListener(...args); } };
        const gif = h.create({ encoder: a.factory, signal, onProgress: p => events.push(p) });
        const work = gif.addFrame(source(), 50);
        for (let i = 0; i < steps; i++) await h.step();
        const reason = new Error('first cancellation');
        if (mode === 'abort') controller.abort(reason); else gif.dispose();
        await assert.rejects(work, mode === 'abort' ? error => error === reason : { name: 'AbortError' });
        assert.equal(h.timers.size, 0); assert.equal(h.ports.size, 0); assert.equal(listeners, 0);
        for (const callback of h.allCallbacks) callback();
        await microtasks();
        assert.equal(a.stats.frames.length, 0); assert.equal(a.stats.disposed, 1);
        assert.deepEqual(events.map(p => [p.phase, p.framesEncoded]), [[mode === 'abort' ? 'aborted' : 'disposed', 0]]);
        gif.dispose(); assert.equal(a.stats.disposed, 1);
        const fresh = adapter(), second = h.create({ encoder: fresh.factory });
        const retry = second.addFrame(source(2, 2), 50); await h.step(); await retry; await second.finish();
        assert.equal(fresh.stats.frames.length, 1); assert.equal(fresh.stats.disposed, 1);
    }
});

test('preparation task failure and invalid readback release resources before any encoder submission', async () => {
    for (const invalid of [true, false]) {
        const h = harness(), a = adapter(), gif = h.create({ encoder: a.factory });
        const canvas = source(2, 2);
        if (invalid) canvas.getContext = () => ({ getImageData: () => ({ data: new Uint8ClampedArray(1) }) });
        const work = gif.addFrame(canvas, 50);
        if (!invalid) { h.failClock(new Error('preparation clock failed')); await h.step(); }
        await assert.rejects(work, invalid ? /Invalid canvas pixel data/ : /preparation clock failed/);
        assert.equal(h.timers.size, 0); assert.equal(a.stats.disposed, 1); assert.equal(a.stats.frames.length, 0);
    }
});

test('retaining terminated exporters does not retain owned RGBA snapshots after GC', () => {
    const output = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/gif-preparation-gc.mjs', import.meta.url))], { encoding: 'utf8', timeout: 20000 });
    assert.match(output, /Four retained exporters released all owned snapshots/);
});

test('reentrant cancellation from canvas readback preserves its reason and schedules no late task', async () => {
    for (const mode of ['abort', 'dispose']) {
        const h = harness(), a = adapter(), controller = new AbortController(), reason = new Error('readback aborted');
        const gif = h.create({ encoder: a.factory, signal: controller.signal });
        const canvas = source(2, 2);
        canvas.getContext = () => ({ getImageData() {
            if (mode === 'abort') controller.abort(reason); else gif.dispose();
            return { data: canvas.data };
        } });
        await assert.rejects(gif.addFrame(canvas, 50), mode === 'abort' ? error => error === reason : { name: 'AbortError' });
        assert.equal(h.timers.size, 0); assert.equal(a.stats.frames.length, 0); assert.equal(a.stats.disposed, 1);
    }
});
