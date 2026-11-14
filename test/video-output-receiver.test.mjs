import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPositionedReceiver} from '../scripts/video-output-study/receiver.mjs';
import {createFileDestination} from '../scripts/video-output-study/file-destination.mjs';
import {buildStudy} from '../scripts/video-output-study/build.mjs';
import {storageHarness,mediaInput,writeInput} from './fixtures/muxer-storage.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function directory(t){const root=await mkdtemp(join(tmpdir(),'canvastake-output-study-'));t.after(async()=>{const target=await realpath(root);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-output-study-'));await rm(target,{recursive:true,force:true});});return root;}
function controlled(){const calls=[];return {calls,destination:{ready(){calls.push('ready');},writeAt(p,d){calls.push({position:p,data:[...d]});},truncate(n){calls.push(['truncate',n]);},commit(){calls.push('commit');return 'handle';},abort(r){calls.push(['abort',r]);}}};}

test('receiver owns input subviews before readiness, serializes, bounds memory and commits high-water size',async()=>{
    const ready=deferred(),c=controlled();c.destination.ready=()=>ready.promise;
    const sink=createPositionedReceiver(c.destination,{maxOutputBytes:20,maxWriteBytes:10}),data=new Uint8Array([99,1,2,3,99]);
    const pending=sink.writeAt(6,data.subarray(1,4));data.fill(9);await assert.rejects(sink.writeAt(0,new Uint8Array([4])),/overlap/);assert.equal(sink.stats.ownedBytes,3);assert.equal(c.calls.length,0);
    ready.resolve();await pending;assert.deepEqual(c.calls[0],{position:6,data:[1,2,3]});
    await sink.writeAt(0,new Uint8Array([8,7]));await sink.writeAt(7,new Uint8Array([5]));
    const a=sink.finish('video/mp4');assert.equal(a,sink.finish('video/mp4'));const receipt=await a;
    assert.equal(receipt.size,9);assert.equal(receipt.kind,'external-output');assert.equal(receipt.handle,'handle');assert.deepEqual(c.calls.slice(-2),[['truncate',9],'commit']);
    await sink.abort(new Error('late'));assert.equal(sink.stats.aborts,0);assert.equal(sink.stats.ownedBytes,0);assert.equal(sink.stats.peakOwnedBytes,3);
});

test('abort while waiting for readiness rejects promptly and cannot start a late write',async()=>{
    const c=controlled(),gate=deferred(),abort=new AbortController(),reason=new Error('waiting');c.destination.ready=()=>gate.promise;
    const sink=createPositionedReceiver(c.destination,{signal:abort.signal}),p=sink.writeAt(0,new Uint8Array(17));abort.abort(reason);
    await assert.rejects(p,e=>e===reason);await sink.settled();assert.equal(sink.stats.ownedBytes,0);gate.resolve();await new Promise(r=>setTimeout(r,0));
    assert.equal(c.calls.filter(x=>typeof x==='object'&&!Array.isArray(x)).length,0);assert.deepEqual(c.calls,[['abort',reason]]);
});

test('abort during non-cancellable I/O retains only the owned copy until real I/O settles',async()=>{
    const c=controlled(),entered=deferred(),gate=deferred(),reason=0;c.destination.writeAt=async(p,data)=>{entered.resolve(data);await gate.promise;};
    const sink=createPositionedReceiver(c.destination),input=new Uint8Array([1,2,3]),p=sink.writeAt(0,input);const owned=await entered.promise;
    const cleanup=sink.abort(reason);await assert.rejects(p,e=>e===reason);input.fill(8);assert.deepEqual([...owned],[1,2,3]);assert.equal(sink.stats.ownedBytes,3);assert.equal(c.calls.length,1);
    gate.resolve();await cleanup;await sink.settled();assert.equal(sink.stats.ownedBytes,0);assert.equal(sink.stats.aborts,1);await assert.rejects(sink.finish('video/webm'),e=>e===reason);
});

test('caller signal preserves an explicit null abort reason while waiting for capacity',async()=>{
    const c=controlled(),gate=deferred(),abort=new AbortController();c.destination.ready=()=>gate.promise;
    const sink=createPositionedReceiver(c.destination,{signal:abort.signal}),pending=sink.writeAt(0,new Uint8Array([1]));
    abort.abort(null);await assert.rejects(pending,error=>error===null);await sink.settled();
    assert.deepEqual(c.calls,[['abort',null]]);assert.equal(sink.stats.ownedBytes,0);
    gate.resolve();await new Promise(resolve=>setTimeout(resolve,0));assert.equal(c.calls.length,1);
});

