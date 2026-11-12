import { createApngController } from '/dist/internal/apng-controller.js';
import { createApngWorkerEncoder } from '/dist/internal/apng-worker.js';

export async function exportCase({ width = 7, height = 3, delays = [1, 14, 55, 2000], plays = 3, workerUrl, offscreen = false } = {}) {
    const canvas = offscreen ? new OffscreenCanvas(width, height) : document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'), frames = [], events = [];
    const exporter = createApngController({ encoder: createApngWorkerEncoder({ workerUrl }), plays,
        maxInputBytes: width * height * 4 * delays.length, totalFrames: delays.length, onProgress: p => events.push(p) });
    try {
        for (let f = 0; f < delays.length; f++) {
            const image = ctx.createImageData(width, height);
            for (let p = 0; p < image.data.length; p += 4) {
                const alpha = [0, 1, 127, 128, 254, 255][(p / 4 + f) % 6];
                image.data.set(f === 1 ? [0, 0, 0, 0] : [70 + f * 20, 130, 220, alpha], p);
            }
            ctx.putImageData(image, 0, 0);
            // Browser premultiplication can change draw colors: the oracle is the captured snapshot.
            frames.push({ data: [...ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data], durationMs: delays[f] });
            const pending = exporter.addFrame(canvas, delays[f]);
            ctx.clearRect(0, 0, width, height); // Must not change the synchronously captured image.
            await pending;
        }
        const pending = exporter.finish(), same = exporter.finish() === pending;
        const blob = await pending; exporter.dispose();
        const bytes = [...new Uint8Array(await blob.arrayBuffer())];
        const url = URL.createObjectURL(blob);
        let viewerError;
        try { const image = new Image(); image.src = url; await image.decode(); if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('APNG viewer dimensions'); }
        catch (error) { viewerError = error.message; }
        finally { URL.revokeObjectURL(url); }
        return { bytes, frames, width, height, plays, delays, events, same, type: blob.type, viewerError };
    } finally { exporter.dispose(); }
}

export async function cancelCompression() {
    const NativeWorker = window.Worker, controller = new AbortController(), reason = new Error('cancel active APNG compression');
    const status = new Int32Array(new SharedArrayBuffer(4)); let active = false, entered = false;
    class ProbeWorker extends NativeWorker {
        constructor(url, options) {
            super(url, options);
            this.addEventListener('message', event => {
                if (event.data.compressionProbe) { entered = true; active = Atomics.load(status, 0) === 1; controller.abort(reason); }
            });
        }
        postMessage(message, transfer) { super.postMessage(message.action === 'init' ? { ...message, probeBuffer: status.buffer } : message, transfer); }
    }
    window.Worker = ProbeWorker;
    const events = [], exporter = createApngController({ signal: controller.signal,
        encoder: createApngWorkerEncoder({ workerUrl: '/fixtures/apng-probe.js', timeoutMs: 60000 }), onProgress: p => events.push(p.phase) });
    try {
        const canvas = new OffscreenCanvas(2048, 1280), ctx = canvas.getContext('2d');
        let seed = 123456789;
        for (let f = 0; f < 3; f++) {
            const image = ctx.createImageData(canvas.width, canvas.height);
            for (let i = 0; i < image.data.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; image.data[i] = seed & 255; }
            ctx.putImageData(image, 0, 0); await exporter.addFrame(canvas, 50);
        }
        let sameReason = false;
        try { await exporter.finish(); } catch (error) { sameReason = error === reason; }
        return { entered, active, sameReason, state: exporter.state, events, compressionFlag: Atomics.load(status, 0) };
    } finally { exporter.dispose(); window.Worker = NativeWorker; }
}
