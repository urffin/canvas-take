import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseGIF, decompressFrames } from 'gifuct-js';

test('GIF example explains each limit, retries, downloads a valid GIF and clears stale output', async ({ page }, testInfo) => {
    const workers = [], closed = [], errors = [];
    page.on('worker', worker => { workers.push(worker); worker.on('close', () => closed.push(worker)); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/examples/gif.html');
    const start = page.getByRole('button', { name: 'Export GIF', exact: true });
    const cancel = page.getByRole('button', { name: 'Cancel', exact: true });
    const pixels = page.getByLabel('Maximum frame pixels');
    const frames = page.getByLabel('Maximum frames', { exact: true });
    const duration = page.getByLabel('Maximum duration');
    const status = page.getByRole('status');
    const link = page.getByRole('link', { name: 'Download GIF' });
    const fail = async message => {
        await start.click();
        await expect(status).toContainText(message);
        await expect(start).toBeEnabled(); await expect(cancel).toBeDisabled();
        await expect(pixels).toBeEnabled(); await expect(link).toBeHidden();
    };
    await pixels.fill('359999'); await fail('Frame size limit exceeded');
    await expect(status).toContainText('360,000 pixels');
    await pixels.fill('360000'); await frames.fill('1'); await fail('Frame count limit exceeded');
    await frames.fill('121'); await duration.fill('50'); await fail('Duration limit exceeded');
    await expect(status).toContainText('8,000 ms including the final hold');
    await duration.fill('8000');
    await start.click();
    await expect(link).toBeVisible({ timeout: 30000 });
    await expect(start).toBeEnabled();
    const details = JSON.parse(await status.textContent());
    expect(details).toMatchObject({ frames: 121, durationMs: 8000, state: 'finished' });
    const downloading = page.waitForEvent('download'); await link.click();
    const download = await downloading, path = testInfo.outputPath('example.gif');
    await download.saveAs(path);
    const bytes = await readFile(path), parsed = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(bytes.length).toBe(details.bytes);
    expect([parsed.lsd.width, parsed.lsd.height]).toEqual([800, 450]);
    const decoded = decompressFrames(parsed, false);
    expect(decoded).toHaveLength(121);
    expect(decoded.map(frame => frame.delay)).toEqual([...Array(120).fill(50), 2000]);
    await testInfo.attach('example.gif', { path, contentType: 'image/gif' });
    // A new failed attempt must not leave the previous successful download/preview visible.
    await frames.fill('1'); await fail('Frame count limit exceeded');
    await expect(page.locator('#preview')).not.toHaveAttribute('src', /.+/);
    // Empty fields mean no extra limits; cancellation still leaves the controls reusable.
    await pixels.fill(''); await frames.fill(''); await duration.fill('');
    await start.click(); await expect(cancel).toBeEnabled(); await cancel.click();
    await expect(status).toContainText('Export cancelled'); await expect(start).toBeEnabled();
    await expect.poll(() => workers.length - closed.length).toBe(0);
    expect(workers.length).toBeGreaterThanOrEqual(4);
    expect(errors).toEqual([]);
});
