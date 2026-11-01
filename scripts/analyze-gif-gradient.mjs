import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const directory = process.argv[2];
if (!directory) throw Error('Usage: node scripts/analyze-gif-gradient.mjs <results-directory>');
const { metadata, rows } = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8'));
const loopProbe = metadata.framesPerSample !== undefined;
const median = values => {
    const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
    return (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2;
};
const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
const percent = logRatio => 100 * Math.expm1(logRatio);
// Deterministic paired bootstrap: keep each before/after observation paired.
function interval(logRatios) {
    let seed = 1729;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const samples = [];
    for (let i = 0; i < 20000; i++) {
        const sample = logRatios.map(() => logRatios[Math.floor(random() * logRatios.length)]);
        samples.push(percent(mean(sample)));
    }
    samples.sort((a, b) => a - b);
    return [samples[499], samples[19499]];
}
function signTest(positive, n) {
    const k = Math.min(positive, n - positive);
    let term = 2 ** -n, tail = term;
    for (let i = 1; i <= k; i++) { term *= (n - i + 1) / i; tail += term; }
    return Math.min(1, 2 * tail);
}
const results = [];
for (const adapter of loopProbe ? ['loop'] : ['sync', 'worker']) for (const variant of loopProbe ? ['after', 'control'] : ['after']) {
    const group = loopProbe ? rows : rows.filter(row => row.adapter === adapter);
    if (!loopProbe) assert.ok(group.every(row => row.scene === 'gradient' && row.width === 1920 && row.height === 1080 && row.seconds === 3));
    const pairs = [];
    for (let repeat = 1; repeat <= (metadata.repeats ?? metadata.settings.repeats); repeat++) {
        const beforeRows = group.filter(row => row.variant === 'before' && row.repeat === repeat);
        const afterRows = group.filter(row => row.variant === variant && row.repeat === repeat);
        assert.equal(beforeRows.length, 1); assert.equal(afterRows.length, 1);
        const before = beforeRows[0], after = afterRows[0];
        if (!loopProbe) assert.equal(before.sha256, after.sha256);
        const b = loopProbe ? before.ms : before.exportMs, a = loopProbe ? after.ms : after.exportMs;
        pairs.push({ repeat, before: b, after: a, deltaPercent: 100 * (a / b - 1), logRatio: Math.log(a / b), beforeFirst: rows.indexOf(before) < rows.indexOf(after) });
    }
    const logs = pairs.map(p => p.logRatio), positive = logs.filter(x => x > 0).length, nonzero = logs.filter(x => x !== 0).length;
    results.push({ adapter, variant, n: pairs.length, beforeMedianMs: median(pairs.map(p => p.before)), afterMedianMs: median(pairs.map(p => p.after)),
        beforeRangeMs: [Math.min(...pairs.map(p => p.before)), Math.max(...pairs.map(p => p.before))],
        afterRangeMs: [Math.min(...pairs.map(p => p.after)), Math.max(...pairs.map(p => p.after))],
        geometricMeanChangePercent: percent(mean(logs)), bootstrap95Percent: interval(logs),
        pairedMedianChangePercent: median(pairs.map(p => p.deltaPercent)), slowerPairs: positive,
        signTestP: signTest(positive, nonzero),
        orderEffects: Object.fromEntries([true, false].map(first => [first ? 'beforeFirst' : 'afterFirst', percent(mean(pairs.filter(p => p.beforeFirst === first).map(p => p.logRatio)))])), pairs });
}
await writeFile(join(directory, 'analysis.json'), JSON.stringify({ metadata, results }, null, 2));
const lines = ['# Gradient regression analysis', '',
    'Positive change means slower. Export units are milliseconds/export; loop-probe units are milliseconds/frame.',
    'Effect: geometric mean of paired after/before ratios. 95% interval: 20,000 paired bootstrap resamples (seed 1729). Conventional medians average the two middle values for even sample counts.',
    'Intervals and sign tests assume independent pairs; adjacent exports can be correlated. They describe this machine/session, not universal performance. No samples are discarded.', '',
    '| Adapter / variant | Pairs | Before median ms | After median ms | Paired change | Bootstrap 95% | Slower pairs | Sign test p |',
    '| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |'];
for (const r of results) lines.push(`| ${r.adapter}/${r.variant} | ${r.n} | ${r.beforeMedianMs.toFixed(2)} | ${r.afterMedianMs.toFixed(2)} | ${r.geometricMeanChangePercent.toFixed(2)}% | ${r.bootstrap95Percent.map(x => x.toFixed(2)).join(' to ')}% | ${r.slowerPairs}/${r.n} | ${r.signTestP < 0.0001 ? '<0.0001' : r.signTestP.toFixed(4)} |`);
lines.push('', 'Order effects and all individual pairs are retained in analysis.json. The loop control uses identical baseline code in a separate function; extracted functions may have different JIT behavior from the production async exporter.');
await writeFile(join(directory, 'analysis.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log(`Analysis: ${resolve(directory)}`);
