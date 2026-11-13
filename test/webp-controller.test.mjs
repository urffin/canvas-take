import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { harness, encoder, source, file, chunk, riff, chunks, rewrite, add, finish, deferred, microtasks } from './fixtures/webp-controller.mjs';

test('private WebP snapshots sRGB RGBA synchronously and freezes normalized factory options', async () => {
    const h = harness(), a = encoder(), canvas = source(3, 1), original = canvas.data.slice(), events = [];
    const options = { encoder: a.factory, plays: 3, totalFrames: 9, maxInputBytes: 12, onProgress: p => events.push(p) };
    const exporter = h.create(options); options.plays = 1; options.maxInputBytes = 1;
    assert.equal(events.length, 0); const pending = exporter.addFrame(canvas, 55);
    assert.equal(exporter.state, 'adding'); assert.equal(canvas.reads, 1); assert.equal(h.copies.length, 1); assert.equal(a.stats.frames.length, 0);
    assert.equal(canvas.args[0][4].colorSpace, 'srgb'); canvas.data.fill(0); canvas.width = 7;
    await h.step(); await pending;
    assert.deepEqual(a.stats.frames[0].data, original); assert.ok(a.stats.frames[0].frozen);
    assert.equal(a.stats.options.plays, 3); assert.ok(Object.isFrozen(a.stats.options)); assert.ok(Object.isFrozen(a.stats.context)); assert.ok(Object.isFrozen(a.stats.context.limits));
    assert.deepEqual({ ...a.stats.context.limits }, { maxFramePixels: 4194304, maxFrames: 1000, maxDurationMs: 2147483647, maxInputBytes: 12, maxOutputBytes: 33554432 });
    const blob = await finish(h, exporter); assert.equal(blob.type, 'image/webp'); assert.equal(a.stats.disposed, 1);
    assert.deepEqual(events.map(p => [p.phase, p.framesAccepted, p.durationMs, p.inputBytesAccepted]), [['collecting', 1, 55, 12], ['finalizing', 1, 55, 12], ['finished', 1, 55, 12]]);
    assert.ok(events.every(Object.isFrozen)); assert.equal(events.at(-1).outputBytes, blob.size); assert.equal(events[0].totalFrames, 9);
});

test('private WebP preserves exact input delays/plays and animation metadata for one frame', async () => {
    for (const plays of [0, 1, 3, 65535]) for (const delays of [[1], [16777215], [1, 10, 11, 55, 2000]]) {
        const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory, plays });
        for (const delay of delays) await add(h, exporter, source(), delay);
        const bytes = Buffer.from(await (await finish(h, exporter)).arrayBuffer()), animation = chunks(bytes).find(c => c.type === 'ANIM');
        assert.equal(bytes.readUInt16LE(animation.data + 4), plays);
        assert.deepEqual(chunks(bytes).filter(c => c.type === 'ANMF').map(c => bytes.readUIntLE(c.data + 12, 3)), delays);
        assert.deepEqual(a.stats.frames.map(f => f.durationMs), delays);
    }
});

test('private WebP admits merged/split packet timelines without confusing accepted snapshots', async () => {
    const h = harness(), a = encoder({ merge: true, split: true }), events = [], exporter = h.create({ encoder: a.factory, onProgress: p => events.push(p) });
    for (const [color, delay] of [[1, 50], [2, 70], [2, 90], [3, 200]]) { const canvas = source(); canvas.data[0] = color; await add(h, exporter, canvas, delay); }
    const bytes = Buffer.from(await (await finish(h, exporter)).arrayBuffer());
    assert.deepEqual(chunks(bytes).filter(c => c.type === 'ANMF').map(c => bytes.readUIntLE(c.data + 12, 3)), [50, 160, 200]);
    assert.equal(events.at(-1).framesAccepted, 4); assert.equal(events.at(-1).durationMs, 410);
    const b = encoder({ merge: true, split: true }), other = h.create({ encoder: b.factory });
    await add(h, other, source(), 16777215); await add(h, other, source(), 55);
    assert.equal(chunks(Buffer.from(await (await finish(h, other)).arrayBuffer())).filter(c => c.type === 'ANMF').length, 2);
});

