import test from 'node:test';
import assert from 'node:assert/strict';
import {createExternalVideoExporter as create} from '../dist/internal/video-external.js';
import {createOfflineVideoExporter as createBlob} from '../dist/video.js';
import {fixtures,canvas,deferred,turn} from './fixtures/video-external.mjs';
const pending=async promise=>{let done=false;void promise.then(()=>{done=true;},()=>{done=true;});await turn();assert.equal(done,false);};
const frame=async exporter=>{await exporter.ready;await exporter.addFrame(canvas(),{timestampUs:0,durationUs:1000});};
const clean=a=>{assert.ok(a.stats.resources.every(r=>r.disposals===1),JSON.stringify(a.stats.resources.map(r=>[r.name,r.disposals])));assert.ok(a.stats.transactions.every(t=>t.releases===1));assert.equal(a.stats.physical,0);};

test('P1/P2: private import does not change Blob API; incompatible factories reject before acquisition',async()=>{
    const a=fixtures();for(const extra of [{muxer:{...a.muxer,outputKind:'blob'}},{destination:new WritableStream()},{ifExists:'append'},{muxer:{...a.muxer,format:{mimeType:'video/webm',extension:'mp4'}}}])assert.throws(()=>create(a.options(extra)));
    assert.deepEqual(a.stats.trace,[]);assert.equal(typeof createBlob,'function');
    await assert.rejects(import('@grundyjs/canvas-take/internal/video-external.js'),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
});

test('P4: pre-abort preserves null/0 and synchronous validation acquires nothing',()=>{
    for(const reason of [null,0,new Error('before')]){const a=fixtures(),abort=new AbortController();abort.abort(reason);assert.throws(()=>create(a.options({signal:abort.signal})),error=>error===reason);assert.deepEqual(a.stats.trace,[]);}
    const a=fixtures();for(const extra of [{maxFrames:0},{background:[-1,0,0]},{audio:{...a.withAudio(1),source:{sampleRate:1000,channels:[new Float32Array([NaN])]}}}])assert.throws(()=>create(a.options(extra)));assert.deepEqual(a.stats.trace,[]);
});

test('P5/P6: synchronous handle, stable ready/closed, all preflights before destination creation',async()=>{
    const gate=deferred(),a=fixtures({videoSupport:()=>gate.promise}),e=create(a.options({audio:a.withAudio(1)}));
    assert.equal(e.state,'initializing');assert.equal(e.outputPhase,'waiting');assert.equal(e.ready,e.ready);assert.equal(e.closed,e.closed);assert.deepEqual(a.stats.trace,[]);
    await assert.rejects(e.addFrame(canvas(),{timestampUs:0,durationUs:1}),/initializing/);await assert.rejects(e.finish(),/initializing/);await pending(e.ready);
    gate.resolve({supported:true});await e.ready;assert.deepEqual(a.stats.trace.slice(0,5),['video.support','audio.support','muxer.support','destination.support','destination.create']);
    assert.equal(a.stats.request.ifExists,'error');assert.equal(a.stats.request.maxWriteBytes,16*1024*1024);assert.equal(a.stats.contexts.video.maxPendingInputs,4);
    e.dispose();assert.equal((await e.closed).publication,'not-committed');clean(a);
});

for(const stage of ['videoSupport','muxerSupport','destinationSupport'])test('P6: unsupported '+stage+' does not create a target',async()=>{
    const a=fixtures({[stage]:()=>({supported:false,reason:'no capability'})}),e=create(a.options());await assert.rejects(e.ready,/unsupported/);await e.closed;assert.equal(a.stats.transactions.length,0);assert.equal(a.stats.resources.length,0);
});

for(const kind of ['Destination','Muxer','Video','Audio'])test('P7: cancelled late '+kind+' acquisition is fenced and disposed once',async()=>{
    const gate=deferred(),entered=deferred(),abort=new AbortController(),reason=new Error('late '+kind);
    const a=fixtures({['acquire'+kind]:async resource=>{entered.resolve();await gate.promise;return resource;}}),e=create(a.options({signal:abort.signal,...(kind==='Audio'?{audio:a.withAudio(1)}:{})}));
    await entered.promise;abort.abort(reason);await assert.rejects(e.ready,error=>error===reason);await pending(e.closed);
    gate.resolve();const closed=await e.closed;assert.equal(closed.reason,reason);assert.equal(closed.publication,'not-committed');assert.equal(a.stats.events.length,0);clean(a);
});

test('P8: failed acquisition cleans unreturned resources without seizing caller-owned values',async()=>{
    const reason=new Error('factory create failed'),caller={closed:0,close(){this.closed++;}},a=fixtures();
    const original=a.destination.create;a.destination.create=async context=>{const transaction=await original(context);transaction.ownerHandle=caller;await transaction.abort(reason);await transaction.release({publication:'not-committed'});throw reason;};
    const e=create(a.options());await assert.rejects(e.ready,error=>error===reason);await e.closed;assert.equal(caller.closed,0);assert.equal(a.stats.transactions[0].releases,1);
});

test('P9: positioned sink snapshots the exact subview before its first yield',async()=>{
    const gate=deferred(),a=fixtures({ready:()=>gate.promise}),e=create(a.options());await e.ready;
    const input=new Uint8Array([99,1,2,99]),work=a.stats.contexts.muxer.output.writeAt(3,input.subarray(1,3));input.fill(8);gate.resolve();await work;
    assert.deepEqual([...a.stats.borrowed[0]],[1,2]);assert.equal(a.stats.borrowed[0].buffer.byteLength,2);assert.notEqual(a.stats.borrowed[0].buffer,input.buffer);assert.equal(a.stats.contexts.muxer.output.size,5);
    e.dispose();await e.closed;clean(a);
});

test('P9/P23: immediate frame/PCM snapshots and unchanged timeline/progress counters',async()=>{
    const a=fixtures(),audio=a.withAudio(3),source=canvas(),events=[],e=create(a.options({audio,onProgress:p=>events.push(p)}));audio.source.channels[0].fill(0.9);await e.ready;
    const work=e.addFrame(source,{timestampUs:0,durationUs:3000});source.data.fill(9);await work;const result=await e.finish();await e.closed;
    assert.deepEqual([...a.stats.frames[0].data],[1,2,3,255]);assert.ok(a.stats.blocks.every(b=>b.channels[0].every(n=>n===0.25)));
    assert.equal(result.audioPresentationSamples,3);assert.equal(result.durationUs,3000);assert.equal(result.videoFrames,1);assert.equal(events.at(-1).phase,'finished');assert.equal(events.at(-1).audioSamplesAccepted,3);assert.equal(events.at(-1).framesAccepted,1);
    assert.ok(events.filter(p=>p.phase!=='finished').every(p=>!Object.hasOwn(p,'outputBytes')));assert.equal(events.at(-1).outputBytes,result.output.size);clean(a);
});

test('P10: inclusive extents, rewrites and validated empty writes preserve high-water size',async()=>{
    const a=fixtures(),e=create(a.options({maxOutputBytes:8,maxPendingBytes:4}));await e.ready;const sink=a.stats.contexts.muxer.output;
    await sink.writeAt(4,new Uint8Array([1,2,3,4]));await sink.writeAt(0,new Uint8Array([9]));const writes=a.stats.transactions[0].writes;await sink.writeAt(8,new Uint8Array());
    assert.equal(sink.size,8);assert.equal(a.stats.transactions[0].writes,writes);e.dispose();await e.closed;clean(a);
});

for(const [label,position,bytes]of [['negative',-1,1],['overflow',Number.MAX_SAFE_INTEGER,1],['extent',8,1],['write budget',0,5],['empty bound',9,0]])test('P10: '+label+' rejects before physical I/O',async()=>{
    const a=fixtures(),e=create(a.options({maxOutputBytes:8,maxPendingBytes:4}));await e.ready;await assert.rejects(a.stats.contexts.muxer.output.writeAt(position,new Uint8Array(bytes)));await e.closed;assert.equal(a.stats.transactions[0].writes,0);assert.equal(a.stats.transactions[0].commits,0);clean(a);
});

test('P10: backend short-write loop completes and zero-progress failure prevents publication',async()=>{
    const a=fixtures({shortWrite:1}),e=create(a.options());await frame(e);const result=await e.finish();await e.closed;assert.equal(a.store.get('movie').length,result.output.size);clean(a);
    const reason=new Error('no progress'),b=fixtures({shortWrite:0,zeroReason:reason}),f=create(b.options());await assert.rejects(frame(f),error=>error===reason);const closed=await f.closed;assert.equal(closed.reason,reason);assert.equal(b.stats.transactions[0].commits,0);clean(b);
});

test('P11: overlap is terminal, physical I/O remains fenced and late writes never start',async()=>{
    const gate=deferred(),entered=deferred(),a=fixtures({write:async()=>{entered.resolve();await gate.promise;}}),e=create(a.options());await e.ready;const sink=a.stats.contexts.muxer.output;
    const first=sink.writeAt(0,new Uint8Array([1]));void first.catch(()=>{});await entered.promise;await assert.rejects(sink.writeAt(1,new Uint8Array([2])),/overlap/);await assert.rejects(first,/overlap/);await pending(e.closed);
    assert.equal(a.stats.transactions[0].aborts,0);gate.resolve();await e.closed;const count=a.stats.transactions[0].writes;await assert.rejects(sink.writeAt(0,new Uint8Array([3])));assert.equal(a.stats.transactions[0].writes,count);clean(a);
});

for(const stage of ['ready','write','truncate'])test('P12: abort during '+stage+' rejects promptly but closed waits for physical settlement',async()=>{
    for(const reason of [null,0,new Error(stage)]){
        const gate=deferred(),entered=deferred(),abort=new AbortController(),a=fixtures({[stage]:async()=>{entered.resolve();await gate.promise;}}),e=create(a.options({signal:abort.signal}));await e.ready;
        let work;if(stage==='truncate'){await e.addFrame(canvas(),{timestampUs:0,durationUs:1000});work=e.finish();}else work=a.stats.contexts.muxer.output.writeAt(0,new Uint8Array([1,2]));
        void work.catch(()=>{});await entered.promise;abort.abort(reason);await assert.rejects(work,error=>error===reason);await pending(e.closed);assert.equal(a.stats.transactions[0].aborts,0);
        gate.resolve();const closed=await e.closed;assert.equal(closed.reason,reason);assert.equal(closed.publication,'not-committed');assert.equal(a.stats.transactions[0].abortReason,reason);clean(a);
    }
});

test('P13: create-new races publish one winner and never erase an intervening target',async()=>{
    const store=new Map(),a=fixtures({},store),b=fixtures({},store),e=create(a.options()),f=create(b.options());await Promise.all([frame(e),frame(f)]);
    const results=await Promise.allSettled([e.finish(),f.finish()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
    await Promise.all([e.closed,f.closed]);assert.equal(store.size,1);clean(a);clean(b);
    const c=fixtures(),g=create(c.options());await frame(g);c.store.set('movie',new Uint8Array([7,7]));await assert.rejects(g.finish(),/exists/);await g.closed;assert.deepEqual([...c.store.get('movie')],[7,7]);clean(c);
});

test('P14/P16: replace remains private until commit, then survives abort/dispose with no stale tail',async()=>{
    const store=new Map([['movie',new Uint8Array(100).fill(8)]]),gate=deferred(),entered=deferred(),abort=new AbortController(),value={owned:true};
    const a=fixtures({commit:async(t)=>{entered.resolve();await gate.promise;store.set('movie',t.staging.slice());return {status:'committed',value};}},store),e=create(a.options({ifExists:'replace',signal:abort.signal}));await frame(e);
    const finish=e.finish();await entered.promise;assert.equal(e.outputPhase,'committing');assert.equal(store.get('movie').length,100);abort.abort(null);e.dispose();assert.equal(e.state,'finalizing');assert.equal(a.stats.contexts.destination.signal.aborted,false);
    gate.resolve();const result=await finish,closed=await e.closed;assert.equal(result.output.value,value);assert.equal(closed.publication,'committed');assert.equal(store.get('movie').length,result.output.size);assert.equal(a.stats.transactions[0].aborts,0);assert.equal(e.state,'disposed');clean(a);
});

for(const kind of ['missing-end','bad-size','bad-mime','blob','finalize','truncate'])test('P15: '+kind+' failure prevents commit',async()=>{
    const reason=new Error(kind),hooks=kind==='missing-end'?{omitEnd:true}:kind==='finalize'?{finalize(){throw reason;}}:kind==='truncate'?{truncate(){throw reason;}}:{container(ctx){return kind==='blob'?new Blob(['x']):{kind:'external-container',mimeType:kind==='bad-mime'?'video/webm':'video/mp4',size:ctx.output.size+(kind==='bad-size'?1:0)};}};
    const a=fixtures(hooks),e=create(a.options());await frame(e);await assert.rejects(e.finish());const closed=await e.closed;assert.equal(closed.publication,'not-committed');assert.equal(a.stats.transactions[0].commits,0);assert.equal(a.stats.transactions[0].aborts,1);clean(a);
});

test('P16/P22: synchronous commit-phase observer cancellation cannot overtake admission',async()=>{
    const abort=new AbortController(),a=fixtures();let e,reentrant;
    e=create(a.options({signal:abort.signal,onProgress(p){if(p.phase==='finalizing'&&e.outputPhase==='committing'){reentrant=e.finish();abort.abort(new Error('too late'));e.dispose();}}}));await frame(e);const finish=e.finish();const result=await finish;
    assert.equal(reentrant,finish);assert.equal(e.finish(),finish);assert.equal(result.output.size,a.store.get('movie').length);await e.closed;assert.equal(a.stats.transactions[0].commits,1);assert.equal(a.stats.transactions[0].aborts,0);clean(a);
});

for(const value of [null,false,0,undefined])test('P17: committed '+String(value)+' is not treated as a missing value',async()=>{
    const a=fixtures({value}),e=create(a.options());await frame(e);const result=await e.finish();await e.closed;assert.equal(result.output.value,value);assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(result.output));assert.equal('blob'in result,false);e.dispose();assert.ok(a.store.has('movie'));clean(a);
});

test('P17: opaque caller value is not frozen, closed or deleted by session disposal',async()=>{
    const value={closed:0,close(){this.closed++;}},a=fixtures({value}),e=create(a.options());await frame(e);const result=await e.finish();e.dispose();await e.closed;assert.equal(result.output.value,value);assert.equal(Object.isFrozen(value),false);assert.equal(value.closed,0);assert.ok(a.store.has('movie'));clean(a);
});

test('P18: refusal keeps its exact reason despite abort/release failures',async()=>{
    for(const reason of [null,0,new Error('refused')]){
        const cleanup=new Error('cleanup'),a=fixtures({commit:()=>({status:'not-committed',reason}),abort(){throw cleanup;},release(){throw cleanup;}}),e=create(a.options());await frame(e);const finish=e.finish();await assert.rejects(finish,error=>error===reason);assert.equal(e.finish(),finish);
        const closed=await e.closed;assert.equal(closed.reason,reason);assert.equal(closed.publication,'not-committed');assert.deepEqual(closed.cleanupIssues.map(i=>i.operation),['destination.abort','destination.release']);clean(a);
    }
});

for(const mode of ['explicit','throw','throw-null','malformed','missing-value','live-writer'])test('P19: '+mode+' commit is indeterminate and never rolls back published data',async()=>{
    const reason=new Error('unknown'),recovery={id:1},a=fixtures({commit(t,context,store,name){store.set(name,t.staging.slice());if(mode==='explicit')return {status:'indeterminate',reason,recovery};if(mode==='throw')throw reason;if(mode==='throw-null')throw null;if(mode==='malformed')return {};if(mode==='live-writer')return {status:'committed',value:t};return {status:'committed'};}}),e=create(a.options());await frame(e);await assert.rejects(e.finish());
    const closed=await e.closed;assert.equal(closed.publication,'indeterminate');if(mode==='explicit')assert.equal(closed.recovery,recovery);assert.equal(a.stats.transactions[0].aborts,0);assert.deepEqual(a.stats.transactions[0].releaseContext,{publication:'indeterminate'});assert.ok(a.store.has('movie'));clean(a);
});

test('P20/P23: cleanup failure after publication cannot reject finish or emit a failed result',async()=>{
    const reason=new Error('release failed'),progress=[],a=fixtures({release(){throw reason;},dispose(){throw reason;}}),e=create(a.options({onProgress:p=>progress.push(p.phase)}));await frame(e);const result=await e.finish(),closed=await e.closed;
    assert.equal(closed.publication,'committed');assert.equal(closed.output,result.output);assert.equal(closed.cleanupIssues.length,3);assert.equal(a.stats.transactions[0].aborts,0);assert.equal(progress.at(-1),'finished');assert.equal(progress.includes('failed'),false);assert.ok(Object.isFrozen(closed.cleanupIssues));clean(a);
});

test('P21: closed waits for asynchronous encoder disposal and destination release',async()=>{
    const disposeGate=deferred(),releaseGate=deferred(),entered=deferred(),a=fixtures({dispose:name=>name==='video'?disposeGate.promise:undefined,release:async()=>{entered.resolve();await releaseGate.promise;}}),e=create(a.options());await frame(e);await e.finish();await pending(e.closed);assert.equal(a.stats.transactions[0].releases,0);
    disposeGate.resolve();await entered.promise;await pending(e.closed);releaseGate.resolve();await e.closed;clean(a);
});

test('P22: invalid concurrency rejects only that call and accepted finish identity is stable',async()=>{
    const gate=deferred(),entered=deferred(),a=fixtures({frame:async()=>{entered.resolve();await gate.promise;}}),e=create(a.options());await e.ready;const adding=e.addFrame(canvas(),{timestampUs:0,durationUs:1000});await entered.promise;
    await assert.rejects(e.finish(),/encoding/);await assert.rejects(e.addFrame(canvas(),{timestampUs:1000,durationUs:1000}),/encoding/);assert.equal(e.state,'encoding');gate.resolve();await adding;
    const finish=e.finish();assert.equal(e.finish(),finish);const result=await finish;assert.equal(await e.finish(),result);await e.closed;clean(a);
});

test('P22: rejected accepted finish is cached and dispose before init creates no resources',async()=>{
    const a=fixtures(),e=create(a.options());await e.ready;const finish=e.finish();await assert.rejects(finish,/at least one/);assert.equal(e.finish(),finish);await e.closed;clean(a);
    const b=fixtures(),f=create(b.options());f.dispose();await assert.rejects(f.ready,/disposed/);await f.closed;assert.deepEqual(b.stats.trace,[]);
});

test('P3: controlled WebM factory retains exact format and opaque result identity',async()=>{
    const value={id:'webm'},a=fixtures({value});a.muxer.format={mimeType:'video/webm',extension:'webm'};const e=create(a.options());await frame(e);const result=await e.finish();await e.closed;
    assert.equal(result.mimeType,'video/webm');assert.equal(result.extension,'webm');assert.equal(result.output.mimeType,'video/webm');assert.equal(result.output.value,value);clean(a);
});

test('P8: malformed acquired instances release available owned resources once',async()=>{
    for(const kind of ['Destination','Muxer']){
        const a=fixtures({['acquire'+kind]:resource=>{delete resource[kind==='Destination'?'writeAt':'finalize'];return resource;}}),e=create(a.options());await assert.rejects(e.ready,/missing methods/);await e.closed;clean(a);
    }
});

test('P8: reusing another live session transaction does not seize its ownership',async()=>{
    const a=fixtures(),e=create(a.options());await e.ready;const b=fixtures();b.destination.create=()=>a.stats.transactions[0];const f=create(b.options());await assert.rejects(f.ready,/fresh transaction/);await f.closed;
    assert.equal(a.stats.transactions[0].releases,0);assert.equal(a.stats.transactions[0].aborts,0);await e.addFrame(canvas(),{timestampUs:0,durationUs:1000});await e.finish();await e.closed;clean(a);
});

test('P9: overridden typed-array slice cannot alias PCM or positioned snapshots',async()=>{
    const a=fixtures(),audio=a.withAudio(1),pcm=audio.source.channels[0];pcm.slice=()=>pcm;
    const e=create(a.options({audio}));pcm.fill(0.75);await e.ready;const input=new Uint8Array([1,2]);input.slice=()=>input;const work=a.stats.contexts.muxer.output.writeAt(0,input);input.fill(8);await work;
    assert.deepEqual([...a.stats.borrowed[0]],[1,2]);await e.addFrame(canvas(),{timestampUs:0,durationUs:1000});await e.finish();await e.closed;assert.equal(a.stats.blocks[0].channels[0][0],0.25);clean(a);
});

test('P10: shared and detached empty views reject before destination I/O',async()=>{
    const detached=new Uint8Array(2);structuredClone(detached.buffer,{transfer:[detached.buffer]});
    for(const input of [detached,new Uint8Array(new SharedArrayBuffer(2))]){
        const a=fixtures(),e=create(a.options());await e.ready;await assert.rejects(a.stats.contexts.muxer.output.writeAt(0,input));await e.closed;assert.equal(a.stats.transactions[0].writes,0);clean(a);
    }
});

test('P15: accepted unfinished writes drain before truncate and commit',async()=>{
    const gate=deferred(),entered=deferred();let blocking=false;
    const a=fixtures({ready:async()=>{if(blocking){entered.resolve();await gate.promise;}},finalizeResult(context){blocking=true;void context.output.writeAt(5,new Uint8Array([7])).catch(()=>{});return {kind:'external-container',mimeType:'video/mp4',size:6};}}),e=create(a.options());await frame(e);const work=e.finish();await entered.promise;await pending(work);assert.equal(a.stats.transactions[0].commits,0);
    gate.resolve();const result=await work;await e.closed;assert.equal(result.output.size,6);assert.equal(a.store.get('movie')[5],7);clean(a);
});

test('P11/P15: a write admitted after muxer finalize is rejected and prevents commit',async()=>{
    const gate=deferred(),entered=deferred();let blocking=false;
    const a=fixtures({ready:async()=>{if(blocking){entered.resolve();await gate.promise;}},finalizeResult(context){blocking=true;void context.output.writeAt(5,new Uint8Array([7])).catch(()=>{});return {kind:'external-container',mimeType:'video/mp4',size:6};}}),e=create(a.options());await frame(e);const work=e.finish();void work.catch(()=>{});await entered.promise;await turn();
    await assert.rejects(a.stats.contexts.muxer.output.writeAt(7,new Uint8Array([8])),/sealed/);gate.resolve();await assert.rejects(work,/sealed/);await e.closed;assert.equal(a.stats.transactions[0].commits,0);clean(a);
});

for(const field of ['status','reason','recovery','value'])test('P19: throwing '+field+' getter keeps commit conservatively indeterminate',async()=>{
    const reason=new Error('getter '+field),a=fixtures({commit(){const result={status:field==='value'?'committed':field==='recovery'?'indeterminate':'not-committed',reason:null,value:{}};Object.defineProperty(result,field,{get(){throw reason;},enumerable:true});return result;}}),e=create(a.options());await frame(e);await assert.rejects(e.finish(),error=>error===reason);const closed=await e.closed;
    assert.equal(closed.publication,'indeterminate');assert.equal(closed.reason,reason);assert.equal(a.stats.transactions[0].aborts,0);assert.equal(a.stats.transactions[0].releaseContext.publication,'indeterminate');clean(a);
});

test('P21: cancellation waits for non-cooperative encoder work before releasing destination',async()=>{
    const gate=deferred(),entered=deferred(),abort=new AbortController(),reason=new Error('cancel encoder');
    const a=fixtures({frame:async()=>{entered.resolve();await gate.promise;}}),e=create(a.options({signal:abort.signal}));await e.ready;const work=e.addFrame(canvas(),{timestampUs:0,durationUs:1000});void work.catch(()=>{});await entered.promise;abort.abort(reason);await assert.rejects(work,error=>error===reason);await pending(e.closed);
    assert.equal(a.stats.transactions[0].releases,0);gate.resolve();await e.closed;assert.equal(a.stats.events.length,0);clean(a);
});

test('P21: a late resource disposal error remains secondary to acquisition cancellation',async()=>{
    const gate=deferred(),entered=deferred(),abort=new AbortController(),reason=new Error('cancel acquire'),cleanup=new Error('late dispose');
    const a=fixtures({acquireVideo:async resource=>{entered.resolve();await gate.promise;return resource;},dispose(name){if(name==='video')throw cleanup;}}),e=create(a.options({signal:abort.signal}));await entered.promise;abort.abort(reason);await assert.rejects(e.ready,error=>error===reason);gate.resolve();const closed=await e.closed;
    assert.equal(closed.reason,reason);assert.ok(closed.cleanupIssues.some(issue=>issue.operation==='encoder.dispose'&&issue.reason===cleanup));clean(a);
});

test('P23: output phases expose publication then settling; observer exceptions cannot change success',async()=>{
    const gate=deferred(),a=fixtures({release:()=>gate.promise}),phases=[];let e;
    e=create(a.options({onProgress(progress){phases.push([progress.phase,e.outputPhase]);throw new Error('observer');}}));await frame(e);const result=await e.finish();assert.equal(e.outputPhase,'settling');gate.resolve();await e.closed;assert.equal(e.outputPhase,'settled');
    assert.ok(phases.some(([phase,output])=>phase==='finalizing'&&output==='committing'));assert.equal(phases.at(-1)[0],'finished');assert.equal(result.videoFrames,1);clean(a);
});

test('P15: ignored asynchronous write rejection still fails the session without an unhandled rejection',async()=>{
    const reason=new Error('unawaited sink failed'),a=fixtures({write(t,position){if(position===5)throw reason;},finalizeResult(context){void context.output.writeAt(5,new Uint8Array([7]));return {kind:'external-container',mimeType:'video/mp4',size:6};}}),e=create(a.options());await frame(e);await assert.rejects(e.finish(),error=>error===reason);await e.closed;await turn();assert.equal(a.stats.transactions[0].commits,0);clean(a);
});

test('P16: cancellation from the final truncate hook wins before commit admission',async()=>{
    const abort=new AbortController(),reason=new Error('last pre-commit cancellation'),a=fixtures({truncate(){abort.abort(reason);}}),e=create(a.options({signal:abort.signal}));await frame(e);await assert.rejects(e.finish(),error=>error===reason);await e.closed;assert.equal(a.stats.transactions[0].commits,0);clean(a);
});

test('P14/P18: aborted or refused replacement preserves the previous published target',async()=>{
    for(const mode of ['abort','truncate','refuse']){
        const store=new Map([['movie',new Uint8Array([8,8,8,8,8,8,8,8])]]),reason=new Error(mode);
        const a=fixtures(mode==='truncate'?{truncate(){throw reason;}}:mode==='refuse'?{commit:()=>({status:'not-committed',reason})}:{},store),e=create(a.options({ifExists:'replace'}));await frame(e);
        if(mode==='abort')e.dispose();else await assert.rejects(e.finish());await e.closed;assert.deepEqual([...store.get('movie')],[8,8,8,8,8,8,8,8]);clean(a);
    }
});

test('P21: closed waits for staging abort before invoking release',async()=>{
    const gate=deferred(),entered=deferred(),a=fixtures({abort:async()=>{entered.resolve();await gate.promise;}}),e=create(a.options());await e.ready;e.dispose();await entered.promise;await pending(e.closed);assert.equal(a.stats.transactions[0].releases,0);gate.resolve();await e.closed;clean(a);
});

test('P6: malformed support responses reject ready without acquisition',async()=>{
    for(const answer of [null,{}, {supported:'yes'}, {supported:false}]){
        const a=fixtures();a.destination.checkSupport=()=>answer;const e=create(a.options());await assert.rejects(e.ready,/invalid support/);await e.closed;assert.equal(a.stats.transactions.length,0);
    }
});

test('P15/P23: variable video intervals, final hold and exact audio sample timeline remain intact',async()=>{
    const a=fixtures(),progress=[],e=create(a.options({audio:a.withAudio(767),onProgress:p=>progress.push(p)}));await e.ready;let timestampUs=0;
    for(const durationUs of [33333,33334,700001]){await e.addFrame(canvas(),{timestampUs,durationUs});timestampUs+=durationUs;}
    const result=await e.finish();await e.closed;assert.equal(result.durationUs,766668);assert.equal(result.audioPresentationSamples,767);assert.deepEqual(a.stats.frames.map(f=>[f.timestampUs,f.durationUs]),[[0,33333],[33333,33334],[66667,700001]]);
    const last=progress.at(-1);assert.equal(last.framesAccepted,3);assert.equal(last.videoPacketsWritten,3);assert.equal(last.audioSamplesAccepted,767);assert.equal(last.encodedBytes,6);clean(a);
});

test('P15: controlled leading/trailing discard is validated; incorrect audio end cannot publish',async()=>{
    const a=fixtures({leading:3,trailing:4}),e=create(a.options({audio:a.withAudio(10)}));await e.ready;await e.addFrame(canvas(),{timestampUs:0,durationUs:10000});const result=await e.finish();await e.closed;assert.equal(result.audioPresentationSamples,10);clean(a);
    for(const change of [{presentationSamples:11},{leadingDiscardSamples:1},{trailingDiscardSamples:2}]){
        const b=fixtures({audioEnd:end=>({...end,...change})}),f=create(b.options({audio:b.withAudio(10)}));await f.ready;await f.addFrame(canvas(),{timestampUs:0,durationUs:10000});await assert.rejects(f.finish(),/audio|encoder|protocol/);await f.closed;assert.equal(b.stats.transactions[0].commits,0);clean(b);
    }
});

test('P15: invalid input intervals and codec packets never reach publication',async()=>{
    for(const timing of [{timestampUs:1,durationUs:1},{timestampUs:0,durationUs:0},{timestampUs:0,durationUs:NaN}]){
        const a=fixtures(),e=create(a.options());await e.ready;let reads=0;const source=canvas();source.getContext=()=>{reads++;throw new Error('unexpected capture');};await assert.rejects(e.addFrame(source,timing));await e.closed;assert.equal(reads,0);assert.equal(a.stats.transactions[0].commits,0);clean(a);
    }
    for(const patch of [{timestampUs:5},{decodeTimestampUs:5},{durationUs:2},{type:'delta'}]){
        const a=fixtures({event:event=>({...event,packet:{...event.packet,...patch}})}),e=create(a.options());await assert.rejects(frame(e));await e.closed;assert.equal(a.stats.transactions[0].commits,0);clean(a);
    }
});
