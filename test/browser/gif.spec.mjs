import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseGIF, decompressFrames } from 'gifuct-js';

function observe(page) {
    const workers = [], closed = [], errors = [];
    page.on('worker', worker => {
        workers.push(worker);
        worker.on('close', () => closed.push(worker));
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    return { workers, closed, errors };
}

async function checkResult(page, testInfo) {
    await expect(page.locator('#state')).toHaveText('finished');
    const details = JSON.parse(await page.locator('#details').textContent());
    expect(details.type).toBe('image/gif');
    expect(details.events.map(p => [p.phase, p.framesEncoded, p.durationMs, p.totalFrames])).toEqual([
        ['encoding', 1, 50, 3], ['encoding', 2, 100, 3], ['encoding', 3, 2100, 3],
        ['finalizing', 3, 2100, 3], ['finished', 3, 2100, 3]
    ]);
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download GIF' }).click();
    const download = await downloaded;
    expect(await download.failure()).toBeNull();
    const path = testInfo.outputPath('worker.gif');
    await download.saveAs(path);
    const bytes = await readFile(path);
    expect(bytes.length).toBe(details.size);
    const parsed = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect([parsed.lsd.width, parsed.lsd.height]).toEqual([32, 24]);
    const frames = decompressFrames(parsed, true);
    expect(frames.map(frame => frame.delay)).toEqual([50, 50, 2000]);
    for (let i = 0; i < 3; i++) {
        const rgba = [0, 0, 0, 255]; rgba[i] = 255;
        expect(frames[i].patch.length).toBe(32 * 24 * 4);
        const expected = new Uint8ClampedArray(frames[i].patch.length);
        for (let p = 0; p < expected.length; p += 4) expected.set(rgba, p);
        expect(frames[i].patch).toEqual(expected);
    }
    const loop = parsed.frames.find(frame => frame.application)?.application;
    expect(loop.id).toBe('NETSCAPE2.0');
    expect(loop.blocks[1] + 256 * loop.blocks[2]).toBe(3);
    await testInfo.attach('export.gif', { path, contentType: 'image/gif' });
}

test('real module Worker exports a decodable GIF and closes', async ({ page }, testInfo) => {
    const observed = observe(page);
    const response = await page.goto('/');
    expect(response.headers()['content-security-policy']).toBe("worker-src 'self'");
    await page.getByRole('button', { name: 'Export GIF', exact: true }).click();
    await checkResult(page, testInfo);
    await expect.poll(() => observed.closed.length).toBe(1);
    expect(observed.workers).toHaveLength(1);
    expect(new URL(observed.workers[0].url()).pathname).toBe('/dist/gif-worker-runtime.js');
    expect(observed.errors).toEqual([]);
});

test('cancel active export, close Worker, then export again on the same page', async ({ page }, testInfo) => {
    const observed = observe(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Export until cancelled' }).click();
    await expect.poll(async () => Number(await page.locator('#count').textContent())).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#state')).toHaveText('aborted');
    await expect(page.getByRole('link', { name: 'Download GIF' })).toBeHidden();
    const { events, error } = JSON.parse(await page.locator('#details').textContent());
    expect(error).toBe('AbortError');
    expect(events.at(-1).phase).toBe('aborted');
    expect(events.some(p => p.phase === 'finished')).toBe(false);
    expect(events.at(-1).framesEncoded).toBeGreaterThan(0);
    await expect.poll(() => observed.closed.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Export GIF', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Export GIF', exact: true }).click();
    await checkResult(page, testInfo);
    await expect.poll(() => observed.closed.length).toBe(2);
    expect(observed.workers).toHaveLength(2);
    expect(observed.workers[0]).not.toBe(observed.workers[1]);
    expect(observed.errors).toEqual([]);
});

for (const adapter of ['sync', 'worker']) test(`${adapter} limits fail cleanly and allow a fresh decodable export`, async ({ page }) => {
    const observed = observe(page);
    await page.goto('/');
    const results = await page.evaluate(async adapter => {
        const { createGifExporter } = await import('/dist/gif.js');
        const { createGifencEncoder } = await import('/dist/gifenc.js');
        const { createGifWorkerEncoder } = await import('/dist/gif-worker.js');
        const factory = adapter === 'worker' ? createGifWorkerEncoder() : createGifencEncoder();
        const canvas = document.querySelector('canvas');
        const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, 32, 24);
        const results = [];
        for (const [key, value] of [['maxFrames', 1], ['maxDurationMs', 100]]) {
            const events = []; let disposed = 0, submitted = 0;
            const gif = createGifExporter({ encoder(options) {
                const encoder = factory(options);
                return { addFrame(frame) { submitted++; return encoder.addFrame(frame); },
                    finish: () => encoder.finish(), dispose() { disposed++; encoder.dispose(); } };
            }, [key]: value, onProgress: p => events.push(p) });
            let failure;
            try {
                await gif.addFrame(canvas, 54);
                try { await gif.addFrame(canvas, 55); } catch (error) { failure = { name: error.name, message: error.message }; }
                results.push({ key, failure, state: gif.state, events, submitted });
            } finally { gif.dispose(); }
            results.at(-1).disposed = disposed;
            const fresh = createGifExporter({ encoder: factory, maxFramePixels: 768, maxFrames: 1, maxDurationMs: 50 });
            try {
                await fresh.addFrame(canvas, 54);
                results.at(-1).bytes = Array.from(new Uint8Array(await (await fresh.finish()).arrayBuffer()));
            } finally { fresh.dispose(); }
        }
        return results;
    }, adapter);
    for (const result of results) {
        expect(result.failure.name).toBe('RangeError'); expect(result.failure.message).toContain(result.key);
        expect(result.state).toBe('failed'); expect(result.disposed).toBe(1); expect(result.submitted).toBe(1);
        expect(result.events.map(p => [p.phase, p.framesEncoded, p.durationMs])).toEqual([['encoding', 1, 50], ['failed', 1, 50]]);
        const frames = decompressFrames(parseGIF(Uint8Array.from(result.bytes).buffer), true);
        expect(frames.map(frame => frame.delay)).toEqual([50]);
        expect([frames[0].dims.width, frames[0].dims.height]).toEqual([32, 24]);
        const expected = new Uint8ClampedArray(32 * 24 * 4);
        for (let i = 0; i < expected.length; i += 4) expected.set([255, 0, 0, 255], i);
        expect(frames[0].patch).toEqual(expected);
    }
    if (adapter === 'worker') await expect.poll(() => observed.closed.length).toBe(4);
    expect(observed.workers).toHaveLength(adapter === 'worker' ? 4 : 0);
    expect(observed.errors).toEqual([]);
});