test('private WebP validates options and pre-abort before factory acquisition', () => {
    const h = harness(); let made = 0; const factory = () => { made++; };
    for (const key of ['maxFramePixels', 'maxFrames', 'maxDurationMs', 'maxInputBytes', 'maxOutputBytes']) for (const value of [0, -1, 1.5, NaN, Infinity, 2147483648, null, '1']) {
        assert.throws(() => h.create({ encoder: factory, [key]: value }), { name: 'RangeError' });
    }
    for (const totalFrames of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => h.create({ encoder: factory, totalFrames }), /totalFrames/);
    for (const plays of [-1, 65536, 1.5, NaN, null]) assert.throws(() => h.create({ encoder: factory, plays }), /plays/);
    assert.throws(() => h.create({ encoder: undefined }), /factory/); assert.throws(() => h.create({ encoder: factory, onProgress: 1 }), /onProgress/);
    const abort = new AbortController(), reason = { cancelled: true }; abort.abort(reason);
    assert.throws(() => h.create({ signal: abort.signal, get encoder() { throw new Error('must not read'); } }), e => e === reason);
    assert.equal(made, 0); assert.equal(h.copies.length, 0);
});

test('private WebP input limits reject before readback, preserve counters, and include exact boundaries', async () => {
    for (const [limits, canvas, delay, expected] of [
        [{}, source(), 0, /duration/], [{}, source(), 1.5, /duration/], [{}, source(), 16777216, /duration/],
        [{}, { ...source(), width: 16384 }, 55, /dimensions/], [{}, { ...source(), height: NaN }, 55, /dimensions/],
        [{ maxFramePixels: 1 }, source(2, 1), 55, /maxFramePixels/], [{ maxDurationMs: 54 }, source(), 55, /maxDurationMs/], [{ maxInputBytes: 3 }, source(), 55, /maxInputBytes/]
    ]) {
        const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory, ...limits });
        await assert.rejects(exporter.addFrame(canvas, delay), expected);
        assert.equal(canvas.reads, 0); assert.equal(canvas.contexts, 0); assert.equal(h.copies.length, 0); assert.equal(a.stats.disposed, 1);
    }
    for (const limits of [{ maxFrames: 1 }, { maxDurationMs: 55 }, { maxInputBytes: 4 }]) {
        const h = harness(), a = encoder(), events = [], exporter = h.create({ encoder: a.factory, ...limits, onProgress: p => events.push(p) });
        await add(h, exporter, source(), 55); const rejected = source(); await assert.rejects(exporter.addFrame(rejected, 1));
        assert.equal(rejected.reads, 0); assert.deepEqual(events.map(p => [p.phase, p.framesAccepted, p.durationMs, p.inputBytesAccepted]), [['collecting', 1, 55, 4], ['failed', 1, 55, 4]]);
    }
    const h = harness(), a = encoder(), outputSize = file([{ ...source(), durationMs: 1 }], 0).length;
    const exact = h.create({ encoder: a.factory, maxFrames: 1, maxFramePixels: 1, maxDurationMs: 1, maxInputBytes: 4, maxOutputBytes: outputSize, totalFrames: Number.MAX_SAFE_INTEGER });
    await add(h, exact, source(), 1); assert.equal((await finish(h, exact)).size, outputSize);
    const b = encoder(), short = h.create({ encoder: b.factory, maxOutputBytes: outputSize - 1 }); await add(h, short, source(), 1);
    await assert.rejects(finish(h, short), /maxOutputBytes/); assert.equal(b.stats.disposed, 1);
});

test('private WebP enforces signed duration sum and the hard dimension ceiling without large allocations', async () => {
    const h = harness(), a = encoder(), events = [], exporter = h.create({ encoder: a.factory, onProgress: p => events.push(p) });
    for (let i = 0; i < 128; i++) await add(h, exporter, source(), 16777215);
    const next = source(); await assert.rejects(exporter.addFrame(next, 128), /maxDurationMs/); assert.equal(next.reads, 0);
    assert.equal(events.at(-1).durationMs, 2147483520); assert.equal(events.at(-1).framesAccepted, 128);
    const b = encoder(), wide = h.create({ encoder: b.factory }); await add(h, wide, source(16383, 1), 1); assert.ok((await finish(h, wide)).size);
});