for(const stage of ['ready','writeAt','truncate','commit'])test('receiver preserves '+stage+' failure and aborts once even when cleanup fails',async()=>{
    const c=controlled(),reason=new Error(stage),cleanup=new Error('cleanup');c.destination[stage]=()=>{throw reason;};c.destination.abort=()=>{throw cleanup;};
    const sink=createPositionedReceiver(c.destination);
    if(['ready','writeAt'].includes(stage))await assert.rejects(sink.writeAt(0,new Uint8Array([1])),e=>e===reason);
    else{await sink.writeAt(0,new Uint8Array([1]));await assert.rejects(sink.finish('video/mp4'),e=>e===reason);}
    await sink.settled();assert.equal(sink.state,'failed');assert.equal(sink.stats.aborts,1);assert.equal(sink.stats.cleanupError,cleanup);assert.equal(sink.stats.ownedBytes,0);
});

test('receiver validates limits/positions before destination I/O and supports inclusive boundaries',async()=>{
    const c=controlled(),sink=createPositionedReceiver(c.destination,{maxOutputBytes:8,maxWriteBytes:4});
    for(const position of [-1,NaN,Number.MAX_SAFE_INTEGER])await assert.rejects(sink.writeAt(position,new Uint8Array([1])));
    await assert.rejects(sink.writeAt(0,new Uint8Array(5)),RangeError);assert.equal(c.calls.length,0);
    await sink.writeAt(4,new Uint8Array(4));assert.equal((await sink.finish('video/webm')).size,8);
});

test('file destination rejects a zero-progress short write and removes its temporary output',async t=>{
    const root=await directory(t),sink=createPositionedReceiver(await createFileDestination(join(root,'short.mp4'),{write:async()=>({bytesWritten:0})}));
    await assert.rejects(sink.writeAt(0,new Uint8Array([1])),/no valid progress/);await sink.settled();assert.deepEqual(await readdir(root),[]);assert.equal(sink.stats.ownedBytes,0);
});

test('pre-abort releases an acquired destination without invoking readiness or writing',async()=>{
    const c=controlled(),abort=new AbortController(),reason=new Error('pre-abort');abort.abort(reason);
    const sink=createPositionedReceiver(c.destination,{signal:abort.signal});await assert.rejects(sink.writeAt(0,new Uint8Array([1])),e=>e===reason);await sink.settled();assert.deepEqual(c.calls,[['abort',reason]]);
});

for(const stage of ['truncate','commit'])test('abort during '+stage+' rejects before physical completion and then removes only the owned file',async t=>{
    const root=await directory(t),gate=deferred(),entered=deferred(),reason=new Error(stage+' abort');
    const destination=await createFileDestination(join(root,'abort.mp4'));
    const previous=destination[stage].bind(destination);destination[stage]=async(...args)=>{entered.resolve();await gate.promise;return previous(...args);};
    const sink=createPositionedReceiver(destination);await sink.writeAt(0,new Uint8Array([1,2,3]));const pending=sink.finish('video/mp4');await entered.promise;
    const cleanup=sink.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(sink.stats.commits,0);
    gate.resolve();await cleanup;await sink.settled();assert.deepEqual(await readdir(root),[]);
});

let built;
async function prototype(){built??=(async()=>{const root=resolve('benchmark-results/video-output-study-tests');await buildStudy(root);return import(pathToFileURL(join(root,'external.mjs')).href);})();return built;}
for(const kind of ['mp4','webm'])for(const audio of [false,true])test('real '+kind+(audio?' A/V':' video')+' positioned file matches the unchanged Blob muxer, including header rewrites',async t=>{
    const root=await directory(t),path=join(root,'result.'+kind),input=mediaInput(kind,audio,true);
    const baseline=await storageHarness(kind,{real:true}),expected=await writeInput(baseline,input);
    const sink=createPositionedReceiver(await createFileDestination(path,{write:(h,d,o,n,p)=>h.write(d,o,Math.min(n,71),p)}));
    const {createStudyMuxer}=await prototype(),controller=new AbortController();
    const muxer=await createStudyMuxer(kind,sink).create(input.config,{signal:controller.signal,maxPendingInputs:2,maxPendingBytes:1000000});
    try{for(const event of input.events)await muxer.write(event);const receipt=await muxer.finalize(input.timeline);assert.equal(receipt.size,expected.blob.size);assert.ok((await readFile(path)).equals(Buffer.from(await expected.blob.arrayBuffer())));assert.ok(sink.stats.rewrites>0);assert.equal(sink.stats.commits,1);}finally{muxer.dispose();await sink.settled();}
    assert.deepEqual(await readdir(root),['result.'+kind]);
});

