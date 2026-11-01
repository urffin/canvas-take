import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { cpus } from 'node:os';
import assert from 'node:assert/strict';

// Mechanism probe, not an end-to-end export benchmark. Extract the actual source
// loops so the experiment cannot silently drift from the implementation.
const root = fileURLToPath(new URL('../', import.meta.url));
const baselineCommit = '2f71f3c';
const before = execFileSync('git', ['show', `${baselineCommit}:src/gif.ts`], { cwd: root, encoding: 'utf8' });
const after = await readFile(new URL('../src/gif.ts', import.meta.url), 'utf8');
const extract = source => {
    const start = source.indexOf('for (let i = 0; i < data.length; i += 4)');
    const end = source.indexOf('await encoder!.addFrame', start);
    assert.ok(start >= 0 && end > start);
    return source.slice(start, end).trim();
};
const loops = { before: extract(before), after: extract(after), control: extract(before) };
assert.equal(loops.after.replace('if (data[i + 3] === 255) continue;', '').replace(/\s+/g, ''), loops.before.replace(/\s+/g, ''));
const browser = await chromium.launch({ headless: true });
const rows = [];
const directory = new URL(`../benchmark-results/gradient-loop-${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(directory, { recursive: true });
try {
    const page = await browser.newPage();
    await page.evaluate(loops => {
        const canvas = document.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
        const ctx = canvas.getContext('2d');
        const sources = [];
        for (let index = 0; index < 6; index++) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
            gradient.addColorStop(0, `rgba(${40 + index % 100}, 80, 220, 0.15)`);
            gradient.addColorStop(1, `rgba(220, ${80 + index % 100}, 40, 0.85)`);
            ctx.fillStyle = gradient; ctx.fillRect(0, 0, canvas.width, canvas.height);
            sources.push(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
        }
        if (sources.some(data => data.some((v, i) => i % 4 === 3 && (v === 0 || v === 255)))) throw Error('Expected only translucent pixels');
        const functions = Object.fromEntries(Object.entries(loops).map(([name, code]) => [name, new Function('data', 'background', code)]));
        const background = [255, 255, 255];
        // Compare every output byte before any timed samples.
        for (const source of sources) {
            const reference = source.slice(); functions.before(reference, background);
            for (const name of ['after', 'control']) {
                const output = source.slice(); functions[name](output, background);
                if (output.some((v, i) => v !== reference[i])) throw Error('Compositing output mismatch');
            }
        }
        window.measure = async name => {
            const times = [];
            for (const source of sources) {
                const data = source.slice(); // Copy and scheduling are outside the timer.
                await new Promise(resolve => setTimeout(resolve, 0));
                const start = performance.now(); functions[name](data, background);
                times.push(performance.now() - start);
                if (data[3] !== 255) throw Error('Result not consumed');
            }
            return times;
        };
    }, loops);
    for (let i = 0; i < 4; i++) for (const name of ['before', 'after', 'control']) await page.evaluate(name => window.measure(name), name);
    const orders = [
        ['before', 'after', 'control'], ['control', 'after', 'before'],
        ['after', 'control', 'before'], ['before', 'control', 'after'],
        ['control', 'before', 'after'], ['after', 'before', 'control']
    ];
    const metadata = { date: new Date().toISOString(), baselineCommit, browser: browser.version(), cpu: cpus()[0]?.model,
        loops, repeats: 36, framesPerSample: 6, width: 1920, height: 1080,
        note: 'Extracted loop in standalone functions; no renderer, allocation, readback, encoder or Worker inside timing. Control is a separate function with identical baseline code. Does not reproduce production JIT context.' };
    for (let repeat = 1; repeat <= 36; repeat++) {
        for (const variant of orders[(repeat - 1) % orders.length]) {
            const frameTimes = await page.evaluate(name => window.measure(name), variant);
            rows.push({ repeat, variant, frameTimes, ms: frameTimes.reduce((a, b) => a + b, 0) / frameTimes.length });
        }
        await writeFile(new URL('results.json', directory), JSON.stringify({ metadata, rows }, null, 2));
        if (repeat % 6 === 0) console.log(`Loop probe: ${repeat}/36 blocks complete`);
    }
    console.log(`Results: ${fileURLToPath(directory)}`);
} finally { await browser.close(); }
