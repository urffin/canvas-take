import { test, expect } from '@playwright/test';
import { parseGIF, decompressFrames } from 'gifuct-js';

for (const adapter of ['sync', 'worker']) for (const mode of ['abort', 'dispose']) {
    test(`${adapter}: ${mode} between preparation chunks closes ports and permits a fresh export`, async ({ page }) => {
        const workers = [], closed = [], errors = [];
        page.on('worker', worker => { workers.push(worker); worker.on('close', () => closed.push(worker)); });
        page.on('pageerror', error => errors.push(error.message));
        await page.goto('/');
        await page.setContent('<button id="cancel">Cancel chunk</button>');
        await page.evaluate(async ({ adapter, mode }) => {
            const { createGifExporter } = await import('/dist/gif.js');
            const { createGifencEncoder } = await import('/dist/gifenc.js');
            const { createGifWorkerEncoder } = await import('/dist/gif-worker.js');
            const factory = adapter === 'worker' ? createGifWorkerEncoder() : createGifencEncoder();
            const NativeChannel = window.MessageChannel, nativeNow = performance.now.bind(performance);
            const ports = new Set(); let clock = 0, lateCallback, submitted = 0, disposed = 0;
            // Hold a real preparation continuation so the native click targets a known boundary.
            // No timing assertions depend on this artificial hold/clock.
            performance.now = () => clock += 5;
            window.MessageChannel = class extends NativeChannel { constructor() {
                super();
                for (const port of [this.port1, this.port2]) {
                    ports.add(port); const close = port.close.bind(port);
                    port.close = () => { ports.delete(port); close(); };
                }
                this.port2.postMessage = () => { lateCallback = this.port1.onmessage; window.__chunkWaiting = true; };
            } };
            const controller = new AbortController(), events = [];
            const gif = createGifExporter({ signal: controller.signal, onProgress: e => events.push([e.phase, e.framesEncoded]),
                encoder(settings) { const real = factory(settings); return {
                    addFrame(frame) { submitted++; return real.addFrame(frame); }, finish: () => real.finish(),
                    dispose() { disposed++; real.dispose(); }
                }; } });
            const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(20,80,200,0.5)'; ctx.fillRect(0, 0, 640, 360);
            window.__chunkWork = gif.addFrame(canvas, 50).then(() => { throw new Error('partially prepared frame was encoded'); }, error => {
                window.__chunkResult = { error: error.name, message: error.message, state: gif.state, submitted, disposed, ports: ports.size, events };
                lateCallback?.(); // Already queued continuation after cleanup must be harmless.
                gif.dispose();
            });
            document.querySelector('#cancel').onclick = event => {
                window.__trustedCancel = event.isTrusted;
                performance.now = nativeNow; window.MessageChannel = NativeChannel;
                if (mode === 'abort') controller.abort(new DOMException('chunk cancelled', 'AbortError')); else gif.dispose();
            };
            window.__retryChunks = async () => {
                const second = createGifExporter({ encoder: factory });
                const small = document.createElement('canvas'); small.width = 4; small.height = 4;
                const context = small.getContext('2d');
                context.fillStyle = '#00ff00'; context.fillRect(0, 0, 4, 4); await second.addFrame(small, 50);
                context.fillStyle = '#0000ff'; context.fillRect(0, 0, 4, 4); await second.addFrame(small, 2000);
                const blob = await second.finish(); second.dispose();
                return Array.from(new Uint8Array(await blob.arrayBuffer()));
            };
        }, { adapter, mode });
        await page.waitForFunction(() => window.__chunkWaiting);
        await page.getByRole('button', { name: 'Cancel chunk' }).click();
        await page.waitForFunction(() => window.__chunkResult);
        const result = await page.evaluate(() => window.__chunkResult);
        expect(result).toEqual({ error: 'AbortError', message: mode === 'abort' ? 'chunk cancelled' : 'GIF exporter disposed',
            state: mode === 'abort' ? 'aborted' : 'disposed', submitted: 0, disposed: 1, ports: 0,
            events: [[mode === 'abort' ? 'aborted' : 'disposed', 0]] });
        expect(await page.evaluate(() => window.__trustedCancel)).toBe(true);
        const bytes = Uint8Array.from(await page.evaluate(() => window.__retryChunks()));
        const decoded = decompressFrames(parseGIF(bytes.buffer), true);
        expect(decoded.map(f => f.delay)).toEqual([50, 2000]);
        expect([...decoded[0].patch.slice(0, 4)]).toEqual([0, 255, 0, 255]);
        expect([...decoded[1].patch.slice(0, 4)]).toEqual([0, 0, 255, 255]);
        await expect.poll(() => closed.length).toBe(workers.length);
        if (adapter === 'worker') expect(workers.length).toBeGreaterThanOrEqual(1);
        expect(errors).toEqual([]);
    });
}
