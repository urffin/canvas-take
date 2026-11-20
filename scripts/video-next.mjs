import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {chromium, firefox} from '@playwright/test';
import {build} from 'esbuild';
import {mp4Headers} from '../test/browser/helpers/offline-video.mjs';
import {bestLag, decodeOfflineAudio, readAudioLayout} from '../test/browser/helpers/offline-audio.mjs';
import {decodeWebm, readWebm} from '../test/browser/helpers/offline-webm.mjs';
import {makeOfflinePcm} from '../test/browser/helpers/offline-audio-input.mjs';

const workerPath = '/canvastake-video/video-aac-worker.js';

export async function prepareVideoNext(root, workspace) {
    const page = join(workspace, 'app/external-video');
    const assets = join(workspace, 'public/canvastake-video');
    const pkg = join(workspace, 'node_modules/@grundyjs/canvas-take');
    await Promise.all([mkdir(page, {recursive: true}), mkdir(assets, {recursive: true})]);
    const worker = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')).exports['./video/aac-worker'];
    await Promise.all([
        copyFile(join(pkg, worker), join(assets, 'video-aac-worker.js')),
        copyFile(join(root, 'test/fixtures/video-public-browser.mjs'), join(page, 'fixture.mjs')),
        copyFile(join(root, 'test/browser/helpers/offline-audio-input.mjs'), join(page, 'offline-audio-input.mjs'))
    ]);
    await writeFile(join(page, 'client.jsx'), `'use client';
import {useEffect} from 'react';
import {attachExternalVideoFixture} from './fixture.mjs';
export default function Client() {
    useEffect(() => attachExternalVideoFixture(new URL(${JSON.stringify(workerPath)}, window.location.href)), []);
    return <p>External video client</p>;
}
`);
    await writeFile(join(page, 'page.jsx'), `import {createExternalVideoExporter} from '@grundyjs/canvas-take/video';
import {createMp4Muxer} from '@grundyjs/canvas-take/video/mp4';
import {createWebmMuxer} from '@grundyjs/canvas-take/video/webm';
import {openBrowserVideoResultStore} from '@grundyjs/canvas-take/video/browser';
import {provisionNodeVideoDestination} from '@grundyjs/canvas-take/video/node';
import Client from './client';
export const dynamic = 'force-dynamic';
export default function Page() {
    const ok = typeof createExternalVideoExporter === 'function' && createMp4Muxer({output:'external'}).format.extension === 'mp4' &&
        createWebmMuxer({output:'external'}).format.extension === 'webm' && typeof openBrowserVideoResultStore === 'function' &&
        typeof provisionNodeVideoDestination === 'function';
    if (!ok) throw new Error('SSR import failed');
    return <main><h1>External video SSR ready</h1><Client /></main>;
}
`);
    await writeFile(join(assets, 'packed.html'), '<!doctype html><title>Packed external video</title><script type="module" src="./packed.js"></script>');
    const bundle = await build({absWorkingDir: workspace, stdin: {
        contents: `import {attachExternalVideoFixture} from './fixture.mjs';
attachExternalVideoFixture(new URL(${JSON.stringify(workerPath)}, window.location.href));`,
        resolveDir: page, sourcefile: 'standalone.mjs'
    }, outfile: join(assets, 'packed.js'), bundle: true, platform: 'browser', format: 'esm', metafile: true});
    assert.ok(Object.keys(bundle.metafile.inputs).some(path => /canvas-take\/dist\/video-browser\.js$/.test(path)));
    assert.ok(Object.keys(bundle.metafile.inputs).some(path => /canvas-take\/dist\/internal\/video-external-mp4\.js$/.test(path)));
    assert.ok(!Object.keys(bundle.metafile.inputs).some(path => /video-node|video-file-node/.test(path)));
    await assert.rejects(build({absWorkingDir: workspace, stdin: {
        contents: "import {provisionNodeVideoDestination} from '@grundyjs/canvas-take/video/node'; console.log(provisionNodeVideoDestination);",
        resolveDir: page
    }, bundle: true, platform: 'browser', write: false, logLevel: 'silent'}), /Could not resolve/);
}

async function verifyVideo(path, result) {
    const content = await readFile(path);
    let videoPts, audio, first, samples;
    if (result.kind === 'mp4') {
        const layout = readAudioLayout(content);
        assert.equal(layout.leading, 1024);
        assert.equal(layout.trailing, (1024 - result.samples % 1024) % 1024);
        const decoded = await decodeOfflineAudio(path, 1, layout);
        videoPts = decoded.videoFrames.map(pts => pts * 1e6);
        [audio] = decoded.presentation;
        first = decoded.audioFirst;
        samples = layout.presentationSamples;
        const video = mp4Headers(content).tracks.find(track => track.type === 'vide');
        assert.ok(Math.abs(video.duration / video.timescale * 1e6 - result.durationUs) < 20);
    } else {
        const layout = readWebm(content);
        const track = layout.tracks.find(track => track.codec === 'V_VP8');
        assert.equal(layout.duration, result.durationUs);
        assert.deepEqual(layout.blocks.filter(block => block.track === track.number).map(block => block.duration),
            result.timings.map(timing => timing.durationUs));
        const decoded = await decodeWebm(path, 1);
        videoPts = decoded.pts;
        [audio] = decoded.planes;
        first = decoded.first;
        samples = decoded.containerSamples;
    }
    assert.equal(videoPts.length, result.timings.length);
    assert.ok(videoPts.every((pts, i) => Math.abs(pts - result.timings[i].timestampUs) < 20));
    assert.equal(first, 0);
    assert.equal(samples, result.samples);
    assert.equal(audio.length, samples);
    const [reference] = makeOfflinePcm(48000, 1, samples);
    const checks = [bestLag(reference, audio), bestLag(reference, audio, samples - 4096)];
    assert.ok(checks.every(({lag, correlation}) => lag === 0 && correlation > 0.9));
    return {samples, videoFrames: videoPts.length, durationUs: result.durationUs, audio: checks, bytes: content.length};
}

