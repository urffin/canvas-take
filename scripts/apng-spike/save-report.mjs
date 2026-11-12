import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { output, root, sha256, sources } from './prepare.mjs';
import { cases } from './fixtures.mjs';

// Explicitly freeze an already successful run; never rewrite expectations to accept a failure.
const result = JSON.parse(await readFile(resolve(output, 'results.json'), 'utf8'));
assert.equal(result.status, 'passed'); assert.equal(result.nodeOnly, false);
assert.equal(result.cases.length, cases.length * 3 + 12); assert.equal(result.cancellations.length, 12);
assert.ok(result.workers.every(w => w.opened === w.closed));
assert.ok(result.controls.length === 9 && result.controls.every(c => c.detected));
assert.ok(result.invalidInputs.length === 13 && result.invalidInputs.every(c => c.rejected));
assert.equal(result.provenance.backendSha256, sha256(await readFile(resolve(output, 'backend.mjs'))));
for (const [name, , hash] of sources) assert.equal(sha256(await readFile(resolve(output, 'vendor', name))), hash);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), result.base);
assert.equal(git('diff', '--name-only', '--', 'src', 'package.json', 'package-lock.json', 'scripts/build-adapters.mjs', 'test', '.github', 'tsconfig.json'), '');
assert.match(JSON.parse(await readFile(resolve(root, 'package.json'))).version, /^\d+\.\d+\.\d+$/);
result.harnessSnapshot = {};
const paths = ['scripts/check-apng-backend.mjs', ...(await readdir(new URL('./', import.meta.url))).filter(f => f.endsWith('.mjs')).map(f => 'scripts/apng-spike/' + f)];
for (const file of paths) result.harnessSnapshot[file] = sha256(await readFile(resolve(root, file)));
result.notes = [
    'Explicit prototype, not the public APNG controller/adapter.',
    'RGBA exactness certified only for full-frame SOURCE/BACKGROUND profile; installed FFmpeg did not distinguish the full-frame OVER mutation.',
    'Worker closure observed by Node exit or Playwright close; no universal memory/latency guarantee or browser GC claim.',
    'Raw/compressed artifacts and cached licensed sources remain ignored under benchmark-results/apng-backend-spike.'
];
const path = resolve(root, 'docs/drafts/apng-backend-spike-results.json');
await writeFile(path, JSON.stringify(result, null, 2) + '\n');
for (const engine of ['node', 'chromium', 'firefox']) {
    const selected = result.cancellations.filter(c => c.engine === engine && c.mode === 'compression');
    const range = key => [Math.min(...selected.map(c => c[key])), Math.max(...selected.map(c => c[key]))];
    console.log(JSON.stringify({ engine, compressionCancellations: selected.length, settlementMs: range('settlementMs'),
        ...(engine === 'node' ? { terminationMs: range('terminationMs') } : {}), workers: result.workers.find(w => w.engine === engine) }));
}
console.log(JSON.stringify({ exports: result.cases.length, profiles: cases.length, decodedFrames: result.cases.reduce((n, c) => n + c.decoded.frames, 0),
    decodedPixels: result.cases.reduce((n, c) => n + c.decoded.pixels, 0), controls: result.controls.length, invalidInputs: result.invalidInputs.length,
    cancellations: result.cancellations.length, workers: result.workers.reduce((n, w) => n + w.opened, 0), ffmpeg: result.ffmpeg,
    limitations: result.limitations, report: 'docs/drafts/apng-backend-spike-results.json' }));
