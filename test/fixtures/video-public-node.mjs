import assert from 'node:assert/strict';
import {readFile, realpath} from 'node:fs/promises';
import {createExternalVideoExporter} from '@grundyjs/canvas-take/video';
import {createMp4Muxer} from '@grundyjs/canvas-take/video/mp4';
import {createWebmMuxer} from '@grundyjs/canvas-take/video/webm';
import {openBrowserVideoResultStore} from '@grundyjs/canvas-take/video/browser';
import {provisionNodeVideoDestination} from '@grundyjs/canvas-take/video/node';

assert.equal(typeof createExternalVideoExporter, 'function');
await assert.rejects(openBrowserVideoResultStore({scopeId: '00000000-0000-4000-8000-000000000001', mode: 'reopen'}),
    {name: 'NotSupportedError'});
const receiver = await provisionNodeVideoDestination(await realpath('.'), {trust: 'controlled-local-directory'});
assert.equal(receiver.stats, undefined);
assert.equal(receiver.invalidate, undefined);
const binding = receiver.bind('packed.mp4');
const signal = new AbortController().signal;
const transaction = await binding.destination.create({format: {mimeType: 'video/mp4', extension: 'mp4'},
    ifExists: 'error', maxWriteBytes: 4096, signal});
try {
    await transaction.writeAt(0, Uint8Array.of(7, 9), signal);
    await transaction.truncate(2, signal);
    const committed = await transaction.commit();
    assert.equal(committed.status, 'committed');
    assert.deepEqual(await committed.value.read(), Uint8Array.of(7, 9));
} finally { await transaction.release({publication: 'committed'}); }
assert.deepEqual(await readFile('packed.mp4'), Buffer.from([7, 9]));
assert.equal((await binding.recovery.inspect(binding.key)).publication.status, 'committed');

const warnings = [];
const warn = console.warn;
console.warn = (...values) => { warnings.push(values.join(' ')); warn(...values); };
try { for (const [make, config] of [
    [createMp4Muxer, {codec: 'avc1.42E01F', bitstreamFormat: 'avc'}],
    [createWebmMuxer, {codec: 'vp8', bitstreamFormat: 'vp8'}]
]) {
    assert.equal(make().outputKind, undefined);
    assert.equal(make({output: 'external'}).outputKind, 'external');
    assert.throws(() => make({output: 'append'}), TypeError);
    assert.equal((await make({output: 'external'}).checkSupport({video: {...config, width: 2, height: 2, bitrate: 1000}})).supported, true);
} } finally { console.warn = warn; }
assert.ok(!warnings.some(message => /Mediabunny was loaded twice/i.test(message)));
