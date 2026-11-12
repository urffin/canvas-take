import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { harness, encoder, source, add, finish, file, rewrite, deferred, microtasks } from './fixtures/apng-controller.mjs';

test('internal APNG captures one owned transparent sRGB frame before yielding and snapshots options', async () => {
    const h = harness(), a = encoder(), canvas = source(3, 1), original = canvas.data.slice(), options = { encoder: a.factory, plays: 3, maxInputBytes: 12, totalFrames: 9 };
    const progress = []; options.onProgress = p => progress.push(p);
    const exporter = h.create(options); options.plays = 0; options.maxInputBytes = 1;
    const pending = exporter.addFrame(canvas, 55); assert.equal(exporter.state, 'adding');
    assert.equal(canvas.reads, 1); assert.equal(h.copies.length, 1); assert.equal(a.stats.frames.length, 0);
    assert.deepEqual(canvas.args[0].slice(0, 4), [0, 0, 3, 1]); assert.equal(canvas.args[0][4].colorSpace, 'srgb');
    canvas.data.fill(0); canvas.width = 5; await h.step(); await pending;
    assert.deepEqual(a.stats.frames[0].data, original); assert.ok(a.stats.frames[0].frozen); assert.equal(a.stats.frames[0].durationMs, 55);
    assert.equal(a.stats.options.plays, 3); assert.ok(Object.isFrozen(a.stats.options)); assert.ok(Object.isFrozen(a.stats.context));
    assert.equal(a.stats.context.maxInputBytes, 12); assert.equal('maxOutputBytes' in a.stats.context, false);
    const blob = await finish(h, exporter); assert.equal(blob.type, 'image/apng'); assert.ok(blob.size);
    assert.deepEqual(progress.map(p => [p.phase, p.framesAccepted, p.durationMs, p.inputBytesAccepted]), [['collecting', 1, 55, 12], ['finalizing', 1, 55, 12], ['finished', 1, 55, 12]]);
    assert.ok(progress.every(Object.isFrozen)); assert.equal(progress.at(-1).outputBytes, blob.size); assert.equal(progress[0].totalFrames, 9);
    assert.equal(a.stats.disposed, 1); exporter.dispose(); assert.equal(a.stats.disposed, 1);
});

test('internal APNG preserves exact millisecond delays, plays and a single animation frame', async () => {
    for (const plays of [0, 1, 3, 0xffffffff]) for (const delays of [[1], [65535], [1, 14, 15, 54, 55, 65535]]) {
        const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory, plays });
        for (const delay of delays) await add(h, exporter, source(), delay);
        const blob = await finish(h, exporter);
        assert.equal(a.stats.options.plays, plays); assert.deepEqual(a.stats.frames.map(f => f.durationMs), delays);
        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(a.stats.bytes)); assert.equal(a.stats.disposed, 1);
    }
});

test('internal APNG permits exact rational milliseconds including PNG zero-denominator convention', async () => {
    for (const denominator of [100, 0]) {
        const h = harness(), a = encoder({ denominator }), exporter = h.create({ encoder: a.factory });
        await add(h, exporter, source(), 50); assert.ok((await finish(h, exporter)).size);
    }
});

test('internal APNG invalid options and pre-abort allocate no encoder or snapshot', () => {
    const h = harness(); let made = 0; const factory = () => { made++; };
    for (const key of ['maxFramePixels', 'maxFrames', 'maxDurationMs', 'maxInputBytes', 'maxOutputBytes', 'totalFrames']) {
        for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '1']) assert.throws(() => h.create({ encoder: factory, [key]: value }), { name: 'RangeError' });
    }
    for (const plays of [-1, 0x100000000, 1.5, NaN, null, '1']) assert.throws(() => h.create({ encoder: factory, plays }), /plays/);
    assert.throws(() => h.create({ encoder: null }), /factory/); assert.throws(() => h.create({ encoder: factory, onProgress: 1 }), /onProgress/);
    const controller = new AbortController(), reason = { cancelled: true }; controller.abort(reason);
    assert.throws(() => h.create({ signal: controller.signal, get encoder() { throw new Error('should not read factory'); } }), error => error === reason);
    assert.equal(made, 0); assert.equal(h.copies.length, 0);
});