test('private WebP pending admission reserves budgets, rejects overlap and commits only after acknowledgement', async () => {
    const h = harness(), gate = deferred(), a = encoder({ transfer: true, add: () => gate.promise }), events = [];
    const exporter = h.create({ encoder: a.factory, maxFrames: 1, maxDurationMs: 55, maxInputBytes: 4, onProgress: p => events.push(p) });
    const caller = source(), pending = exporter.addFrame(caller, 55); await h.step();
    assert.equal(events.length, 0); assert.ok(a.stats.detached[0]); assert.equal(caller.data.byteLength, 4);
    const rejected = source(); await assert.rejects(exporter.addFrame(rejected, 1), /adding/); await assert.rejects(exporter.finish(), /adding/);
    assert.equal(rejected.reads, 0); assert.equal(a.stats.disposed, 0); gate.resolve(); await pending;
    assert.deepEqual(events.map(p => [p.framesAccepted, p.inputBytesAccepted]), [[1, 4]]);
    await assert.rejects(exporter.addFrame(source(), 1), /maxFrames/); assert.equal(a.stats.disposed, 1);
});

test('private WebP owns a full-span copy of caller subviews and safely hands off a transferred snapshot', async () => {
    const h = harness(), a = encoder({ transfer: true }), backing = new Uint8ClampedArray(20), pixels = backing.subarray(8, 12);
    pixels.set([11, 22, 33, 128]); const canvas = source(); canvas.getContext = () => ({ getImageData: () => ({ data: pixels }) });
    const exporter = h.create({ encoder: a.factory }); const pending = exporter.addFrame(canvas, 55);
    assert.equal(h.copies[0].deref().byteOffset, 0); assert.equal(h.copies[0].deref().buffer.byteLength, 4);
    await h.step(); await pending; assert.equal(backing.byteLength, 20); assert.deepEqual([...pixels], [11, 22, 33, 128]);
    assert.ok(a.stats.detached[0]); assert.equal(a.stats.kept[0].data.buffer.byteLength, 4); assert.deepEqual([...a.stats.kept[0].data], [...pixels]);
    const blob = await finish(h, exporter); exporter.dispose(); assert.ok(blob.size); assert.equal(a.stats.kept.length, 0);
});

test('private WebP rejects tainted, missing, shared, detached or non-RGBA8 readback and resize', async () => {
    for (const kind of ['tainted', 'context', 'bytes', 'type', 'shared', 'detached', 'resize', 'schedule']) {
        const h = harness(), a = encoder(), canvas = source(), original = new DOMException('Tainted', 'SecurityError');
        const exporter = h.create({ encoder: a.factory });
        if (kind === 'context') canvas.getContext = () => null;
        if (kind === 'tainted') canvas.getContext = () => ({ getImageData() { throw original; } });
        if (['bytes', 'type', 'shared', 'detached'].includes(kind)) {
            let raw = kind === 'type' ? new Uint8Array(4) : kind === 'shared' ? new Uint8ClampedArray(new SharedArrayBuffer(4)) : new Uint8ClampedArray(kind === 'bytes' ? 3 : 4);
            if (kind === 'detached') structuredClone(raw.buffer, { transfer: [raw.buffer] });
            canvas.getContext = () => ({ getImageData: () => ({ data: raw }) });
        }
        if (kind === 'resize') { await add(h, exporter, canvas); canvas.width = 2; }
        if (kind === 'schedule') h.failSchedule(original);
        await assert.rejects(exporter.addFrame(canvas, 55), e => ['tainted', 'schedule'].includes(kind) ? e === original : /WebP/.test(e.message));
        assert.equal(h.timers.size, 0); assert.equal(a.stats.disposed, 1);
    }
});

