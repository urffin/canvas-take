import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { sampleBrowserMemory } from '../scripts/lib/gif-worker-memory.mjs';

test('failed process dumps are recorded/retried, not reported as a zero-memory sample', async () => {
    for (const permanent of [false, true]) {
        const browser = new EventEmitter(), failures = []; let starts = 0, ends = 0;
        browser.send = async action => {
            if (action === 'Tracing.start') starts++;
            if (action === 'Tracing.requestMemoryDump') return { success: !permanent && starts > 1 };
            if (action === 'Tracing.end') { ends++;
                browser.emit('Tracing.dataCollected', { value: [{ pid: 1, args: { dumps: { process_totals: { private_footprint_bytes: '1000' } } } }] });
                queueMicrotask(() => browser.emit('Tracing.tracingComplete'));
            }
        };
        const work = sampleBrowserMemory(browser, { send: async () => ({ usedSize: 50, backingStorageSize: 100 }) }, { retryDelayMs: 0, onFailure: failure => failures.push(failure) });
        if (permanent) { await assert.rejects(work, /three attempts/); assert.equal(starts, 3); assert.equal(failures.length, 3); }
        else { const result = await work; assert.equal(result.privateFootprintBytes, 4096); assert.equal(result.retries, 1); assert.equal(failures.length, 1); }
        assert.equal(starts, ends); assert.equal(browser.listenerCount('Tracing.dataCollected'), 0); assert.equal(browser.listenerCount('Tracing.tracingComplete'), 0);
    }
});