test('internal APNG invalid input/limits fail before readback and preserve already accepted counters', async () => {
    for (const [limits, canvas, delay, error] of [
        [{}, source(), 0, /duration/], [{}, source(), 1.5, /duration/], [{}, source(), 65536, /duration/],
        [{}, { ...source(), width: 0 }, 50, /dimensions/], [{}, { ...source(), width: 0x80000000 }, 50, /dimensions/],
        [{ maxFramePixels: 1 }, source(2, 1), 50, /maxFramePixels/], [{ maxDurationMs: 49 }, source(), 50, /maxDurationMs/],
        [{ maxInputBytes: 3 }, source(), 50, /maxInputBytes/]
    ]) {
        const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory, ...limits });
        await assert.rejects(exporter.addFrame(canvas, delay), error); assert.equal(canvas.reads, 0); assert.equal(canvas.contexts, 0);
        assert.equal(h.copies.length, 0); assert.equal(a.stats.disposed, 1); assert.equal(exporter.state, 'failed');
    }
    for (const limits of [{ maxFrames: 1 }, { maxDurationMs: 50 }, { maxInputBytes: 4 }]) {
        const h = harness(), a = encoder(), events = [], exporter = h.create({ encoder: a.factory, ...limits, onProgress: p => events.push(p) });
        await add(h, exporter); const rejected = source(); await assert.rejects(exporter.addFrame(rejected, 1));
        assert.equal(rejected.reads, 0); assert.deepEqual(events.map(p => [p.phase, p.framesAccepted, p.durationMs]), [['collecting', 1, 50], ['failed', 1, 50]]); assert.equal(a.stats.disposed, 1);
    }
});

test('internal APNG count/duration/input/output bounds are inclusive and totalFrames remains a hint', async () => {
    const h = harness(), a = encoder(), fixture = source();
    const outputSize = file([{ width: 1, height: 1, data: fixture.data, durationMs: 1 }], 0).length;
    const exporter = h.create({ encoder: a.factory, totalFrames: 100, maxFrames: 1, maxFramePixels: 1, maxDurationMs: 1, maxInputBytes: 4, maxOutputBytes: outputSize });
    await add(h, exporter, fixture, 1); assert.equal((await finish(h, exporter)).size, outputSize); assert.equal(a.stats.context.maxOutputBytes, outputSize);
    const b = encoder(), limited = h.create({ encoder: b.factory, maxOutputBytes: outputSize - 1 }); await add(h, limited, source(), 1);
    await assert.rejects(finish(h, limited), /maxOutputBytes/); assert.equal(b.stats.disposed, 1);
});

test('internal APNG overlap rejects without cancelling the admitted frame and finish caches its original promise', async () => {
    const h = harness(), gate = deferred(), a = encoder({ add: () => gate.promise }), exporter = h.create({ encoder: a.factory });
    const adding = exporter.addFrame(source(), 50); await h.step(); assert.equal(exporter.state, 'adding');
    await assert.rejects(exporter.addFrame(source(), 50), /adding/); await assert.rejects(exporter.finish(), /adding/); assert.equal(a.stats.disposed, 0);
    gate.resolve(); await adding; const pending = exporter.finish(); assert.equal(exporter.finish(), pending);
    await assert.rejects(exporter.addFrame(source(), 1), /finalizing/); await h.flush(); const blob = await pending;
    assert.equal(exporter.finish(), pending); assert.equal(await exporter.finish(), blob); assert.equal(a.stats.disposed, 1);
});

test('internal APNG reentrant finalizing observers see the cached finish promise before encoder finish', async () => {
    const h = harness(), trace = [], gate = deferred(); let exporter, nested;
    const a = encoder({ finish(stats) { trace.push('encoder:finish'); return gate.promise.then(() => file(stats.kept, 0)); } });
    exporter = h.create({ encoder: a.factory, onProgress(p) { if (p.phase === 'finalizing') { trace.push('observer:finalizing'); nested = exporter.finish(); } } });
    await add(h, exporter); const pending = exporter.finish(); trace.push('finish:return');
    assert.equal(nested, pending); assert.deepEqual(trace, ['observer:finalizing', 'encoder:finish', 'finish:return']);
    gate.resolve(); await h.flush(); assert.ok((await pending).size);
});

