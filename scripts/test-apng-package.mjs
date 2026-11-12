import { mkdtemp, readFile, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url)), npm = process.env.npm_execpath;
if (!npm) throw new Error('Use npm run test:apng:package');
const workspace = await mkdtemp(join(tmpdir(), 'canvastake-apng-consumer-'));
const run = (args, cwd, capture = false) => execFileSync(process.execPath, [npm, ...args], {
    cwd, encoding: 'utf8', timeout: 300000, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
try {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', workspace], root, true));
    for (const name of ['apng-controller.js', 'apng-controller.d.ts', 'apng-worker.js', 'apng-worker.d.ts', 'apng-worker-runtime.js', 'apng-worker-runtime.js.map', 'apng-PROVENANCE.md', 'apng-sources/UPNG-LICENSE', 'apng-sources/pako-LICENSE', 'apng-sources/pako-zlib-README']) {
        assert.ok(packed.files.some(f => f.path === 'dist/internal/' + name), 'Missing private APNG asset: ' + name);
    }
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(workspace, packed.filename)], workspace);
    const dist = join(workspace, 'node_modules/@grundyjs/canvas-take/dist');
    const pkg = JSON.parse(await readFile(join(dist, '../package.json'), 'utf8'));
    assert.equal(pkg.exports['./apng'], undefined);
    await writeFile(join(workspace, 'consumer.ts'), `import {createApngController} from './node_modules/@grundyjs/canvas-take/dist/internal/apng-controller.js';
import {createApngWorkerEncoder} from './node_modules/@grundyjs/canvas-take/dist/internal/apng-worker.js';
const create = () => createApngController({encoder:createApngWorkerEncoder(),plays:1,maxInputBytes:64}); void create;
`);
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', join(workspace, 'consumer.ts')], { stdio: 'inherit' });
    execFileSync(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', 'test/browser/apng.spec.mjs', '--workers=1'], {
        cwd: root, timeout: 300000, stdio: 'inherit', env: { ...process.env, CANVASTAKE_APNG_DIST: dist } });
    console.log('Packed private APNG consumer passed; public APNG entry remains absent.');
} finally {
    const parent = await realpath(tmpdir()), target = await realpath(workspace), child = relative(parent, target);
    if (!child || child.startsWith('..') || isAbsolute(child) || dirname(target) !== parent) throw new Error('Unsafe APNG consumer cleanup path');
    await rm(target, { recursive: true, force: true });
}
