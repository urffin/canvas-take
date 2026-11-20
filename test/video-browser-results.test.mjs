import test from 'node:test';
import assert from 'node:assert/strict';
import {backend,deferred,turn,request,stage,publish,superseded,deletion} from './fixtures/video-browser-results.mjs';
import {createExternalVideoExporter} from '../dist/internal/video-external.js';
import {fixtures,canvas} from './fixtures/video-external.mjs';
const reason=async(promise,value)=>{let caught=false;try{await promise;}catch(e){caught=true;assert.equal(e,value);}assert.ok(caught,'Expected rejection with exact reason');};
const code=(outcome,expected)=>{assert.equal(outcome.status,'blocked');assert.equal(outcome.code,expected);};
const bytes=async lease=>[...new Uint8Array(await lease.file.arrayBuffer())];
const close=async(b,...stores)=>{for(const s of stores)assert.equal((await s.close()).status,'closed');b.idle();};
const at=b=>structuredClone(b.state);
const pending=async promise=>{let settled=false;void promise.then(()=>settled=true,()=>settled=true);await turn();assert.equal(settled,false);};

test('B1: managed import is SSR-safe/private and rejects legacy schema without adoption',async()=>{
 for(const path of ['internal/video-browser-results.js','internal/video-browser-results-types.js','internal/video-browser-results-ports.js','video/browser-results'])await assert.rejects(import('@grundyjs/canvas-take/'+path),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
 const b=backend();b.state.scope.schema=1;const before=at(b);await assert.rejects(b.open());assert.deepEqual(b.state,before);b.idle();
});
test('B2: repeated preflight is readonly and unsupported ports never fall back',async()=>{
 const b=backend(),s=await b.open(),before=at(b),trace=b.stats.trace.length;
 for(let i=0;i<3;i++)assert.equal((await s.checkSupport()).supported,true);
 assert.deepEqual(b.state,before);assert.equal(b.stats.lockRequests,0);assert.ok(b.stats.trace.slice(trace).every(p=>p.startsWith('metadata.read')));
 b.locks.sharedExclusive=false;assert.equal((await s.checkSupport()).supported,false);b.locks.sharedExclusive=true;
 b.objects.positioned=false;assert.equal((await s.checkSupport()).supported,false);b.objects.positioned=true;await close(b,s);
});
test('B3/B4: binding precedes acquisition and publication atomically retains its original version',async()=>{
 const b=backend(),s=await b.open(),item=await publish(s),original=item.value;
 assert.equal(original.key.attemptId,item.binding.key.attemptId);assert.ok(Object.isFrozen(original));assert.ok(Object.isFrozen(original.key));assert.equal(original.path,undefined);
 assert.equal((await s.inspectHold(item.binding.ownerHold)).status,'active');assert.equal(b.state.versions.size,1);assert.equal(b.state.names.get('movie.mp4'),original.key.attemptId);
 await publish(s,{ifExists:'replace',bytes:new Uint8Array([9])});assert.notEqual((await s.lookup('movie.mp4')).key.attemptId,original.key.attemptId);
 const file=await s.acquireFile(original.key);assert.equal(file.status,'available');assert.deepEqual(await bytes(file.value),[1,2,3]);assert.equal(file.value.file.name,'movie.mp4');assert.equal(file.value.file.type,'video/mp4');await file.value.release();await close(b,s);
});
test('B3/B13/B25: owner holds survive replacement and connection close/reopen',async()=>{
 const b=backend(),s=await b.open(),first=await superseded(s);await close(b,s);
 const reopened=await b.open();assert.equal((await reopened.inspectHold(first.binding.ownerHold)).status,'active');code(await reopened.deleteVersion(first.binding.key,{expectedRevision:(await reopened.inspectVersion(first.binding.key)).revision}),'retained');
 const access=await reopened.acquireFile(first.binding.key);assert.deepEqual(await bytes(access.value),[1,2,3]);await access.value.release();await close(b,reopened);
});
test('B5: missing or changed bytes never become a fabricated original File',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),v=b.state.versions.get(a.binding.key.attemptId),entry=b.files.get(v.objectId);
 entry.bytes=new Uint8Array([1]);assert.equal((await s.acquireFile(a.binding.key)).code,'changed');b.files.delete(v.objectId);assert.equal((await s.acquireFile(a.binding.key)).code,'missing');assert.equal(b.stats.locks,0);await close(b,s);
});
test('B6/B7: shared read ownership blocks cross-connection deletion and busy close is reversible',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),first=await superseded(s);await s.releaseHold(first.binding.ownerHold);
 const access=await s.acquireFile(first.binding.key),lease=access.value;assert.equal((await s.close()).status,'busy');
 code(await other.deleteVersion(first.binding.key,{expectedRevision:(await other.inspectVersion(first.binding.key)).revision}),'busy');assert.deepEqual(await bytes(lease),[1,2,3]);
 const p=lease.release();assert.equal(lease.release(),p);await p;await lease.closed;assert.equal(lease.state,'released');assert.equal((await deletion(other,first)).status,'deleted');await close(b,s,other);
});
test('B7: pending acquisition prevents close before it hands off an owning lease',async()=>{
 const b=backend(),s=await b.open(),first=await publish(s),g=b.gate('object.read'),work=s.acquireFile(first.binding.key);await g.entered;
 assert.equal((await s.close()).status,'busy');g.release();const access=await work;assert.equal(access.status,'available');assert.equal((await s.close()).status,'busy');await access.value.release();await close(b,s);
});
for(const value of [null,0,Error('cancelled')])test('B8: pre-abort preserves exact reason '+String(value),async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),abort=new AbortController(),n=b.stats.lockRequests;abort.abort(value);
 await reason(s.acquireFile(a.binding.key,{signal:abort.signal}),value);await reason(s.prepareDownload(a.binding.key,{signal:abort.signal}),value);assert.equal(b.stats.lockRequests,n);assert.equal(b.stats.urls,0);await close(b,s);
});
test('B8: abort after native read starts releases the unhanded lease',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),abort=new AbortController(),g=b.gate('object.read'),p=s.acquireFile(a.binding.key,{signal:abort.signal});await g.entered;abort.abort(0);g.release();await reason(p,0);assert.equal(b.stats.locks,0);assert.equal(s.stats.readers,0);await close(b,s);
});
test('B9/B10/B11: download owns a distinct lease and only reports a synchronous request',async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s),read=await s.acquireFile(a.binding.key),download=await s.prepareDownload(a.binding.key,{fileName:'short.mp4'});
 assert.equal(download.status,'available');const d=download.value;assert.equal(s.stats.readers,2);assert.equal(b.stats.urls,1);await read.value.release();assert.equal(s.stats.readers,1);
 b.ui.activation=false;assert.throws(()=>d.request(),e=>e.name==='InvalidStateError');assert.equal(d.state,'prepared');b.ui.activation=true;
 const result=d.request();assert.deepEqual(result,{status:'requested',completion:'unobservable'});assert.equal(result.then,undefined);assert.equal(result.path,undefined);assert.equal(b.stats.requests.length,1);assert.throws(()=>d.request());
 await turn();assert.equal(b.stats.urls,1);assert.equal((await deletion(s,a)).code,'busy');const p=d.dispose();assert.equal(d.dispose(),p);await p;await d.closed;assert.equal(d.state,'disposed');assert.equal(b.stats.urls,0);assert.equal((await deletion(s,a)).status,'deleted');await close(b,s);
});
test('B10: uncertain UI dispatch is one-shot without a false saved acknowledgement',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),d=(await s.prepareDownload(a.binding.key)).value,e=Error('UI dispatch');b.syncFaults.set('ui.request',e);assert.throws(()=>d.request(),x=>x===e);assert.equal(d.state,'requested');assert.throws(()=>d.request());await d.dispose();await close(b,s);
});
test('B11/B28: failed URL revocation keeps its lease and can be explicitly retried',async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s),d=(await s.prepareDownload(a.binding.key)).value,e=Error('revoke');b.syncFaults.set('ui.revoke',e);await reason(d.dispose(),e);assert.equal(b.stats.urls,1);assert.equal(s.stats.downloads,1);await pending(d.closed);assert.equal((await s.close()).status,'busy');await d.dispose();assert.equal(b.stats.urls,0);assert.equal(s.stats.readers,0);await close(b,s);
});
test('B12: filenames and missing document reject before allocating download resources',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),n=b.stats.lockRequests;
 for(const fileName of ['', '../x.mp4','x\\x.mp4','x.webm','x\0.mp4','..mp4','x:foo.mp4','x'.repeat(101)+'.mp4'])code(await s.prepareDownload(a.binding.key,{fileName}),'invalid-filename');assert.equal(b.stats.lockRequests,n);assert.equal(b.stats.urls,0);
 b.ui.enabled=false;code(await s.prepareDownload(a.binding.key),'document-required');await close(b,s);
});
test('B13/B14/B15: selected and explicitly retained results cannot be removed',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s);await s.releaseHold(a.binding.ownerHold);code(await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision}),'selected');
 const hold=s.makeHoldKey(a.binding.key);assert.equal((await s.retain(hold)).status,'active');await publish(s,{ifExists:'replace'});code(await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision}),'retained');await s.releaseHold(hold);assert.equal((await deletion(s,a)).status,'deleted');await close(b,s);
});
test('B14: idempotent hold identities cannot resurrect after release, including delayed retain',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),h=s.makeHoldKey(a.binding.key);await s.retain(h);const rev=(await s.inspectVersion(a.binding.key)).revision;await s.retain(h);assert.equal((await s.inspectVersion(a.binding.key)).revision,rev);
 await s.releaseHold(h);const r=(await s.inspectVersion(a.binding.key)).revision;await s.releaseHold(h);assert.equal((await s.inspectVersion(a.binding.key)).revision,r);code(await s.retain(h),'retired-hold');
 const before=s.makeHoldKey(a.binding.key);await s.releaseHold(before);code(await s.retain(before),'retired-hold');code(await s.retain(a.binding.ownerHold),'foreign-key');await close(b,s);
});
test('B14: commit-owner hold cannot be released before definitive publication',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s);code(await s.releaseHold(a.binding.ownerHold),'uncertain');assert.equal((await a.transaction.commit()).status,'committed');await a.transaction.release({publication:'committed'});assert.equal((await s.inspectHold(a.binding.ownerHold)).status,'active');await close(b,s);
});
for(const operation of ['retain','releaseHold'])test('B14/B28: lost '+operation+' acknowledgement retains its caller-known identity',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),h=s.makeHoldKey(a.binding.key);if(operation==='releaseHold')await s.retain(h);const e=b.fail('tx.ack:hold.'+(operation==='retain'?'retain':'release'));const result=await s[operation](h);assert.equal(result.status,'indeterminate');assert.equal(result.reason,e);const state=operation==='retain'?'active':'released';assert.equal((await s.inspectHold(h)).status,state);assert.equal((await s[operation](h)).status,state);await close(b,s);
});
test('B15/B18: stale revisions and force/TTL options cannot authorize deletion',async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);const old=await s.inspectVersion(a.binding.key),hold=s.makeHoldKey(a.binding.key);await s.retain(hold);await s.releaseHold(hold);code(await s.deleteVersion(a.binding.key,{expectedRevision:old.revision}),'stale-revision');
 code(await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision,force:true}),'unsupported');await assert.rejects(s.scanVersions({ttlMs:0}));assert.equal(b.stats.removes,0);await close(b,s);
});
for(const point of ['tx.commit:version.deleting','tx.ack:version.deleting','object.remove.before','object.remove.after','tx.commit:version.deleted','tx.ack:version.deleted'])test('B16/B27/B28: deletion fault resumes without changing publication history at '+point,async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);const revision=(await s.inspectVersion(a.binding.key)).revision,e=b.fail(point),result=await s.deleteVersion(a.binding.key,{expectedRevision:revision});assert.equal(result.status,'indeterminate');assert.equal(result.reason,e);
 const after=await s.inspectVersion(a.binding.key),retry=await s.deleteVersion(a.binding.key,{expectedRevision:after.revision});assert.ok(['deleted','already-deleted'].includes(retry.status));const recovered=await s.recovery.inspect(a.binding.key);assert.equal(recovered.publication.status,'committed');assert.equal(recovered.publication.receipt.status,'unavailable');assert.equal(b.state.attempts.get(a.binding.key.attemptId).phase,'committed');await close(b,s);
});
test('B17: a read admitted before deletion wins protection across independent connections',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);const gate=b.gate('object.read'),p=s.acquireFile(a.binding.key);await gate.entered;code(await other.deleteVersion(a.binding.key,{expectedRevision:(await other.inspectVersion(a.binding.key)).revision}),'busy');gate.release();const read=await p;await read.value.release();assert.equal((await deletion(other,a)).status,'deleted');await close(b,s,other);
});
test('B17: deletion claim blocks a later retain and duplicate deleter without deadlock',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);const rev=(await s.inspectVersion(a.binding.key)).revision,g=b.gate('object.remove.before'),p=s.deleteVersion(a.binding.key,{expectedRevision:rev});await g.entered;
 const h=other.makeHoldKey(a.binding.key);code(await other.retain(h),'uncertain');code(await other.deleteVersion(a.binding.key,{expectedRevision:(await other.inspectVersion(a.binding.key)).revision}),'busy');code(await other.acquireFile(a.binding.key),'busy');g.release();assert.equal((await p).status,'deleted');assert.equal(b.stats.removes,1);await close(b,s,other);
});
test('B17: an earlier retain invalidates a concurrently prepared deletion revision',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);const revision=(await s.inspectVersion(a.binding.key)).revision,h=s.makeHoldKey(a.binding.key),g=b.gate('tx.enter:hold.retain'),retained=s.retain(h);await g.entered;const removed=other.deleteVersion(a.binding.key,{expectedRevision:revision});g.release();assert.equal((await retained).status,'active');code(await removed,'stale-revision');assert.equal(b.stats.removes,0);await close(b,s,other);
});
test('B18: bounded weak scan uses sequence and scope-bound canonical cursors',async()=>{
 const b=backend(),s=await b.open();for(let i=0;i<40;i++)await publish(s,{name:'v'+i+'.mp4'});const page=await s.scanVersions();assert.equal(page.versions.length,32);assert.ok(page.next);const rest=await s.scanVersions({cursor:page.next});assert.equal(rest.versions.length,8);assert.equal(rest.next,undefined);assert.deepEqual([...page.versions,...rest.versions].map(x=>x.version.publicationSequence),Array.from({length:40},(_,i)=>i+1));
 for(const limit of [0,129,NaN,1.5])await assert.rejects(s.scanVersions({limit}),RangeError);for(const cursor of ['other/1','scope1/999','scope1/01','scope1/NaN'])await assert.rejects(s.scanVersions({cursor}));await close(b,s);
});
test('B19: readonly inspection never infers publication from matching bytes, absence or stale owner',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s),before=at(b),mutations=b.stats.transactions,locks=b.stats.lockRequests;
 for(let i=0;i<3;i++){const state=await s.recovery.inspect(a.binding.key);assert.equal(state.publication.status,'indeterminate');assert.equal(state.quiescent,false);}
 assert.deepEqual(b.state,before);assert.equal(b.stats.transactions,mutations);assert.equal(b.stats.lockRequests,locks);const item=b.files.get(b.state.attempts.get(a.binding.key.attemptId).objectId);b.files.clear();assert.equal((await s.recovery.inspect(a.binding.key)).publication.status,'indeterminate');b.files.set(b.state.attempts.get(a.binding.key.attemptId).objectId,item);
 const original=b.state.attempts.get(a.binding.key.attemptId);b.state.attempts.delete(a.binding.key.attemptId);await assert.rejects(s.recovery.inspect(a.binding.key));b.state.attempts.set(a.binding.key.attemptId,original);await a.transaction.abort('done');await a.transaction.release({publication:'not-committed'});await close(b,s);
});
test('B20: lost commit ack followed by replacement recovers only the historical original',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s),e=b.fail('tx.ack:attempt.publish');await reason(a.transaction.commit(),e);await a.transaction.release({publication:'indeterminate'});await publish(s,{ifExists:'replace',bytes:new Uint8Array([8])});const state=await s.recovery.inspect(a.binding.key);assert.equal(state.publication.status,'committed');assert.equal(state.currentTarget,'other-publication');assert.equal(state.ownerHold.holdId,a.binding.ownerHold.holdId);
 const file=await s.acquireFile(state.publication.receipt.value.key);assert.deepEqual(await bytes(file.value),[1,2,3]);await file.value.release();assert.equal((await s.inspectHold(a.binding.ownerHold)).status,'active');await close(b,s);
});
test('B21/B27: missing bytes do not negate commit and absence without a deleting claim cannot be swept',async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);b.files.delete(b.state.versions.get(a.binding.key.attemptId).objectId);const state=await s.recovery.inspect(a.binding.key);assert.equal(state.publication.status,'committed');assert.equal(state.publication.receipt.status,'unavailable');const before=at(b);code(await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision}),'ownership-unverified');assert.deepEqual(b.state,before);await close(b,s);
});
test('B22: active publisher remains unresolved and cannot be stolen by recovery or cleanup',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),a=await stage(s),state=await other.recovery.inspect(a.binding.key);code(await other.recovery.recover(a.binding.key,{expectedRevision:state.revision}),'busy');assert.equal((await other.recovery.cleanup(a.binding.key,{expectedRevision:state.revision})).status,'blocked');assert.equal((await other.recovery.inspect(a.binding.key)).publication.status,'indeterminate');assert.equal(b.stats.removes,0);await a.transaction.abort(0);await a.transaction.release({publication:'not-committed'});await close(b,s,other);
});
test('B23: indeterminate-but-live queued publication still serializes before recovery',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),a=await stage(s),g=b.gate('tx.enter:attempt.publish'),unknown=Error('lost reply before database completion');b.earlyUnknown.set('attempt.publish',unknown);const rejected=reason(a.transaction.commit(),unknown);await g.entered;await rejected;const released=a.transaction.release({publication:'indeterminate'});await pending(released);b.dropLocks(r=>r.name.includes('/attempt/'));const observed='scope1:'+b.state.attempts.get(a.binding.key.attemptId).revision,recovered=other.recovery.recover(a.binding.key,{expectedRevision:observed});await pending(recovered);g.release();await released;code(await recovered,'stale-revision');assert.equal((await other.recovery.inspect(a.binding.key)).publication.status,'committed');assert.equal((await other.inspectHold(a.binding.ownerHold)).status,'active');await close(b,s,other);
});
test('B23: recovery fences a later stale publisher before its transaction is created',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),a=await stage(s),g=b.gate('tx.enqueue:attempt.publish'),p=a.transaction.commit();await g.entered;b.dropLocks(r=>r.name.includes('/attempt/'));const observed=await other.recovery.inspect(a.binding.key);assert.equal(observed.physicalIO,'settled');const result=await other.recovery.recover(a.binding.key,{expectedRevision:observed.revision});assert.equal(result.status,'fenced');assert.equal(result.snapshot.publication.status,'not-committed');assert.equal(b.stats.removes,0);g.release();assert.equal((await p).status,'not-committed');await a.transaction.abort('fenced');await a.transaction.release({publication:'not-committed'});assert.equal(b.state.versions.size,0);await close(b,s,other);
});
test('B23/B24: lost recovery acknowledgement is reinspected without deleting uncertain physical work',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),a=await stage(s);b.dropLocks(r=>r.name.includes('/attempt/'));const observed=await other.recovery.inspect(a.binding.key),e=b.fail('tx.ack:recover.fence'),result=await other.recovery.recover(a.binding.key,{expectedRevision:observed.revision});assert.equal(result.status,'indeterminate');assert.equal(result.reason,e);const after=await other.recovery.inspect(a.binding.key);assert.equal(after.publication.status,'not-committed');assert.equal(after.physicalIO,'unknown');assert.equal((await other.recovery.cleanup(a.binding.key,{expectedRevision:after.revision})).status,'blocked');assert.equal(b.stats.removes,0);await a.transaction.abort(0);await a.transaction.release({publication:'not-committed'});await close(b,s,other);
});
test('B24: lost owner lock does not settle a delayed physical write or authorize early deletion',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),binding=s.bind('movie.mp4'),context=request(),t=await binding.destination.create(context),g=b.gate('writer.write'),work=t.writeAt(0,new Uint8Array([4,5]),context.signal);await g.entered;b.dropLocks(r=>r.name.includes('/attempt/'));
 const snapshot=await other.recovery.inspect(binding.key),recovered=await other.recovery.recover(binding.key,{expectedRevision:snapshot.revision});assert.equal(recovered.status,'fenced');assert.equal(recovered.snapshot.physicalIO,'unknown');const clean=await other.recovery.cleanup(binding.key,{expectedRevision:recovered.snapshot.revision});assert.equal(clean.status,'blocked');assert.equal(clean.reason.code,'io-unsettled');assert.equal(b.stats.physical,1);assert.equal(b.stats.removes,0);await assert.rejects(t.abort(0));await assert.rejects(t.release({publication:'not-committed'}));
 g.release();await assert.rejects(work);await t.abort(0);await t.release({publication:'not-committed'});assert.equal(b.stats.physical,0);assert.equal(b.files.size,0);assert.equal((await other.recovery.inspect(binding.key)).physicalIO,'settled');await close(b,s,other);
});
test('B25: missing schema and moved object scope do not recreate or migrate storage',async()=>{
 const b=backend(),s=await b.open(),saved=b.state;b.state=undefined;assert.equal((await s.checkSupport()).supported,false);assert.equal(b.state,undefined);b.state=saved;b.objects.directoryId='other';assert.equal((await s.checkSupport()).supported,false);assert.equal(b.state.scope.directoryId,'dir1');b.objects.directoryId='dir1';await close(b,s);
});
test('B26: malformed foreign keys, hold kinds and ownership mismatches reject without mutation',async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s),before=at(b);
 for(const bad of [null,{},'path',{...a.binding.key,version:2},{...a.binding.key,backendId:'v1'},{...a.binding.key,scopeId:'other'},{...a.binding.key,attemptId:'../escape'}]){await assert.rejects(s.recovery.inspect(bad));code(await s.deleteVersion(bad,{expectedRevision:'scope1:1'}),'foreign-key');}
 code(await s.retain({...a.binding.ownerHold,kind:'explicit'}),'foreign-key');assert.deepEqual(b.state,before);
 await s.releaseHold(a.binding.ownerHold);const v=b.state.versions.get(a.binding.key.attemptId);b.files.get(v.objectId).ownerToken='foreign';code(await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision}),'ownership-unverified');assert.equal(b.stats.removes,0);await close(b,s);
});
test('B27: an owned deleting tombstone permits idempotent absence recovery only for that version',async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);b.fail('object.remove.before');assert.equal((await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision})).status,'indeterminate');const v=b.state.versions.get(a.binding.key.attemptId);assert.equal(v.bytes,'deleting');b.files.delete(v.objectId);assert.equal((await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision})).status,'deleted');assert.equal((await s.deleteVersion(a.binding.key,{expectedRevision:(await s.inspectVersion(a.binding.key)).revision})).status,'already-deleted');assert.notEqual((await s.lookup('movie.mp4')).key.attemptId,a.binding.key.attemptId);await close(b,s);
});
test('B28: partial acquisition failure cleans unreturned resources and preserves its first error',async()=>{
 const b=backend(),s=await b.open(),binding=s.bind('movie.mp4'),primary=b.fail('object.create.after');await reason(binding.destination.create(request()),primary);assert.equal(b.stats.writers,0);assert.equal(b.stats.locks,0);assert.equal(b.files.size,0);await close(b,s);
});
test('B28: failed constructor abort stays visible and explicit close retries its owned cleanup',async()=>{
 const b=backend(),s=await b.open(),binding=s.bind('movie.mp4'),primary=b.fail('tx.commit:attempt.writing'),secondary=b.fail('writer.abort');await reason(binding.destination.create(request()),primary);assert.equal(b.stats.writers,1);assert.equal(s.stats.attempts,1);assert.ok(s.stats.cleanupIssues.includes(secondary));await close(b,s);assert.equal(b.files.size,0);
});
test('B28: failed native close never marks physical settlement; release retries after abort failure',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s),primary=b.fail('writer.close'),outcome=await a.transaction.commit();assert.equal(outcome.status,'not-committed');assert.equal(outcome.reason,primary);assert.equal((await s.recovery.inspect(a.binding.key)).physicalIO,'unknown');const secondary=b.fail('writer.abort');await reason(a.transaction.abort(primary),secondary);await a.transaction.release({publication:'not-committed'});const recovered=await s.recovery.inspect(a.binding.key);assert.equal(recovered.physicalIO,'settled');assert.equal((await s.recovery.cleanup(a.binding.key,{expectedRevision:recovered.revision})).status,'cleaned');await close(b,s);
});
test('B28: failed acquisition cleanup lock release preserves abort reason and is retried by close',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),abort=new AbortController(),g=b.gate('object.read'),work=s.acquireFile(a.binding.key,{signal:abort.signal});await g.entered;abort.abort(0);const secondary=b.fail('lock.release');g.release();await reason(work,0);assert.equal(s.stats.orphanLocks,1);assert.ok(s.stats.cleanupIssues.includes(secondary));await close(b,s);
});
test('B28: connection close can fail and be retried without poisoning the store',async()=>{
 const b=backend(),s=await b.open(),e=b.fail('metadata.close');await reason(s.close(),e);assert.equal((await s.checkSupport()).supported,true);await close(b,s);
});
test('B28: acquisition/write errors preserve controller ready/closed cancellation and allow fresh export',async()=>{
 const b=backend(),s=await b.open(),a=fixtures(),binding=s.bind('movie.mp4'),g=b.gate('writer.write'),abort=new AbortController(),e=createExternalVideoExporter(a.options({destination:binding.destination,signal:abort.signal}));await e.ready;
 const work=e.addFrame(canvas(),{timestampUs:0,durationUs:1000});await g.entered;abort.abort(0);await reason(work,0);await pending(e.closed);g.release();const report=await e.closed;assert.equal(report.publication,'not-committed');assert.equal(report.reason,0);assert.deepEqual(report.cleanupIssues,[]);
 const fresh=await publish(s);assert.equal(fresh.outcome.status,'committed');assert.equal(s.stats.attempts,0);assert.equal(b.stats.writers,0);await close(b,s);
});
test('B28: released transaction cannot publish again or mutate caller retention',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s);await a.transaction.release({publication:'not-committed'});await assert.rejects(a.transaction.commit());await a.transaction.release({publication:'not-committed'});assert.equal(b.state.names.size,0);await close(b,s);
});
test('B3/B13: concurrent create-new has exactly one publication and one owner hold',async()=>{
 const b=backend(),s=await b.open(),other=await b.open(),pair=await Promise.all([publish(s),publish(other)]);assert.equal(pair.filter(x=>x.outcome.status==='committed').length,1);assert.equal(b.state.versions.size,1);assert.equal(b.state.holds.size,1);assert.equal(b.files.size,1);await close(b,s,other);
});
test('B4: destination snapshots policy, format and limits before its first yield',async()=>{
 for(const ext of ['mp4','webm']){const name='movie.'+ext,b=backend(),s=await b.open(),original=await publish(s,{name});assert.equal(original.value.format.mimeType,'video/'+ext);const binding=s.bind(name),ctx=request(name),promise=binding.destination.create(ctx);ctx.ifExists='replace';ctx.format.mimeType=ext==='mp4'?'video/webm':'video/mp4';ctx.maxWriteBytes=1;const t=await promise;await t.writeAt(0,new Uint8Array([1,2,3]),ctx.signal);await t.truncate(3,ctx.signal);assert.equal((await t.commit()).status,'not-committed');await t.abort('collision');await t.release({publication:'not-committed'});assert.equal(b.state.versions.size,1);await close(b,s);}
});
test('B8/B28: failed download preparation revokes partial URL and preserves pre-handoff abort',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),abort=new AbortController(),create=b.ui.createURL.bind(b.ui);b.ui.createURL=file=>{const value=create(file);abort.abort(0);return value;};const secondary=Error('partial revoke');b.syncFaults.set('ui.revoke',secondary);await reason(s.prepareDownload(a.binding.key,{signal:abort.signal}),0);assert.equal(b.stats.urls,1);assert.equal(s.stats.readers,1);assert.ok(s.stats.cleanupIssues.includes(secondary));await close(b,s);
});
test('B8/B28: permission-denied File read returns no fabricated File and releases its lock',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),e=b.fail('object.read',new DOMException('Revoked','NotAllowedError')),access=await s.acquireFile(a.binding.key);assert.equal(access.status,'blocked');assert.equal(access.reason,e);assert.equal(b.stats.locks,0);await close(b,s);
});
test('B15/B26: missing or corrupt selection evidence never authorizes deletion',async()=>{
 const b=backend(),s=await b.open(),a=await superseded(s);await s.releaseHold(a.binding.ownerHold);const snapshot=await s.inspectVersion(a.binding.key),previous=b.state.names.get('movie.mp4');b.state.names.delete('movie.mp4');code(await s.deleteVersion(a.binding.key,{expectedRevision:snapshot.revision}),'uncertain');b.state.names.set('movie.mp4','foreign');code(await s.deleteVersion(a.binding.key,{expectedRevision:snapshot.revision}),'uncertain');assert.equal(b.stats.removes,0);b.state.names.set('movie.mp4',previous);await close(b,s);
});
test('B23: lost acknowledgement of an aborted publication cannot retry that identity',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s),e=b.fail('tx.commit:attempt.publish');b.fail('tx.commit:attempt.negative',Error('negative journal'));const outcome=await a.transaction.commit();assert.equal(outcome.status,'not-committed');assert.equal(outcome.reason,e);assert.equal(b.state.names.size,0);await a.transaction.abort(e);await a.transaction.release({publication:'not-committed'});await assert.rejects(a.transaction.commit());await close(b,s);
});
test('B24: cancellation after commit admission cannot undo successful publication',async()=>{
 const b=backend(),s=await b.open(),abort=new AbortController(),a=await stage(s,{abort}),g=b.gate('writer.close'),p=a.transaction.commit();await g.entered;abort.abort(0);g.release();assert.equal((await p).status,'committed');await a.transaction.release({publication:'committed'});assert.equal((await s.recovery.inspect(a.binding.key)).publication.status,'committed');await close(b,s);
});
test('B26: reused global attempt identity cannot overwrite an earlier object or tombstone',async()=>{
 const b=backend(),s=await b.open(),a=await publish(s),ids=[a.binding.key.attemptId,'otherhold','othertoken'],other=await b.open({newId:()=>ids.shift()}),binding=other.bind('movie.mp4'),before=at(b);await assert.rejects(binding.destination.create(request()));assert.deepEqual(b.state,before);assert.equal(b.files.size,1);await close(b,s,other);
});
test('B28: failed session release plus lost metadata permits concurrent close after physical cleanup',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s);await a.transaction.abort(0);const e=b.fail('lock.release');await reason(a.transaction.release({publication:'not-committed'}),e);assert.equal(s.stats.attempts,1);assert.equal(b.stats.locks,1);b.connections[0].invalidate();const g=b.gate('lock.release'),first=s.close(),second=s.close();assert.equal(first,second);await g.entered;g.release();assert.equal((await first).status,'closed');assert.equal(s.stats.attempts,0);assert.equal(s.stats.orphanLocks,0);assert.ok(s.stats.cleanupIssues.length>=2);b.idle();
});
test('B28: lost registration ack preserves unresolved metadata without creating native bytes',async()=>{
 const b=backend(),s=await b.open(),binding=s.bind('movie.mp4'),e=b.fail('tx.ack:attempt.register');await reason(binding.destination.create(request()),e);assert.equal(b.files.size,0);assert.equal(b.stats.writers,0);assert.equal((await s.recovery.inspect(binding.key)).publication.status,'indeterminate');await close(b,s);
});
test('B28: quota and permission failures reject exact writes, clean resources and allow retry',async()=>{
 for(const name of ['QuotaExceededError','NotAllowedError']){
  const b=backend(),s=await b.open(),binding=s.bind('movie.mp4'),ctx=request(),t=await binding.destination.create(ctx),e=b.fail('writer.write',new DOMException('storage failure',name));await reason(t.writeAt(0,new Uint8Array([1]),ctx.signal),e);await t.abort(e);await t.release({publication:'not-committed'});assert.equal((await s.recovery.inspect(binding.key)).publication.status,'not-committed');assert.equal((await publish(s)).outcome.status,'committed');await close(b,s);
 }
});
test('B25/B28: invalidated metadata connection never fabricates cleanup settlement on reopen',async()=>{
 const b=backend(),s=await b.open(),a=await stage(s);b.connections[0].invalidate();assert.equal((await s.checkSupport()).supported,false);await assert.rejects(a.transaction.abort(0));await assert.rejects(a.transaction.release({publication:'not-committed'}));assert.equal(b.stats.writers,0);assert.equal(b.stats.locks,0);await close(b,s);
 const reopened=await b.open(),state=await reopened.recovery.inspect(a.binding.key);assert.equal(state.publication.status,'indeterminate');assert.equal(state.physicalIO,'unknown');const recovered=await reopened.recovery.recover(a.binding.key,{expectedRevision:state.revision});assert.equal(recovered.status,'fenced');const cleanup=await reopened.recovery.cleanup(a.binding.key,{expectedRevision:recovered.snapshot.revision});assert.equal(cleanup.status,'blocked');assert.equal(cleanup.reason.code,'io-unsettled');assert.equal(b.stats.removes,0);await close(b,reopened);
});
