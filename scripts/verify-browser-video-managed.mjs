import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, open, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve, sep} from 'node:path';
import {promisify} from 'node:util';
import {chromium, firefox} from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import {mp4Headers} from '../test/browser/helpers/offline-video.mjs';
import {bestLag, decodeOfflineAudio, readAudioLayout} from '../test/browser/helpers/offline-audio.mjs';
import {decodeWebm, readWebm} from '../test/browser/helpers/offline-webm.mjs';
import {makeOfflinePcm} from '../test/browser/helpers/offline-audio-input.mjs';

// Run only with the browser debugging permission required for this workspace.
const output = resolve('benchmark-results/browser-video-managed-native');
const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {status: 'running', node: process.version, browsers: {}, groups: [], files: [], sourceHashes: {}};
await mkdir(output, {recursive: true});
for (const path of ['scripts/verify-browser-video-managed.mjs', 'scripts/browser-video-managed/browser.mjs',
    'src/internal/video-browser-results-native.ts', 'src/internal/video-browser-results.ts']) {
    report.sourceHashes[path] = digest(await readFile(path));
}
const save = () => writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
await save();
const dist = resolve('dist');
const server = createServer(async (req, res) => {
    try {
        const path = new URL(req.url, 'http://localhost').pathname;
        if (path === '/') {
            res.setHeader('Content-Type', 'text/html');
            res.end('<!doctype html><title>Managed browser video verification</title><button disabled>Download</button><script type="module" src="/browser.mjs"></script>');
            return;
        }
        const file = path === '/browser.mjs' ? resolve('scripts/browser-video-managed/browser.mjs') :
            path === '/pcm.mjs' ? resolve('test/browser/helpers/offline-audio-input.mjs') :
                path.startsWith('/dist/') ? resolve(dist, '.' + path.slice(5)) : undefined;
        if (!file || (path.startsWith('/dist/') && !file.startsWith(dist + sep))) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', 'text/javascript');
        res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;

async function decode(path, row, expectedHash) {
    const data = await readFile(path);
    assert.equal(digest(data), expectedHash);
    let pts, planes, first, count, leading, trailing;
    if (row.kind === 'mp4') {
        const video = mp4Headers(data).tracks.find(track => track.type === 'vide');
        assert.ok(Math.abs(video.duration / video.timescale * 1000000 - row.durationUs) < 20);
        const layout = readAudioLayout(data);
        ({leading, trailing} = layout);
        assert.equal(leading, 1024);
        assert.equal(trailing, (1024 - row.samples % 1024) % 1024);
        const decoded = await decodeOfflineAudio(path, row.channels, layout);
        ({presentation: planes, audioFirst: first} = decoded);
        count = layout.presentationSamples;
        pts = decoded.videoFrames.map(seconds => seconds * 1000000);
        const packets = await execute(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', '-copyts', '-i', path,
            '-map', '0:v:0', '-c:v', 'copy', '-f', 'framecrc', 'pipe:1'], {encoding: 'utf8', timeout: 30000});
        const timebase = packets.stdout.match(/#tb 0:\s*(\d+)\/(\d+)/);
        assert.ok(timebase);
        const micros = Number(timebase[1]) / Number(timebase[2]) * 1000000;
        const rows = packets.stdout.split('\n').filter(line => /^0,/.test(line)).map(line => line.split(',').map(Number));
        assert.equal(rows.length, row.timings.length);
        for (const [i, timing] of row.timings.entries()) {
            assert.ok(Math.abs(rows[i][2] * micros - timing.timestampUs) < 20);
            assert.ok(Math.abs(rows[i][3] * micros - timing.durationUs) < 20);
        }
    } else {
        const layout = readWebm(data);
        const track = layout.tracks.find(track => track.codec === 'V_VP8');
        const opus = layout.tracks.find(track => track.codec === 'A_OPUS');
        const audioBlocks = layout.blocks.filter(block => block.track === opus.number);
        leading = opus.head.readUInt16LE(10);
        trailing = Math.round((audioBlocks.at(-1).discard ?? 0) * 48000 / 1e9);
        assert.ok(leading > 0 && trailing > 0);
        assert.equal(opus.delay, Math.round(leading * 1e9 / 48000));
        assert.ok(audioBlocks.slice(0, -1).every(block => !block.discard));
        assert.equal(audioBlocks.length * 960 - leading - trailing, row.samples);
        const blocks = layout.blocks.filter(block => block.track === track.number);
        assert.equal(layout.duration, row.durationUs);
        assert.deepEqual(blocks.map(block => ({timestampUs: block.time, durationUs: block.duration})), row.timings);
        const decoded = await decodeWebm(path, row.channels);
        ({pts, planes, first, containerSamples: count} = decoded);
    }
    assert.equal(pts.length, row.timings.length);
    for (const [i, time] of pts.entries()) assert.ok(Math.abs(time - row.timings[i].timestampUs) < 20);
    assert.equal(first, 0);
    assert.equal(count, row.samples);
    assert.ok(planes.every(plane => plane.length === count));
    const input = makeOfflinePcm(48000, row.channels, count);
    const checks = input.flatMap((plane, i) => [bestLag(plane, planes[i]), bestLag(plane, planes[i], count - 4096)]);
    assert.ok(checks.every(check => check.lag === 0 && check.correlation > 0.9));
    return {bytes: data.length, sha256: expectedHash, videoFrames: pts.length, durationUs: row.durationUs,
        presentationSamples: count, leading, trailing, firstAudioTimestamp: first,
        minAudioCorrelation: Math.min(...checks.map(check => check.correlation))};
}

const call = (page, method, arg) => page.evaluate(({method, arg}) => window.managed[method](arg), {method, arg});
const binding = (page, id, mode) => page.evaluate(({id, mode}) => window.managed.open(id, mode), {id, mode});
async function deadline(promise) {
    let timer;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Managed browser operation exceeded 60 seconds')), 60000);
        })]);
    } finally { clearTimeout(timer); }
}
async function exportVideo(page, options) {
    await call(page, 'begin', options);
    return deadline(call(page, 'wait'));
}
function resources(counts, connections = 1) {
    for (const [key, value] of Object.entries(counts)) {
        assert.equal(value, key === 'connections' ? connections : 0, key);
    }
}
function successful(row) {
    assert.equal(row.success, true, row.message);
    assert.equal(row.publication, 'committed');
    assert.equal(row.historical, 'committed');
    assert.equal(row.physicalIO, 'settled');
    assert.deepEqual(row.cleanupIssues, []);
    resources(row.live);
}
async function verifyFile(page, row, browser, label, native = false) {
    const name = `${browser}-${row.kind}-${label}`;
    const path = join(output, `${name}.${row.kind}`);
    const file = await call(page, 'read', row.key);
    assert.equal(file.status, 'available');
    assert.equal(file.type, `video/${row.kind}`);
    try {
        if (native) {
            assert.deepEqual(await call(page, 'prepareDownload', row.key), {status: 'available', name: file.name});
            try {
                const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', {name: 'Download'}).click()]);
                assert.deepEqual(await page.evaluate(() => window.managed.requested), {status: 'requested', completion: 'unobservable'});
                assert.equal(download.suggestedFilename(), file.name);
                await download.saveAs(path);
            } finally { await call(page, 'disposeDownload'); }
        } else {
            const target = await open(path, 'w');
            try {
                for (let offset = 0; offset < file.size; offset += 65536) {
                    const length = Math.min(65536, file.size - offset);
                    const bytes = Buffer.from(await call(page, 'chunk', {offset, length}), 'base64');
                    assert.equal(bytes.length, length);
                    await target.writeFile(bytes);
                }
            } finally { await target.close(); }
        }
    } finally { await call(page, 'release'); }
    const decoded = await decode(path, row, file.hash);
    report.files.push({browser, kind: row.kind, label, method: native ? 'download' : 'file-lease', ...decoded});
    await save();
    return file.hash;
}