test('private WebP cached finish promise exists before reentrant finalizing notification', async () => {
    const h = harness(), gate = deferred(), trace = []; let exporter, nested;
    const a = encoder({ finish(stats) { trace.push('encoder'); return gate.promise.then(() => file(stats.kept, 0)); } });
    exporter = h.create({ encoder: a.factory, onProgress(p) { if (p.phase === 'finalizing') { trace.push('observer'); nested = exporter.finish(); } } });
    await add(h, exporter); const pending = exporter.finish(); trace.push('returned');
    assert.equal(nested, pending); assert.equal(exporter.finish(), pending); assert.deepEqual(trace, ['observer', 'encoder', 'returned']);
    await assert.rejects(exporter.addFrame(source(), 1), /finalizing/); gate.resolve(); await h.flush(); const blob = await pending;
    assert.equal(exporter.finish(), pending); assert.equal(await exporter.finish(), blob); assert.equal(a.stats.disposed, 1);
    exporter.dispose(); assert.ok(blob.size); await assert.rejects(exporter.finish(), /disposed/);
});

test('private WebP progress is admission-only, lazy, frozen and synchronous with omitted optional keys', async () => {
    const h = harness(), a = encoder(), quiet = h.create({ encoder: a.factory }); await add(h, quiet); await finish(h, quiet); assert.equal(h.progressSnapshots.length, 0);
    const b = encoder(), events = [], receivers = []; let exporter, overlap;
    exporter = h.create({ encoder: b.factory, totalFrames: 1, onProgress: function(p) { events.push(p); receivers.push(this); if (p.phase === 'collecting') overlap = exporter.addFrame(source(), 1); if (p.phase === 'finished') throw new Error('observer'); } });
    await add(h, exporter, source(), 55); await assert.rejects(overlap, /adding/); await add(h, exporter, source(), 2000); await assert.rejects(overlap, /adding/);
    const blob = await finish(h, exporter);
    assert.deepEqual(events.map(p => [p.phase, p.framesAccepted, p.durationMs, p.inputBytesAccepted]), [['collecting', 1, 55, 4], ['collecting', 2, 2055, 8], ['finalizing', 2, 2055, 8], ['finished', 2, 2055, 8]]);
    assert.ok(events.every(Object.isFrozen)); assert.ok(receivers.every(value => value === undefined)); assert.equal(new Set(events).size, 4);
    assert.equal('outputBytes' in events[0], false); assert.equal(events.at(-1).outputBytes, blob.size); assert.equal(events[1].totalFrames, 1);
    const c = encoder(), snapshots = [], other = h.create({ encoder: c.factory, onProgress: p => snapshots.push(p) }); await add(h, other); await finish(h, other); assert.equal('totalFrames' in snapshots[0], false);
});

test('private WebP original reasons survive pre-abort, factory abort and pending operations', async () => {
    for (const value of [0, false, '', null, undefined, new Error('reason')]) {
        const signal = { aborted: true, reason: value };
        assert.throws(() => harness().create({ encoder: () => {}, signal }), e => value == null ? e.name === 'AbortError' : e === value);
    }
    const h = harness(), abort = new AbortController(), reason = new Error('factory'), phases = [];
    const a = encoder({ create(instance) { abort.abort(reason); return instance; }, dispose() { throw new Error('cleanup'); } });
    assert.throws(() => h.create({ encoder: a.factory, signal: abort.signal, onProgress: p => phases.push(p.phase) }), e => e === reason);
    assert.equal(a.stats.disposed, 1); assert.deepEqual(phases, ['aborted']);
    for (const stage of ['add', 'finish']) for (const lateSuccess of [true, false]) {
        const h = harness(), gate = deferred(), abort = new AbortController(), reason = { stage }, events = [];
        const a = encoder({ [stage]: () => gate.promise, dispose: () => Promise.reject(new Error('async cleanup')) });
        const exporter = h.create({ encoder: a.factory, signal: abort.signal, onProgress: p => events.push(p.phase) }); let pending;
        if (stage === 'add') { pending = exporter.addFrame(source(), 55); await h.step(); } else { await add(h, exporter); pending = exporter.finish(); }
        abort.abort(reason); await assert.rejects(pending, e => e === reason); const count = events.length;
        if (lateSuccess) gate.resolve(new Uint8Array(3)); else gate.reject(new Error('late'));
        await microtasks(); assert.equal(events.length, count); assert.equal(a.stats.disposed, 1); await assert.rejects(exporter.finish(), e => e === reason);
    }
});

