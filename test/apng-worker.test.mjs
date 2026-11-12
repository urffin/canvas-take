import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createApngBatchEncoder } from '../dist/internal/apng-batch.js';
import { apngPlugin, apngSources } from '../scripts/apng-build.mjs';
import { patchUpng } from '../scripts/apng-upng-patch.mjs';
import { patchUpng as spikePatch } from '../scripts/apng-spike/upng-patch.mjs';
import { checkEnvelope, decode } from '../scripts/apng-spike/oracle.mjs';
import { microtasks } from './fixtures/apng-controller.mjs';

const frame = (delay = 55) => ({ width: 1, height: 1, data: new Uint8ClampedArray([120, 60, 20, 128]), durationMs: delay });
const context = options => ({ signal: new AbortController().signal, maxInputBytes: 64, ...options });
async function harness() {
    const code = await build({ entryPoints: ['src/internal/apng-worker.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser', define: { 'import.meta.url': '"https://test.invalid/internal/apng-worker.js"' } });
    const workers = [], timers = new Map(); let timerId = 0;
    class FakeWorker {
        listeners = new Map(); messages = []; terminated = 0;
        constructor(url, options) { this.url = String(url); this.options = options; workers.push(this); }
        addEventListener(type, listener) { this.listeners.set(type, listener); }
        removeEventListener(type, listener) { if (this.listeners.get(type) === listener) this.listeners.delete(type); }
        terminate() { this.terminated++; }
        postMessage(data, transfer) { if (this.throwPost) throw this.throwPost; this.messages.push({ data, transfer }); }
        reply(extra = {}, index = this.messages.length - 1) { const { id, action, version } = this.messages[index].data; this.listeners.get('message')?.({ data: { id, action, version, ...extra } }); }
    }
    const module = { exports: {} };
    vm.runInNewContext(code.outputFiles[0].text, { module, exports: module.exports, Worker: FakeWorker, URL, Error, DOMException, Uint8Array, ArrayBuffer,
        setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); } });
    return { create: module.exports.createApngWorkerEncoder, workers, timers };
}

test('APNG pinned build verifies pristine inputs and rejects patch drift/reapplication', async () => {
    await apngPlugin(); assert.equal(apngSources.length, 5);
    const source = await readFile('vendor/apng/UPNG.js', 'utf8'), patched = patchUpng(source);
    assert.equal(patched, spikePatch(source));
    assert.throws(() => patchUpng(patched), /guard/); assert.throws(() => patchUpng(source.replace('nimg.frames.length>1', 'nimg.frames.length>2')), /guard/);
    const map = JSON.parse(await readFile('dist/internal/apng-worker-runtime.js.map', 'utf8'));
    assert.equal(map.sources.length, map.sourcesContent.length); assert.ok(map.sourcesContent.some(s => s.includes('nimg.frames.length>0')));
    assert.ok(!map.sourcesContent.some(s => s.includes('compressionProbe')));
});

test('APNG real batch backend preserves single/multiple frame alpha, delays and plays', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'canvastake-apng-'));
    // Retained under the OS temp directory as independent decode evidence; no broad cleanup.
    for (const plays of [0, 1, 3, 0xffffffff]) for (const delays of [[65535], [1, 14, 55, 2000]]) {
        const encoder = createApngBatchEncoder({ plays }, context()), frames = delays.map(frame);
        frames.forEach(f => encoder.addFrame(f)); const bytes = encoder.finish(), spec = { width: 1, height: 1, plays, delays };
        checkEnvelope(bytes, spec); const path = join(dir, `${plays}-${delays.length}.apng`); await writeFile(path, bytes);
        await decode(path, spec, { width: 1, height: 1, frames });
        encoder.dispose(); assert.throws(() => encoder.addFrame(frame()), /closed/);
    }
});

test('APNG batch input/output budgets, malformed input and terminal resource release', () => {
    for (const options of [{ maxInputBytes: undefined }, { maxInputBytes: 0 }, { maxOutputBytes: 0 }]) assert.throws(() => createApngBatchEncoder({ plays: 0 }, context(options)), /budget/);
    const exact = createApngBatchEncoder({ plays: 1 }, context({ maxInputBytes: 4 })); exact.addFrame(frame()); assert.throws(() => exact.addFrame(frame()), /maxInputBytes/);
    const bytes = exact.finish();
    for (const limit of [bytes.length, bytes.length - 1]) {
        const e = createApngBatchEncoder({ plays: 1 }, context({ maxOutputBytes: limit })); e.addFrame(frame());
        if (limit === bytes.length) assert.equal(e.finish().length, limit); else assert.throws(() => e.finish(), /maxOutputBytes/);
        assert.throws(() => e.finish(), /closed/);
    }
    for (const change of [f => f.durationMs = 0, f => f.width = 0, f => f.data = new Uint8ClampedArray(new SharedArrayBuffer(4)), f => f.data = new Uint8ClampedArray(5).subarray(1)]) {
        const e = createApngBatchEncoder({ plays: 0 }, context()), f = frame(); change(f); assert.throws(() => e.addFrame(f)); e.dispose(); e.dispose();
    }
    const abort = new AbortController(), e = createApngBatchEncoder({ plays: 0 }, context({ signal: abort.signal })); e.addFrame(frame());
    const reason = new Error('abort'); abort.abort(reason); assert.throws(() => e.finish(), error => error === reason);
});

