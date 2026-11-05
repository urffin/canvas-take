import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {validateResources,summarize,markdownReport} from './lib/gif-lifecycle-metrics.mjs';
const directory=resolve(process.argv[2]??''),file=join(directory,'results.json');
const report=JSON.parse(await readFile(file,'utf8'));assert.equal(report.status,'complete');
for(const row of report.rows){validateResources(row);if(row.mode==='success')assert.equal(row.stats.rawFrames,row.variant==='after'?row.frames:0);}
report.summary=Object.fromEntries(['before','after'].map(v=>[v,summarize(report.rows.filter(r=>r.variant===v))]));
const parts=['# GIF Worker preparation comparison','',JSON.stringify(report.metadata),''];
for(const variant of ['before','after'])parts.push('## '+variant,'',markdownReport({...report,summary:report.summary[variant],rows:report.rows.filter(r=>r.variant===variant)}));
parts.push('## Unprofiled throughput','',...report.throughput.map(r=>JSON.stringify(r)));
await writeFile(file,JSON.stringify(report,null,2));await writeFile(join(directory,'summary.md'),parts.join('\n')+'\n');
console.log(JSON.stringify({cases:report.rows.length,summaryGroups:Object.fromEntries(Object.entries(report.summary).map(([k,v])=>[k,v.memory.length])),status:'verified'}));