test('internal APNG factory reentrant abort releases the returned encoder once with original reason', () => {
    const h = harness(), controller = new AbortController(), reason = new Error('factory abort'), phases = [];
    const a = encoder({ create(instance) { controller.abort(reason); return instance; }, dispose() { throw new Error('cleanup'); } });
    assert.throws(() => h.create({ encoder: a.factory, signal: controller.signal, onProgress: p => phases.push(p.phase) }), e => e === reason);
    assert.equal(a.stats.disposed, 1); assert.equal(a.stats.context.signal.reason, reason); assert.deepEqual(phases, ['aborted']);
});

test('internal APNG abort/dispose cancels its initial task and ignores its stale callback', async () => {
    for (const mode of ['abort', 'dispose']) {
        const h = harness(), a = encoder(), controller = new AbortController(), reason = new Error('first reason'), phases = [];
        const exporter = h.create({ encoder: a.factory, signal: controller.signal, onProgress: p => phases.push(p.phase) });
        const pending = exporter.addFrame(source(), 50); const stale = h.callbacks[0];
        if (mode === 'abort') controller.abort(reason); else exporter.dispose();
        await assert.rejects(pending, e => mode === 'abort' ? e === reason : e.name === 'AbortError');
        assert.equal(h.timers.size, 0); stale(); await microtasks(); assert.equal(a.stats.frames.length, 0); assert.equal(a.stats.disposed, 1);
        exporter.dispose(); assert.equal(a.stats.disposed, 1); assert.deepEqual(phases, [mode === 'abort' ? 'aborted' : 'disposed']);
    }
});

test('internal APNG readback abort keeps its reason and never schedules or hands off a frame', async () => {
    for (const mode of ['abort', 'dispose']) {
        const h = harness(), a = encoder(), controller = new AbortController(), reason = new Error('during readback'); let exporter;
        const canvas = source(); canvas.getContext = () => ({ getImageData() { if (mode === 'abort') controller.abort(reason); else exporter.dispose(); return { data: canvas.data }; } });
        exporter = h.create({ encoder: a.factory, signal: controller.signal });
        await assert.rejects(exporter.addFrame(canvas, 50), e => mode === 'abort' ? e === reason : e.name === 'AbortError');
        assert.equal(h.timers.size, 0); assert.equal(h.copies.length, 0); assert.equal(a.stats.frames.length, 0); assert.equal(a.stats.disposed, 1);
    }
});

test('internal APNG pending adapter calls reject on cancellation and observe late failures', async () => {
    for (const stage of ['add', 'finish']) {
        const h = harness(), gate = deferred(), controller = new AbortController(), reason = new Error('cancel ' + stage), events = [];
        const a = encoder({ [stage]: () => gate.promise, dispose() { throw new Error('cleanup must not win'); } });
        const exporter = h.create({ encoder: a.factory, signal: controller.signal, onProgress: p => events.push(p.phase) });
        let pending;
        if (stage === 'add') { pending = exporter.addFrame(source(), 50); await h.step(); }
        else { await add(h, exporter); pending = exporter.finish(); }
        controller.abort(reason); await assert.rejects(pending, e => e === reason);
        const count = events.length; gate.reject(new Error('late failure')); await microtasks(); assert.equal(events.length, count); assert.equal(a.stats.disposed, 1);
        await assert.rejects(exporter.finish(), e => e === reason);
    }
});

test('internal APNG observer cancellation after acknowledgement retains committed counters', async () => {
    const h = harness(), a = encoder(), controller = new AbortController(), reason = new Error('observer'), events = [];
    const exporter = h.create({ encoder: a.factory, signal: controller.signal, onProgress(p) { events.push(p); if (p.phase === 'collecting') controller.abort(reason); } });
    const pending = exporter.addFrame(source(), 55); await h.step(); await assert.rejects(pending, e => e === reason);
    assert.deepEqual(events.map(p => [p.phase, p.framesAccepted, p.durationMs, p.inputBytesAccepted]), [['collecting', 1, 55, 4], ['aborted', 1, 55, 4]]); assert.equal(a.stats.disposed, 1);
});