test('APNG Worker initializes once, transfers owned input, validates output and closes exactly once', async () => {
    const h = await harness(), e = h.create()({ plays: 3 }, context()), w = h.workers[0];
    assert.equal(w.url, 'https://test.invalid/internal/apng-worker-runtime.js'); assert.equal(w.options.type, 'module');
    const f = frame(), pending = e.addFrame(f); assert.equal(w.messages.length, 1); w.reply(); await microtasks();
    assert.equal(w.messages[1].data.action, 'frame'); assert.equal(w.messages[1].transfer[0], f.data.buffer); w.reply(); await pending;
    const finish = e.finish(); await microtasks(); w.reply({ bytes: new Uint8Array([137, 80]) }); assert.equal((await finish).length, 2);
    assert.equal(w.terminated, 1); assert.equal(w.listeners.size, 0); assert.equal(h.timers.size, 0); e.dispose(); assert.equal(w.terminated, 1);
});

test('APNG Worker abort during init/add/finish rejects pending work with original reason', async () => {
    for (const stage of ['init', 'add', 'finish']) {
        const h = await harness(), abort = new AbortController(), e = h.create()({ plays: 0 }, context({ signal: abort.signal })), w = h.workers[0];
        let pending;
        if (stage === 'init') pending = e.addFrame(frame());
        else { w.reply(); await microtasks(); pending = stage === 'add' ? e.addFrame(frame()) : e.finish(); await microtasks(); }
        const stale = w.listeners.get('message'), original = new Error(stage); abort.abort(original);
        await assert.rejects(pending, error => error === original); stale({ data: { id: 1, action: 'init', version: 1 } });
        e.dispose(); assert.equal(w.terminated, 1); assert.equal(h.timers.size, 0); assert.equal(w.listeners.size, 0);
    }
});

test('APNG Worker invalid acknowledgements/output, transport failures and timeout release all work', async () => {
    for (const kind of ['version', 'action', 'error', 'empty', 'shared', 'budget', 'load', 'messageerror', 'timeout', 'post']) {
        const h = await harness(), e = h.create({ timeoutMs: 20 })({ plays: 0 }, context({ maxOutputBytes: 1 })), w = h.workers[0];
        const pending = e.finish();
        if (['empty', 'shared', 'budget', 'post'].includes(kind)) { if (kind === 'post') w.throwPost = new Error('post failed'); w.reply(); await microtasks(); }
        if (kind === 'version') w.reply({ version: 2 });
        if (kind === 'action') w.reply({ action: 'frame' });
        if (kind === 'error') w.reply({ error: {} });
        if (kind === 'empty') w.reply({ bytes: new Uint8Array() });
        if (kind === 'shared') w.reply({ bytes: new Uint8Array(new SharedArrayBuffer(4)) });
        if (kind === 'budget') w.reply({ bytes: new Uint8Array(2) });
        if (kind === 'load') w.listeners.get('error')({ message: 'load error', preventDefault() {} });
        if (kind === 'messageerror') w.listeners.get('messageerror')();
        if (kind === 'timeout') [...h.timers.values()][0]();
        await assert.rejects(pending); assert.equal(w.terminated, 1, kind); assert.equal(w.listeners.size, 0); assert.equal(h.timers.size, 0);
    }
});

test('APNG Worker pre-abort and invalid timeout allocate no Worker; overlapping calls reject', async () => {
    const h = await harness(), abort = new AbortController(); abort.abort('cancelled');
    assert.throws(() => h.create()({ plays: 0 }, context({ signal: abort.signal })), e => e === 'cancelled');
    for (const value of [0, -1, Infinity, NaN, 2147483648, null]) assert.throws(() => h.create({ timeoutMs: value }), /timeoutMs/);
    assert.equal(h.workers.length, 0);
    const e = h.create()({ plays: 0 }, context()), pending = e.addFrame(frame());
    await assert.rejects(e.addFrame(frame()), /already pending/); await assert.rejects(e.finish(), /already pending/);
    e.dispose(); await assert.rejects(pending, { name: 'AbortError' });
});

test('retained APNG Worker transports release snapshots on initialization abort and post failure', () => {
    const output = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/apng-worker-gc.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /Retained APNG transports released frames/);
});
