import assert from 'node:assert/strict';
import { processMemory } from './gif-lifecycle-metrics.mjs';

// Browser-wide dump requests can fail. Never count a failed request as zero.
export async function sampleBrowserMemory(browserCdp, pageCdp, { onFailure = () => {}, retryDelayMs = 100 } = {}) {
    const start = performance.now();
    for (let attempt = 0; attempt < 3; attempt++) {
        const events = [], collect = e => { for (const item of e.value) if (item.args?.dumps?.process_totals) events.push(item); };
        browserCdp.on('Tracing.dataCollected', collect);
        try {
            await browserCdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } } });
            const dumped = await browserCdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'light', deterministic: false });
            const ended = new Promise(resolve => browserCdp.once('Tracing.tracingComplete', resolve));
            await browserCdp.send('Tracing.end'); await ended;
            if (dumped.success) {
                const totals = processMemory(events); assert(totals.privateFootprintBytes > 0);
                return { ...totals, heap: await pageCdp.send('Runtime.getHeapUsage'), sampleMs: performance.now() - start, retries: attempt };
            }
            onFailure({ attempt: attempt + 1, at: new Date().toISOString() });
        } finally { browserCdp.off('Tracing.dataCollected', collect); }
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, retryDelayMs));
    }
    throw new Error('Chromium memory dump failed after three attempts');
}