test('private WebP abort/dispose cancels scheduled capture work and ignores its stale callback', async () => {
    for (const mode of ['abort', 'dispose']) {
        const h = harness(), a = encoder(), abort = new AbortController(), reason = new Error('early'), events = [];
        const exporter = h.create({ encoder: a.factory, signal: abort.signal, onProgress: p => events.push(p.phase) });
        const pending = exporter.addFrame(source(), 55), stale = h.callbacks[0];
        if (mode === 'abort') abort.abort(reason); else exporter.dispose();
        await assert.rejects(pending, e => mode === 'abort' ? e === reason : e.name === 'AbortError');
        stale(); await microtasks(); assert.equal(h.timers.size, 0); assert.equal(a.stats.frames.length, 0); exporter.dispose(); assert.equal(a.stats.disposed, 1);
        assert.deepEqual(events, [mode === 'abort' ? 'aborted' : 'disposed']);
    }
});

test('private WebP guards reentrant cancellation in dimensions, readback and snapshot allocation', async () => {
    for (const stage of ['width', 'context', 'pixels', 'copy']) {
        const h = harness(), a = encoder(), abort = new AbortController(), reason = new Error(stage), canvas = source();
        if (stage === 'width') Object.defineProperty(canvas, 'width', { get() { abort.abort(reason); return 1; } });
        if (stage === 'context') canvas.getContext = () => { abort.abort(reason); return null; };
        if (stage === 'pixels') canvas.getContext = () => ({ getImageData() { abort.abort(reason); return { get data() { throw new Error('must not read'); } }; } });
        if (stage === 'copy') h.onCopy(() => abort.abort(reason));
        const exporter = h.create({ encoder: a.factory, signal: abort.signal }); await assert.rejects(exporter.addFrame(canvas, 55), e => e === reason);
        assert.equal(h.timers.size, 0); assert.equal(a.stats.frames.length, 0); assert.equal(a.stats.disposed, 1);
    }
});

test('private WebP abort after acknowledgement/observer distinguishes uncommitted and committed counters', async () => {
    const h = harness(), abort = new AbortController(), reason = new Error('observer'), events = [], a = encoder();
    const exporter = h.create({ encoder: a.factory, signal: abort.signal, onProgress(p) { events.push(p); if (p.phase === 'collecting') abort.abort(reason); } });
    const pending = exporter.addFrame(source(), 55); await h.step(); await assert.rejects(pending, e => e === reason);
    assert.deepEqual(events.map(p => [p.phase, p.framesAccepted, p.inputBytesAccepted]), [['collecting', 1, 4], ['aborted', 1, 4]]);
    for (let offset = 0; offset < 12; offset++) {
        const h = harness(), gate = deferred(), a = encoder({ add: () => gate.promise }), abort = new AbortController(), reason = new Error('ack/' + offset), events = [];
        const exporter = h.create({ encoder: a.factory, signal: abort.signal, onProgress: p => events.push(p) });
        const pending = exporter.addFrame(source(), 55); await h.step(); const observed = pending.then(() => 'ok', error => error);
        gate.resolve(); let turn = Promise.resolve(); for (let i = 0; i < offset; i++) turn = turn.then(() => {}); await turn.then(() => abort.abort(reason));
        const result = await observed; assert.ok(result === 'ok' || result === reason);
        assert.ok(events.every(p => p.framesAccepted === 0 || p.framesAccepted === 1));
        if (events.some(p => p.phase === 'collecting')) assert.equal(events.at(-1).framesAccepted, 1); else assert.equal(events.at(-1).framesAccepted, 0);
        assert.equal(a.stats.disposed, 1); assert.equal(h.timers.size, 0);
    }
});