async function verifyContainer(page, peer, browser, kind) {
    const name = `movie.${kind}`;
    const options = {kind, name};
    const scenarios = [];
    const record = label => { scenarios.push(label); console.log(`${browser} ${kind} ${label}`); };
    const [left, right] = await Promise.all([exportVideo(page, options), exportVideo(peer, options)]);
    assert.equal([left, right].filter(row => row.success).length, 1, JSON.stringify([left, right]));
    const winner = [left, right].find(row => row.success);
    const loser = [left, right].find(row => !row.success);
    successful(winner);
    assert.equal(loser.publication, 'not-committed');
    assert.equal(loser.staging, 'absent');
    assert.equal(await call(page, 'hasObject', loser.key), false);
    resources(loser.live);
    assert.deepEqual((await call(page, 'lookup', name)).key, winner.key);
    record('two-tab create-new, one winner');
    const originalHash = await verifyFile(page, winner, browser, 'original', true);
    assert.equal(await call(page, 'hasObject', winner.key), true);
    record('user-gesture download and decoded result');

    const replacement = await exportVideo(page, {...options, scenario: 'lost-ack', ifExists: 'replace', samples: 24001});
    assert.equal(replacement.success, false);
    assert.equal(replacement.publication, 'indeterminate');
    assert.equal(replacement.historical, 'committed');
    assert.deepEqual(replacement.cleanupIssues, []);
    resources(replacement.live);
    assert.deepEqual(await call(peer, 'recover', replacement.key), {
        status: 'observed', publication: 'committed', physicalIO: 'settled', code: undefined
    });
    assert.deepEqual((await call(peer, 'lookup', name)).key, replacement.key);
    await verifyFile(peer, replacement, browser, 'recovered');
    record('lost commit acknowledgement recovered from IndexedDB');

    const first = await call(peer, 'read', winner.key);
    assert.equal(first.hash, originalHash);
    assert.equal((await call(peer, 'close')).status, 'busy');
    assert.equal((await call(page, 'delete', {key: winner.key})).code, 'busy');
    assert.equal((await call(page, 'releaseHold', winner.ownerHold)).status, 'released');
    const old = await call(page, 'inspect', winner.key);
    const hold = await call(page, 'retain', winner.key);
    assert.equal(hold.status, 'active');
    await call(peer, 'release');
    assert.equal((await call(page, 'delete', {key: winner.key, revision: old.revision})).code, 'stale-revision');
    assert.equal((await call(page, 'delete', {key: winner.key})).code, 'retained');
    assert.equal((await call(page, 'releaseHold', hold.key)).status, 'released');
    assert.equal((await call(page, 'delete', {key: replacement.key})).code, 'selected');
    record('replacement preserves original, reader and holds block deletion');

    const deletion = await call(page, 'delete', {key: winner.key, fault: true});
    assert.equal(deletion.status, 'indeterminate');
    assert.equal((await call(peer, 'inspect', winner.key)).bytes, 'deleting');
    assert.equal(await call(page, 'hasObject', winner.key), false);
    assert.equal((await call(peer, 'delete', {key: winner.key})).status, 'deleted');
    assert.equal((await call(page, 'delete', {key: winner.key})).status, 'already-deleted');
    assert.deepEqual(await call(peer, 'observe', winner.key), {
        publication: 'committed', receipt: 'unavailable', current: 'other-publication', physicalIO: 'settled', staging: 'absent'
    });
    assert.equal((await call(peer, 'read', winner.key)).code, 'deleted');
    record('deletion resumes after native transaction abort');

    const cancelled = await call(page, 'begin', {...options, scenario: 'cancel-write', ifExists: 'replace'});
    await page.waitForFunction(() => window.managed.stats().gated);
    await call(page, 'cancel');
    assert.equal((await call(page, 'stats')).closed, false);
    assert.equal((await call(peer, 'recover', cancelled.key)).code, 'busy');
    await call(page, 'ungate');
    const stopped = await deadline(call(page, 'wait'));
    assert.equal(stopped.exactCancellation, true, stopped.message);
    assert.equal(stopped.publication, 'not-committed');
    assert.equal(stopped.staging, 'absent');
    assert.equal(await call(page, 'hasObject', cancelled.key), false);
    assert.deepEqual(stopped.cleanupIssues, []);
    resources(stopped.live);
    assert.deepEqual((await call(peer, 'lookup', name)).key, replacement.key);
    record('cancel during write preserves exact error and prior result');

    const failed = await exportVideo(peer, {...options, ifExists: 'replace', scenario: 'abort-publication'});
    assert.equal(failed.success, false);
    assert.equal(failed.publication, 'not-committed');
    assert.equal(failed.staging, 'absent');
    assert.deepEqual(failed.cleanupIssues, []);
    resources(failed.live);
    assert.deepEqual((await call(peer, 'lookup', name)).key, replacement.key);
    const retry = await exportVideo(page, {...options, ifExists: 'replace', samples: 96001});
    successful(retry);
    await verifyFile(peer, retry, browser, 'retry');
    record('native publication abort and fresh decoded retry');
    report.groups.push({browser, kind, scenarios});
    await save();
}