test('internal APNG finished-observer disposal and mutating cleanup cannot retract the Blob', async () => {
    const h = harness(); let exporter;
    const a = encoder({ dispose(stats) { stats.bytes.fill(0); } });
    exporter = h.create({ encoder: a.factory, onProgress(p) { if (p.phase === 'finished') exporter.dispose(); else throw new Error('UI'); } });
    await add(h, exporter); const blob = await finish(h, exporter), bytes = new Uint8Array(await blob.arrayBuffer());
    assert.equal(exporter.state, 'disposed'); assert.equal(bytes[0], 137); assert.equal(a.stats.disposed, 1); assert.equal(a.stats.bytes[0], 0);
    await assert.rejects(exporter.finish(), { name: 'AbortError' }); assert.equal((await blob.arrayBuffer()).byteLength, blob.size);
});

test('internal APNG validates CRC, animation metadata, packet sequences and complete output', async () => {
    const mutations = {
        signature: bytes => { bytes[0] = 0; return bytes; }, CRC: bytes => { bytes[29] ^= 1; return bytes; },
        plays: bytes => rewrite(bytes, 'acTL', 0, b => b.writeUInt32BE(1, 4)), count: bytes => rewrite(bytes, 'acTL', 0, b => b.writeUInt32BE(2)),
        delay: bytes => rewrite(bytes, 'fcTL', 0, b => b.writeUInt16BE(51, 20)), sequence: bytes => rewrite(bytes, 'fcTL', 0, b => b.writeUInt32BE(1)),
        dimensions: bytes => rewrite(bytes, 'IHDR', 0, b => b.writeUInt32BE(2)), truncated: bytes => bytes.subarray(0, bytes.length - 1),
        trailing: bytes => Buffer.concat([bytes, Buffer.from([0])]), operations: bytes => rewrite(bytes, 'fcTL', 0, b => { b[25] = 2; }),
        static: bytes => Buffer.concat([bytes.subarray(0, 33), bytes.subarray(91)])
    };
    for (const [name, change] of Object.entries(mutations)) {
        const h = harness(), a = encoder({ finish: stats => change(file(stats.kept, 0)) }), exporter = h.create({ encoder: a.factory });
        await add(h, exporter); await assert.rejects(finish(h, exporter), /Invalid APNG/, name); assert.equal(a.stats.disposed, 1);
    }
    for (const value of [null, new Uint8Array(), new Uint8Array(new SharedArrayBuffer(8)), [137, 80]]) {
        const h = harness(), a = encoder({ finish: () => value }), exporter = h.create({ encoder: a.factory });
        await add(h, exporter); await assert.rejects(finish(h, exporter), { name: 'TypeError' }); assert.equal(a.stats.disposed, 1);
    }
});

test('internal APNG validation yields cooperatively and abort clears pending validation work', async () => {
    const h = harness(), a = encoder({ padding: 200000 }), controller = new AbortController(), reason = new Error('cancel validation');
    const exporter = h.create({ encoder: a.factory, signal: controller.signal }); await add(h, exporter);
    const pending = exporter.finish(); await microtasks(); assert.equal(exporter.state, 'finalizing'); assert.equal(h.timers.size, 1);
    const stale = h.callbacks.at(-1); controller.abort(reason); await assert.rejects(pending, e => e === reason);
    assert.equal(h.timers.size, 0); stale(); await microtasks(); assert.equal(a.stats.disposed, 1);
    const fresh = encoder({ padding: 200000 }), retry = h.create({ encoder: fresh.factory }); await add(h, retry); assert.ok((await finish(h, retry)).size > 200000);
});

