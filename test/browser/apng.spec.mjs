import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { checkEnvelope, decode, inspect } from '../../scripts/apng-spike/oracle.mjs';

function observe(page) {
    const workers = [], closed = [], errors = [];
    page.on('worker', worker => { workers.push(worker); worker.on('close', () => closed.push(worker)); });
    page.on('pageerror', error => errors.push(error.message));
    return { workers, closed, errors };
}
async function verify(result, testInfo, name) {
    expect(result.type).toBe('image/apng'); expect(result.same).toBe(true);
    const bytes = Buffer.from(result.bytes), spec = { width: result.width, height: result.height, plays: result.plays, delays: result.delays };
    checkEnvelope(bytes, spec);
    const path = testInfo.outputPath(name + '.apng'); await writeFile(path, bytes);
    const decoded = await decode(path, spec, { ...spec, frames: result.frames.map(frame => ({ ...frame, data: Uint8ClampedArray.from(frame.data) })) });
    expect(decoded.frames).toBe(result.delays.length);
    expect(result.events.map(p => p.phase)).toEqual([...result.delays.map(() => 'collecting'), 'finalizing', 'finished']);
    expect(result.events.at(-1).framesAccepted).toBe(result.delays.length);
    expect(result.events.at(-1).durationMs).toBe(result.delays.reduce((a, b) => a + b, 0));
    await testInfo.attach(name, { path, contentType: 'image/apng' });
}

test('APNG real canvas/Worker preserves alpha, single frame, plays and exact file timeline', async ({ page }, testInfo) => {
    const observed = observe(page); await page.goto('/');
    const cases = [
        { delays: [1, 14, 55, 2000], plays: 3 },
        { delays: [65535], plays: 0 },
        { width: 1, height: 1, delays: [55], plays: 1, offscreen: true },
        { delays: [14, 15], plays: 3, workerUrl: '/custom-apng-worker.js' },
        { delays: [14, 15], plays: 0xffffffff, workerUrl: '/custom-apng-worker.js' }
    ];
    const outputs = [];
    for (let i = 0; i < cases.length; i++) {
        const result = await page.evaluate(async options => (await import('/apng-helper.js')).exportCase(options), cases[i]);
        outputs.push(Buffer.from(result.bytes));
        await verify(result, testInfo, 'case-' + i);
        // Firefox's native viewer rejects unsigned-max plays; independent file decoding still must pass.
        if (result.viewerError !== undefined) {
            expect(testInfo.project.name).toBe('firefox'); expect(cases[i].plays).toBe(0xffffffff);
            expect(result.viewerError).toBe('Invalid encoded image data.');
        }
    }
    const withoutPlays = bytes => { const copy = Buffer.from(bytes), chunk = inspect(copy).chunks.find(c => c.type === 'acTL'); copy.fill(0, chunk.offset + 12, chunk.end); return copy; };
    expect(withoutPlays(outputs[3])).toEqual(withoutPlays(outputs[4]));
    await expect.poll(() => observed.closed.length).toBe(cases.length); expect(observed.workers).toHaveLength(cases.length);
    expect(observed.workers.at(-1).url()).toContain('/custom-apng-worker.js'); expect(observed.errors).toEqual([]);
});

test('APNG cancels inside real deflate and exports again on the same page', async ({ page }, testInfo) => {
    const observed = observe(page); await page.goto('/');
    const result = await page.evaluate(async () => (await import('/apng-helper.js')).cancelCompression());
    expect(result).toMatchObject({ entered: true, active: true, sameReason: true, state: 'aborted', compressionFlag: 1 });
    expect(result.events.at(-1)).toBe('aborted'); expect(result.events).not.toContain('finished');
    await expect.poll(() => observed.closed.length).toBe(1);
    const retry = await page.evaluate(async () => (await import('/apng-helper.js')).exportCase()); await verify(retry, testInfo, 'retry');
    await expect.poll(() => observed.closed.length).toBe(2); expect(observed.errors).toEqual([]);
});

test('APNG limits, early abort, invalid Worker and fresh retry release owned Workers', async ({ page }, testInfo) => {
    const observed = observe(page); await page.goto('/');
    const result = await page.evaluate(async () => {
        const { createApngController } = await import('/dist/internal/apng-controller.js');
        const { createApngWorkerEncoder } = await import('/dist/internal/apng-worker.js');
        const canvas = new OffscreenCanvas(2, 2), ctx = canvas.getContext('2d'); ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 2, 2);
        const NativeWorker = window.Worker; let created = 0, terminated = 0;
        window.Worker = class extends NativeWorker { constructor(...args) { super(...args); created++; } terminate() { terminated++; return super.terminate(); } };
        const results = [];
        for (const mode of ['input', 'output', 'abort', 'invalid']) {
            const abort = new AbortController(), original = new Error('early abort');
            const e = createApngController({ encoder: createApngWorkerEncoder(mode === 'invalid' ? { workerUrl: '/fixtures/apng-invalid.js', timeoutMs: 1000 } : {}),
                signal: abort.signal, maxInputBytes: mode === 'input' ? 15 : 64, maxOutputBytes: mode === 'output' ? 1 : undefined });
            try { const pending = e.addFrame(canvas, 55); if (mode === 'abort') abort.abort(original); await pending; await e.finish(); results.push({ mode, success: true }); }
            catch (error) { results.push({ mode, state: e.state, same: error === original, message: error.message }); }
            finally { e.dispose(); }
        }
        window.Worker = NativeWorker; return { cases: results, created, terminated };
    });
    expect(result.cases.map(r => r.state)).toEqual(['failed', 'failed', 'aborted', 'failed']);
    expect(result.cases[0].message).toContain('maxInputBytes'); expect(result.cases[1].message).toContain('finish'); expect(result.cases[2].same).toBe(true);
    expect([result.created, result.terminated]).toEqual([4, 4]);
    // Two Workers are terminated before Playwright observes startup; require closure of every observed one.
    await expect.poll(() => observed.closed.length).toBe(observed.workers.length); expect(observed.workers.length).toBeGreaterThanOrEqual(2);
    await verify(await page.evaluate(async () => (await import('/apng-helper.js')).exportCase()), testInfo, 'after-errors');
    await expect.poll(() => observed.closed.length).toBe(observed.workers.length); expect(observed.errors).toEqual([]);
});

test('APNG development example exports, cancels, clears its result and retries', async ({ page }) => {
    const observed = observe(page); await page.goto('/examples/apng.html');
    await page.getByRole('button', { name: 'Export APNG', exact: true }).click();
    await expect(page.locator('#status')).toContainText('finished: 24 frames, 2265 ms');
    await expect(page.getByRole('link', { name: 'Download APNG' })).toBeVisible();
    await expect.poll(() => observed.closed.length).toBe(1);
    const started = page.waitForEvent('worker');
    await page.getByRole('button', { name: 'Export APNG', exact: true }).click(); await started;
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('#status')).toContainText('AbortError'); await expect(page.locator('#download')).toBeHidden();
    await expect.poll(() => observed.closed.length).toBe(2);
    await page.getByRole('button', { name: 'Export APNG', exact: true }).click();
    await expect(page.locator('#status')).toContainText('finished: 24 frames, 2265 ms');
    await expect.poll(() => observed.closed.length).toBe(3); expect(observed.errors).toEqual([]);
});