let stage = 'startup';
try {
    for (const [name, browserType] of Object.entries({chromium, firefox})) {
        stage = `${name} launch`;
        const profile = await realpath(await mkdtemp(join(tmpdir(), 'canvastake-managed-native-')));
        let context;
        try {
            context = await browserType.launchPersistentContext(profile, {headless: true, acceptDownloads: true,
                ...(name === 'firefox' ? {firefoxUserPrefs: {'gfx.webrender.software': true, 'layers.acceleration.disabled': true,
                    'dom.ipc.processPrelaunch.enabled': false}} : {})});
            assert.ok(context.pages().length <= 1);
            const page = context.pages()[0] ?? await context.newPage();
            const peer = await context.newPage();
            const pageErrors = [];
            for (const tab of [page, peer]) {
                tab.setDefaultTimeout(45000);
                tab.on('pageerror', error => pageErrors.push(String(error)));
                await tab.goto(origin);
                await tab.waitForFunction(() => !!window.managed);
            }
            report.browsers[name] = await page.evaluate(() => navigator.userAgent);
            stage = `${name} namespace`;
            const id = randomUUID();
            await assert.rejects(binding(peer, id, 'reopen'));
            assert.equal((await binding(page, id, 'create')).supported, true);
            await assert.rejects(binding(peer, id, 'create'));
            assert.equal((await binding(peer, id, 'reopen')).supported, true);
            for (const kind of ['mp4', 'webm']) {
                stage = `${name} ${kind}`;
                await verifyContainer(page, peer, name, kind);
            }
            stage = `${name} reopen and abandon`;
            const old = await call(page, 'lookup', 'movie.mp4');
            assert.equal((await call(page, 'close')).status, 'closed');
            assert.equal((await binding(page, id, 'reopen')).supported, true);
            assert.deepEqual((await call(page, 'lookup', 'movie.mp4')).key, old.key);
            assert.deepEqual((await call(page, 'factoryLookup', 'movie.mp4')).key, old.key);
            const abandoned = await call(peer, 'abandon', 'abandoned.webm');
            assert.equal((await call(page, 'recover', abandoned)).code, 'busy');
            await peer.close();
            await page.waitForFunction(async () => !(await navigator.locks.query()).held.some(lock => lock.name.includes('/attempt/')));
            assert.deepEqual(await call(page, 'recover', abandoned), {
                status: 'fenced', publication: 'not-committed', physicalIO: 'unknown', code: undefined
            });
            assert.deepEqual(await call(page, 'cleanup', abandoned), {status: 'blocked', code: 'io-unsettled'});
            assert.equal(await call(page, 'hasObject', abandoned), true);
            const stats = await call(page, 'stats');
            const {store, gated, closed, ...live} = stats;
            resources(live);
            for (const field of ['attempts','readers','downloads','borrowedBytes','physical','orphanLocks']) assert.equal(store[field], 0, field);
            assert.deepEqual(store.cleanupIssues, []);
            assert.equal((await call(page, 'close')).status, 'closed');
            const closedStats = await call(page, 'stats');
            for (const key of Object.keys(live)) assert.equal(closedStats[key], 0, key);
            assert.deepEqual(await page.evaluate(() => navigator.locks.query()), {held: [], pending: []});
            await call(page, 'removeNamespace', id);
            await assert.rejects(binding(page, id, 'reopen'));
            assert.deepEqual(pageErrors, []);
            report.groups.push({browser: name, scenarios: ['namespace create/reopen/refuse adoption/cleanup',
                'abandoned tab fences publication, staging cleanup remains blocked', 'native connections, URLs and locks released']});
            await save();
        } finally {
            await context?.close();
            const target = await realpath(profile);
            assert.equal(dirname(target), await realpath(tmpdir()));
            assert.ok(basename(target).startsWith('canvastake-managed-native-'));
            await rm(target, {recursive: true, force: true, maxRetries: 8, retryDelay: 100});
        }
    }
    report.status = 'passed';
    console.log(`Managed browser results verified: ${report.files.length} independently decoded files`);
} catch (error) {
    report.status = 'failed';
    report.stage = stage;
    report.error = String(error);
    throw error;
} finally {
    await save();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
