import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { access, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createApngExporter } from '@grundyjs/canvas-take/apng';
import { createApngWorkerEncoder } from '@grundyjs/canvas-take/apng/worker';
import { source, encoder } from './fixtures/apng-controller.mjs';

test('public APNG supports a third-party encoder, owned alpha snapshots and cached finish', async () => {
    const a = encoder(), canvas = source(), events = [], expected = canvas.data.slice();
    const exporter = createApngExporter({ encoder: a.factory, plays: 1, onProgress: p => events.push(p) });
    const frame = exporter.addFrame(canvas, 55); canvas.data.fill(0); await frame;
    assert.deepEqual(a.stats.frames[0].data, expected); assert.equal(a.stats.options.plays, 1);
    const pending = exporter.finish(); assert.equal(exporter.finish(), pending);
    const blob = await pending; assert.equal(blob.type, 'image/apng'); assert.equal(exporter.finish(), pending);
    exporter.dispose(); assert.ok((await blob.arrayBuffer()).byteLength); assert.equal(a.stats.disposed, 1);
    assert.deepEqual(events.map(p => p.phase), ['collecting', 'finalizing', 'finished']);
});

test('public APNG controller and Worker imports are isolated, codec-free and safe without browser globals', async () => {
    const root = await import('@grundyjs/canvas-take'); assert.equal(root.createApngExporter, undefined);
    await access(new URL(import.meta.resolve('@grundyjs/canvas-take/apng/worker-runtime')));
    assert.throws(() => createApngExporter({ encoder: createApngWorkerEncoder() }), error => error.cause?.message.includes('not supported'));
    for (const entry of ['src/apng.ts', 'src/apng-worker.ts']) {
        const result = await build({ entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'browser' });
        assert.ok(!Object.keys(result.metafile.inputs).some(path => /vendor|apng-batch|apng-worker-runtime/.test(path)));
        assert.deepEqual(Object.values(result.metafile.outputs)[0].imports, []);
    }
});

test('built public Worker bootstrap survives sideEffects false and installs its protocol handler', async () => {
    const replies = []; let closed = 0;
    const scope = { postMessage(reply) { replies.push(reply); }, close() { closed++; } };
    runInNewContext(await readFile('dist/apng-worker-runtime.js', 'utf8'), { self: scope, AbortController });
    assert.equal(typeof scope.onmessage, 'function');
    scope.onmessage({ data: { version: 2, id: 1, action: 'init' } });
    assert.equal(replies.length, 1); assert.equal(replies[0].error.name, 'TypeError'); assert.equal(closed, 1);
});
