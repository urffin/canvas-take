import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { hostHarness, runtimeHarness, nativeStub, context, frame, init, limits, codec, tick } from './fixtures/webp-worker.mjs';
import { createWebpNativeEncoder } from '../dist/internal/webp-native.js';

test('private WebP Worker snapshots configuration, resolves independent URLs lazily and owns one Worker per export', () => {
    const h = hostHarness({ globals: { document: { baseURI: 'https://site.invalid/app/' } } }), options = { workerUrl: './worker.js', wasmUrl: './codec.wasm', quality: 75 };
    const factory = h.create(options); options.wasmUrl = '/changed'; assert.equal(h.workers.length, 0);
    const a = factory({ plays: 3 }, context()), b = h.create({ workerUrl: '/elsewhere/worker.js' })({ plays: 0 }, context());
    assert.equal(h.workers[0].url, 'https://site.invalid/app/worker.js'); assert.equal(h.workers[0].options.type, 'module');
    assert.equal(h.workers[0].messages[0].data.value.wasmUrl, 'https://site.invalid/app/codec.wasm');
    assert.equal(h.workers[0].messages[0].data.value.codec.quality, 75);
    assert.equal(h.workers[1].messages[0].data.value.wasmUrl, 'https://test.invalid/internal/webp-codec.wasm');
    a.dispose(); b.dispose(); assert.equal(h.timers.size, 0);
});
test('private WebP Worker rejects invalid configuration/context and pre-abort without acquisition', () => {
    const h = hostHarness();
    for (const bad of [{ lossless: 1 }, { quality: NaN }, { quality: -1 }, { quality: 101 }, { method: 1.5 }, { method: 7 }, { timeoutMs: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2147483648 }]) assert.throws(() => h.create(bad));
    assert.throws(() => h.create()({ plays: -1 }, context())); assert.throws(() => h.create()({ plays: 1 }, context({ limits: { ...limits, maxFrames: 0 } })));
    const abort = new AbortController(), reason = new Error('pre'); abort.abort(reason);
    assert.throws(() => h.create()({ plays: 0 }, context({ signal: abort.signal })), e => e === reason); assert.equal(h.workers.length, 0);
});
test('WebP Worker normalizes bundler-relative default WASM assets before posting init',()=>{
    const NativeURL=URL;
    class AssetURL { constructor(value,base){ if(value==='./webp-codec.wasm')return {href:'/_next/static/media/codec.wasm'};return new NativeURL(value,base); } }
    const h=hostHarness({globals:{URL:AssetURL,document:{baseURI:'https://site.invalid/app/'}}}),e=h.create()({plays:1},context());
    assert.equal(h.workers[0].messages[0].data.value.wasmUrl,'https://site.invalid/_next/static/media/codec.wasm');e.dispose();assert.equal(h.timers.size,0);
});
test('private WebP Worker waits for ABI handshake, reserves one operation and transfers only after init', async () => {
    const h = hostHarness(), e = h.create()({ plays: 3 }, context()), w = h.workers[0], f = frame();
    const pending = e.addFrame(f); await assert.rejects(e.finish(), /pending/); assert.equal(w.messages.length, 1); assert.equal(f.data.byteLength, 4);
    w.reply(); await tick(); assert.equal(w.messages[1].data.action, 'frame'); assert.equal(w.messages[1].transfer[0], f.data.buffer);
    w.reply(); await pending; const done = e.finish(); await tick(); w.reply({ bytes: new Uint8Array([1, 2, 3]) }); assert.equal((await done).length, 3);
    assert.equal(w.terminated, 1); assert.equal(w.listeners.size, 0); assert.equal(h.timers.size, 0); e.dispose(); assert.equal(w.terminated, 1);
});
test('private WebP Worker installs pending state before synchronous acknowledgement and post failure', async () => {
    for (const mode of ['reply', 'throw']) {
        const original = new Error('post');
        const h = hostHarness({ post(w, m) { if (mode === 'throw') throw original; w.reply(m.action === 'finish' ? { bytes: new Uint8Array([1]) } : {}); } });
        const e = h.create()({ plays: 0 }, context());
        if (mode === 'reply') { await e.addFrame(frame()); await e.finish(); } else await assert.rejects(e.finish(), error => error === original);
        assert.equal(h.timers.size, 0); assert.equal(h.workers[0].terminated, 1);
    }
});
test('private WebP Worker malformed matching tags, shapes, profile and mixed error replies fail closed', async () => {
    for (const extra of [{ format: 'apng' }, { version: 0 }, { action: 'frame' }, { value: {} }, { value: { bindingAbi: 2, profile: 'libwebp-batch-animation-v1' } }, { value: { bindingAbi: 1, profile: 'legacy' } },
        { error: { name: 'Error', message: 'native' } }, { error: { name: 1, message: 'bad' }, value: undefined }, { bytes: new Uint8Array([1]) }]) {
        const h = hostHarness(), e = h.create()({ plays: 0 }, context()), w = h.workers[0], pending = e.addFrame(frame()); w.reply(extra);
        await assert.rejects(pending); assert.equal(w.terminated, 1); assert.equal(w.listeners.size, 0); assert.equal(h.timers.size, 0);
    }
});
test('private WebP Worker unknown/stale IDs never reset live request deadlines', async () => {
    const h = hostHarness(), e = h.create()({ plays: 0 }, context()), w = h.workers[0], pending = e.addFrame(frame());
    const timer = [...h.timers.values()][0]; w.reply({ id: 99, format: 'gif' }); assert.equal([...h.timers.values()][0], timer);
    w.reply(); await tick(); timer(); w.reply({}, 0); assert.equal(h.timers.size, 1); [...h.timers.values()][0]();
    await assert.rejects(pending, /frame timed out/); assert.equal(h.timers.size, 0);
});
test('private WebP Worker memoizes idle init failure until the next operation', async () => {
    const h = hostHarness(), e = h.create()({ plays: 0 }, context()), w = h.workers[0];
    w.listeners.get('error')({ message: 'load failed', preventDefault() {} }); await tick();
    let first; await assert.rejects(e.addFrame(frame()), error => { first = error; return /load failed/.test(error.message); });
    await assert.rejects(e.finish(), error => error === first); assert.equal(w.terminated, 1);
});
test('private WebP Worker aborts init/frame/finish with original reason and ignores late replies', async () => {
    for (const stage of ['init', 'frame', 'finish']) {
        const h = hostHarness(), abort = new AbortController(), reason = { stage }, e = h.create()({ plays: 0 }, context({ signal: abort.signal })), w = h.workers[0];
        let pending; if (stage === 'init') pending = e.addFrame(frame());
        else { w.reply(); await tick(); pending = stage === 'frame' ? e.addFrame(frame()) : e.finish(); await tick(); }
        const stale = w.listeners.get('message'); abort.abort(reason); await assert.rejects(pending, error => error === reason);
        stale({ data: { format: 'webp', version: 1, id: 1, action: 'init' } }); e.dispose();
        assert.equal(w.terminated, 1); assert.equal(h.timers.size, 0); assert.equal(w.listeners.size, 0);
    }
});
test('private WebP Worker releases a handle acquired during reentrant constructor/listener abort', () => {
    for (const stage of ['construct', 'listen']) {
        const abort = new AbortController(), reason = new Error(stage), h = hostHarness({ [stage]() { abort.abort(reason); } });
        assert.throws(() => h.create()({ plays: 0 }, context({ signal: abort.signal })), e => e === reason);
        assert.equal(h.workers[0].terminated, 1); assert.equal(h.workers[0].listeners.size, 0); assert.equal(h.timers.size, 0);
    }
});
test('private WebP Worker rejects invalid output spans/types and frame success bodies', async () => {
    for (const bad of [new Uint8Array(0), new Uint8ClampedArray(1), new Uint8Array(new SharedArrayBuffer(1)), new Uint8Array(3), new Uint8Array(4).subarray(1, 2)]) {
        const h = hostHarness(), e = h.create()({ plays: 0 }, context({ limits: { ...limits, maxOutputBytes: 2 } })), w = h.workers[0];
        w.reply(); await tick(); const pending = e.finish(); await tick(); w.reply({ bytes: bad }); await assert.rejects(pending, /output/); assert.equal(w.terminated, 1);
    }
    const h = hostHarness(), e = h.create()({ plays: 0 }, context()), w = h.workers[0]; w.reply(); await tick();
    const pending = e.addFrame(frame()); await tick(); w.reply({ value: {} }); await assert.rejects(pending, /acknowledgement/);
});
test('private WebP Worker handles messageerror, all request timeouts and scheduler reentrancy', async () => {
    for (const stage of ['init', 'frame', 'finish', 'messageerror']) {
        const h = hostHarness(), e = h.create()({ plays: 0 }, context()), w = h.workers[0];
        if (stage !== 'init') { w.reply(); await tick(); }
        const pending = stage === 'finish' ? e.finish() : e.addFrame(frame()); await tick();
        if (stage === 'messageerror') w.listeners.get('messageerror')(); else [...h.timers.values()][0]();
        await assert.rejects(pending); assert.equal(h.timers.size, 0); assert.equal(w.terminated, 1);
    }
    const h = hostHarness({ schedule(fn) { fn(); } }), e = h.create()({ plays: 0 }, context());
    await assert.rejects(e.finish(), /timed out/); assert.equal(h.workers[0].messages.length, 0); assert.equal(h.timers.size, 0);
});
test('private WebP runtime validates init before loading, rejects concurrent init and ignores late load', async () => {
    for (const bad of [{ plays: 65536 }, { codec: { ...codec, lossless: 1 } }, { limits: { ...limits, maxInputBytes: 0 } }, { wasmUrl: '/relative.wasm' }]) {
        let loads = 0; const h = runtimeHarness(async () => { loads++; return nativeStub().module; }); h.send(init(bad)); await tick();
        assert.equal(loads, 0); assert.equal(h.closed, 1); assert.ok(h.messages[0].data.error);
    }
    let resolve, signal; const h = runtimeHarness((url, s) => { signal = s; return new Promise(r => resolve = r); }); h.send(init());
    const stale = h.scope.onmessage; h.send(init()); assert.equal(h.closed, 1); assert.ok(signal.aborted);
    resolve(nativeStub().module); await tick(); stale({ data: init() }); assert.equal(h.messages.length, 1); assert.equal(h.scope.onmessage, null);
});
test('private WebP runtime rejects unknown tags/IDs/actions/order, duplicates and incompatible native profile', async () => {
    for (const bad of [{ ...init(), format: 'gif' }, { ...init(), version: 0 }, { ...init(), id: 0 }, { ...init(), id: 1.5 }, { ...init(), action: 'frame', value: frame() }]) {
        const h = runtimeHarness(async () => nativeStub().module); h.send(bad); await tick(); assert.equal(h.closed, 1); assert.ok(h.messages[0].data.error);
    }
    for (const extra of [{ _ct_binding_abi: () => 2 }, { _ct_profile: () => 0 }, { _ct_add: undefined }]) {
        const h = runtimeHarness(async () => ({ ...nativeStub().module, ...extra })); h.send(init()); await tick(); assert.ok(h.messages[0].data.error); assert.equal(h.closed, 1);
    }
    for (const bad of [init(), { format: 'webp', version: 1, id: 2, action: 'unknown' }, { ...init(), id: 2 }]) {
        const h = runtimeHarness(async () => nativeStub().module); h.send(init()); await tick(); h.send(bad); await tick(); assert.ok(h.messages.at(-1).data.error); assert.equal(h.closed, 1);
    }
});
test('private WebP runtime acknowledges admission, validates all budgets, transfers exact output and clears state', async () => {
    const a = nativeStub(), h = runtimeHarness(async () => a.module); h.send(init()); await tick();
    h.send({ format: 'webp', version: 1, id: 2, action: 'frame', value: frame() }); await tick(); assert.equal(a.stats.opens, 0);
    h.send({ format: 'webp', version: 1, id: 3, action: 'finish' }); await tick();
    assert.equal(a.stats.closes, 1); assert.equal(a.stats.live, 0); assert.equal(h.closed, 1); assert.equal(h.scope.onmessage, null);
    const reply = h.messages.at(-1); assert.equal(reply.transfer[0], reply.data.bytes.buffer); assert.equal(reply.data.bytes.byteLength, reply.data.bytes.buffer.byteLength);
    for (const key of ['maxFrames', 'maxInputBytes', 'maxDurationMs', 'maxFramePixels']) {
        const h = runtimeHarness(async () => nativeStub().module); h.send(init({ limits: { ...limits, [key]: 1 } })); await tick();
        const f = frame(); if (key === 'maxFramePixels') { f.width = 2; f.data = new Uint8ClampedArray(8); }
        h.send({ format: 'webp', version: 1, id: 2, action: 'frame', value: f }); await tick();
        if (key === 'maxFrames') { h.send({ format: 'webp', version: 1, id: 3, action: 'frame', value: frame() }); await tick(); }
        assert.ok(h.messages.at(-1).data.error); assert.equal(h.closed, 1);
    }
});
test('private WebP native batch validates owned storage and disposes after native failures/output copy', () => {
    for (const change of [f => f.durationMs = 0, f => f.width = 0, f => f.data = new Uint8ClampedArray(new SharedArrayBuffer(4)), f => f.data = new Uint8ClampedArray(8).subarray(4)]) {
        const a = nativeStub(), e = createWebpNativeEncoder(a.module, 0, limits, codec), f = frame(); change(f); assert.throws(() => e.addFrame(f)); assert.throws(() => e.finish(), /closed/); assert.equal(a.stats.opens, 0);
    }
    for (const method of ['_ct_add', '_ct_finish', '_ct_size']) {
        const a = nativeStub(); a.module[method] = () => 0;
        const e = createWebpNativeEncoder(a.module, 0, limits, codec); e.addFrame(frame()); assert.throws(() => e.finish()); assert.equal(a.stats.live, 0); assert.equal(a.stats.closes, 1); assert.equal(a.stats.frees, 1);
    }
    const a = nativeStub(), e = createWebpNativeEncoder(a.module, 0, limits, codec), f = frame(); e.addFrame(f); f.durationMs = 1;
    const bytes = e.finish(); assert.equal(a.stats.adds[0].delay, 55); a.module.HEAPU8.fill(0); assert.deepEqual([...bytes], [82, 73, 70, 70]);
});
test('private WebP host and controller graph contain no native codec or runtime imports', async () => {
    for (const entry of ['src/internal/webp-worker.ts', 'src/internal/webp-controller.ts']) {
        const built = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser' });
        assert.ok(Object.keys(built.metafile.inputs).every(name => !/webp-native|webp-codec|worker-runtime/.test(name)));
    }
});

test('private WebP runtime closes on fetch/compile errors and postMessage failures without late success', async () => {
    const error = new Error('WASM load');
    const h = runtimeHarness(async () => { throw error; }); h.send(init()); await tick();
    assert.equal(h.messages[0].data.error.message, error.message); assert.equal(h.closed, 1); assert.equal(h.scope.onmessage, null);
    const a = nativeStub(), other = runtimeHarness(async () => a.module); other.send(init()); await tick();
    other.send({ format: 'webp', version: 1, id: 2, action: 'frame', value: frame() }); await tick();
    other.scope.postMessage = () => { throw new Error('transport'); };
    other.send({ format: 'webp', version: 1, id: 3, action: 'finish' }); await tick();
    assert.equal(other.closed, 1); assert.equal(a.stats.live, 0); assert.equal(a.stats.closes, 1); assert.equal(other.scope.onmessage, null);
});
