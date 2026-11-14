import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

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
    assert.ok(packed.files.some(file => file.path === 'docs/video-recording.md'), 'Missing video verification documentation');
    for (const file of ['dist/video.js', 'dist/video.d.ts', 'dist/video-webcodecs.js', 'dist/video-webcodecs.d.ts', 'dist/video-mp4.js', 'dist/video-mp4.d.ts', 'dist/video-mp4.js.map', 'dist/mediabunny-LICENSE.txt', 'docs/offline-video-api.md', 'docs/offline-video-adapters.md']) assert.ok(packed.files.some(entry => entry.path === file), 'Missing offline video package file: ' + file);
    assert.equal(installed.version, pkg.version);
    assert.equal(installed.exports['./webp'].import, './dist/webp.js');
    for (const file of ['webp.js','webp.d.ts','webp-worker.js','webp-worker.d.ts','webp-worker-runtime.js','webp-worker-runtime.js.map','webp-codec.js','webp-codec.wasm'])
        assert.ok(packed.files.some(entry => entry.path === 'dist/' + file), 'Missing public WebP file: ' + file);
    const webpManifest = JSON.parse(await readFile(join(workspace, 'node_modules/@grundyjs/canvas-take/dist/internal/webp-notices/manifest.json'), 'utf8'));
    for (const file of webpManifest.files) {
        const path = file.file.startsWith('webp-codec.') ? file.file : 'webp-notices/' + file.file;
        const bytes = await readFile(join(workspace, 'node_modules/@grundyjs/canvas-take/dist/internal', path));
        assert.equal(bytes.length, file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, 'Packed WebP asset/notice mismatch');
    }
    for(const file of ['dist/video-webm.js','dist/video-webm.d.ts','dist/video-opus.js','dist/video-opus.d.ts','docs/offline-webm.md','dist/webm-PROVENANCE.md','dist/webm-sources/matroska-muxer.ts','dist/webm-sources/matroska-muxer.js','dist/webm-sources/webm-muxer-patch.mjs']) assert.ok(packed.files.some(entry=>entry.path===file),'Missing WebM file: '+file);
    const sharedMaps=packed.files.filter(entry=>/^dist\/video-container-[A-Z0-9]+\.js\.map$/.test(entry.path));
    assert.ok(sharedMaps.length>0,'Missing shared container sources');
    for(const file of sharedMaps){
        assert.ok(packed.files.some(entry=>entry.path===file.path.slice(0,-4)),'Missing shared runtime');
        const map=JSON.parse(await readFile(join(workspace,'node_modules/@grundyjs/canvas-take',file.path),'utf8'));
        assert.equal(map.sources.length,map.sourcesContent.length);assert.ok(map.sourcesContent.every(s=>typeof s==='string'&&s.length));
        assert.ok(map.sourcesContent.some(s=>s.includes('canvastakeDiscardPaddingNs')),'Missing modified MPL source');
    }
    const muxerMap = JSON.parse(await readFile(join(workspace, 'node_modules/@grundyjs/canvas-take/dist/video-mp4.js.map'), 'utf8'));
    assert.equal(muxerMap.sourcesContent.length, muxerMap.sources.length);
    assert.ok(muxerMap.sourcesContent.every(source => typeof source === 'string' && source.length > 0), 'Missing bundled MPL source text');
    for (const file of ['dist/video-aac.js','dist/video-aac.d.ts','dist/video-aac-worker.js','dist/video-aac-worker.js.map','dist/aac-PROVENANCE.md','dist/aac-licenses/MPL-2.0.txt','dist/aac-licenses/COPYING.LGPLv2.1','dist/aac-licenses/bridge.c','docs/offline-aac.md']) assert.ok(packed.files.some(entry=>entry.path===file),'Missing AAC file: '+file);
    await writeFile(join(workspace, 'consumer.ts'), `
import { createApngExporter, type ApngExportOptions, type ApngExporter } from '@grundyjs/canvas-take/apng';
for (const path of ['/internal/webp-controller.js', '/internal/webp-worker.js']) {
    try { await import('@grundyjs/canvas-take' + path); throw new Error('Private WebP unexpectedly exported'); }
    catch (error) { if ((error as {code?:string}).code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }
}
import { createWebpExporter, type WebpEncoderFactory, type WebpExportOptions, type WebpExporter } from '@grundyjs/canvas-take/webp';
import { createWebpWorkerEncoder, type WebpWorkerOptions } from '@grundyjs/canvas-take/webp/worker';
const webpWorker:WebpWorkerOptions = {lossless:true,quality:100,method:4,timeoutMs:30000,wasmUrl:new URL('./codec.wasm',import.meta.url)};
const webpOptions:WebpExportOptions = {encoder:createWebpWorkerEncoder(webpWorker),plays:1,maxInputBytes:64};
const createWebp:()=>WebpExporter = () => createWebpExporter(webpOptions); void createWebp;
if (!import.meta.resolve('@grundyjs/canvas-take/webp/worker-runtime').endsWith('/webp-worker-runtime.js')) throw Error('Missing WebP runtime');
if (!import.meta.resolve('@grundyjs/canvas-take/webp/codec.wasm').endsWith('/webp-codec.wasm')) throw Error('Missing WebP WASM');
try { createWebpExporter(webpOptions); throw Error('Unexpected browser Worker'); } catch(error) { if (!(error as Error & {cause?:Error}).cause?.message.includes('not supported')) throw error; }
// @ts-expect-error encoder is required
const invalidWebp:WebpExportOptions = {plays:1}; void invalidWebp;
// @ts-expect-error method is a number
const invalidWebpWorker:WebpWorkerOptions = {method:'fast'}; void invalidWebpWorker;
import { createApngWorkerEncoder, type ApngWorkerOptions } from '@grundyjs/canvas-take/apng/worker';
const apngWorkerOptions: ApngWorkerOptions = { timeoutMs:30000 };
const apngOptions: ApngExportOptions = { encoder:createApngWorkerEncoder(apngWorkerOptions),plays:1,maxInputBytes:64 };
const createApng:()=>ApngExporter = () => createApngExporter(apngOptions); void createApng;
if (!import.meta.resolve('@grundyjs/canvas-take/apng/worker-runtime').endsWith('/apng-worker-runtime.js')) throw new Error('Missing public APNG Worker asset');
import { createCanvasRecorder, type RecorderOptions, type RecordingResult } from '@grundyjs/canvas-take';
import { createGifExporter, type GifEncoderFactory } from '@grundyjs/canvas-take/gif';
import { createGifencEncoder } from '@grundyjs/canvas-take/gif/gifenc';
import { createGifWorkerEncoder } from '@grundyjs/canvas-take/gif/worker';
import { createOfflineVideoExporter, type OfflineVideoOptions } from '@grundyjs/canvas-take/video';
import { createWebCodecsVideoEncoder } from '@grundyjs/canvas-take/video/webcodecs';
import { createMp4Muxer } from '@grundyjs/canvas-take/video/mp4';
import { createWebmMuxer } from '@grundyjs/canvas-take/video/webm';
import { createWebCodecsAudioEncoder } from '@grundyjs/canvas-take/video/opus';
import { createAacAudioEncoder, type AacEncoderOptions } from '@grundyjs/canvas-take/video/aac';
const aacOptions: AacEncoderOptions = { timeoutMs:30000, workerUrl:new URL('./aac-worker.js',import.meta.url) };
const aac = createAacAudioEncoder(aacOptions);
if ((await aac.checkSupport({codec:'mp4a.40.2',bitstreamFormat:'aac',sampleRate:48000,numberOfChannels:1,bitrate:128000})).supported) throw new Error('Unexpected browser Worker in Node');
const nativeVideo = createWebCodecsVideoEncoder();
const mp4 = createMp4Muxer();
const webm = createWebmMuxer(), opus = createWebCodecsAudioEncoder();
if (!(await webm.checkSupport({video:{codec:'vp8',bitstreamFormat:'vp8',width:2,height:2,bitrate:10000}})).supported) throw new Error('Invalid WebM provider');
if ((await opus.checkSupport({codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:1,bitrate:128000})).supported) throw new Error('Unexpected native AudioEncoder in Node');
const avcConfig = { codec: 'avc1.42E01F', bitstreamFormat: 'avc', width: 2, height: 2, bitrate: 1000 };
if ((await nativeVideo.checkSupport(avcConfig)).supported) throw new Error('Unexpected native VideoEncoder in Node consumer');
if (!(await mp4.checkSupport({ video: avcConfig })).supported || mp4.format.mimeType !== 'video/mp4') throw new Error('Invalid packed MP4 provider');
const workerFactory: GifEncoderFactory = createGifWorkerEncoder({ maxColors: 128, timeoutMs: 30000 });
void workerFactory;
const encoder: GifEncoderFactory = createGifencEncoder({ maxColors: 128, quality: 'fast' });
const gif = createGifExporter({ encoder, repeat: -1, totalFrames: 1, maxFramePixels: 1, maxFrames: 1, maxDurationMs: 50, onProgress(p) { const count: number = p.framesEncoded; void count; } });
await gif.addFrame({ width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }) }) } as unknown as HTMLCanvasElement, 50);
const blob = await gif.finish();
if (blob.type !== 'image/gif' || blob.size < 20) throw new Error('Invalid packed GIF result');
gif.dispose();
// Contract-only packed consumer: deliberately fake bytes, no real codec/container.
let disposed = 0;
const offlineOptions: OfflineVideoOptions = {
    video: { config: { codec: 'test', bitstreamFormat: 'test', width: 1, height: 1, bitrate: 1000 }, encoder: {
        async checkSupport() { return { supported: true }; },
        create(config, context) { return {
            async encodeFrame(frame) {
                await context.output.write({ type: 'config', track: 'video', config: { codec: config.codec, bitstreamFormat: config.bitstreamFormat, width: 1, height: 1, color: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', fullRange: true } } });
                await context.output.write({ type: 'packet', packet: { track: 'video', timestampUs: frame.timestampUs, decodeTimestampUs: frame.timestampUs, durationUs: frame.durationUs, type: 'key', data: new Uint8Array([1]) } });
            },
            async flush() { await context.output.write({ type: 'end', track: 'video' }); },
            dispose() { disposed++; }
        }; }
    } },
    muxer: { format: { mimeType: 'video/x-test', extension: 'test' }, async checkSupport() { return { supported: true }; },
        create() { return { async write() {}, async finalize() { return new Blob(['test'], { type: 'video/x-test' }); }, dispose() { disposed++; } }; } }
};
const offline = await createOfflineVideoExporter(offlineOptions);
await offline.addFrame({ width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray([0,0,0,255]) }) }) } as unknown as HTMLCanvasElement, { timestampUs: 0, durationUs: 1000 });
const offlineResult = await offline.finish(); offline.dispose();
if (offlineResult.durationUs !== 1000 || offlineResult.videoFrames !== 1 || disposed !== 2) throw new Error('Invalid offline packed result');
const options: RecorderOptions = { fps: 30, audioTracks: [] as readonly MediaStreamTrack[], mimeType: 'video/mp4;codecs=avc1,mp4a.40.2', maxDurationMs: 30000 };
function record(canvas: HTMLCanvasElement): Promise<RecordingResult> {
    const recorder = createCanvasRecorder(canvas, options);
    const completed: Promise<RecordingResult> = recorder.finished;
    const pause: () => Promise<void> = recorder.pause;
    const resume: () => Promise<void> = recorder.resume;
    void completed; void pause; void resume;
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
