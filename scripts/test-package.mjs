import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run through npm run test:package');
const workspace = await mkdtemp(join(tmpdir(), 'canvastake-consumer-'));
const run = (args, cwd) => execFileSync(process.execPath, [npm, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit']
});
try {
    const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', workspace], root));
    assert.equal(packed.filename, packed.filename.split(/[\\/]/).at(-1));
    for (const required of ['dist/index.js', 'dist/index.d.ts', 'dist/gif.js', 'dist/gif.d.ts', 'dist/gifenc.js', 'dist/gifenc.d.ts', 'dist/gifenc-LICENSE.txt', 'dist/gif-worker.js', 'dist/gif-worker.d.ts', 'dist/gif-worker-runtime.js', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
        assert.ok(packed.files.some(file => file.path === required), `Missing ${required}`);
    }
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(workspace, packed.filename)], workspace);
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const installed = JSON.parse(await readFile(join(workspace, 'node_modules/@grundyjs/canvas-take/package.json'), 'utf8'));
    assert.equal(installed.version, pkg.version);
    await writeFile(join(workspace, 'consumer.ts'), `
import { createCanvasRecorder, type RecorderOptions, type RecordingResult } from '@grundyjs/canvas-take';
import { createGifExporter, type GifEncoderFactory } from '@grundyjs/canvas-take/gif';
import { createGifencEncoder } from '@grundyjs/canvas-take/gif/gifenc';
import { createGifWorkerEncoder } from '@grundyjs/canvas-take/gif/worker';
const workerFactory: GifEncoderFactory = createGifWorkerEncoder({ maxColors: 128, timeoutMs: 30000 });
void workerFactory;
const encoder: GifEncoderFactory = createGifencEncoder({ maxColors: 128, quality: 'fast' });
const gif = createGifExporter({ encoder, repeat: -1, totalFrames: 1, onProgress(p) { const count: number = p.framesEncoded; void count; } });
await gif.addFrame({ width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }) }) } as unknown as HTMLCanvasElement, 50);
const blob = await gif.finish();
if (blob.type !== 'image/gif' || blob.size < 20) throw new Error('Invalid packed GIF result');
gif.dispose();
const options: RecorderOptions = { fps: 30, audioTracks: [] as readonly MediaStreamTrack[], mimeType: 'video/mp4;codecs=avc1,mp4a.40.2' };
function record(canvas: HTMLCanvasElement): Promise<RecordingResult> {
    const recorder = createCanvasRecorder(canvas, options);
    return recorder.start().then(() => recorder.stop());
}
if (typeof createCanvasRecorder !== 'function') throw new Error('Missing runtime export');
void record;
`);
    await writeFile(join(workspace, 'tsconfig.json'), JSON.stringify({
        compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true,
            exactOptionalPropertyTypes: true, types: [], outDir: 'output' }, files: ['consumer.ts']
    }));
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(workspace, 'tsconfig.json')], { stdio: 'inherit' });
    execFileSync(process.execPath, [join(workspace, 'output/consumer.js')], { cwd: workspace, stdio: 'inherit' });
    console.log(`Packed consumer passed: ${pkg.name}@${pkg.version}`);
} finally {
    const parent = await realpath(tmpdir());
    const target = await realpath(workspace);
    const child = relative(parent, target);
    if (!child || child.startsWith('..') || isAbsolute(child) || dirname(target) !== parent) throw new Error('Unsafe cleanup path');
    await rm(target, { recursive: true, force: true });
}