test('internal APNG owns copied handoffs even when an encoder transfers them', async () => {
    const h = harness(); let moved;
    const a = encoder({ add(frame) { moved = structuredClone(frame.data, { transfer: [frame.data.buffer] }); } }), exporter = h.create({ encoder: a.factory });
    const canvas = source(), before = canvas.data.slice(); await add(h, exporter, canvas);
    assert.equal(a.stats.owned[0].deref().byteLength, 0); assert.deepEqual(moved, before); assert.deepEqual(canvas.data, before); assert.equal(canvas.data.byteLength, 4);
    exporter.dispose(); assert.equal(a.stats.disposed, 1);
});

test('internal APNG removes signal listeners on terminal outcomes and preserves error causes', async () => {
    for (const mode of ['success', 'fail', 'abort', 'dispose']) {
        const h = harness(), controller = new AbortController(), listeners = new Set();
        const listen = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
        controller.signal.addEventListener = (type, callback, opts) => { listeners.add(callback); listen(type, callback, opts); };
        controller.signal.removeEventListener = (type, callback, opts) => { listeners.delete(callback); remove(type, callback, opts); };
        const original = new Error('backend failure'), a = encoder(mode === 'fail' ? { add() { throw original; } } : {}), exporter = h.create({ encoder: a.factory, signal: controller.signal });
        assert.equal(listeners.size, 1);
        if (mode === 'success') { await add(h, exporter); await finish(h, exporter); }
        if (mode === 'fail') { const pending = exporter.addFrame(source(), 50); await h.step(); await assert.rejects(pending, e => e.cause === original && /addFrame/.test(e.message)); }
        if (mode === 'abort') controller.abort(original);
        if (mode === 'dispose') exporter.dispose();
        assert.equal(listeners.size, 0); exporter.dispose(); assert.equal(a.stats.disposed, 1);
    }
});

test('public APNG entry exposes the controller and types without importing a codec', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.exports['./apng'].import, './dist/apng.js');
    const publicEntry = await import('@grundyjs/canvas-take/apng'); assert.equal(typeof publicEntry.createApngExporter, 'function');
    assert.deepEqual(Object.keys(publicEntry), ['createApngExporter']);
    const module = await import('../dist/internal/apng-controller.js'); assert.equal(typeof module.createApngController, 'function');
    const bundle = await build({ entryPoints: ['dist/internal/apng-controller.js'], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser' });
    assert.ok(Object.keys(bundle.metafile.inputs).every(path => path.startsWith('dist/internal/apng-')));
    assert.deepEqual(Object.values(bundle.metafile.outputs)[0].imports, []);
});

test('internal APNG malformed synchronous/async factories release partial and late resources', async () => {
    const h = harness(), partial = encoder({ create(instance) { delete instance.finish; return instance; } });
    assert.throws(() => h.create({ encoder: partial.factory }), /disposable/); assert.equal(partial.stats.disposed, 1);
    const late = deferred(), a = encoder({ create: instance => late.promise.then(() => instance) });
    assert.throws(() => h.create({ encoder: a.factory }), /disposable/); assert.equal(a.stats.context.signal.aborted, true); assert.equal(a.stats.disposed, 0);
    late.resolve(); await microtasks(); assert.equal(a.stats.disposed, 1);
    const rejected = deferred(); assert.throws(() => h.create({ encoder: () => rejected.promise }), /disposable/);
    rejected.reject(new Error('late rejected factory')); await microtasks();
});

test('internal APNG adapter failures preserve primitive causes at every component boundary', async () => {
    for (const stage of ['create', 'addFrame', 'finish']) for (const original of [undefined, null, false, 0, '', new Error('original')]) {
        const h = harness(), hooks = {};
        if (stage === 'create') hooks.create = () => { throw original; };
        if (stage === 'addFrame') hooks.add = () => { throw original; };
        if (stage === 'finish') hooks.finish = () => { throw original; };
        const a = encoder(hooks);
        const match = error => Object.hasOwn(error, 'cause') && error.cause === original && error.message === 'APNG encoder.' + stage + ' failed';
        if (stage === 'create') assert.throws(() => h.create({ encoder: a.factory }), match);
        else {
            const exporter = h.create({ encoder: a.factory }); let pending;
            if (stage === 'addFrame') { pending = exporter.addFrame(source(), 50); await h.step(); }
            else { await add(h, exporter); pending = exporter.finish(); }
            let first; await assert.rejects(pending, error => { first = error; return match(error); });
            await assert.rejects(exporter.finish(), error => error === first); assert.equal(a.stats.disposed, 1);
        }
    }
});

