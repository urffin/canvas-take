import { makeJob } from './fixtures.mjs';
const deferred = () => { let yes, no, settled = false; const promise = new Promise((resolve, reject) => { yes = resolve; no = reject; }); void promise.catch(() => {}); return { promise, get settled() { return settled; }, resolve(value) { settled = true; yes(value); }, reject(error) { settled = true; no(error); } }; };
const fingerprint = frames => frames.reduce((hash, f) => { for (const b of f.data) hash = Math.imul(hash ^ b, 16777619) >>> 0; return hash; }, 2166136261);
const base64 = bytes => { let text = ''; for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384)); return btoa(text); };

// Test page transport only. It is not a CanvasTake controller/adapter implementation.
window.apngSpike = async (spec, mode = 'success') => {
    const original = makeJob(spec), before = fingerprint(original.frames), ready = deferred(), done = deferred();
    let owned = original.frames.map(f => ({ ...f, data: f.data.slice() }));
    const rawBytes = owned.reduce((n, f) => n + f.data.byteLength, 0);
    let worker = new Worker('./worker.mjs', { type: 'module' }), closed = false, success = false, abortAt, rejectionAt;
    const reason = new Error('APNG spike cancelled'), phase = mode === 'compression' ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
    const stats = { rawBytes, transferred: false, outputs: 0, compressionMessages: 0, rejectedWithOriginalReason: false };
    let handlers = 3;
    let timer;
    function close(error) {
        if (closed) return; closed = true; clearTimeout(timer);
        const previous = worker; worker = undefined;
        previous.removeEventListener('message', message); previous.removeEventListener('error', errorEvent); previous.removeEventListener('messageerror', messageError);
        handlers -= 3;
        previous.terminate(); owned = [];
        ready.reject(error); done.reject(error);
    }
    function abort() { if (closed) return; abortAt = performance.now(); stats.phaseAtAbort = phase && Atomics.load(phase, 0); close(reason); }
    function message({ data }) {
        if (closed) return;
        if (data.boot) { if (mode === 'before-ready') abort(); return; }
        if (data.ready) { ready.resolve(); return; }
        if (data.compression) {
            stats.compressionMessages++;
            if (phase && Atomics.load(phase, 0) === 1) abort();
            return;
        }
        if (data.error) { const error = new Error(data.error.message); error.name = data.error.name; done.reject(error); return; }
        stats.outputs++; done.resolve(data.bytes);
    }
    function errorEvent(event) { close(new Error(event.message)); }
    function messageError() { close(new Error('Worker messageerror')); }
    worker.addEventListener('message', message); worker.addEventListener('error', errorEvent); worker.addEventListener('messageerror', messageError);
    timer = setTimeout(() => close(new Error('APNG spike timed out')), 30000);
    try {
        await ready.promise;
        const buffers = owned.map(f => f.data.buffer);
        worker.postMessage({ id: 1, job: { ...original, frames: owned }, phase: phase?.buffer }, buffers);
        stats.transferred = buffers.every(b => b.byteLength === 0); owned = [];
        const bytes = await done.promise;
        if (mode !== 'success') throw new Error('Expected interruption, received complete output');
        success = true; return { bytes: base64(bytes), stats };
    } catch (error) {
        rejectionAt = performance.now();
        if (error !== reason) throw error;
        stats.rejectedWithOriginalReason = true;
        return { cancelled: true, stats };
    } finally {
        close(success ? new Error('Completed') : reason);
        stats.sourceIntact = original.frames.every(f => f.data.byteLength === spec.width * spec.height * 4) && fingerprint(original.frames) === before;
        stats.retainedOwnedFrames = owned.length;
        stats.pendingAfterClose = [ready, done].filter(p => !p.settled).length; stats.listenersAfterClose = handlers;
        if (phase) stats.phaseAfterClose = Atomics.load(phase, 0);
        if (abortAt !== undefined) stats.settlementMs = rejectionAt - abortAt;
    }
};
