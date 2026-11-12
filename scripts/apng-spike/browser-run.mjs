import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium, firefox } from '@playwright/test';
import { output } from './prepare.mjs';

export async function withBrowsers(run) {
    const html = '<!doctype html><meta charset="utf-8"><title>APNG backend spike</title><script type="module" src="/client.mjs"></script>';
    const server = createServer(async (req, res) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        try {
            if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(html); return; }
            const file = resolve(output, '.' + decodeURIComponent(new URL(req.url, 'http://local').pathname));
            if (!file.startsWith(output + sep)) { res.writeHead(403); res.end(); return; }
            res.setHeader('Content-Type', extname(file) === '.mjs' ? 'text/javascript' : 'application/octet-stream'); res.end(await readFile(file));
        } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        for (const [name, engine] of [['chromium', chromium], ['firefox', firefox]]) {
            const browser = await engine.launch({ headless: true });
            try {
                const page = await browser.newPage(); // One agent-owned tab at a time; user tabs untouched.
                const workers = [];
                page.on('worker', worker => {
                    const item = { closed: false }; item.exited = new Promise(resolve => worker.on('close', () => { item.closed = true; resolve(); })); workers.push(item);
                });
                await page.goto('http://127.0.0.1:' + server.address().port);
                await page.waitForFunction(() => typeof window.apngSpike === 'function');
                const invoke = async (spec, mode = 'success') => {
                    const start = workers.length;
                    const result = await page.evaluate(({ spec, mode }) => window.apngSpike(spec, mode), { spec, mode });
                    const created = workers.slice(start); assert.equal(created.length, 1, name + ': one actual Worker');
                    await Promise.race([created[0].exited, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('Worker did not close')), 5000); created[0].exited.finally(() => clearTimeout(t)); })]);
                    assert.ok(created[0].closed); assert.ok(result.stats.sourceIntact); assert.equal(result.stats.retainedOwnedFrames, 0);
                    result.stats.actualWorkerClosed = true; return result;
                };
                await run(name, invoke, () => ({ opened: workers.length, closed: workers.filter(w => w.closed).length }));
            } finally { await browser.close(); }
        }
    } finally { await new Promise(resolve => server.close(resolve)); }
}