test('internal APNG preserves falsy abort reasons and existing nullish defaults', async () => {
    for (const input of [0, false, '', { reason: true }, null, undefined]) {
        const h = harness(), a = encoder(), controller = new AbortController(), exporter = h.create({ encoder: a.factory, signal: controller.signal });
        const pending = exporter.addFrame(source(), 50); controller.abort(input);
        let first; await assert.rejects(pending, error => { first = error; return input == null ? error.name === 'AbortError' : error === input; });
        assert.equal(a.stats.context.signal.reason, first); exporter.dispose(); await assert.rejects(exporter.finish(), error => error === first);
    }
});

test('internal APNG cleanup reentrancy/throws cannot replace the original failure or duplicate notifications', async () => {
    const h = harness(), original = new Error('original input failure'), events = []; let exporter;
    const a = encoder({ add() { throw original; }, dispose() { exporter.dispose(); throw new Error('cleanup'); } });
    exporter = h.create({ encoder: a.factory, onProgress: p => events.push(p.phase) });
    const pending = exporter.addFrame(source(), 50); await h.step(); let first;
    await assert.rejects(pending, error => { first = error; return error.cause === original; });
    assert.equal(exporter.state, 'disposed'); assert.equal(a.stats.disposed, 1); assert.deepEqual(events, ['failed']);
    await assert.rejects(exporter.addFrame(source(), 1), error => error === first);
});

test('internal APNG finalizing observer abort stops finish before calling the encoder', async () => {
    const h = harness(), controller = new AbortController(), reason = new Error('finalizing observer'), phases = []; let finishes = 0;
    const a = encoder({ finish() { finishes++; } }), exporter = h.create({ encoder: a.factory, signal: controller.signal, onProgress(p) { phases.push(p.phase); if (p.phase === 'finalizing') controller.abort(reason); } });
    await add(h, exporter); await assert.rejects(exporter.finish(), error => error === reason);
    assert.equal(finishes, 0); assert.equal(a.stats.disposed, 1); assert.deepEqual(phases, ['collecting', 'finalizing', 'aborted']);
});

test('internal APNG optional progress is lazy and fresh, with omitted fields absent and a bare synchronous call', async () => {
    const h = harness(), a = encoder(), noObserver = h.create({ encoder: a.factory }); await add(h, noObserver); await finish(h, noObserver);
    assert.equal(h.progressSnapshots.length, 0);
    const b = encoder(), events = [], receivers = []; let exporter, overlap;
    exporter = h.create({ encoder: b.factory, onProgress: function(p) { events.push(p); receivers.push(this); if (p.phase === 'collecting') overlap = exporter.addFrame(source(), 1); } });
    const frame = exporter.addFrame(source(), 55); await h.step(); await frame; await assert.rejects(overlap, /adding/);
    const blob = await finish(h, exporter); assert.ok(blob.size); assert.ok(receivers.every(value => value === undefined));
    assert.equal('totalFrames' in events[0], false); assert.equal('outputBytes' in events[0], false);
    assert.equal(new Set(events).size, events.length); assert.ok(events.every(Object.isFrozen));
});

test('internal APNG tainted/missing/invalid readback, resize and scheduler failures release owned work', async () => {
    for (const kind of ['tainted', 'context', 'pixels', 'resize', 'timer']) {
        const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory }), canvas = source(), original = new DOMException('Tainted', 'SecurityError');
        if (kind === 'tainted') canvas.getContext = () => ({ getImageData() { throw original; } });
        if (kind === 'context') canvas.getContext = () => null;
        if (kind === 'pixels') canvas.getContext = () => ({ getImageData() { return { data: new Uint8ClampedArray(3) }; } });
        if (kind === 'resize') { await add(h, exporter, canvas); canvas.width = 2; }
        if (kind === 'timer') h.failSchedule(original);
        await assert.rejects(exporter.addFrame(canvas, 50), error => ['timer', 'tainted'].includes(kind) ? error === original : /APNG/.test(error.message));
        assert.equal(a.stats.disposed, 1); assert.equal(h.timers.size, 0);
    }
});