test('private WebP finalizing abort skips codec, and finished-disposing observer cannot retract success', async () => {
    const h = harness(), abort = new AbortController(), reason = new Error('finish observer'); let calls = 0;
    const a = encoder({ finish() { calls++; } }), exporter = h.create({ encoder: a.factory, signal: abort.signal, onProgress(p) { if (p.phase === 'finalizing') abort.abort(reason); } });
    await add(h, exporter); await assert.rejects(exporter.finish(), e => e === reason); assert.equal(calls, 0);
    const b = encoder(), events = []; let success;
    success = h.create({ encoder: b.factory, onProgress(p) { events.push(p.phase); if (p.phase === 'finished') success.dispose(); } });
    await add(h, success); const pending = success.finish(), blob = await pending; assert.equal(success.state, 'disposed'); assert.ok(blob.size); assert.equal(await pending, blob);
    assert.deepEqual(events, ['collecting', 'finalizing', 'finished']); assert.equal(b.stats.disposed, 1);
});

test('private WebP preserves component causes, rejects async factories, and disposes late acquisitions', async () => {
    const h = harness(), original = new Error('component');
    assert.throws(() => h.create({ encoder() { throw original; } }), e => e.cause === original && /create/.test(e.message));
    for (const stage of ['add', 'finish']) {
        const a = encoder({ [stage]() { throw original; } }), exporter = h.create({ encoder: a.factory }); let pending;
        if (stage === 'add') { pending = exporter.addFrame(source(), 55); await h.step(); } else { await add(h, exporter); pending = exporter.finish(); }
        await assert.rejects(pending, e => e.cause === original && e.message.includes(stage)); assert.equal(a.stats.disposed, 1);
    }
    const gate = deferred(), a = encoder({ create: instance => gate.promise.then(() => instance) });
    assert.throws(() => h.create({ encoder: a.factory }), /synchronously/); assert.equal(a.stats.disposed, 0); gate.resolve(); await microtasks(); assert.equal(a.stats.disposed, 1);
    assert.throws(() => h.create({ encoder: () => Promise.reject(original) }), /synchronously/); await microtasks();
    let disposed = 0; const invalid = { addFrame() {}, get finish() { throw original; }, dispose() { disposed++; } };
    assert.throws(() => h.create({ encoder: () => invalid }), e => e === original); assert.equal(disposed, 1);
});

test('private WebP cleanup reentrancy/async rejection cannot overwrite the first failure', async () => {
    const h = harness(), original = new Error('codec'), events = []; let exporter;
    const a = encoder({ add() { throw original; }, dispose() { exporter.dispose(); return Promise.reject(new Error('cleanup')); } });
    exporter = h.create({ encoder: a.factory, onProgress: p => events.push(p.phase) }); let selected;
    const pending = exporter.addFrame(source(), 55); await h.step();
    await assert.rejects(pending, e => { selected = e; return e.cause === original; }); await microtasks();
    assert.equal(exporter.state, 'disposed'); assert.equal(a.stats.disposed, 1); assert.deepEqual(events, ['failed']); await assert.rejects(exporter.finish(), e => e === selected);
});

test('private WebP preserves falsy component causes and stable terminal errors', async () => {
    for (const cause of [undefined, null, false, 0, '']) for (const stage of ['create', 'add', 'finish']) {
        const h = harness(), a = encoder({ [stage]() { throw cause; } }); let error;
        if (stage === 'create') assert.throws(() => h.create({ encoder: a.factory }), e => { error = e; return Object.hasOwn(e, 'cause') && e.cause === cause; });
        else {
            const exporter = h.create({ encoder: a.factory }); let pending;
            if (stage === 'add') { pending = exporter.addFrame(source(), 55); await h.step(); }
            else { await add(h, exporter); pending = exporter.finish(); }
            await assert.rejects(pending, e => { error = e; return Object.hasOwn(e, 'cause') && e.cause === cause; });
            await assert.rejects(exporter.finish(), e => e === error); assert.equal(a.stats.disposed, 1);
        }
        assert.match(error.message, new RegExp(stage === 'create' ? 'create' : stage === 'add' ? 'addFrame' : 'finish'));
        assert.equal(h.timers.size, 0);
    }
});

