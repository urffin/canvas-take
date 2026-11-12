import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { output } from './prepare.mjs';

export async function nodeJob(job, mode = 'success') {
    const worker = new Worker(new URL('./node-worker.mjs', import.meta.url), { workerData: { backend: pathToFileURL(resolve(output, 'backend.mjs')).href } });
    let resolveReady, rejectReady, resolveDone, rejectDone;
    const ready = new Promise((yes, no) => { resolveReady = yes; rejectReady = no; }); void ready.catch(() => {});
    const done = new Promise((yes, no) => { resolveDone = yes; rejectDone = no; }); void done.catch(() => {});
    const phase = new Int32Array(new SharedArrayBuffer(4)), reason = new Error('Original APNG cancellation');
    let closed = false, terminate, abortAt, settledAt, timer, bytes, owned = job.frames.map(f => ({ ...f, data: f.data.slice() }));
    const stats = { mode, outputs: 0, transferred: false, rawBytes: job.frames.reduce((n, f) => n + f.data.byteLength, 0) };
    const exit = new Promise(resolve => worker.once('exit', code => { stats.exitCode = code; stats.exitedAt = performance.now(); resolve(); }));
    const close = error => {
        if (closed) return; closed = true; clearTimeout(timer);
        rejectReady(error); rejectDone(error); owned = [];
        terminate = worker.terminate();
    };
    const abort = () => { abortAt = performance.now(); stats.phaseAtAbort = Atomics.load(phase, 0); close(reason); };
    const message = data => {
        if (closed) return;
        if (data.boot) { if (mode === 'before-ready') abort(); return; }
        if (data.ready) { resolveReady(); return; }
        if (data.compression) { if (mode === 'compression' && Atomics.load(phase, 0) === 1) abort(); return; }
        if (data.error) { close(new Error(data.error.message)); return; }
        stats.outputs++; resolveDone(data.bytes);
    };
    worker.on('message', message); worker.on('error', close);
    timer = setTimeout(() => close(new Error('Node Worker timeout')), 30000);
    try {
        await ready;
        const buffers = owned.map(f => f.data.buffer);
        worker.postMessage({ id: 1, job: { ...job, frames: owned }, phase: phase.buffer }, buffers);
        stats.transferred = buffers.every(b => b.byteLength === 0); owned = [];
        bytes = await done; if (mode !== 'success') throw new Error('Cancellation did not interrupt compression');
    } catch (error) {
        settledAt = performance.now(); if (error !== reason) throw error;
        stats.rejectedWithOriginalReason = true;
    } finally {
        close(reason); await terminate; await exit;
        worker.removeAllListeners('message'); worker.removeAllListeners('error');
    }
    if (abortAt !== undefined) { stats.settlementMs = settledAt - abortAt; stats.terminationMs = stats.exitedAt - abortAt; }
    stats.phaseAfterExit = Atomics.load(phase, 0); stats.retainedOwnedFrames = owned.length;
    stats.listenersAfterClose = worker.listenerCount('message') + worker.listenerCount('error');
    return { stats, bytes };
}