test('internal APNG owns returned bytes before cooperative validation and checks payload CRCs', async () => {
    const h = harness(), a = encoder({ padding: 200000 }), exporter = h.create({ encoder: a.factory }); await add(h, exporter);
    const pending = exporter.finish(); await microtasks(); assert.equal(h.timers.size, 1); a.stats.bytes.fill(0);
    await h.flush(); const blob = await pending; assert.equal(new Uint8Array(await blob.arrayBuffer())[0], 137);
    const b = encoder({ finish: stats => rewrite(file(stats.kept, 0), 'IDAT', 0, bytes => { bytes[0] ^= 1; }, false) }), invalid = h.create({ encoder: b.factory });
    await add(h, invalid); await assert.rejects(finish(h, invalid), /CRC IDAT/); assert.equal(b.stats.disposed, 1);
});

test('internal APNG empty completion fails once and later disposal preserves its rejection', async () => {
    const h = harness(), a = encoder(), exporter = h.create({ encoder: a.factory }); let first;
    await assert.rejects(exporter.finish(), error => { first = error; return /at least one frame/.test(error.message); });
    assert.equal(a.stats.disposed, 1); exporter.dispose(); await assert.rejects(exporter.finish(), error => error === first);
});

test('retained internal APNG controllers release owned snapshots and ArrayBuffers at terminal cleanup', () => {
    const output = execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/apng-controller-gc.mjs', import.meta.url))], { encoding: 'utf8', timeout: 30000 });
    assert.match(output, /Five retained APNG controllers released owned snapshots and buffers/);
});

test('internal APNG ignores late successful adapter completions after abort', async () => {
    for (const stage of ['add', 'finish']) {
        const h = harness(), gate = deferred(), controller = new AbortController(), original = new Error('cancelled'), events = [];
        const a = encoder({ [stage]: () => gate.promise }), exporter = h.create({ encoder: a.factory, signal: controller.signal, onProgress: p => events.push(p.phase) });
        let pending, result;
        if (stage === 'add') { pending = exporter.addFrame(source(), 50); await h.step(); }
        else { await add(h, exporter); result = file(a.stats.kept, 0); pending = exporter.finish(); }
        controller.abort(original); await assert.rejects(pending, error => error === original); const count = events.length;
        gate.resolve(result); await microtasks(); assert.equal(events.length, count); assert.equal(a.stats.disposed, 1); assert.equal(h.timers.size, 0);
    }
});

test('internal APNG validates multi-frame sequence/default-image bounds and corrupt compressed data', async () => {
    for (const change of [
        bytes => rewrite(bytes, 'fcTL', 1, data => data.writeUInt32BE(0)),
        bytes => rewrite(bytes, 'fdAT', 0, data => data.writeUInt32BE(0)),
        bytes => rewrite(bytes, 'fcTL', 1, data => data.writeUInt32BE(2, 12)),
        bytes => rewrite(bytes, 'IHDR', 0, data => { data[9] = 1; }),
        bytes => rewrite(bytes, 'fdAT', 0, data => { data[4] ^= 1; }, false)
    ]) {
        const h = harness(), a = encoder({ finish: stats => change(file(stats.kept, 0)) }), exporter = h.create({ encoder: a.factory });
        await add(h, exporter); await add(h, exporter); await assert.rejects(finish(h, exporter), /Invalid APNG/); assert.equal(a.stats.disposed, 1);
    }
});

