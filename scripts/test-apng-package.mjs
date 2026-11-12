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
    for (const name of ['apng.js', 'apng.d.ts', 'apng-worker.js', 'apng-worker.d.ts', 'apng-worker-runtime.js', 'apng-worker-runtime.js.map', 'apng-PROVENANCE.md', 'apng-sources/UPNG-LICENSE', 'apng-sources/pako-LICENSE', 'apng-sources/pako-zlib-README']) {
        assert.ok(packed.files.some(f => f.path === 'dist/' + name), 'Missing public APNG asset: ' + name);
    }
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(workspace, packed.filename)], workspace);
    const dist = join(workspace, 'node_modules/@grundyjs/canvas-take/dist');
    const pkg = JSON.parse(await readFile(join(dist, '../package.json'), 'utf8'));
    assert.equal(pkg.exports['./apng'].import, './dist/apng.js');
    assert.equal(pkg.exports['./apng/worker-runtime'], './dist/apng-worker-runtime.js');
    await writeFile(join(workspace, 'consumer.ts'), `import {createApngExporter, type ApngEncoderFactory, type ApngExporter, type ApngExportOptions} from '@grundyjs/canvas-take/apng';
import {createApngWorkerEncoder, type ApngWorkerOptions} from '@grundyjs/canvas-take/apng/worker';
const worker:ApngWorkerOptions = {workerUrl:new URL('./worker.js',import.meta.url),timeoutMs:30000};
const encoder:ApngEncoderFactory = createApngWorkerEncoder(worker);
const options:ApngExportOptions = {encoder,plays:1,maxInputBytes:64,onProgress(p){const n:number=p.framesAccepted;void n;}};
const create:()=>ApngExporter = () => createApngExporter(options); void create;
// @ts-expect-error encoder selection is required
const missing:ApngExportOptions = {plays:1}; void missing;
// @ts-expect-error plays is a number
const invalid:ApngExportOptions = {encoder,plays:'once'}; void invalid;
`);
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM', join(workspace, 'consumer.ts')], { stdio: 'inherit' });
    await writeFile(join(workspace,'runtime.mjs'), `import {createApngExporter} from '@grundyjs/canvas-take/apng';
import {createApngWorkerEncoder} from '@grundyjs/canvas-take/apng/worker';
import {access} from 'node:fs/promises';
if(typeof createApngExporter!=='function')throw Error('Missing APNG controller');
await access(new URL(import.meta.resolve('@grundyjs/canvas-take/apng/worker-runtime')));
try{createApngExporter({encoder:createApngWorkerEncoder()});throw Error('Unexpected browser Worker');}
catch(error){if(!error.cause?.message.includes('not supported'))throw error;}
`);
    execFileSync(process.execPath,[join(workspace,'runtime.mjs')],{cwd:workspace,stdio:'inherit'});
    execFileSync(process.execPath, [join(root, 'node_modules/@playwright/test/cli.js'), 'test', 'test/browser/apng.spec.mjs', '--workers=1'], {
        cwd: root, timeout: 300000, stdio: 'inherit', env: { ...process.env, CANVASTAKE_APNG_DIST: dist } });
    console.log('Packed public APNG consumer passed: types, Node imports and real browser Workers.');
} finally {
    const parent = await realpath(tmpdir()), target = await realpath(workspace), child = relative(parent, target);
    if (!child || child.startsWith('..') || isAbsolute(child) || dirname(target) !== parent) throw new Error('Unsafe APNG consumer cleanup path');
    await rm(target, { recursive: true, force: true });
}
