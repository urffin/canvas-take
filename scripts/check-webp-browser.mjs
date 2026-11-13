// Explicit opt-in browser verification. Obtain permission before launching external browsers.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium, firefox } from '@playwright/test';
import { inspect, verify, comparePixels } from './webp-libwebp/oracle.mjs';
const out = resolve('benchmark-results/webp-integration'); await mkdir(out, { recursive: true });
const assets = new Map();
for (const file of ['webp-controller.js', 'webp-envelope.js', 'webp-worker.js', 'webp-worker-runtime.js', 'webp-worker-core.js', 'webp-codec.js', 'webp-codec.wasm']) assets.set('/dist/internal/' + file, resolve('dist/internal', file));
for (const file of ['browser-client.mjs', 'browser-probe-worker.mjs', 'fixtures.mjs']) assets.set('/scripts/webp-integration/' + file, resolve('scripts/webp-integration', file));
assets.set('/scripts/webp-libwebp/fixtures.mjs', resolve('scripts/webp-libwebp/fixtures.mjs'));
assets.set('/scripts/webp-spike/fixtures.mjs', resolve('scripts/webp-spike/fixtures.mjs'));
for (const [alias, file] of [['/relocated/runtime.js', 'webp-worker-runtime.js'], ['/relocated/webp-codec.js', 'webp-codec.js'], ['/separate-assets/codec.wasm', 'webp-codec.wasm'],
    ['/deny-connect/runtime.js', 'webp-worker-runtime.js'], ['/deny-connect/webp-codec.js', 'webp-codec.js']]) assets.set(alias, resolve('dist/internal', file));
async function serve(isolated = false, corsOnly = false) {
    const state = { requests: [], slowSeen: false, slowClosed: 0 }, timers = new Set();
    const server = createServer(async (req, res) => {
        const path = new URL(req.url, 'http://localhost').pathname; state.requests.push(path);
        if (isolated) { res.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); }
        try {
            if (corsOnly) { res.writeHead(200, { 'Content-Type': 'application/wasm' }).end(await readFile('dist/internal/webp-codec.wasm')); return; }
            if (path === '/' || path === '/deny-worker') {
                if (path === '/deny-worker') res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'");
                res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><title>Private WebP integration verification</title>'); return;
            }
            if (path === '/slow-seen') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ seen: state.slowSeen })); return; }
            if (path === '/reset-slow') { state.slowSeen = false; res.writeHead(200).end(); return; }
            if (path === '/slow.wasm') {
                state.slowSeen = true;
                const timer = setTimeout(async () => { timers.delete(timer); if (!res.destroyed) res.writeHead(200, { 'Content-Type': 'application/wasm' }).end(await readFile('dist/internal/webp-codec.wasm')); }, 15000);
                timers.add(timer); res.once('close', () => { state.slowClosed++; clearTimeout(timer); timers.delete(timer); }); return;
            }
            if (path === '/html.wasm') { res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>fallback'); return; }
            if (path === '/wrong-profile-worker.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end("self.onmessage=({data:m})=>{self.postMessage({format:'webp',version:1,id:m.id,action:m.action,value:{bindingAbi:1,profile:'legacy'}});self.close();};"); return; }
            const file = assets.get(path); if (!file) { res.writeHead(404).end(); return; }
            if (path === '/deny-connect/runtime.js') res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'none'");
            res.writeHead(200, { 'Content-Type': path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' }).end(await readFile(file));
        } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
    return { state, origin: 'http://127.0.0.1:' + server.address().port,
        async close() { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); await new Promise(yes => server.close(yes)); } };
}
function checkNative(actual, record, engine) {
    const envelope = inspect(Uint8Array.from(record.bytes)); assert.equal(actual.count, envelope.frames.length);
    assert.equal(actual.repetitions, record.plays === 0 ? 'Infinity' : String(record.plays - 1));
    let fileTime = 0, nativeTime = 0, comparisons = 0; const frames = [];
    actual.frames.forEach((frame, i) => {
        const hold = envelope.frames[i].durationMs, viewerHold = engine === 'firefox' && hold <= 10 ? 100 : hold;
        assert.equal(frame.timestamp, nativeTime * 1000, record.name + ': native timestamp'); assert.equal(frame.duration, viewerHold * 1000, record.name + ': native hold');
        assert.equal(frame.width, record.width); assert.equal(frame.height, record.height);
        let inputTime = 0, partialRgbDifferences = 0, maxMeanRgbError = 0;
        for (const input of record.frames) {
            if (inputTime < fileTime + hold && inputTime + input.duration > fileTime) {
                const pixels = comparePixels(frame.rgba, input.data, record.lossless); assert.equal(pixels.alphaErrors, 0, record.name + ': exact native alpha');
                let sum = 0, count = 0;
                for (let p = 0; p < input.data.length; p += 4) {
                    if (record.lossless && input.data[p + 3] === 255) for (let c = 0; c < 3; c++) assert.equal(frame.rgba[p + c], input.data[p + c], record.name + ': opaque lossless RGB');
                    if (input.data[p + 3] > 0 && input.data[p + 3] < 255) for (let c = 0; c < 3; c++) if (frame.rgba[p + c] !== input.data[p + c]) partialRgbDifferences++;
                    if (input.data[p + 3] >= 128) for (let c = 0; c < 3; c++) { sum += Math.abs(frame.rgba[p + c] - input.data[p + c]); count++; }
                }
                const mean = count ? sum / count : 0; if (!record.lossless) assert.ok(mean <= 100, record.name + ': lossy MAE bound'); maxMeanRgbError = Math.max(maxMeanRgbError, mean); comparisons++;
            }
            inputTime += input.duration;
        }
        frames.push({ fileDurationMs: hold, nativeDurationMs: viewerHold, nativeTimestampMs: nativeTime, viewerClamped: hold !== viewerHold, partialRgbDifferences, maxMeanRgbError });
        fileTime += hold; nativeTime += viewerHold;
    });
    assert.equal(fileTime, record.frames.reduce((n, f) => n + f.duration, 0));
    return { encodedFrames: envelope.frames.length, inputFrames: record.frames.length, intervalComparisons: comparisons, repetitions: actual.repetitions, frames };
}
async function drain(page, events) {
    const started = performance.now();
    while (page.workers().length && performance.now() - started < 25000) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(page.workers().length, 0, 'actual Worker target inventory empty'); assert.equal(events.opened, events.closed, 'all observed Worker targets closed');
    return performance.now() - started;
}
const engines = [['chromium', chromium], ['firefox', firefox]].filter(([name]) => !process.argv.some(arg => arg.startsWith('--browser=')) || process.argv.includes('--browser=' + name));
assert.ok(engines.length, 'Unknown browser selector');
const repeatCount = Number(process.argv.find(arg => arg.startsWith('--repeat='))?.slice('--repeat='.length) ?? 0);
assert.ok(Number.isInteger(repeatCount) && repeatCount >= 0 && repeatCount <= 5, 'Repeat count must be 0..5');
const main = await serve(), isolated = await serve(true), cors = await serve(false, true);
const results = { date: new Date().toISOString(), base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), version: '0.7.0', publicApiChanged: false,
    authorization: 'User explicitly allowed Playwright Chromium/Firefox for WebP decoding and Worker lifecycle verification after built-in browser failures', browsers: [] };