test('private WebP removes abort listeners and supports fresh exports after every terminal outcome', async () => {
    const h = harness(), abort = new AbortController(), listeners = new Set(), retained = [];
    const signal = {
        get aborted() { return abort.signal.aborted; }, get reason() { return abort.signal.reason; },
        addEventListener(type, listener, options) { listeners.add(listener); abort.signal.addEventListener(type, listener, options); },
        removeEventListener(type, listener) { listeners.delete(listener); abort.signal.removeEventListener(type, listener); }
    };
    for (let round = 0; round < 3; round++) for (const mode of ['success', 'failure', 'dispose']) {
        const a = encoder(), exporter = h.create({ encoder: a.factory, signal }); retained.push({ exporter, a });
        assert.equal(listeners.size, 1);
        if (mode === 'failure') await assert.rejects(exporter.addFrame(source(), 0), /duration/);
        else if (mode === 'dispose') { const pending = exporter.addFrame(source(), 55); exporter.dispose(); await assert.rejects(pending, { name: 'AbortError' }); }
        else { await add(h, exporter); assert.ok((await finish(h, exporter)).size); }
        assert.equal(listeners.size, 0); assert.equal(h.timers.size, 0); assert.equal(a.stats.disposed, 1); assert.equal(a.stats.kept.length, 0);
    }
    const a = encoder(), exporter = h.create({ encoder: a.factory, signal });
    const pending = exporter.addFrame(source(), 55); abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(listeners.size, 0); assert.equal(h.timers.size, 0); assert.equal(a.stats.disposed, 1); assert.equal(retained.length, 9);
});

test('private WebP checks output ownership/type/span and snapshots bytes before yielding validation', async () => {
    const h = harness(), a = encoder({ paddingChunks: 600 }), exporter = h.create({ encoder: a.factory }); await add(h, exporter);
    const pending = exporter.finish(); await microtasks(); assert.equal(h.timers.size, 1); a.stats.bytes.fill(0);
    await h.flush(); assert.equal(Buffer.from(await (await pending).arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
    const b = encoder({ finish(stats) { const bytes = file(stats.kept, 0), backing = new Uint8Array(bytes.length + 20); backing.set(bytes, 10); return backing.subarray(10, 10 + bytes.length); } });
    const view = h.create({ encoder: b.factory }); await add(h, view); assert.equal((await finish(h, view)).size, file([{ ...source(), durationMs: 50 }], 0).length);
    for (const output of [new Uint8Array(0), new Uint8ClampedArray(4), new Uint8Array(new SharedArrayBuffer(4))]) {
        const a = encoder({ finish: () => output }), exporter = h.create({ encoder: a.factory }); await add(h, exporter); await assert.rejects(finish(h, exporter), /nonshared Uint8Array/); assert.equal(a.stats.disposed, 1);
    }
});

test('private WebP validates animation envelope with metadata, VP8 space FourCC and unknown chunks', async () => {
    for (const options of [{ metadata: true, tail: true }, { imageType: 'VP8 ', alpha: true }]) {
        const h = harness(), a = encoder(options), exporter = h.create({ encoder: a.factory }); await add(h, exporter); assert.ok((await finish(h, exporter)).size);
    }
    // Deliberately undecodable stub image is accepted: envelope checking is not a codec decoder.
    const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory }); await add(h, exporter); assert.ok((await finish(h, exporter)).size);
    // A total-preserving wrong distribution also demonstrates the documented validation boundary.
    const b = encoder({ finish(stats) { return file(stats.kept.map(f => ({ ...f, durationMs: 100 })), 0); } }), other = h.create({ encoder: b.factory });
    await add(h, other, source(), 50); await add(h, other, source(), 150); assert.ok((await finish(h, other)).size);
});

