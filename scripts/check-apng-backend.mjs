// Explicit, opt-in prototype. Does not build/modify the published library or install dependencies.
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepare, output, sha256 } from './apng-spike/prepare.mjs';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { cases, makeJob, stress } from './apng-spike/fixtures.mjs';
import { checkEnvelope, inspect, decode, mutateChunk } from './apng-spike/oracle.mjs';
import { nodeJob } from './apng-spike/node-client.mjs';
import { withBrowsers } from './apng-spike/browser-run.mjs';

const nodeOnly = process.argv.includes('--node-only');
const provenance = await prepare(), { encodeApng } = await import(pathToFileURL(resolve(output, 'backend.mjs')).href);
await mkdir(resolve(output, 'files'), { recursive: true });
const results = { date: new Date().toISOString(), base: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    node: process.version, platform: process.platform, arch: process.arch, ffmpegStatic: JSON.parse(await readFile(new URL('../node_modules/ffmpeg-static/package.json', import.meta.url))).version,
    ffmpeg: execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' }).split(/\r?\n/)[0], provenance, cases: [], controls: [], limitations: [], invalidInputs: [], cancellations: [], workers: [], nodeOnly };
const save = () => writeFile(resolve(output, nodeOnly ? 'results-node.json' : 'results.json'), JSON.stringify(results, null, 2) + '\n');
async function verify(engine, spec, bytes) {
    const job = makeJob(spec), envelope = checkEnvelope(bytes, spec);
    const file = resolve(output, 'files', engine + '-' + spec.name + '.apng'); await writeFile(file, bytes);
    const decoded = await decode(file, spec, job);
    const record = { engine, name: spec.name, width: spec.width, height: spec.height, plays: spec.plays, delays: spec.delays,
        bytes: bytes.length, sha256: sha256(bytes), decoded };
    if (engine !== 'node') assert.equal(record.sha256, results.cases.find(c => c.engine === 'node' && c.name === (spec.sourceName ?? spec.name)).sha256, 'same backend bytes in actual Worker');
    results.cases.push(record); console.log(engine + ': ' + spec.name + ' decoded (' + bytes.length + ' bytes)'); await save();
}
async function negativeControls() {
    const spec = cases.find(c => c.name === 'erase'), bytes = encodeApng(makeJob(spec));
    const controls = [
        ['corrupt CRC', () => { const bad = bytes.slice(); bad[29] ^= 1; inspect(bad); }],
        ['missing frame control', () => { const chunk = inspect(bytes).chunks.find(c => c.type === 'fcTL'); inspect(Buffer.concat([bytes.subarray(0, chunk.offset), bytes.subarray(chunk.end)])); }],
        ['wrong plays with valid CRC', () => checkEnvelope(mutateChunk(bytes, 'acTL', 0, data => data.writeUInt32BE(2, 4)), spec)],
        ['wrong delay with valid CRC', () => checkEnvelope(mutateChunk(bytes, 'fcTL', 0, data => data.writeUInt16BE(15, 20)), spec)],
        ['duplicate sequence with valid CRC', () => inspect(mutateChunk(bytes, 'fcTL', 1, data => data.writeUInt32BE(0, 0)))],
        ['truncated IEND', () => inspect(bytes.subarray(0, bytes.length - 1))],
        ['static-only single frame', () => {
            const one = encodeApng(makeJob(cases.find(c => c.name === 'single-1')));
            const chunks = inspect(one).chunks.filter(c => !['acTL', 'fcTL'].includes(c.type));
            inspect(Buffer.concat([one.subarray(0, 8), ...chunks.map(c => one.subarray(c.offset, c.end))]));
        }]
    ];
    for (const [name, run] of controls) { assert.throws(run, undefined, name); results.controls.push({ name, detected: true }); }
    const ghost = mutateChunk(mutateChunk(bytes, 'fcTL', 0, data => { data[24] = 0; }), 'fcTL', 1, data => { data[25] = 1; });
    checkEnvelope(ghost, spec, { profile: false });
    const file = resolve(output, 'files/negative-transparent-trail.apng'); await writeFile(file, ghost);
    // Installed FFmpeg accepts this full-frame OVER mutation as if it were SOURCE. Record the
    // decoder limitation instead of using its agreement to certify arbitrary blend/dispose modes.
    let decoderDetected = false;
    try { await decode(file, spec, makeJob(spec)); } catch (error) { if (!/alpha frame=1/.test(error.message)) throw error; decoderDetected = true; }
    results.limitations.push({ name: 'full-frame OVER metadata mutation', decoderDetected, scope: 'Generic OVER/disposal optimization is not certified; candidate requires full-frame SOURCE/BACKGROUND' });
    assert.throws(() => checkEnvelope(ghost, spec), /SOURCE\/BACKGROUND/);
    results.controls.push({ name: 'unsupported blend/disposal strategy with valid CRC/timing', detected: true });
    const wrong = makeJob(spec); wrong.frames[1].data.set(wrong.frames[0].data);
    const wrongFile = resolve(output, 'files/negative-wrong-rgba.apng'); const wrongBytes = encodeApng(wrong);
    checkEnvelope(wrongBytes, spec); await writeFile(wrongFile, wrongBytes);
    await assert.rejects(decode(wrongFile, spec, makeJob(spec)), /alpha frame=1/, 'independent pixel oracle detects wrong transparent pixels');
    results.controls.push({ name: 'incorrect transparent pixels with valid profile/CRC/timing', detected: true });
}
function validation() {
    const spec = cases[0], job = makeJob(spec), bytes = encodeApng(job), raw = job.width * job.height * 4 * job.frames.length;
    assert.deepEqual(encodeApng({ ...job, maxInputBytes: raw, maxOutputBytes: bytes.length }), bytes);
    const invalid = [
        ...[0, 65536, 1.5, NaN, Infinity].map(delay => ['invalid delay ' + delay, { ...job, frames: [{ ...job.frames[0], durationMs: delay }] }]),
        ...[-1, 0x100000000, 1.5, NaN].map(plays => ['invalid plays ' + plays, { ...job, plays }]),
        ['empty input', { ...job, frames: [] }], ['dimensions', { ...job, width: 0 }],
        ['one raw byte over limit', { ...job, maxInputBytes: raw - 1 }], ['one output byte over limit', { ...job, maxOutputBytes: bytes.length - 1 }]
    ];
    for (const [name, input] of invalid) { assert.throws(() => encodeApng(input)); results.invalidInputs.push({ name, rejected: true }); }
}
function checkCancel(stats, mode) {
    assert.equal(stats.outputs, 0); assert.ok(stats.rejectedWithOriginalReason); assert.equal(stats.retainedOwnedFrames, 0); assert.equal(stats.listenersAfterClose, 0);
    if (mode === 'compression') { assert.ok(stats.transferred); assert.equal(stats.phaseAtAbort, 1, 'actually inside Pako deflate at cancellation'); }
    else assert.equal(stats.transferred, false);
}
try {
    for (const spec of cases) {
        const job = makeJob(spec), before = job.frames.map(f => sha256(f.data));
        const bytes = encodeApng(job); assert.deepEqual(job.frames.map(f => sha256(f.data)), before, 'batch codec does not mutate input');
        await verify('node', spec, bytes);
    }
    await negativeControls(); validation(); await save();
    for (const mode of ['before-ready', 'compression', 'compression', 'compression']) {
        const spec = mode === 'compression' ? stress : cases[0], job = makeJob(spec), before = job.frames.map(f => sha256(f.data));
        const { stats } = await nodeJob(job, mode); checkCancel(stats, mode);
        assert.deepEqual(job.frames.map(f => sha256(f.data)), before); assert.ok(stats.exitCode !== undefined);
        if (mode === 'compression') assert.equal(stats.phaseAfterExit, 1, 'terminate interrupted the synchronous deflate call');
        results.cancellations.push({ engine: 'node', ...stats }); console.log('node: ' + mode + ' cancelled, Worker exited'); await save();
        const retry = cases.find(c => c.name === 'single-1'), complete = await nodeJob(makeJob(retry));
        assert.equal(complete.stats.outputs, 1); assert.ok(complete.stats.exitCode !== undefined);
        await verify('node-worker', { ...retry, sourceName: retry.name, name: retry.name + '-retry-' + results.cancellations.length }, complete.bytes);
    }
    results.workers.push({ engine: 'node', opened: 8, closed: 8 });
    if (!nodeOnly) await withBrowsers(async (engine, invoke, workerCounts) => {
        for (const spec of cases) { const result = await invoke(spec); assert.ok(result.stats.transferred); await verify(engine, spec, Buffer.from(result.bytes, 'base64')); }
        for (const mode of ['before-ready', 'compression', 'compression', 'compression']) {
            const result = await invoke(mode === 'compression' ? stress : cases[0], mode); assert.ok(result.cancelled); checkCancel(result.stats, mode);
            assert.equal(result.stats.pendingAfterClose, 0);
            results.cancellations.push({ engine, mode, ...result.stats }); console.log(engine + ': ' + mode + ' cancelled, actual Worker closed'); await save();
            const retry = cases.find(c => c.name === 'single-1'), complete = await invoke(retry);
            await verify(engine, { ...retry, sourceName: retry.name, name: retry.name + '-retry-' + results.cancellations.length }, Buffer.from(complete.bytes, 'base64'));
        }
        results.workers.push({ engine, ...workerCounts() });
    });
    results.status = 'passed'; await save();
    console.log(JSON.stringify({ status: results.status, exports: results.cases.length, negativeControls: results.controls.length, invalidInputs: results.invalidInputs.length, cancellations: results.cancellations.length, workers: results.workers }));
} catch (error) { results.status = 'failed'; results.failure = { message: error.message, stack: error.stack }; await save(); throw error; }