export async function verifyVideoNext(root, workspace) {
    const output = join(root, 'benchmark-results/video-public-next');
    await mkdir(output, {recursive: true});
    const probe = createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, [join(workspace, 'node_modules/next/dist/bin/next'),
        'start', '--hostname', '127.0.0.1', '--port', String(port)], {cwd: workspace, windowsHide: true, stdio: ['ignore','pipe','pipe']});
    let logs = '';
    const append = data => { logs = (logs + data).slice(-16000); };
    server.stdout.on('data', append);
    server.stderr.on('data', append);
    const exited = once(server, 'exit');
    const report = {status: 'running', node: process.version, ssr: false, cases: []};
    const save = () => writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
    await save();
    try {
        for (let i = 0; i < 150 && server.exitCode === null; i++) {
            const response = await fetch(origin + '/external-video/', {signal: AbortSignal.timeout(2000)}).catch(() => undefined);
            if (response?.ok && (await response.text()).includes('External video SSR ready')) { report.ssr = true; break; }
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        assert.ok(report.ssr, `SSR probe failed: ${logs}`);
        const servedWorker = await fetch(origin + workerPath);
        assert.equal(servedWorker.status, 200);
        assert.match(servedWorker.headers.get('content-type'), /javascript/);
        assert.deepEqual(Buffer.from(await servedWorker.arrayBuffer()), await readFile(join(workspace,
            'node_modules/@grundyjs/canvas-take/dist/video-aac-worker.js')));
        for (const [browserName, engine] of Object.entries({chromium, firefox})) {
            report.stage = `${browserName}/launch`;
            await save();
            const prefix = 'canvastake-video-next-profile-';
            const profile = await realpath(await mkdtemp(join(tmpdir(), prefix)));
            let context;
            try {
                context = await engine.launchPersistentContext(profile, {headless: true,
                    ...(browserName === 'firefox' ? {firefoxUserPrefs: {'gfx.webrender.software': true,
                        'layers.acceleration.disabled': true, 'dom.ipc.processPrelaunch.enabled': false}} : {})});
                assert.ok(context.pages().length <= 1);
                const page = context.pages()[0] ?? await context.newPage();
                page.setDefaultTimeout(45000);
                const errors = [];
                const workerResponses = [];
                page.on('pageerror', error => errors.push(String(error)));
                page.on('console', message => {
                    if (/Mediabunny was loaded twice/i.test(message.text())) errors.push(message.text());
                });
                page.on('response', response => {
                    if (new URL(response.url()).pathname === workerPath) workerResponses.push(response.status());
                });
                for (const [mode, path] of [['packed', '/canvastake-video/packed.html'], ['next', '/external-video/']]) {
                    report.stage = `${browserName}/${mode}/load`;
                    await save();
                    errors.length = 0;
                    workerResponses.length = 0;
                    await page.goto(origin + path);
                    await page.waitForFunction(() => typeof window.runPublicExternalVideo === 'function');
                    for (const kind of ['mp4', 'webm']) {
                        report.stage = `${browserName}/${mode}/${kind}`;
                        await save();
                        let timer;
                        let result;
                        try {
                            result = await Promise.race([page.evaluate(format => window.runPublicExternalVideo(format), kind),
                                new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${report.stage}`)), 60000); })]);
                        } catch (error) {
                            report.pageStage = await page.evaluate(() => window.externalVideoStage).catch(() => undefined);
                            report.pageErrors = errors;
                            report.workerResponses = workerResponses;
                            throw error;
                        } finally { clearTimeout(timer); }
                        assert.equal(result.cancelled, 'not-committed');
                        assert.equal(result.publication, 'committed');
                        assert.equal(result.recovered, 'committed');
                        assert.equal(result.workers.opened, 2);
                        assert.equal(result.workers.closed, 2);
                        const file = join(output, `${browserName}-${mode}.${kind}`);
                        await writeFile(file, Uint8Array.from(result.bytes));
                        const checks = await verifyVideo(file, result);
                        report.cases.push({browser: browserName, mode, kind, cancelled: result.cancelled, workers: result.workers, ...checks});
                        console.log(`${report.stage}: cancellation, reopen, independently decoded retry`);
                        await save();
                    }
                    assert.ok(workerResponses.every(status => status === 200 || status === 304));
                    assert.deepEqual(errors, []);
                }
            } finally {
                await context?.close();
                const target = await realpath(profile);
                assert.equal(dirname(target), await realpath(tmpdir()));
                assert.ok(basename(target).startsWith(prefix));
                await rm(target, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
            }
        }
        delete report.stage;
        assert.doesNotMatch(logs, /Mediabunny was loaded twice/i);
        report.status = 'passed';
    } catch (error) {
        report.status = 'failed';
        report.error = String(error);
        throw error;
    } finally {
        server.kill();
        await exited;
        await save();
        await writeFile(join(output, 'next-server.log'), logs);
    }
}
