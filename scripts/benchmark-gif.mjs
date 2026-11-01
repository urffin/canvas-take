import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';

const args = process.argv.slice(2);
if (args.some(arg => !['--quick', '--compare-opacity', '--gradient-study'].includes(arg))) throw Error('Usage: npm run benchmark:gif -- [--quick] [--compare-opacity] [--gradient-study]');
const quick = args.includes('--quick');
const study = args.includes('--gradient-study');
if (study && quick) throw Error('--gradient-study cannot be combined with --quick');
const compare = study || args.includes('--compare-opacity');
const baselineCommit = compare ? '2f71f3c' : undefined;
const variants = compare ? ['before', 'after'] : ['after'];
const settings = { fps: 20, maxColors: 128, quality: 'high', repeats: study ? 12 : quick ? 1 : 3,
    resolutions: study ? [[1920, 1080]] : quick ? [[640, 360], [1280, 720]] : [[640, 360], [1280, 720], [1920, 1080]],
    durations: compare ? [3] : quick ? [3, 10] : [3, 10, 30],
    scenes: study ? ['gradient'] : compare ? ['opaque', 'mixed', 'gradient'] : ['opaque'] };
const root = fileURLToPath(new URL('../', import.meta.url));
const baselineSource = compare ? ts.transpileModule(execFileSync('git', ['show', `${baselineCommit}:src/gif.ts`], { cwd: root, encoding: 'utf8' }),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText : undefined;
const routes = new Map([
    ['/', new URL('../benchmarks/gif.html', import.meta.url)],
    ...['gif.js', 'gifenc.js', 'gif-worker.js', 'gif-worker-runtime.js'].map(name =>
        [`/dist/${name}`, new URL(`../dist/${name}`, import.meta.url)])
]);
const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
    const file = routes.get(path === '/before' ? '/' : path);
    if (path === '/before.js' && compare) { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(baselineSource); return; }
    if (!file) { res.writeHead(404).end(); return; }
    try {
        let bytes = await readFile(file);
        if (path === '/before') bytes = bytes.toString().replace("'/dist/gif.js'", "'/before.js'");
        res.writeHead(200, { 'Content-Type': path === '/' || path === '/before' ? 'text/html' : 'text/javascript',
            'Content-Security-Policy': "worker-src 'self'" }); res.end(bytes);
    } catch { res.writeHead(500).end(); }
});
const rows = [];
let browser, directory, metadata;
const percentile = (values, p) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    if (p === 0.5 && sorted.length % 2 === 0) return (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    browser = await chromium.launch({ headless: true });
    const pages = {};
    const errors = [];
    for (const variant of variants) {
        const page = pages[variant] = await browser.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/${variant === 'before' ? 'before' : ''}`);
        await page.waitForFunction(() => typeof window.runBenchmark === 'function');
    }
    metadata = { date: new Date().toISOString(), packageVersion: JSON.parse(await readFile(join(root, 'package.json'))).version,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
        dirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
        browser: browser.version(), node: process.version, os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), settings, baselineCommit, variants, sceneAlphaCounts: [] };
    for (const [width, height] of settings.resolutions) for (const scene of settings.scenes) {
        const counts = await pages.after.evaluate(options => window.inspectScene(options), { scene, width, height });
        assert.equal(counts.opaque + counts.transparent + counts.translucent, width * height);
        if (scene === 'opaque') assert.equal(counts.opaque, width * height);
        if (scene === 'gradient') assert.equal(counts.translucent, width * height);
        if (scene === 'mixed') assert.ok(Object.values(counts).every(n => n > 0));
        metadata.sceneAlphaCounts.push({ scene, width, height, ...counts });
    }
    directory = join(root, 'benchmark-results', new Date().toISOString().replace(/[:.]/g, '-'));
    await mkdir(directory, { recursive: true });
    const run = async (variant, parameters) => {
        let timer;
        try {
            return await Promise.race([
                pages[variant].evaluate(options => window.runBenchmark(options), { ...settings, ...parameters }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Benchmark case exceeded 5 minutes')), 300000); })
            ]);
        } finally { clearTimeout(timer); }
    };
    console.log(`Warm-up: both adapters, ${study ? '1920x1080, 3 seconds' : '320x180, 1 second'} (excluded)`);
    for (const scene of settings.scenes) for (const variant of variants) for (const adapter of ['sync', 'worker'])
        await run(variant, { scene, adapter, width: study ? 1920 : 320, height: study ? 1080 : 180, seconds: study ? 3 : 1 });
    let pair = 0;
    for (const [width, height] of settings.resolutions) for (const seconds of settings.durations) for (const scene of settings.scenes) {
        let expectedHash;
        for (let repeat = 1; repeat <= settings.repeats; repeat++) {
            // Alternate which adapter runs first to reduce systematic order bias.
            // Study: independently balance adapter order and before/after order in four-repeat blocks.
            const reverseAdapters = study ? Math.floor((repeat - 1) / 2) % 2 : pair % 2;
            for (const adapter of reverseAdapters ? ['worker', 'sync'] : ['sync', 'worker']) for (const variant of pair % 2 ? [...variants].reverse() : variants) {
                console.log(`Run ${scene}/${variant}/${adapter}: ${width}x${height}, ${seconds}s, repeat ${repeat}/${settings.repeats}`);
                const result = await run(variant, { scene, adapter, width, height, seconds });
                expectedHash ??= result.sha256;
                assert.equal(result.sha256, expectedHash, 'Adapters/repeats must produce byte-identical GIFs');
                assert.equal(result.frameCount, seconds * settings.fps);
                assert.deepEqual(errors, [], 'Browser errors');
                rows.push({ scene, variant, adapter, width, height, seconds, repeat, ...result,
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
    const fields = ['scene', 'variant', 'adapter', 'width', 'height', 'seconds', 'repeat', 'frameCount', 'exportMs', 'finishMs', 'framesPerSecond', 'frameP95Ms', 'timerLagP95Ms', 'timerLagMaxMs', 'bytes', 'sha256'];
    await writeFile(join(directory, 'results.csv'), [fields.join(','), ...rows.map(row => fields.map(key => row[key] ?? '').join(','))].join('\n') + '\n');
    const report = ['# GIF benchmark', '', `Environment: ${metadata.cpu}; ${metadata.os}; Chromium ${metadata.browser}.`,
        `CanvasTake ${metadata.packageVersion}; commit ${metadata.commit}; dirty=${metadata.dirty}.`,
        `20 fps; 128 colors; high quality; ${settings.repeats} repeat(s); warm-up excluded.`, '',
        'Medians across repeats. Lag is excess delay of a 16 ms main-thread timer, not input latency. Lower export time/lag is better.', '',
        `Before core: ${baselineCommit ?? 'not used'}; variants: ${variants.join(', ')}.`, '',
        '| Scene | Variant | Resolution | Seconds | Adapter | Export ms | Frames/s | Frame p95 ms | Timer lag p95 ms | Max timer lag ms | GIF bytes |',
        '| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
    for (const [width, height] of settings.resolutions) for (const seconds of settings.durations) for (const scene of settings.scenes) for (const variant of variants) for (const adapter of ['sync', 'worker']) {
        const group = rows.filter(row => row.width === width && row.height === height && row.seconds === seconds && row.scene === scene && row.variant === variant && row.adapter === adapter);
        const values = ['exportMs', 'framesPerSecond', 'frameP95Ms', 'timerLagP95Ms', 'timerLagMaxMs', 'bytes'].map(key => {
            const value = percentile(group.map(row => row[key]).filter(x => x !== null), 0.5);
            return value === null ? 'n/a' : value.toFixed(key === 'bytes' ? 0 : 1);
        });
        report.push(`| ${scene} | ${variant} | ${width}×${height} | ${seconds} | ${adapter} | ${values.join(' | ')} |`);
    }
    await writeFile(join(directory, 'summary.md'), report.join('\n') + '\n');
    if (compare) {
        const comparison = ['# Opacity: before / after', '', `Baseline core: ${baselineCommit}; current commit: ${metadata.commit}; dirty=${metadata.dirty}.`,
            `Environment: ${metadata.cpu}; ${metadata.os}; Chromium ${metadata.browser}; Node ${metadata.node}.`,
            `${settings.repeats} repeat(s); 20 fps; 128 colors; high quality. Medians; positive reduction means faster.`, '',
            '| Scene | Resolution | Seconds | Adapter | Before ms | After ms | Time reduction | Lag p95 before ms | Lag p95 after ms |',
            '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |'];
        for (const scene of settings.scenes) for (const [width, height] of settings.resolutions) for (const seconds of settings.durations) for (const adapter of ['sync', 'worker']) {
            const groups = variants.map(variant => rows.filter(row => row.scene === scene && row.width === width && row.height === height && row.seconds === seconds && row.adapter === adapter && row.variant === variant));
            const times = groups.map(group => percentile(group.map(row => row.exportMs), 0.5));
            const lag = groups.map(group => percentile(group.map(row => row.timerLagP95Ms).filter(value => value !== null), 0.5));
            comparison.push(`| ${scene} | ${width}×${height} | ${seconds} | ${adapter} | ${times[0].toFixed(1)} | ${times[1].toFixed(1)} | ${(100 * (1 - times[1] / times[0])).toFixed(1)}% | ${lag[0]?.toFixed(1) ?? 'n/a'} | ${lag[1]?.toFixed(1) ?? 'n/a'} |`);
        }
        await writeFile(join(directory, 'comparison.md'), comparison.join('\n') + '\n');
    }
    console.log(`Results: ${directory}`);
} finally {
    try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
}