try {
    for (const [name, engine] of engines) {
        const browser = await engine.launch();
        const consoleMessages = [];
        try {
            // One agent-owned page at a time; fresh browser profiles preserve all user tabs.
            const page = await browser.newPage(), events = { opened: 0, closed: 0 }, errors = [];
            page.on('worker', worker => { events.opened++; worker.on('close', () => { events.closed++; }); }); page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { consoleMessages.push({ type: message.type(), text: message.text() }); if (consoleMessages.length > 100) consoleMessages.shift(); });
            await page.goto(main.origin);
            const raw = await page.evaluate(async () => (await import('/scripts/webp-integration/browser-client.mjs')).runMatrix());
            await writeFile(resolve(out, name + '-browser-raw.json'), JSON.stringify(raw, null, 2) + '\n');
            const cases = raw.cases.map(record => {
                const native = checkNative(record.decoded, record, name), bytes = Uint8Array.from(record.bytes);
                let ffmpeg = 'known ALPH discrepancy; native alpha exact';
                if (record.name !== 'lossy-partial-alpha') { verify(bytes, { name: record.name, plays: record.plays }, { width: record.width, height: record.height, lossless: record.lossless, frames: record.frames.map(f => ({ ...f, data: Uint8Array.from(f.data) })) }); ffmpeg = 'passed'; }
                return { name: record.name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), native, ffmpeg };
            });
            const repeats = [];
            for (let iteration = 0; iteration < repeatCount; iteration++) {
                const repeated = await page.evaluate(async () => (await import('/scripts/webp-integration/browser-client.mjs')).runMatrix());
                assert.equal(repeated.cases.length, cases.length);
                for (const record of repeated.cases) {
                    checkNative(record.decoded, record, name);
                    assert.equal(createHash('sha256').update(Uint8Array.from(record.bytes)).digest('hex'), cases.find(c => c.name === record.name).sha256, 'deterministic fresh-Worker repeat: ' + record.name);
                }
                assert.equal(repeated.inventory.objects, repeated.inventory.terminated); assert.equal(repeated.inventory.handlers, 0);
                repeats.push({ iteration: iteration + 1, exports: repeated.cases.length, deterministicBytes: true, decoded: true, closeDrainMs: await drain(page, events) });
            }
            const first = raw.cases[0], controls = [];
            const wrongHold = Buffer.from(first.bytes), frames = inspect(wrongHold).frames; wrongHold.writeUIntLE(75, frames[0].durationOffset, 3); wrongHold.writeUIntLE(1980, frames[1].durationOffset, 3);
            controls.push({ name: 'total-preserving-wrong-hold', bytes: [...wrongHold], reference: first });
            const wrongPlays = Buffer.from(first.bytes);
            for (let p = 12; p < wrongPlays.length;) { const size = wrongPlays.readUInt32LE(p + 4); if (wrongPlays.toString('ascii', p, p + 4) === 'ANIM') { wrongPlays.writeUInt16LE(2, p + 12); break; } p += 8 + size + (size & 1); }
            controls.push({ name: 'wrong-plays', bytes: [...wrongPlays], reference: first }); controls.push({ name: 'wrong-pixels', bytes: raw.wrongPixels.bytes, reference: first });
            const erasure = raw.cases.find(c => c.name === 'transparent-erasure'), ghost = Buffer.from(erasure.bytes), gs = inspect(ghost).frames;
            ghost[gs[0].durationOffset + 3] &= ~1; ghost[gs[1].durationOffset + 3] &= ~2; controls.push({ name: 'wrong-blend-ghost', bytes: [...ghost], reference: erasure });
            const negativeControls = [];
            for (const control of controls) {
                const actual = await page.evaluate(async bytes => (await import('/scripts/webp-integration/browser-client.mjs')).decode(bytes), control.bytes);
                assert.throws(() => checkNative(actual, control.reference, name)); negativeControls.push({ name: control.name, independentlyRejected: true });
            }
            const faults = await page.evaluate(async origin => (await import('/scripts/webp-integration/browser-client.mjs')).runFaults(origin), cors.origin);
            const cancellation = await page.evaluate(async () => (await import('/scripts/webp-integration/browser-client.mjs')).runCancellation());
            const inventory = await page.evaluate(async () => (await import('/scripts/webp-integration/browser-client.mjs')).snapshot());
            assert.equal(inventory.objects, inventory.terminated); assert.equal(inventory.handlers, 0); const mainDrainMs = await drain(page, events);
            await page.goto(main.origin + '/deny-worker');
            const csp = await page.evaluate(async () => {
                const m = await import('/scripts/webp-integration/browser-client.mjs');
                try { await m.capture({ name: 'blocked', width: 1, height: 1, colors: [[255, 0, 0, 255]], delays: [55], plays: 1 }); return { succeeded: true }; }
                catch (error) { return { error: error.message, cause: error.cause?.message, inventory: m.snapshot() }; }
            });
            assert.ok(!csp.succeeded && csp.error); if (csp.inventory) { assert.equal(csp.inventory.objects, csp.inventory.terminated); assert.equal(csp.inventory.handlers, 0); } await drain(page, events);
            await page.goto(isolated.origin);
            const nativeProbe = await page.evaluate(async () => (await import('/scripts/webp-integration/browser-client.mjs')).runNativeProbe());
            const nativeDrainMs = await drain(page, events), nativePhaseAfterExit = await page.evaluate(() => Atomics.load(globalThis.webpProbeFlags, 0));
            assert.equal(nativePhaseAfterExit, 1, 'native callback did not unwind before observed target closure'); assert.equal(nativeProbe.inventory.objects, nativeProbe.inventory.terminated); assert.equal(nativeProbe.inventory.handlers, 0);
            assert.deepEqual(errors, [], 'unexpected page errors');
            results.browsers.push({ name, version: browser.version(), cases, repeats, negativeControls, faults: faults.faults, cancellation: cancellation.results, mainInventory: inventory, mainDrainMs,
                workerSrcCsp: csp, nativeProbe, nativeDrainMs, nativePhaseAfterExit, workerEvents: { ...events }, liveWorkerTargets: page.workers().length, maxAgentPages: 1 });
            await writeFile(resolve(out, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
            console.log(name + ': ' + cases.length + ' canvas exports + ' + repeats.length + ' repeated matrices independently decoded; Worker targets ' + events.opened + '/' + events.closed + ' closed; native abort and deployment faults passed');
            await page.close();
        } catch (error) {
            await writeFile(resolve(out, name + '-browser-failure.json'), JSON.stringify({ date: new Date().toISOString(), error: String(error), consoleMessages, recentRequests: main.state.requests.slice(-30) }, null, 2) + '\n');
            throw error;
        } finally { await browser.close(); }
    }
    assert.ok(main.state.requests.includes('/relocated/runtime.js')); assert.ok(main.state.requests.includes('/separate-assets/codec.wasm')); assert.ok(cors.state.requests.length > 0);
    const slowFetchRequests = main.state.requests.filter(path => path === '/slow.wasm').length;
    assert.equal(slowFetchRequests, engines.length, 'each browser entered its own paused WASM fetch'); assert.equal(main.state.slowClosed, engines.length, 'each paused fetch connection closed');
    results.servers = { relocatedWorkerRequested: true, separateWasmRequested: true, corsRequests: cors.state.requests.length, slowFetchRequests, slowFetchRequestsClosed: main.state.slowClosed };
    await writeFile(resolve(out, 'browser-results.json'), JSON.stringify(results, null, 2) + '\n');
} finally { await main.close(); await isolated.close(); await cors.close(); }
