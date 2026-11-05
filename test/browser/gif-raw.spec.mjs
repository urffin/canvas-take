import { test, expect } from '@playwright/test';
import { parseGIF, decompressFrames } from 'gifuct-js';

test('raw handoff, old assets, unknown versions and public wrappers preserve GIF bytes', async ({ page }) => {
    const errors = []; page.on('pageerror', e => errors.push(e.message)); await page.goto('/');
    const results = await page.evaluate(async () => {
        const { createGifExporter } = await import('/dist/gif.js');
        const { createGifWorkerEncoder } = await import('/dist/gif-worker.js');
        const { createGifWorkerEncoder: legacy } = await import('/fixtures/gif-worker-legacy-adapter.mjs');
        const NativeWorker = Worker, NativeChannel = MessageChannel, now = performance.now.bind(performance);
        let record, clock = 0;
        window.Worker = class extends NativeWorker {
            postMessage(message, transfer) { record.actions.push(message.action); super.postMessage(message, transfer);
                if (transfer.length) record.detached += message.value.data.byteLength === 0 ? 1 : 0; }
            terminate() { record.terminated++; super.terminate(); }
        };
        window.MessageChannel = class extends NativeChannel { constructor() { super(); record.chunks++; } };
        performance.now = () => clock += 5; // Force chunk boundaries in fallback; not a timing measurement.
        const results = [], canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d'), image = ctx.createImageData(320, 180);
        for (let p = 0; p < 320 * 180; p++) image.data.set([200, 100, 50, [0, 1, 128, 254, 255][p % 5]], p * 4);
        try {
            for (const mode of ['raw', 'old-runtime', 'old-adapter', 'unknown', 'wrapper', 'observed-proxy']) {
                record = { mode, actions: [], chunks: 0, detached: 0, terminated: 0 };
                const runtime = mode === 'old-runtime' ? '/fixtures/gif-worker-legacy-runtime.mjs' : mode === 'unknown' ? '/fixtures/gif-worker-unknown-version.mjs' : '/dist/gif-worker-runtime.js';
                let factory = (mode === 'old-adapter' ? legacy : createGifWorkerEncoder)({ workerUrl: runtime, maxColors: 16 });
                if (mode === 'wrapper') { const real = factory; factory = settings => { const e = real(settings); return {
                    addFrame: frame => e.addFrame(frame), finish: () => e.finish(), dispose: () => e.dispose()
                }; }; }
                if (mode === 'observed-proxy') { const real=factory;factory=settings=>{
                    const encoder=real(settings);record.observed=0;
                    return new Proxy(encoder,{get(target,key){if(key==='addFrame')return frame=>{record.observed++;return target.addFrame(frame);};return Reflect.get(target,key,target);}});
                }; }
                const gif = createGifExporter({ encoder: factory, background: [20, 40, 60], repeat: 3 });
                try {
                    ctx.putImageData(image, 0, 0); const first = gif.addFrame(canvas, 54); ctx.clearRect(0, 0, 320, 180); await first;
                    ctx.putImageData(image, 0, 0); await gif.addFrame(canvas, 2000);
                    record.bytes = Array.from(new Uint8Array(await (await gif.finish()).arrayBuffer()));
                    record.sourceAttached = image.data.byteLength === 320 * 180 * 4;
                } finally { gif.dispose(); }
                results.push(record);
            }
            return results;
        } finally { window.Worker = NativeWorker; window.MessageChannel = NativeChannel; performance.now = now; }
    });
    const expected = results[0].bytes;
    for (const result of results) {
        expect(result.bytes).toEqual(expected); expect(result.sourceAttached).toBe(true);
        expect(result.detached).toBe(2); expect(result.terminated).toBe(1);
        expect(result.actions).toEqual(['init', ...(result.mode === 'raw' ? ['raw-frame-v1', 'raw-frame-v1'] : ['frame', 'frame']), 'finish']);
        if (result.mode === 'raw') expect(result.chunks).toBe(0); else expect(result.chunks).toBeGreaterThan(0);
        if (result.mode === 'observed-proxy') expect(result.observed).toBe(2);
    }
    const frames = decompressFrames(parseGIF(Uint8Array.from(expected).buffer), true);
    expect(frames.map(f => f.delay)).toEqual([50, 2000]); expect(frames[0].patch).toEqual(frames[1].patch);
    expect(errors).toEqual([]);
});

for (const mode of ['abort', 'dispose']) test(`${mode} after raw Worker entry terminates work and permits restart`, async ({ page }) => {
    const workers = [], closed = [], errors = []; page.on('worker', w => { workers.push(w); w.on('close', () => closed.push(w)); });
    page.on('pageerror', e => errors.push(e.message)); await page.goto('/');
    const result = await page.evaluate(async mode => {
        const { createGifExporter } = await import('/dist/gif.js'), { createGifWorkerEncoder } = await import('/dist/gif-worker.js');
        const NativeWorker = Worker; let cancel, entered = false, terminated = 0;
        window.Worker = class extends NativeWorker {
            constructor(...args) { super(...args); this.addEventListener('message', e => { if (e.data.rawStarted) { entered = true; cancel(); } }); }
            terminate() { terminated++; super.terminate(); }
        };
        const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(80,120,200,0.5)'; ctx.fillRect(0, 0, 1920, 1080);
        const controller = new AbortController(), events = [];
        const gif = createGifExporter({ encoder: createGifWorkerEncoder({ workerUrl: '/fixtures/gif-worker-raw-probe.mjs' }), signal: controller.signal,
            onProgress: p => events.push([p.phase, p.framesEncoded]) });
        cancel = () => mode === 'abort' ? controller.abort(new DOMException('raw abort', 'AbortError')) : gif.dispose();
        try {
            let error;
            try { await gif.addFrame(canvas, 50); } catch (e) { error = e.name; }
            const cancelled = { error, entered, events, terminated };
            const fresh = createGifExporter({ encoder: createGifWorkerEncoder() });
            try { canvas.width = canvas.height = 2; ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 2, 2);
                await fresh.addFrame(canvas, 50); cancelled.bytes = Array.from(new Uint8Array(await (await fresh.finish()).arrayBuffer()));
            } finally { fresh.dispose(); }
            return cancelled;
        } finally { gif.dispose(); window.Worker = NativeWorker; }
    }, mode);
    expect(result.error).toBe('AbortError'); expect(result.entered).toBe(true); expect(result.terminated).toBe(1);
    expect(result.events).toEqual([[mode === 'abort' ? 'aborted' : 'disposed', 0]]);
    expect(decompressFrames(parseGIF(Uint8Array.from(result.bytes).buffer), true)[0].delay).toBe(50);
    await expect.poll(() => closed.length).toBe(2); expect(workers.length).toBe(2); expect(errors).toEqual([]);
});
