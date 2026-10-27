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
