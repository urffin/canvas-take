import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { output } from './toolchain.mjs';
import { jobFor, specs, stressJob } from './fixtures.mjs';

export async function checkWorkers() {
    const lifecycle = { opened: 0, exited: 0, cleared: 0, transfers: 0 }, cancellations = [], retries = [];
    function open() {
        const worker = new Worker(new URL('./node-worker.mjs', import.meta.url), { workerData: {
            codec: pathToFileURL(resolve(output, 'build-a/backend.mjs')).href, wasm: resolve(output, 'build-a/backend.wasm') } });
        lifecycle.opened++;
        let pending, closed = false;
        const wait = () => new Promise((resolve, reject) => {
            const timer = setTimeout(() => { pending = undefined; reject(new Error('Node Worker timeout')); }, 30000);
            pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        });
        const ready = wait();
        worker.on('message', value => { const current = pending; pending = undefined; current?.resolve(value); });
        worker.on('error', error => { const current = pending; pending = undefined; current?.reject(error); });
        return { ready,
            call(job, shared) {
                assert.ok(!closed && !pending);
                const promise = wait(); worker.postMessage({ job, shared }, job.frames.map(frame => frame.data.buffer));
                assert.ok(job.frames.every(frame => frame.data.byteLength === 0)); lifecycle.transfers++; return promise;
            },
            async close(reason = new Error('Worker closed')) {
                if (closed) return;
                closed = true; pending?.reject(reason); pending = undefined;
                const exitCode = await worker.terminate(); lifecycle.exited++;
                worker.removeAllListeners(); assert.equal(worker.eventNames().length, 0); lifecycle.cleared++;
                return exitCode;
            }
        };
    }
    const before = open(), reason = new Error('Before ready');
    const rejected = before.ready.catch(error => error); await before.close(reason); assert.equal(await rejected, reason);
    cancellations.push({ mode: 'before-ready', outputs: 0 });
    for (const mode of ['cooperative', 'terminate', 'terminate']) {
        const client = open(), flags = new Int32Array(new SharedArrayBuffer(16));
        try {
            await client.ready;
            const response = client.call(stressJob(), flags.buffer).then(value => ({ value }), error => ({ error }));
            const deadline = performance.now() + 20000;
            while (!Atomics.load(flags, 0)) {
                assert.ok(performance.now() < deadline, 'inside-native probe reached'); await new Promise(resolve => setTimeout(resolve, 1));
            }
            const phaseBefore = Atomics.load(flags, 0), started = performance.now();
            if (mode === 'cooperative') {
                Atomics.store(flags, 1, 1); Atomics.store(flags, 2, 1); Atomics.notify(flags, 2);
                const { value } = await response;
                assert.equal(value.error?.message, 'Native encoding aborted'); assert.equal(value.bytes, undefined);
                assert.equal(value.stats.liveBytes, 0); assert.equal(value.stats.liveAllocations, 0);
                cancellations.push({ mode, phaseBefore, phaseAfter: Atomics.load(flags, 0), hookCalls: Atomics.load(flags, 3), settlementMs: performance.now() - started, stats: value.stats });
                const retry = await client.call(jobFor(specs[0])); assert.ok(!retry.error);
                retries.push({ name: 'same-worker', bytes: retry.bytes, stats: retry.stats });
            } else {
                const reason = new Error('Hard cancel'), exitCode = await client.close(reason);
                assert.equal((await response).error, reason); assert.equal(Atomics.load(flags, 0), 1, 'terminated while inside native callback');
                cancellations.push({ mode, phaseBefore, phaseAfter: Atomics.load(flags, 0), hookCalls: Atomics.load(flags, 3), exitCode, settlementMs: performance.now() - started, outputs: 0 });
            }
        } finally { await client.close(); }
        const retry = open();
        try { await retry.ready; const result = await retry.call(jobFor(specs[0])); assert.ok(!result.error); retries.push({ name: 'fresh-worker', bytes: result.bytes, stats: result.stats }); }
        finally { await retry.close(); }
    }
    assert.equal(lifecycle.opened, lifecycle.exited); assert.equal(lifecycle.opened, lifecycle.cleared);
    return { lifecycle, cancellations, retries };
}