for(const kind of ['mp4','webm'])test(kind+' real muxer waits for slow receiver and removes a failed/cancelled file before retry',async t=>{
    const root=await directory(t),{createStudyMuxer}=await prototype(),input=mediaInput(kind,false,true),gate=deferred(),entered=deferred(),abort=new AbortController();
    const sink=createPositionedReceiver(await createFileDestination(join(root,'cancel.'+kind),{beforeWrite:async()=>{entered.resolve();await gate.promise;}}),{signal:abort.signal});
    const first=await createStudyMuxer(kind,sink).create(input.config,{signal:abort.signal,maxPendingInputs:2,maxPendingBytes:1000000});
    const pending=(async()=>{for(const event of input.events)await first.write(event);return first.finalize(input.timeline);})();void pending.catch(()=>{});
    try{
        await entered.promise;let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});await new Promise(r=>setTimeout(r,10));assert.equal(settled,false);
        const reason=new Error('cancel pending I/O');abort.abort(reason);gate.resolve();await assert.rejects(pending,e=>e===reason);
    }finally{gate.resolve();first.dispose();await sink.settled();}
    assert.deepEqual(await readdir(root),[]);
    const retry=createPositionedReceiver(await createFileDestination(join(root,'retry.'+kind)));const muxer=await createStudyMuxer(kind,retry).create(input.config,{signal:new AbortController().signal,maxPendingInputs:2,maxPendingBytes:1000000});
    try{for(const event of input.events)await muxer.write(event);await muxer.finalize(input.timeline);}finally{muxer.dispose();await retry.settled();}assert.equal(retry.state,'committed');
});

for(const kind of ['mp4','webm'])for(const stage of ['write','commit','limit'])test(kind+' releases its owned file after '+stage+' failure without a successful receipt',async t=>{
    const root=await directory(t),reason=new Error(stage),input=mediaInput(kind,false,true),{createStudyMuxer}=await prototype();
    const destination=await createFileDestination(join(root,'failed.'+kind),{...(stage==='write'?{beforeWrite:()=>{throw reason;}}:{}),...(stage==='commit'?{beforeCommit:()=>{throw reason;}}:{})});
    const sink=createPositionedReceiver(destination);let muxer;
    await assert.rejects(async()=>{
        try{muxer=await createStudyMuxer(kind,sink).create(input.config,{signal:new AbortController().signal,maxPendingInputs:2,maxPendingBytes:1000000,...(stage==='limit'?{maxOutputBytes:4}:{})});for(const event of input.events)await muxer.write(event);await muxer.finalize(input.timeline);}
        finally{muxer?.dispose();await sink.settled();}
    },stage==='limit'?/maxOutputBytes/:e=>e===reason);
    assert.equal(sink.stats.commits,0);assert.equal(sink.stats.ownedBytes,0);assert.deepEqual(await readdir(root),[]);
});

for(const kind of ['mp4','webm'])test(kind+' cannot silently use an append-only destination for the current container layout',async()=>{
    const {createStudyMuxer}=await prototype(),input=mediaInput(kind,false,true),reason=new Error('append-only cannot seek');let end=0,aborted=0;
    const sink=createPositionedReceiver({writeAt(position,data){if(position!==end)throw reason;end+=data.length;},truncate(){},commit(){throw Error('Unexpected commit');},abort(){aborted++;}});let muxer;
    await assert.rejects(async()=>{try{muxer=await createStudyMuxer(kind,sink).create(input.config,{signal:new AbortController().signal,maxPendingInputs:2,maxPendingBytes:1000000});for(const event of input.events)await muxer.write(event);await muxer.finalize(input.timeline);}finally{muxer?.dispose();await sink.settled();}},e=>e===reason);
    assert.equal(aborted,1);assert.equal(sink.stats.commits,0);
});
