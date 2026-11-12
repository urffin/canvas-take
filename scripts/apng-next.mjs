import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium, firefox } from '@playwright/test';
import assert from 'node:assert/strict';
import { checkEnvelope, decode } from './apng-spike/oracle.mjs';

export async function prepareApngNext(root, workspace) {
    const destination = join(workspace, 'public/canvastake-apng'); await mkdir(destination, { recursive: true });
    for (const name of ['apng-controller.js', 'apng-worker.js', 'apng-worker-runtime.js', 'apng-worker-runtime.js.map', 'apng-PROVENANCE.md']) {
        await cp(join(workspace, 'node_modules/@grundyjs/canvas-take/dist/internal', name), join(destination, name));
    }
    await cp(join(workspace, 'node_modules/@grundyjs/canvas-take/dist/internal/apng-sources'), join(destination, 'apng-sources'), { recursive: true });
    // Private static-copy deployment until a public APNG package entry is approved.
    await writeFile(join(workspace, 'public/apng-preview.html'), (await readFile(join(root, 'examples/apng.html'), 'utf8')).replaceAll('../dist/internal/', '/canvastake-apng/'));
    await writeFile(join(destination, 'helper.js'), (await readFile(join(root, 'test/browser/helpers/apng.mjs'), 'utf8')).replaceAll('/dist/internal/', '/canvastake-apng/'));
}

export async function verifyApngNext(root, workspace) {
    const output = join(root, 'benchmark-results/apng-next'); await mkdir(output, { recursive: true });
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
                await page.goto('http://127.0.0.1:3188/apng-preview.html');
                const response = await page.request.get('http://127.0.0.1:3188/canvastake-apng/apng-worker-runtime.js');
                assert.equal(response.headers()['content-security-policy'], "worker-src 'self'");
                for (const notice of ['apng-PROVENANCE.md', 'apng-sources/UPNG-LICENSE', 'apng-sources/pako-LICENSE', 'apng-sources/pako-zlib-README']) {
                    const response = await page.request.get('http://127.0.0.1:3188/canvastake-apng/' + notice); assert.equal(response.status(), 200);
                }
                const result = await page.evaluate(async () => (await import('/canvastake-apng/helper.js')).exportCase());
                const spec = { width: result.width, height: result.height, plays: result.plays, delays: result.delays };
                const bytes = Buffer.from(result.bytes), path = join(output, name + '.apng');
                checkEnvelope(bytes, spec); await writeFile(path, bytes);
                await decode(path, spec, { ...spec, frames: result.frames });
                assert.equal(result.viewerError, undefined);
                await page.getByRole('button', { name: 'Export APNG', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('finished:'));
                assert.equal(await page.locator('#download').isVisible(), true);
                await page.waitForFunction(() => document.querySelector('#cancel').disabled);
                // Allow the native close event to arrive without another page or a fixed-duration sleep.
                for (let i = 0; i < 100 && closed.length !== workers.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
                assert.equal(workers.length, 2); assert.equal(closed.length, 2); assert.deepEqual(errors, []);
                await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
                console.log(`Next installed private APNG ${name}: decoded 4 frames, example passed, 2/2 Workers closed`);
            } finally { await browser.close(); }
        }
    } finally { server.kill(); await exited; await writeFile(join(output, 'server.log'), logs); }
}
