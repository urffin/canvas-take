import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, firefox } from '@playwright/test';
import assert from 'node:assert/strict';
import { checkEnvelope, decode } from './apng-spike/oracle.mjs';

export async function prepareApngNext(root, workspace) {
    const destination = join(workspace, 'public/canvastake-apng'); await mkdir(destination, { recursive: true });
    for (const name of ['apng.js', 'apng-worker.js', 'apng-worker-runtime.js', 'apng-worker-runtime.js.map', 'apng-PROVENANCE.md']) {
        await cp(join(workspace, 'node_modules/@grundyjs/canvas-take/dist', name), join(destination, name));
    }
    await cp(join(workspace, 'node_modules/@grundyjs/canvas-take/dist/apng-sources'), join(destination, 'apng-sources'), { recursive: true });
    await writeFile(join(workspace, 'public/apng-preview.html'), (await readFile(join(root, 'examples/apng.html'), 'utf8')).replaceAll('../dist/', '/canvastake-apng/'));
    const helper = await readFile(join(root, 'test/browser/helpers/apng.mjs'), 'utf8');
    await writeFile(join(workspace, 'app/apng-fixture.js'), helper.slice(0, helper.indexOf('export async function cancelCompression')));
}

export async function verifyApngNext(root, workspace) {
    const output = join(root, 'benchmark-results/apng-public-next'); await mkdir(output, { recursive: true });
    const server = spawn(process.execPath, [join(workspace, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3188'], { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = ''; server.stdout.on('data', data => { logs = (logs + data).slice(-64000); }); server.stderr.on('data', data => { logs = (logs + data).slice(-64000); });
    const exited = once(server, 'exit');
    try {
        let ready = false;
        for (let i = 0; i < 150 && server.exitCode === null; i++) {
            try { const response = await fetch('http://127.0.0.1:3188/apng-preview.html'); if (response.ok) { ready = true; break; } } catch {}
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error('Next APNG server did not start: ' + logs);
        for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
            const browser = await engine.launch();
            try {
                const page = await browser.newPage(), workers = [], closed = [], errors = [];
                page.on('worker', worker => { workers.push(worker); worker.on('close', () => closed.push(worker)); });
                page.on('pageerror', error => errors.push(error.message));
                await page.goto('http://127.0.0.1:3188/apng/');
                await page.waitForFunction(() => typeof window.runNextApngCase === 'function');
                const response = await page.request.get('http://127.0.0.1:3188/canvastake-apng/apng-worker-runtime.js');
                assert.equal(response.headers()['content-security-policy'], "worker-src 'self'");
                for (const notice of ['apng-PROVENANCE.md', 'apng-sources/UPNG-LICENSE', 'apng-sources/pako-LICENSE', 'apng-sources/pako-zlib-README']) {
                    const response = await page.request.get('http://127.0.0.1:3188/canvastake-apng/' + notice); assert.equal(response.status(), 200);
                }
                for (const mode of ['bundled', 'package', 'copied']) {
                    const result = await page.evaluate(mode => window.runNextApngCase(mode === 'copied' ? { workerUrl: '/canvastake-apng/apng-worker-runtime.js' } : { workerMode: mode }), mode);
                    const spec = { width: result.width, height: result.height, plays: result.plays, delays: result.delays };
                    const bytes = Buffer.from(result.bytes), path = join(output, name + '-' + mode + '.apng');
                    checkEnvelope(bytes, spec); await writeFile(path, bytes);
                    await decode(path, spec, { ...spec, frames: result.frames }); assert.equal(result.viewerError, undefined);
                    const workerPath = new URL(workers.at(-1).url(), page.url()).pathname;
                    if (mode !== 'copied') assert.ok(workerPath.startsWith('/_next/'), 'Expected Next-emitted Worker URL, got ' + workerPath);
                    else assert.equal(workerPath, '/canvastake-apng/apng-worker-runtime.js');
                }
                const cancelled = await page.evaluate(async () => {
                    const controller = new AbortController(), original = new Error('Next APNG cancellation');
                    try { await window.runNextApngCase({ signal: controller.signal, onProgress(p) { if (p.framesAccepted === 1) controller.abort(original); } }); return false; }
                    catch (error) { return error === original; }
                });
                assert.equal(cancelled, true);
                await page.getByRole('button', { name: 'Export until cancelled', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('[role=status]').textContent.startsWith('collecting:'));
                await page.getByRole('button', { name: 'Cancel', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('[role=status]').textContent.startsWith('AbortError:'));
                assert.equal(await page.getByRole('link', { name: 'Download APNG' }).count(), 0);
                await page.getByRole('button', { name: 'Export APNG', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('[role=status]').textContent.startsWith('finished:'));
                const downloaded = page.waitForEvent('download'); await page.getByRole('link', { name: 'Download APNG' }).click();
                const download = await downloaded, uiPath = join(output, name + '-ui.apng'); await download.saveAs(uiPath);
                const spec = { width: 7, height: 3, plays: 3, delays: [55, 55, 2000] };
                checkEnvelope(await readFile(uiPath), spec);
                await decode(uiPath, spec, { ...spec, frames: [0, 1, 2].map(color => ({ data: Uint8ClampedArray.from({ length: 7 * 3 * 4 }, (_, i) => i % 4 === color || i % 4 === 3 ? 255 : 0) })) });
                await page.goto('http://127.0.0.1:3188/apng-preview.html');
                await page.getByRole('button', { name: 'Export APNG', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('finished:'));
                // Allow the native close event to arrive without another page or a fixed-duration sleep.
                for (let i = 0; i < 100 && closed.length !== workers.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
                assert.equal(workers.length, 7); assert.equal(closed.length, 7); assert.deepEqual(errors, []);
                await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
                console.log(`Next public APNG ${name}: bundled/package/copied Workers, decoded 15 frames, cancel/retry, 7/7 Workers closed`);
            } finally { await browser.close(); }
        }
    } finally { server.kill(); await exited; await writeFile(join(output, 'server.log'), logs); }
}