test('internal and public APNG contracts match the draft types', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'canvastake-apng-types-'));
    try {
        const internal = fileURLToPath(new URL('../src/internal/apng-types.js', import.meta.url)).replaceAll('\\', '/');
        const draft = fileURLToPath(new URL('../docs/drafts/apng-export-api.js', import.meta.url)).replaceAll('\\', '/');
        const controller = fileURLToPath(new URL('../src/internal/apng-controller.js', import.meta.url)).replaceAll('\\', '/');
        const publicEntry = fileURLToPath(new URL('../src/apng.js', import.meta.url)).replaceAll('\\', '/');
        const names = ['ApngFrame', 'ApngEncoderContext', 'ApngFrameEncoder', 'ApngEncoderFactory', 'ApngExportState', 'ApngExportProgress', 'ApngExportOptions', 'ApngExporter'];
        await writeFile(join(workspace, 'check.mts'), `import type * as I from ${JSON.stringify(internal)};
import type * as D from ${JSON.stringify(draft)};
import type * as P from ${JSON.stringify(publicEntry)};
import {createApngExporter} from ${JSON.stringify(publicEntry)};
import {createApngController} from ${JSON.stringify(controller)};
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2) ? true : false;
const checks: [${names.map(n => 'Equal<I.' + n + ',D.' + n + '>').join(',')}] = [${names.map(() => 'true').join(',')}];
const create: typeof D.createApngExporter = createApngController;
const publicChecks: [${names.map(n => 'Equal<P.' + n + ',D.' + n + '>').join(',')}] = [${names.map(() => 'true').join(',')}];
const publicCreate: typeof D.createApngExporter = createApngExporter;
void checks; void create; void publicChecks; void publicCreate;\n`);
        execFileSync(process.execPath, [fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)), '--ignoreConfig', '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', join(workspace, 'check.mts')], { encoding: 'utf8', timeout: 30000 });
    } finally {
        const parent = await realpath(tmpdir()), target = await realpath(workspace), child = relative(parent, target);
        if (!child || child.startsWith('..') || isAbsolute(child) || dirname(target) !== parent) throw new Error('Unsafe temporary type-check cleanup path');
        await rm(target, { recursive: true, force: true });
    }
});

test('internal APNG cancellation between nested await continuations cannot commit late counters or success', async () => {
    for (const stage of ['add', 'finish']) for (let offset = 0; offset < 13; offset++) {
        const h = harness(), gate = deferred(), controller = new AbortController(), original = new Error(stage + '/' + offset), events = [];
        const a = encoder({ [stage]: () => gate.promise }), exporter = h.create({ encoder: a.factory, signal: controller.signal, onProgress: p => events.push(p.phase) });
        let pending;
        if (stage === 'add') { pending = exporter.addFrame(source(), 50); await h.step(); }
        else { await add(h, exporter); pending = exporter.finish(); }
        const observed = pending.then(value => ({ value }), error => ({ error }));
        gate.resolve(stage === 'finish' ? file(a.stats.kept, 0) : undefined);
        let turn = Promise.resolve(); for (let i = 0; i < offset; i++) turn = turn.then(() => {});
        await turn.then(() => controller.abort(original)); const result = await observed; await microtasks();
        const aborted = events.indexOf('aborted');
        if (aborted >= 0) {
            assert.deepEqual(events.slice(aborted + 1), [], 'no post-abort event: ' + stage + '/' + offset);
            assert.equal(exporter.state, 'aborted');
            if (stage === 'finish') assert.equal(result.error, original, 'no successful Blob after terminal cancellation');
        } else { assert.equal(stage, 'finish'); assert.equal(exporter.state, 'finished'); assert.ok(result.value.size); }
        assert.equal(h.timers.size, 0); assert.equal(a.stats.disposed, 1); exporter.dispose();
    }
});

test('internal APNG cancellation between CRC continuations never schedules validation after cleanup', async () => {
    for (let offset = 0; offset < 13; offset++) {
        const h = harness(), a = encoder({ padding: 200000 }), controller = new AbortController(), original = new Error('CRC/' + offset);
        const exporter = h.create({ encoder: a.factory, signal: controller.signal }); await add(h, exporter);
        const pending = exporter.finish(), observed = assert.rejects(pending, error => error === original);
        await microtasks(); assert.equal(h.timers.size, 1);
        let turn = Promise.resolve(); for (let i = 0; i < offset; i++) turn = turn.then(() => {});
        const aborted = turn.then(() => controller.abort(original));
        await h.step(); await aborted; await observed; await microtasks();
        assert.equal(h.timers.size, 0, 'no task resurrected after cleanup: ' + offset); assert.equal(a.stats.disposed, 1);
    }
});
