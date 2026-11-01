import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const args = process.argv.slice(2);
if (args.some(arg => arg !== '--quick')) throw Error('Usage: npm run benchmark:gif -- [--quick]');
const quick = args.includes('--quick');
const settings = { fps: 20, maxColors: 128, quality: 'high', repeats: quick ? 1 : 3,
    resolutions: quick ? [[640, 360], [1280, 720]] : [[640, 360], [1280, 720], [1920, 1080]],
    durations: quick ? [3, 10] : [3, 10, 30] };
const root = fileURLToPath(new URL('../', import.meta.url));
const routes = new Map([
    ['/', new URL('../benchmarks/gif.html', import.meta.url)],
    ...['gif.js', 'gifenc.js', 'gif-worker.js', 'gif-worker-runtime.js'].map(name =>
        [`/dist/${name}`, new URL(`../dist/${name}`, import.meta.url)])
]);
const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = routes.get(path);
    if (!file) { res.writeHead(404).end(); return; }
    try {
        const bytes = await readFile(file);
        res.writeHead(200, { 'Content-Type': path === '/' ? 'text/html' : 'text/javascript',
            'Content-Security-Policy': "worker-src 'self'" }); res.end(bytes);
    } catch { res.writeHead(500).end(); }
});
const rows = [];
let browser, directory, metadata;
const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => typeof window.runBenchmark === 'function');
    metadata = { date: new Date().toISOString(), packageVersion: JSON.parse(await readFile(join(root, 'package.json'))).version,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
        browser: browser.version(), node: process.version, os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), settings };
    directory = join(root, 'benchmark-results', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(directory, { recursive: true });
    const run = async parameters => {
        let timer;
        try {
            return await Promise.race([
                page.evaluate(options => window.runBenchmark(options), { ...settings, ...parameters }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Benchmark case exceeded 5 minutes')), 300000); })
            ]);
        } finally { clearTimeout(timer); }
    };
    console.log('Warm-up: both adapters, 320x180, 1 second (excluded)');
    for (const adapter of ['sync', 'worker']) await run({ adapter, width: 320, height: 180, seconds: 1 });
    let pair = 0;
    for (const [width, height] of settings.resolutions) for (const seconds of settings.durations) {
        let expectedHash;
        for (let repeat = 1; repeat <= settings.repeats; repeat++) {
            // Alternate which adapter runs first to reduce systematic order bias.
            for (const adapter of pair % 2 ? ['worker', 'sync'] : ['sync', 'worker']) {
                console.log(`Run ${adapter}: ${width}x${height}, ${seconds}s, repeat ${repeat}/${settings.repeats}`);
                const result = await run({ adapter, width, height, seconds });
                expectedHash ??= result.sha256;
                assert.equal(result.sha256, expectedHash, 'Adapters/repeats must produce byte-identical GIFs');
                assert.equal(result.frameCount, seconds * settings.fps);
                assert.deepEqual(errors, [], 'Browser errors');
                rows.push({ adapter, width, height, seconds, repeat, ...result,
                    framesPerSecond: result.frameCount * 1000 / result.exportMs,
                    frameP95Ms: percentile(result.frameTimes, 0.95),
                    timerLagP95Ms: percentile(result.timerLag, 0.95),
                    timerLagMaxMs: result.timerLag.length ? Math.max(...result.timerLag) : null });
                await writeFile(join(directory, 'results.json'), JSON.stringify({ metadata, rows }, null, 2));
                console.log(`  ${result.exportMs.toFixed(0)} ms; ${result.bytes} bytes; SHA-256 matches`);
            }
            pair++;
        }
    }
    const fields = ['adapter', 'width', 'height', 'seconds', 'repeat', 'frameCount', 'exportMs', 'finishMs', 'framesPerSecond', 'frameP95Ms', 'timerLagP95Ms', 'timerLagMaxMs', 'bytes', 'sha256'];
    await writeFile(join(directory, 'results.csv'), [fields.join(','), ...rows.map(row => fields.map(key => row[key] ?? '').join(','))].join('\n') + '\n');
    const report = ['# GIF benchmark', '', `Environment: ${metadata.cpu}; ${metadata.os}; Chromium ${metadata.browser}.`,
        `CanvasTake ${metadata.packageVersion}; commit ${metadata.commit}; dirty=${metadata.dirty}.`,
        `20 fps; 128 colors; high quality; ${settings.repeats} repeat(s); warm-up excluded.`, '',
        'Medians across repeats. Lag is excess delay of a 16 ms main-thread timer, not input latency. Lower export time/lag is better.', '',
        '| Resolution | Seconds | Adapter | Export ms | Frames/s | Frame p95 ms | Timer lag p95 ms | Max timer lag ms | GIF bytes |',
        '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
    for (const [width, height] of settings.resolutions) for (const seconds of settings.durations) for (const adapter of ['sync', 'worker']) {
        const group = rows.filter(row => row.width === width && row.height === height && row.seconds === seconds && row.adapter === adapter);
        const values = ['exportMs', 'framesPerSecond', 'frameP95Ms', 'timerLagP95Ms', 'timerLagMaxMs', 'bytes'].map(key => {
            const value = percentile(group.map(row => row[key]).filter(x => x !== null), 0.5);
            return value === null ? 'n/a' : value.toFixed(key === 'bytes' ? 0 : 1);
        });
        report.push(`| ${width}×${height} | ${seconds} | ${adapter} | ${values.join(' | ')} |`);
    }
    await writeFile(join(directory, 'summary.md'), report.join('\n') + '\n');
    console.log(`Results: ${directory}`);
} finally {
    try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
}
