import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {median} from '../lib/gif-lifecycle-metrics.mjs';
const path=resolve('benchmark-results/video-output-study/results.json');
let data;for(let i=0;i<5;i++){try{data=JSON.parse(await readFile(path,'utf8'));break;}catch(error){if(i===4)throw error;await new Promise(r=>setTimeout(r,100));}}
if(process.argv.includes('--progress')){console.log(JSON.stringify({status:data.status,cases:data.rows.length,controls:data.controls.length,probes:data.probes.map(p=>({pendingInputs:p.pendingInputs,success:p.result.success})),last:data.rows.at(-1)?.id}));process.exit(0);}
assert.equal(data.status,'passed');assert.equal(data.rows.length,28);assert.equal(data.controls.length,6);assert.equal(data.probes.length,5);assert.equal(data.failures.length,0);
assert.equal(data.profileMode,'fresh-persistent-disk-profile');
const timelineProof=JSON.parse(await readFile('benchmark-results/video-output-study/timeline-proof.json','utf8'));
assert.equal(timelineProof.status,'passed');assert.equal(timelineProof.rows.length,data.rows.length);
for(const row of data.rows){const proof=timelineProof.rows.find(p=>p.id===row.id);assert.ok(proof);assert.equal(proof.frames,row.frames);assert.equal(proof.durationUs,row.durationUs);}
const quick=JSON.parse(await readFile('benchmark-results/video-output-study-quick/results.json','utf8'));
assert.equal(quick.status,'passed');assert.equal(quick.profileMode,data.profileMode);assert.equal(quick.rows.length,12);assert.equal(quick.controls.length,6);assert.equal(quick.probes.length,5);
assert.deepEqual(quick.build.sourceHashes,data.build.sourceHashes);
const changedHarnessFiles=Object.keys(data.build.harnessHashes).filter(path=>data.build.harnessHashes[path]!==quick.build.harnessHashes[path]);
// Fresh reproductions use identical current code in both runs. The archived matrix additionally
// permits the documented two-guard receiver correction, checked by the focused regression.
assert.deepEqual(changedHarnessFiles.filter(path=>path!=='scripts/video-output-study/receiver.mjs'),[]);
if(changedHarnessFiles.length)assert.deepEqual(
    [data.build.harnessHashes[changedHarnessFiles[0]],quick.build.harnessHashes[changedHarnessFiles[0]]],
    ['27cfe588ff6b2edacfcdc795d5aaec48a8dc1d8a0bde36612696b70c71b3aada','65cbe0c86da9b0d94ffcf46102c9a2b5b00fa2b74d14b41ceb670ad7f5570860']
);
for(const [path,expected]of Object.entries(quick.build.harnessHashes))assert.equal(createHash('sha256').update(await readFile(path)).digest('hex'),expected);
if(process.argv.includes('--validate-inputs')){console.log(JSON.stringify({status:'inputs verified',changedHarnessFiles}));process.exit(0);}
for(const row of data.rows){assert.equal(row.profileMode,data.profileMode);if(row.mode==='file'){assert.equal(row.diskEvidence.mode,data.profileMode);assert.ok(row.diskEvidence.files.length>0);assert.ok(row.diskEvidence.files.every(f=>f.size===row.result.size));}}
const hashes=new Map();for(const row of data.rows){const hash=createHash('sha256');for await(const bytes of createReadStream(row.file))hash.update(bytes);hashes.set(row.id,hash.digest('hex'));}
const pairs=[];for(const row of data.rows.filter(r=>r.mode==='blob')){const other=data.rows.find(r=>r.mode==='file'&&r.kind===row.kind&&r.seconds===row.seconds&&r.repeat===row.repeat&&r.audio===row.audio);assert.ok(other);pairs.push({kind:row.kind,seconds:row.seconds,repeat:row.repeat,audio:row.audio,byteEqual:hashes.get(row.id)===hashes.get(other.id),blobSha256:hashes.get(row.id),fileSha256:hashes.get(other.id)});}
const at=(row,phase)=>row.checkpoints.find(p=>p.phase===phase),groups=[];
for(const kind of ['mp4','webm'])for(const seconds of [60,180]){
    const modes={};
    for(const mode of ['blob','file']){
        const rows=data.rows.filter(r=>!r.audio&&r.kind===kind&&r.seconds===seconds&&r.mode===mode);assert.equal(rows.length,3);
        const metrics=rows.map(r=>{
            assert.equal(r.decoded.frames,r.frames);assert.equal(r.decoded.durationUs,r.durationUs);assert.equal(r.errors.length,0);
            const initial=at(r,'initialized').memory.privateFootprintBytes;
            const privateSamples=r.checkpoints.filter(p=>!['page-ready','released-after-download'].includes(p.phase)).map(p=>p.memory.privateFootprintBytes);
            return {bytes:r.result.size,ownedPeak:mode==='blob'?Math.max(...r.checkpoints.map(p=>p.stats.storage?.peak??0)):at(r,'finished-result-retained').stats.receiver.peakOwnedBytes,
                sampledPeakPrivate:Math.max(...privateSamples),sampledPeakGrowth:Math.max(...privateSamples)-initial,
                beforeFinishGrowth:at(r,'frames-1').memory.privateFootprintBytes-initial,
                retainedAfterGcGrowth:at(r,'disposed-result-retained').memory.privateFootprintBytes-initial,
                releasedGrowth:at(r,'released-after-download').memory.privateFootprintBytes-at(r,'page-ready').memory.privateFootprintBytes,
                encodeMs:r.encodeMs,peakPageBacking:Math.max(...r.checkpoints.map(p=>p.memory.heap.backingStorageSize??0))};
        });
        modes[mode]={repeats:3,medians:Object.fromEntries(Object.keys(metrics[0]).map(k=>[k,median(metrics.map(m=>m[k]))])),ranges:Object.fromEntries(Object.keys(metrics[0]).map(k=>[k,[Math.min(...metrics.map(m=>m[k])),Math.max(...metrics.map(m=>m[k]))]]))};
    }
    groups.push({kind,seconds,frames:seconds*24,durationUs:seconds*1e6+250000,modes});
}
for(const c of data.controls){assert.equal(c.result.success,false);assert.equal(c.result.fileExists,false);assert.equal(c.result.stats.receiver.ownedBytes,0);assert.equal(c.decoded.frames,c.retry.frames);}
const audio=data.rows.filter(r=>r.audio).map(r=>({kind:r.kind,mode:r.mode,pendingInputs:r.maxPendingInputs,frames:r.decoded.frames,durationUs:r.decoded.durationUs,presentationSamples:r.decoded.samples,bytes:r.result.size}));assert.equal(audio.length,4);
const summary={date:data.date,base:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),version:'0.8.1',status:'completed local research; no API/version/publication change',environment:{node:data.node,platform:data.platform,browser:data.rows[0].browser,profileMode:data.profileMode},configuration:{width:640,height:360,fps:24,requestedBitrate:2000000,longVideoPendingInputs:4,audioPendingInputs:32,maxPendingBytes:16777216,maxOutputBytes:536870912,scene:'8 deterministic seeded noise textures + frame marker',freshBrowserPerMemoryCase:true,alternatingTargetOrder:true,physicalBackingFilesConfirmed:data.rows.filter(r=>r.mode==='file').length},sourceHashes:data.build.sourceHashes,harnessHashes:data.build.harnessHashes,groups,
    postMatrixGuardVerification:{changedHarnessFiles,receiverSha256:quick.build.harnessHashes['scripts/video-output-study/receiver.mjs'],quickCases:quick.rows.length,quickControls:quick.controls.length,quickProbes:quick.probes.map(p=>({pendingInputs:p.pendingInputs,success:p.result.success})),note:changedHarnessFiles.length?'Only the two null-abort-reason guards changed after frozen matrix build; covered by focused regression and current-code quick browser run.':'Identical harness in full and current-code quick run.'},
    pairs,finalIntervals:timelineProof.rows,controls:data.controls.map(c=>({kind:c.kind,failureStage:c.failureStage,partialFileRemoved:!c.result.fileExists,retryFrames:c.decoded.frames,retryDurationUs:c.decoded.durationUs})),
    opusProbes:data.probes.map(p=>({pendingInputs:p.pendingInputs,delayMs:p.delayMs,success:p.result.success,causes:p.result.causes,partialFileRemoved:p.result.success?undefined:!p.result.fileExists,decoded:p.decoded})),audio,
    verifiedFrames:data.rows.reduce((n,r)=>n+r.decoded.frames,0),memoryDumpFailures:data.rows.flatMap(r=>r.dumpFailures),memoryDumpRetries:data.rows.reduce((n,r)=>n+r.checkpoints.reduce((s,p)=>s+p.memory.retries,0),0),
    limits:['Sampled process maxima, not instantaneous peak or total machine RAM.','Long-video matrix is silent; only short prepared-PCM A/V checks are measured separately.','Receiver ownership excludes vendor stream/staging, native codec buffers and OS file cache.','Small/default Opus output-event budgets can fail under slow output. A larger explicit budget is not a universal fix.','Experimental guarded source transforms do not constitute a public controller/muxer refactor.']};
await writeFile('docs/drafts/video-output-memory-results.json',JSON.stringify(summary,null,2)+'\n');
const mib=n=>(n/1048576).toFixed(2);
const table=['| Format | Seconds | File MiB | Blob pages MiB | Receiver snapshot MiB | Sampled private growth Blob/file MiB |','| --- | ---: | ---: | ---: | ---: | ---: |'];
for(const g of groups)table.push(`| ${g.kind} | ${g.seconds} | ${mib(g.modes.blob.medians.bytes)} | ${mib(g.modes.blob.medians.ownedPeak)} | ${mib(g.modes.file.medians.ownedPeak)} | ${mib(g.modes.blob.medians.sampledPeakGrowth)} / ${mib(g.modes.file.medians.sampledPeakGrowth)} |`);
await writeFile('benchmark-results/video-output-study/summary-table.md',table.join('\n')+'\n');console.log(table.join('\n'));console.log(JSON.stringify({cases:data.rows.length,verifiedFrames:summary.verifiedFrames,controls:summary.controls.length,probes:summary.opusProbes.map(p=>({budget:p.pendingInputs,success:p.success})),memoryDumpRetries:summary.memoryDumpRetries}));