test('private WebP rejects corrupt RIFF/animation fields, frame bounds, padding and image structure', async () => {
    const changes = [
        bytes => { const b = Buffer.from(bytes); b[0] = 0; return b; },
        bytes => { const b = Buffer.from(bytes); b.writeUInt32LE(b.length, 4); return b; },
        bytes => bytes.subarray(0, bytes.length - 1),
        bytes => Buffer.concat([bytes, Buffer.alloc(2)]),
        bytes => rewrite(bytes, 'VP8X', 0, d => { d[0] |= 0x80; }),
        bytes => rewrite(bytes, 'VP8X', 0, d => { d[0] &= ~2; }),
        bytes => rewrite(bytes, 'VP8X', 0, d => { d[1] = 1; }),
        bytes => rewrite(bytes, 'VP8X', 0, d => { d[4] = 1; }),
        bytes => rewrite(bytes, 'ANIM', 0, d => { d.writeUInt16LE(3, 4); }),
        bytes => rewrite(bytes, 'ANMF', 0, d => { d[0] = 1; }),
        bytes => rewrite(bytes, 'ANMF', 0, d => { d[15] |= 4; }),
        bytes => rewrite(bytes, 'ANMF', 0, d => { d.writeUIntLE(0, 12, 3); }),
        bytes => rewrite(bytes, 'ANMF', 0, d => { d.writeUIntLE(49, 12, 3); }),
        bytes => rewrite(bytes, 'ANMF', 0, d => { d[29] = 1; }), // VP8L payload padding.
        bytes => rewrite(bytes, 'ANMF', 0, d => { d.write('ALPH', 16); }),
        bytes => rewrite(bytes, 'ANMF', 0, d => { d.writeUInt32LE(999, 20); }),
        bytes => riff(chunks(bytes).filter(c => c.type !== 'ANIM').map(c => bytes.subarray(c.offset, c.end))),
        bytes => { const cs = chunks(bytes); return riff([bytes.subarray(cs[0].offset, cs[0].end), bytes.subarray(cs[2].offset, cs[2].end), bytes.subarray(cs[1].offset, cs[1].end)]); },
        bytes => { const cs = chunks(bytes); return riff([...cs.map(c => bytes.subarray(c.offset, c.end)), bytes.subarray(cs[1].offset, cs[1].end)]); },
        bytes => riff([chunk('VP8L', Buffer.from([1]))])
    ];
    for (const change of changes) {
        const h = harness(), a = encoder({ finish: stats => change(file(stats.kept, 0)) }), exporter = h.create({ encoder: a.factory });
        await add(h, exporter); await assert.rejects(finish(h, exporter), /Invalid WebP/); assert.equal(a.stats.disposed, 1);
    }
});

test('private WebP validation checkpoints are cancellable and cannot resurrect tasks', async () => {
    for (let offset = 0; offset < 12; offset++) {
        const h = harness(), a = encoder({ paddingChunks: 600 }), abort = new AbortController(), reason = new Error('validation/' + offset);
        const exporter = h.create({ encoder: a.factory, signal: abort.signal }); await add(h, exporter);
        const pending = exporter.finish(); await microtasks(); assert.equal(h.timers.size, 1);
        const observed = assert.rejects(pending, e => e === reason); let turn = Promise.resolve(); for (let i = 0; i < offset; i++) turn = turn.then(() => {});
        const cancelled = turn.then(() => abort.abort(reason)); await h.step(); await cancelled; await observed; await microtasks();
        assert.equal(h.timers.size, 0); assert.equal(a.stats.disposed, 1);
    }
});

test('private WebP empty finish fails once and keeps its reason after disposal', async () => {
    const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory }); let first;
    await assert.rejects(exporter.finish(), e => { first = e; return /at least one frame/.test(e.message); });
    assert.equal(a.stats.disposed, 1); exporter.dispose(); await assert.rejects(exporter.finish(), e => e === first);
});

test('private WebP has no codec/Worker dependency or new package exports', async () => {
    const built = await build({ entryPoints: ['src/internal/webp-controller.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, metafile: true });
    assert.deepEqual(Object.keys(built.metafile.inputs).sort(), ['src/internal/webp-controller.ts', 'src/internal/webp-envelope.ts']);
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.ok(!Object.keys(pkg.exports).some(name => name.includes('webp')));
    for (const path of ['/webp', '/webp/worker', '/internal/webp-controller.js']) await assert.rejects(import('@grundyjs/canvas-take' + path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('private WebP internal types match the draft contract', () => {
    execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '-p', fileURLToPath(new URL('./fixtures/webp-controller-types.json', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
});

test('retained private WebP controllers release owned snapshots/caller references after termination', () => {
    const output = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/webp-controller-gc.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /Five retained WebP controllers released owned snapshots and buffers/);
});
