// Paired old/new browser comparison. Experimental schedulers exist only in generated fixtures.
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, freemem, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { validateGif, median } from './lib/gif-lifecycle-metrics.mjs';

const args = process.argv.slice(2);
assert(args.every(a => ['--tune', '--quick'].includes(a)), 'Usage: node scripts/benchmark-gif-preparation.mjs [--tune] [--quick]');
const tune = args.includes('--tune'), quick = args.includes('--quick');
const root = fileURLToPath(new URL('../', import.meta.url)), baseline = 'fe2f6f397a311e3b70ea4aae05840ba144a9b2b3';
const directory = join(root, 'benchmark-results', 'gif-preparation-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(directory, { recursive: true });
const variants = tune ? ['baseline', 'baseline-control', 'timer2', 'timer4', 'timer8', 'message4', 'scheduler4'] : ['baseline', 'after'];
const settings = { tune, repeats: quick ? 1 : 5, throughputRepeats: quick ? 1 : 3,
    resolutions: quick ? [[640, 360]] : tune ? [[1280, 720], [1920, 1080]] : [[640, 360], [1280, 720], [1920, 1080]],
    scenes: tune ? ['gradient'] : ['opaque', 'mixed', 'gradient'], fps: 20, frames: quick ? 2 : 3, maxColors: 128, quality: 'high' };
const before = execFileSync('git', ['show', `${baseline}:src/gif.ts`], { cwd: root, encoding: 'utf8' });
const current = await readFile(join(root, 'src/gif.ts'), 'utf8'), helper = await readFile(join(root, 'src/gif-preparation.ts'), 'utf8');
const routes = new Map(), rows = [], errors = [], hashes = new Map();
function instrumentCore(source) {
    const prefix = 'for (let i = 0; i < data.length; i += 4) {';
    assert(source.includes(prefix));
    return source.replace(prefix, 'globalThis.__prepProbe.begin();\n' + prefix)
        .replace('await encoder!.addFrame(', 'globalThis.__prepProbe.end();\nawait encoder!.addFrame(');
}
function experimentalHelper(variant, instrument) {
    let source = helper;
    if (variant !== 'after') {
        source = source.replace('const budgetMs = 4;', `const budgetMs = ${Number(variant.match(/\d+/)[0])};`);
        const start = source.indexOf('    function yieldTask('), end = source.indexOf('    return {', start);
        const scheduling = variant.startsWith('message') ? `
            const channel = new MessageChannel();
            cancelTask = () => { channel.port1.onmessage = null; channel.port1.close(); channel.port2.close(); };
            channel.port1.onmessage = done; channel.port2.postMessage(null);`
            : variant.startsWith('scheduler') ? `
            if (typeof scheduler?.yield !== 'function') throw new Error('scheduler.yield unavailable for experiment');
            scheduler.yield().then(done, reject);`
            : `const timer = setTimeout(done, 0); cancelTask = () => clearTimeout(timer);`;
        assert(start >= 0 && end > start);
        source = source.slice(0, start) + `    function yieldTask(): Promise<void> {
        return new Promise((resolve, reject) => {
            rejectTask = reject;
            const done = () => {
                if (rejectTask !== reject) return;
                cancelTask?.(); cancelTask = undefined; rejectTask = undefined; resolve();
            };
            ${scheduling}
        });
    }
` + source.slice(end);
    }
    if (instrument) {
        assert(source.includes('const deadline = performance.now()') && source.includes('if (offset < pixels.length / 4) {'), 'Preparation probe anchors changed');
        source = source.replace('const deadline = performance.now()', 'globalThis.__prepProbe.begin();\nconst deadline = performance.now()')
            .replace('if (offset < pixels.length / 4) {', 'globalThis.__prepProbe.end();\nif (offset < pixels.length / 4) {');
    }
    return source;
}
for (const variant of variants) for (const instrument of [false, true]) {
    let code;
    if (variant.startsWith('baseline')) code = (await transform(instrument ? instrumentCore(before) : before, { loader: 'ts', format: 'esm', target: 'es2022' })).code;
    else code = (await build({ stdin: { contents: current, resolveDir: join(root, 'src'), sourcefile: 'gif.ts', loader: 'ts' },
        bundle: true, write: false, format: 'esm', target: 'es2022', plugins: [{ name: 'benchmark-only-preparation', setup(b) {
            b.onLoad({ filter: /gif-preparation\.ts$/ }, () => ({ contents: experimentalHelper(variant, instrument), loader: 'ts', resolveDir: join(root, 'src') }));
        } }] })).outputFiles[0].text;
    const name = `${variant}${instrument ? '-probe' : ''}.js`;
    routes.set('/' + name, { code }); await writeFile(join(directory, name), code);
}
for (const name of ['gifenc.js', 'gif-worker.js', 'gif-worker-runtime.js']) routes.set('/' + name, { file: join(root, 'dist', name) });
routes.set('/scene.js', { file: join(root, 'benchmarks/gif-scene.mjs') });
const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/favicon.ico') return res.writeHead(204).end();
    if (path === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end('<button id="cancel">Cancel</button>');
    const route = routes.get(path); if (!route) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store', 'Content-Security-Policy': "worker-src 'self'" });
    res.end(route.code ?? await readFile(route.file));
});
let browser, page, report, inputReady, browserCdp, activeCase;
const observed = { created: 0, closed: 0 };
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)];
function summary() {
    const groups = new Map();
    for (const row of rows) { const key = [row.lane, row.width, row.height, row.scene, row.adapter, row.variant].join('/');
        if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
    return [...groups.values()].map(group => {
        const r = group[0], values = key => group.map(row => row[key]).filter(Number.isFinite);
        return { lane: r.lane, width: r.width, height: r.height, scene: r.scene, adapter: r.adapter, variant: r.variant, n: group.length,
            elapsedMs: median(values('elapsedMs')), prefixMs: median(values('prefixMs')), readbackMs: median(values('readbackMs')),
            blendMs: median(values('blendMs')), maxTaskMs: median(values('maxTaskMs')), p95TaskMs: percentile(group.flatMap(r => r.tasks), .95),
            deadlineToSettleMs: median(values('deadlineToSettleMs')), abortToSettleMs: median(values('abortToSettleMs')),
            inputToSettleMs: median(values('inputToSettleMs')), inputQueueMs: median(values('inputQueueMs')), cancelMissed: group.filter(r => r.cancelMissed).length,
            accepted: median(values('submitted')), deadlineRange: values('deadlineToSettleMs').length ? [Math.min(...values('deadlineToSettleMs')), Math.max(...values('deadlineToSettleMs'))] : null };
    });
}
async function persist() {
    report.rows = rows; report.summary = summary(); report.errors = errors;
    await writeFile(join(directory, 'results.json'), JSON.stringify(report, null, 2));
    const lines = ['# GIF preparation comparison', '', JSON.stringify(report.metadata), '', JSON.stringify(settings), '',
        '| Lane | Size | Scene | Adapter | Variant | n | elapsed ms | blend CPU ms | median max task ms | pooled p95 task ms | deadline→settled ms | range ms |',
        '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |'];
    const f = n => n == null ? '—' : n.toFixed(2);
    for (const s of report.summary) lines.push(`| ${s.lane} | ${s.width}×${s.height} | ${s.scene} | ${s.adapter} | ${s.variant} | ${s.n} | ${f(s.elapsedMs)} | ${f(s.blendMs)} | ${f(s.maxTaskMs)} | ${f(s.p95TaskMs)} | ${f(s.deadlineToSettleMs)} | ${s.deadlineRange?.map(f).join('–') ?? '—'} |`);
    lines.push('', 'Timing tasks measure composition only, excluding synchronous snapshot and codec. Throughput uses uninstrumented code. Cancellation includes subsequent blocking work. No memory sampling or GC in these lanes.', '', `Cases ${rows.length}; Workers ${observed.created}/${observed.closed}; errors ${errors.length}.`);
    await writeFile(join(directory, 'summary.md'), lines.join('\n') + '\n');
}
async function run(options, record = true) {
    activeCase = options;
    const initial = { ...observed };
    const ready = options.lane === 'input' ? new Promise(resolve => { inputReady = resolve; }) : undefined;
    const work = page.evaluate(async options => {
        const { createGifExporter } = await import(`/${options.variant}${options.lane === 'throughput' ? '' : '-probe'}.js`);
        const { createGifencEncoder } = await import('/gifenc.js'), { createGifWorkerEncoder } = await import('/gif-worker.js'), { draw } = await import('/scene.js');
        const nativeSet = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window), NativeChannel = window.MessageChannel, NativeWorker = window.Worker;
        const timers = new Set(), ports = new Set(), events = [], tasks = [];
        let startedTask, armedAt, abortAt, submitted = 0, disposed = 0, prefixMs = 0, readbackMs = 0, cancelTimer, inputTimestamp, trustedInput, workersConstructed = 0, workersTerminated = 0, rawFrames = 0;
        const controller = new AbortController();
        const cancel = event => { abortAt = performance.now(); inputTimestamp = event?.timeStamp; trustedInput = event?.isTrusted; controller.abort(); };
        document.querySelector('#cancel').onclick = cancel;
        window.setTimeout = (callback, delay, ...args) => { const id = nativeSet(() => { timers.delete(id); callback(...args); }, delay); timers.add(id); return id; };
        window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
        window.MessageChannel = class extends NativeChannel { constructor() { super(); for (const port of [this.port1, this.port2]) {
            ports.add(port); const close = port.close.bind(port); port.close = () => { ports.delete(port); close(); }; } } };
        window.Worker = class extends NativeWorker { constructor(...args) { super(...args); workersConstructed++; }
            postMessage(message,...args) { if(message.action==='raw-frame-v1')rawFrames++;return super.postMessage(message,...args); }
            terminate() { workersTerminated++; super.terminate(); } };
        window.__prepProbe = { begin() { startedTask = performance.now(); if (armedAt === undefined && options.lane === 'cancel') {
            armedAt = startedTask; cancelTimer = nativeSet(cancel, 1);
        } else if (armedAt === undefined && options.lane === 'input') {
            armedAt = startedTask; void window.__prepInputReady();
        } }, end() { tasks.push(performance.now() - startedTask); } };
        const canvas = document.createElement('canvas'); canvas.width = options.width; canvas.height = options.height;
        const ctx = canvas.getContext('2d'), read = ctx.getImageData.bind(ctx);
        ctx.getImageData = (...args) => { const t = performance.now(); try { return read(...args); } finally { readbackMs += performance.now() - t; } };
        const factory = options.adapter === 'worker' ? createGifWorkerEncoder() : options.adapter === 'sync' ? createGifencEncoder({ maxColors: 128 }) : () => ({ addFrame() {}, finish() { return new Uint8Array([71, 73, 70, 56, 57, 97]); }, dispose() {} });
        const gif = createGifExporter({ signal: controller.signal, background: [20, 40, 60], repeat: 0, onProgress: e => events.push(e),
            encoder(settings) { const real = factory(settings); return { addFrame(frame) { submitted++; return real.addFrame(frame); }, finish: () => real.finish(), dispose() { disposed++; real.dispose(); } }; } });
        const start = performance.now(); let blob, outcome;
        try {
            for (let i = 0; i < (options.lane === 'input' ? 100 : options.lane === 'cancel' ? 5 : options.frames); i++) {
                draw(ctx, i, canvas.width, canvas.height, options.scene);
                const t = performance.now(), frame = gif.addFrame(canvas, 50); prefixMs += performance.now() - t; await frame;
            }
            blob = await gif.finish(); outcome = 'finished';
        } catch (error) { if (error.name !== 'AbortError') throw error; outcome = 'aborted'; }
        finally { gif.dispose(); nativeClear(cancelTimer); }
        const settledAt = performance.now();
        const result = { outcome, elapsedMs: settledAt - start, prefixMs, readbackMs, tasks, blendMs: tasks.reduce((n, t) => n + t, 0), maxTaskMs: Math.max(0, ...tasks),
            deadlineToSettleMs: options.lane !== 'cancel' || armedAt === undefined ? null : settledAt - armedAt - 1, abortToSettleMs: abortAt === undefined ? null : settledAt - abortAt,
            inputToSettleMs: inputTimestamp === undefined ? null : settledAt - inputTimestamp, inputQueueMs: inputTimestamp === undefined ? null : abortAt - inputTimestamp, trustedInput,
            submitted, disposed, workersConstructed, workersTerminated, rawFrames, timersAtSettle: timers.size, portsAtSettle: ports.size, events: events.map(e => [e.phase, e.framesEncoded]) };
        // The old controller races cancellation but leaves its initial-yield timer queued.
        // Preserve that observation, then drain late work before measuring final cleanup.
        await new Promise(resolve => nativeSet(resolve, 20));
        result.timers = timers.size; result.ports = ports.size;
        window.__prepBytes = blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : null;
        window.setTimeout = nativeSet; window.clearTimeout = nativeClear; window.MessageChannel = NativeChannel; window.Worker = NativeWorker; delete window.__prepProbe;
        canvas.width = canvas.height = 0;
        return result;
    }, options);
    if (ready) {
        await Promise.race([ready, work.then(() => { throw new Error('Export completed before input probe'); })]);
        await page.locator('#cancel').click({ force: true });
    }
    const row = await work;
    assert.equal(row.disposed, 1); assert.equal(row.timers, 0); assert.equal(row.ports, 0);
    assert.equal(row.rawFrames,0,'This historical study intentionally isolates chunk preparation via public-method wrappers; use benchmark:gif:worker-preparation for raw handoff');
    if (options.variant === 'after') { assert.equal(row.timersAtSettle, 0); assert.equal(row.portsAtSettle, 0); }
    const cancelling = options.lane === 'cancel' || options.lane === 'input';
    row.cancelMissed = cancelling && row.outcome !== 'aborted';
    if (!tune || !row.cancelMissed) {
        assert.equal(row.outcome, cancelling ? 'aborted' : 'finished');
        assert.equal(row.events.at(-1)[0], cancelling ? 'aborted' : 'finished');
    }
    if (options.lane === 'input') assert.equal(row.trustedInput, true);
    if (!cancelling && options.adapter !== 'spy') {
        const bytes = Buffer.from(await page.evaluate(() => window.__prepBytes));
        const checked = validateGif(bytes, { ...options, fps: 20 });
        const key = [options.width, options.height, options.scene, options.frames].join('/');
        if (hashes.has(key)) assert.equal(checked.sha256, hashes.get(key), 'baseline/current/adapter GIF mismatch'); else hashes.set(key, checked.sha256);
        Object.assign(row, checked);
        if (!report.fixtures[key]) { const name = key.replaceAll('/', '-') + '.gif'; await writeFile(join(directory, name), bytes); report.fixtures[key] = name; }
    }
    await page.evaluate(() => { window.__prepBytes = null; });
    for (let i = 0; i < 100; i++) {
        const { targetInfos } = await browserCdp.send('Target.getTargets');
        if (!targetInfos.some(t => t.type === 'worker') && observed.created === observed.closed) break;
        await new Promise(r => setTimeout(r, 10));
    }
    assert.equal((await browserCdp.send('Target.getTargets')).targetInfos.some(t => t.type === 'worker'), false);
    assert.equal(observed.created, observed.closed);
    assert.equal(row.workersConstructed, options.adapter === 'worker' ? 1 : 0); assert.equal(row.workersConstructed, row.workersTerminated);
    assert.ok(observed.created - initial.created <= row.workersConstructed, 'unexpected Worker target');
    assert.deepEqual(errors, []);
    if (record) { rows.push({ ...options, ...row }); await persist(); }
    activeCase = undefined;
}
try {
    await new Promise(r => server.listen(0, '127.0.0.1', r)); browser = await chromium.launch({ headless: true }); browserCdp = await browser.newBrowserCDPSession(); page = await browser.newPage();
    page.on('pageerror', e => errors.push(e.message)); page.on('worker', w => { observed.created++; w.on('close', () => observed.closed++); });
    await page.exposeFunction('__prepInputReady', () => inputReady?.());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    report = { status: 'running', metadata: { startedAt: new Date().toISOString(), baseline, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        cpu: cpus()[0].model, os: platform() + ' ' + release(), node: process.version, browser: browser.version(), freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
        packageVersion: JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version,
        dirty: Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()),
        coreSha256: createHash('sha256').update(current).digest('hex'), helperSha256: createHash('sha256').update(helper).digest('hex') }, settings, fixtures: {} };
    for (const variant of variants) await run({ ...settings, width: quick ? 320 : 1280, height: quick ? 180 : 720, scene: 'gradient', adapter: 'spy', variant, lane: 'timing', frames: 5 }, false);
    for (const [width, height] of settings.resolutions) for (const scene of settings.scenes) {
        for (const lane of ['timing', 'cancel', ...(tune ? [] : ['throughput'])]) {
            const adapters = lane === 'timing' || tune ? ['spy'] : ['sync', 'worker'];
            for (const adapter of adapters) for (let repeat = 0; repeat < (lane === 'throughput' ? settings.throughputRepeats : settings.repeats); repeat++) {
                const order = repeat % 2 ? [...variants].reverse() : variants;
                for (const variant of order) {
                    await run({ width, height, scene, lane, adapter, variant, frames: settings.frames, repeat });
                    process.stdout.write(`${lane} ${width}x${height} ${scene} ${adapter} ${variant} ${repeat + 1}\n`);
                }
            }
        }
    }
    if (!tune) for (const adapter of ['sync', 'worker']) for (let repeat = 0; repeat < settings.repeats; repeat++) {
        for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
            await run({ width: quick ? 640 : 1920, height: quick ? 360 : 1080, scene: 'gradient', lane: 'input', adapter, variant, frames: settings.frames, repeat });
        }
    }
    report.status = 'complete'; report.workers = observed; await persist();
    process.stdout.write(directory + '\n');
} catch (error) {
    if (report) { report.status = 'failed'; report.failure = { message: error.message, activeCase }; await persist(); }
    throw error;
} finally { await browser?.close(); await new Promise(r => server.close(r)); }
