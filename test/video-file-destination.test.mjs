import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,lstat,rename,unlink,mkdir,symlink,realpath,rm,rmdir} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {provisionNodeVideoDestination} from '../dist/internal/video-file-node.mjs';
import {createExternalVideoExporter} from '../dist/internal/video-external.js';
import {fixtures,canvas,deferred,turn} from './fixtures/video-external.mjs';

const bytes=new Uint8Array([1,2,3,4]),signal=()=>new AbortController().signal;
const request=(extra={})=>({format:{mimeType:'video/mp4',extension:'mp4'},ifExists:'error',maxWriteBytes:4096,...extra});
async function fixture(options={}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'canvastake-receiver-'))),receiver=await provisionNodeVideoDestination(root,{trust:'controlled-local-directory',...options});
 return {root,receiver,bind:(name='movie.mp4')=>receiver.bind(name),async dispose(){const target=await realpath(root);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-receiver-'));await rm(target,{recursive:true,force:true});}};
}
async function prepared(binding,extra={}){const context={...request(extra),signal:signal()},tx=await binding.destination.create(context);await tx.ready(context.signal);await tx.writeAt(0,bytes,context.signal);await tx.truncate(bytes.length,context.signal);return tx;}
async function settle(tx,outcome){if(outcome.status==='not-committed')await tx.abort(outcome.reason);await tx.release({publication:outcome.status});}
const zero=r=>{assert.equal(r.stats.liveHandles,0);assert.equal(r.stats.borrowedBytes,0);assert.equal(r.stats.physical,0);};
async function manifest(root){const result=[];async function walk(path){for(const name of(await readdir(path)).sort()){const p=join(path,name),s=await lstat(p);result.push([p,s.size,s.mtimeMs]);if(s.isDirectory())await walk(p);else if(s.isFile())result.push([p,(await readFile(p)).toString('hex')]);}}await walk(root);return result;}

test('D1/D2: explicit scoped provisioning; exact-request checks are read-only and reusable',async()=>{
 await assert.rejects(provisionNodeVideoDestination('.'),/explicit/);
 const f=await fixture();try{const b=f.bind(),before=await manifest(f.root),stats=f.receiver.stats;
  for(let i=0;i<3;i++){const report=await b.destination.checkSupport(request());assert.equal(report.supported,true);assert.deepEqual(report.guarantees.scope,f.receiver.scope);assert.equal(report.guarantees.policy,'error');}
  assert.deepEqual(await manifest(f.root),before);assert.deepEqual(f.receiver.stats,stats);
  f.receiver.invalidate();assert.equal((await b.destination.checkSupport(request())).code,'stale-profile');await assert.rejects(prepared(b));zero(f.receiver);
 }finally{await f.dispose();}
});
test('D3: permission-required/denied and revocation reject without prompting/acquiring',async()=>{
 let code='PERMISSION_REQUIRED';const f=await fixture({fault(point){if(point==='check-permission'&&code)throw Object.assign(Error('no permission'),{code});}});
 try{const b=f.bind(),before=await manifest(f.root);assert.equal((await b.destination.checkSupport(request())).code,'permission-required');code='EACCES';assert.equal((await b.destination.checkSupport(request())).code,'permission-denied');
  code='';assert.equal((await b.destination.checkSupport(request())).supported,true);code='EACCES';await assert.rejects(prepared(b));assert.deepEqual(await manifest(f.root),before);zero(f.receiver);
 }finally{await f.dispose();}
});
test('D4: unsupported policy/format/bounds, detached/shared views, admission and retention quota',async()=>{
 const f=await fixture({maxWriteBytes:4096,maxAttempts:2});try{const b=f.bind();
  for(const extra of [{ifExists:'append'},{maxWriteBytes:4097},{maxWriteBytes:0},{maxOutputBytes:0},{format:{mimeType:'video/webm',extension:'webm'}}])assert.equal((await b.destination.checkSupport(request(extra))).supported,false);
  const tx=await b.destination.create({...request(),signal:signal()});await assert.rejects(tx.writeAt(0,new Uint8Array(new SharedArrayBuffer(1)),signal()));await tx.abort(null);await tx.release({publication:'not-committed'});zero(f.receiver);
  f.bind('other.mp4');assert.throws(()=>f.bind('third.mp4'),/quota/);await assert.rejects(prepared(b));
 }finally{await f.dispose();}
});
test('D5: scope moved between support and acquisition rejects; original target preserved',async()=>{
 const f=await fixture(),moved=f.root+'-moved';try{const b=f.bind();assert.equal((await b.destination.checkSupport(request())).supported,true);await rename(f.root,moved);await mkdir(f.root);await writeFile(join(f.root,'movie.mp4'),'foreign');
  await assert.rejects(prepared(b));assert.equal(await readFile(join(f.root,'movie.mp4'),'utf8'),'foreign');zero(f.receiver);
 }finally{await unlink(join(f.root,'movie.mp4')).catch(()=>{});await rmdir(f.root);await rename(moved,f.root);await f.dispose();}
});
for(const point of ['before-journal-registered','after-journal-registered','after-stage-open','after-journal-prepared'])test('D5/D11: partial acquisition failure '+point+' closes unreturned handles',async()=>{
 const reason=Error(point);let paths;const f=await fixture({fault(p,context){paths=context;if(p===point)throw reason;}});try{const b=f.bind();await assert.rejects(prepared(b),e=>e===reason);const report=await b.recovery.inspect(b.key);assert.equal(report.publication.status,'not-committed');assert.equal(report.quiescent,true);assert.equal(report.staging,'absent');zero(f.receiver);assert.equal(f.receiver.stats.publications,0);assert.ok(paths.journalPath);
 }finally{await f.dispose();}
});
test('D6: concurrent create-new and intervening creator preserve exactly one winner',async()=>{
 const f=await fixture();try{const a=f.bind(),b=f.bind(),at=await prepared(a),bt=await prepared(b),out=await Promise.all([at.commit(),bt.commit()]);assert.equal(out.filter(o=>o.status==='committed').length,1);await Promise.all([settle(at,out[0]),settle(bt,out[1])]);assert.deepEqual(new Uint8Array(await readFile(join(f.root,'movie.mp4'))),bytes);
  const next=f.bind('late.mp4'),tx=await prepared(next);await writeFile(join(f.root,'late.mp4'),'intervening',{flag:'wx'});const collision=await tx.commit();assert.equal(collision.status,'not-committed');await settle(tx,collision);assert.equal(await readFile(join(f.root,'late.mp4'),'utf8'),'intervening');zero(f.receiver);
 }finally{await f.dispose();}
});
test('D6: publication-time no-replace holds against another receiver process',async()=>{
 const f=await fixture();let child;try{const b=f.bind(),tx=await prepared(b);child=fork(new URL('./fixtures/video-file-process.mjs',import.meta.url),[f.root,'movie.mp4'],{stdio:['ignore','ignore','inherit','ipc']});const [ready]=await once(child,'message');assert.equal(ready.ready,true);
  const childResult=once(child,'message');child.send('commit');const outcome=await tx.commit(),[other]=await childResult;assert.equal([outcome.status,other.status].filter(s=>s==='committed').length,1);assert.equal(other.live,0);await settle(tx,outcome);const actual=[...await readFile(join(f.root,'movie.mp4'))];assert.deepEqual(actual,outcome.status==='committed'?[...bytes]:[7,7,7]);zero(f.receiver);
 }finally{child?.kill();await f.dispose();}
});
test('D7: invalid names, aliases, symlink/reparse/non-regular targets and parent rebinding',async()=>{
 const f=await fixture();try{for(const name of ['../x.mp4','MOVIE.mp4','con.mp4','movie..mp4','/x.mp4','x.webm/child'])assert.throws(()=>f.bind(name));
  await mkdir(join(f.root,'directory.mp4'));assert.equal((await f.bind('directory.mp4').destination.checkSupport(request())).supported,false);
  await mkdir(join(f.root,'real'));await symlink(join(f.root,'real'),join(f.root,'linked.mp4'),process.platform==='win32'?'junction':'dir');assert.equal((await f.bind('linked.mp4').destination.checkSupport(request())).supported,false);
  const first=f.bind(),tx=await prepared(first);await writeFile(join(f.root,'MOVIE.mp4'),'case alias',{flag:'wx'});let aliased=true;try{await lstat(join(f.root,'movie.mp4'));}catch(error){if(error.code!=='ENOENT')throw error;aliased=false;}const outcome=await tx.commit();assert.equal(outcome.status,aliased?'not-committed':'committed');await settle(tx,outcome);zero(f.receiver);
 }finally{await f.dispose();}
});
test('D8/D9: positioned rewrites, short writes and atomic whole replacement preserve old value until commit',async()=>{
 let target;const f=await fixture({shortWrite:1,fault:async(point)=>{if(point==='before-publish')assert.equal((await readFile(target)).length,100);}});try{target=join(f.root,'movie.mp4');await writeFile(target,Buffer.alloc(100,9));const b=f.bind(),context={...request({ifExists:'replace'}),signal:signal()},tx=await b.destination.create(context);await tx.writeAt(0,bytes,context.signal);await tx.writeAt(1,new Uint8Array([8]),context.signal);await tx.truncate(4,context.signal);assert.equal((await readFile(target)).length,100);const outcome=await tx.commit();await settle(tx,outcome);assert.deepEqual([...await readFile(target)],[1,8,3,4]);assert.deepEqual([...await outcome.value.read()],[1,8,3,4]);zero(f.receiver);
 }finally{await f.dispose();}
});
test('D9: failed replacement never restores old snapshot over a concurrent writer',async()=>{
 const reason=Error('stop before publication');let path;const f=await fixture({fault:async(point)=>{if(point==='before-publish'){await writeFile(path,'other writer');throw reason;}}});try{path=join(f.root,'movie.mp4');await writeFile(path,'old');const b=f.bind(),tx=await prepared(b,{ifExists:'replace'}),outcome=await tx.commit();assert.equal(outcome.status,'not-committed');await settle(tx,outcome);assert.equal(await readFile(path,'utf8'),'other writer');zero(f.receiver);
 }finally{await f.dispose();}
});
for(const point of ['before-journal-publishing','after-journal-publishing','before-publish','after-publish','before-journal-committed','after-journal-committed','before-ack'])test('D10/D11/D12: journal/publication fault '+point+' reconciles independently',async()=>{
 const reason=Error(point);let paths;const f=await fixture({fault(p,context){paths=context;if(p===point)throw reason;}});try{const b=f.bind(),tx=await prepared(b);let outcome;try{outcome=await tx.commit();await settle(tx,outcome);}catch(e){assert.equal(e,reason);await tx.release({publication:'indeterminate'});}
  const observed=await f.receiver.recovery.inspect(structuredClone(b.key)),published=['after-publish','before-journal-committed','after-journal-committed','before-ack'].includes(point);assert.equal(observed.publication.status,published?'committed':'not-committed');assert.equal(observed.quiescent,true);
  if(published){assert.deepEqual([...await observed.publication.receipt.value.read()],[...bytes]);const rows=(await readFile(paths.journalPath,'utf8')).trim().split('\n').map(JSON.parse);assert.ok(rows.some(r=>r.phase==='publishing'));}
  zero(f.receiver);assert.equal(f.receiver.stats.publications,published?1:0);
 }finally{await f.dispose();}
});
test('D13: byte equality, target absence and missing/corrupt journal cannot resolve lost native evidence',async()=>{
 let paths;const reason=Object.assign(Error('native acknowledgement lost'),{code:'EEXIST'}),f=await fixture({publish:async operation=>{await operation();throw reason;},fault(point,context){paths=context;}});
 try{const b=f.bind(),tx=await prepared(b);await assert.rejects(tx.commit(),e=>e===reason);await tx.release({publication:'indeterminate'});let report=await b.recovery.inspect(b.key);assert.equal(report.publication.status,'indeterminate');assert.equal(report.currentTarget,'this-attempt');
  await writeFile(join(f.root,'movie.mp4'),bytes);assert.equal((await b.recovery.inspect(b.key)).publication.status,'indeterminate');await unlink(join(f.root,'movie.mp4'));assert.equal((await b.recovery.inspect(b.key)).publication.status,'indeterminate');
  await writeFile(paths.journalPath,'broken record');report=await b.recovery.inspect(b.key);assert.equal(report.publication.status,'indeterminate');assert.equal((await b.recovery.cleanup(b.key,{expectedRevision:report.revision})).status,'blocked');
  await unlink(paths.journalPath);assert.equal((await b.recovery.inspect(b.key)).publication.status,'indeterminate');zero(f.receiver);
 }finally{await f.dispose();}
});
test('D14: a timed-out caller cannot infer non-publication; late commit remains fenced',async()=>{
 const entered=deferred(),gate=deferred(),f=await fixture({publish:async operation=>{entered.resolve();await gate.promise;await operation();}});
 try{const b=f.bind(),tx=await prepared(b),work=tx.commit();await entered.promise;
  const report=await b.recovery.inspect(b.key);assert.equal(report.quiescent,false);assert.equal(report.publication.status,'indeterminate');assert.equal((await b.recovery.cleanup(b.key,{expectedRevision:report.revision})).status,'blocked');await assert.rejects(tx.release({publication:'indeterminate'}));
  gate.resolve();const out=await work;await settle(tx,out);assert.equal((await b.recovery.inspect(b.key)).publication.status,'committed');zero(f.receiver);
 }finally{gate.resolve();await f.dispose();}
});
test('D15/D16: historical publication survives in-place overwrite/delete and receipt is independent',async()=>{
 const f=await fixture();try{const b=f.bind(),tx=await prepared(b),out=await tx.commit();await settle(tx,out);await writeFile(join(f.root,'movie.mp4'),'other contents');let report=await b.recovery.inspect(b.key);assert.equal(report.publication.status,'committed');assert.equal(report.currentTarget,'other-publication');assert.deepEqual([...await out.value.read()],[...bytes]);
  await unlink(join(f.root,'movie.mp4'));report=await b.recovery.inspect(b.key);assert.equal(report.publication.status,'committed');assert.equal(report.currentTarget,'absent');assert.deepEqual([...await report.publication.receipt.value.read()],[...bytes]);f.receiver.invalidate();assert.deepEqual([...await out.value.read()],[...bytes]);assert.equal((await b.recovery.inspect(b.key)).publication.status,'committed');await unlink(out.value.path);report=await b.recovery.inspect(b.key);assert.equal(report.publication.status,'committed');assert.equal(report.publication.receipt.status,'unavailable');zero(f.receiver);
 }finally{await f.dispose();}
});
test('D17: inspect is read-only, rejects foreign/versioned keys and preserves state after inspector failure',async()=>{
 let reject=false;const f=await fixture({fault(point){if(reject&&point==='before-inspect')throw Error('inspector offline');}});try{const b=f.bind(),tx=await prepared(b),out=await tx.commit();await settle(tx,out);const before=await manifest(f.root),stats=f.receiver.stats;
  const a=await b.recovery.inspect(b.key),c=await b.recovery.inspect({...b.key});assert.deepEqual(JSON.parse(JSON.stringify(a)),JSON.parse(JSON.stringify(c)));
  for(const key of [{...b.key,version:2},{...b.key,backendId:'foreign'},{...b.key,scopeId:'foreign'},{...b.key,attemptId:'foreign'}])await assert.rejects(b.recovery.inspect(key));
  reject=true;await assert.rejects(b.recovery.inspect(b.key));reject=false;assert.equal((await b.recovery.inspect(b.key)).publication.status,'committed');assert.deepEqual(await manifest(f.root),before);assert.deepEqual(f.receiver.stats,stats);
 }finally{await f.dispose();}
});
test('D18/D19: explicit recovery cleanup rejects stale/foreign state and preserves receipt/evidence',async()=>{
 let paths;const f=await fixture({fault(point,context){paths=context;if(point==='after-publish')throw Error('lost acknowledgement');}});try{const b=f.bind(),tx=await prepared(b);await assert.rejects(tx.commit());await tx.release({publication:'indeterminate'});let report=await b.recovery.inspect(b.key);assert.equal(report.staging,'retained');assert.equal(report.publication.status,'committed');
  assert.equal((await b.recovery.cleanup(b.key,{expectedRevision:'stale'})).status,'blocked');
  const original=paths.stagePath+'.owned';await rename(paths.stagePath,original);await writeFile(paths.stagePath,'foreign');assert.equal((await b.recovery.cleanup(b.key,{expectedRevision:report.revision})).status,'blocked');assert.equal(await readFile(paths.stagePath,'utf8'),'foreign');await unlink(paths.stagePath);await rename(original,paths.stagePath);
  report=await b.recovery.inspect(b.key);const cleaned=await b.recovery.cleanup(b.key,{expectedRevision:report.revision});assert.equal(cleaned.status,'cleaned');const after=await b.recovery.inspect(b.key);assert.equal((await b.recovery.cleanup(b.key,{expectedRevision:after.revision})).status,'already-clean');assert.equal(after.publication.status,'committed');assert.deepEqual([...await after.publication.receipt.value.read()],[...bytes]);assert.deepEqual([...await readFile(join(f.root,'movie.mp4'))],[...bytes]);assert.ok((await readFile(paths.journalPath)).length);zero(f.receiver);
 }finally{await f.dispose();}
});
test('D20: unchanged private exporter consumes destination and closes resources after commit exception',async()=>{
 const f=await fixture({fault(point){if(point==='before-ack')throw Error('ack failed');}});try{const b=f.bind(),fake=fixtures(),e=createExternalVideoExporter({...fake.options(),destination:b.destination});await e.ready;await e.addFrame(canvas(),{timestampUs:0,durationUs:1000});await assert.rejects(e.finish());const report=await e.closed;assert.equal(report.publication,'indeterminate');assert.deepEqual(report.cleanupIssues,[]);const recovered=await b.recovery.inspect(b.key);assert.equal(recovered.publication.status,'committed');assert.ok((await recovered.publication.receipt.value.read()).length);zero(f.receiver);
 }finally{await f.dispose();}
});
for(const point of ['before-ready','before-write','before-truncate'])test('D14/D19/D20: controller cancellation fences '+point+' before releasing real handles',async()=>{
 const gate=deferred(),entered=deferred(),abort=new AbortController(),reason=Error(point),f=await fixture({fault:async p=>{if(p===point){entered.resolve();await gate.promise;}}});
 try{const b=f.bind(),fake=fixtures(),e=createExternalVideoExporter({...fake.options(),destination:b.destination,signal:abort.signal});
  const work=(async()=>{await e.ready;await e.addFrame(canvas(),{timestampUs:0,durationUs:1000});return e.finish();})();void work.catch(()=>{});await entered.promise;abort.abort(reason);await assert.rejects(work,error=>error===reason);let closed=false;void e.closed.then(()=>closed=true);await turn();assert.equal(closed,false);assert.ok(f.receiver.stats.liveHandles>0);assert.equal((await b.recovery.inspect(b.key)).quiescent,false);
  gate.resolve();const report=await e.closed;assert.equal(report.publication,'not-committed');assert.deepEqual(report.cleanupIssues,[]);assert.equal((await b.recovery.inspect(b.key)).publication.status,'not-committed');zero(f.receiver);
 }finally{gate.resolve();await f.dispose();}
});
test('D12/D14/D20: post-admission cancel/dispose does not interrupt publication',async()=>{
 const gate=deferred(),entered=deferred(),abort=new AbortController(),f=await fixture({fault:async p=>{if(p==='before-publish'){entered.resolve();await gate.promise;}}});
 try{const b=f.bind(),fake=fixtures(),e=createExternalVideoExporter({...fake.options(),destination:b.destination,signal:abort.signal});await e.ready;await e.addFrame(canvas(),{timestampUs:0,durationUs:1000});const work=e.finish();await entered.promise;abort.abort(Error('late abort'));e.dispose();gate.resolve();const result=await work,closed=await e.closed;assert.equal(closed.publication,'committed');assert.deepEqual(closed.cleanupIssues,[]);assert.ok((await result.output.value.read()).length);zero(f.receiver);
 }finally{gate.resolve();await f.dispose();}
});
test('D18: cleanup revalidates a concurrent artifact change inside the mutation boundary',async()=>{
 let mutate=false,paths;const f=await fixture({fault:async(point,context)=>{paths=context;if(point==='after-publish')throw Error('lost ack');if(point==='before-cleanup'&&mutate){await rename(context.stagePath,context.stagePath+'.owned');await writeFile(context.stagePath,'replacement artifact');}}});
 try{const b=f.bind(),tx=await prepared(b);await assert.rejects(tx.commit());await tx.release({publication:'indeterminate'});const report=await b.recovery.inspect(b.key);mutate=true;assert.equal((await b.recovery.cleanup(b.key,{expectedRevision:report.revision})).status,'blocked');assert.equal(await readFile(paths.stagePath,'utf8'),'replacement artifact');assert.deepEqual([...await report.publication.receipt.value.read()],[...bytes]);zero(f.receiver);
 }finally{await f.dispose();}
});
test('D4/D19: invalid positions, extents, detached views and parallel operations terminate safely',async()=>{
 const f=await fixture();try{const detached=new Uint8Array(1);structuredClone(detached,{transfer:[detached.buffer]});
  for(const [position,data]of [[-1,bytes],[Number.MAX_SAFE_INTEGER,bytes],[0,detached]]){const b=f.bind(),tx=await b.destination.create({...request(),signal:signal()});await assert.rejects(tx.writeAt(position,data,signal()));await tx.abort(null);await tx.release({publication:'not-committed'});}
  const b=f.bind(),tx=await prepared(b);await assert.rejects(tx.writeAt(0,bytes,signal()),/bounds/);await tx.abort(null);await tx.release({publication:'not-committed'});zero(f.receiver);
 }finally{await f.dispose();}
});
test('D4/D19: overlapping I/O/cleanup admission never queues unbounded work',async()=>{
 const gate=deferred(),entered=deferred(),f=await fixture({fault:async p=>{if(p==='before-write'){entered.resolve();await gate.promise;}}});
 try{const b=f.bind(),tx=await b.destination.create({...request(),signal:signal()}),write=tx.writeAt(0,bytes,signal());await entered.promise;assert.throws(()=>tx.ready(signal()),/overlapping/);await assert.rejects(tx.release({publication:'not-committed'}));gate.resolve();await write;await tx.abort(null);await tx.release({publication:'not-committed'});zero(f.receiver);
 }finally{gate.resolve();await f.dispose();}
});
test('D12/D13: an uncertain falsy failure reason is preserved by the recovery channel',async()=>{
 const f=await fixture({publish:async()=>{throw null;}});try{const b=f.bind(),tx=await prepared(b);await assert.rejects(tx.commit(),e=>e===null);await tx.release({publication:'indeterminate'});const report=await b.recovery.inspect(b.key);assert.equal(report.publication.status,'indeterminate');assert.equal(report.publication.reason,null);zero(f.receiver);
 }finally{await f.dispose();}
});
test('D11: publication observes the complete ordered journal and retained original version',async()=>{
 let issued=false,paths,key;const f=await fixture({fault:async(point,context)=>{paths=context;if(point==='before-publish'){const rows=(await readFile(context.journalPath,'utf8')).trim().split('\n').map(JSON.parse);assert.deepEqual(rows.map(r=>r.phase),['registered','prepared','sealed','publishing']);assert.deepEqual(rows.map(r=>r.sequence),[1,2,3,4]);assert.ok(rows.every(r=>r.key.attemptId===key.attemptId));assert.equal(rows.at(-1).size,4);assert.deepEqual([...await readFile(context.receiptPath)],[...bytes]);issued=true;}}});
 try{const b=f.bind();key=b.key;const tx=await prepared(b),outcome=await tx.commit();assert.equal(issued,true);await settle(tx,outcome);const rows=(await readFile(paths.journalPath,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(rows.at(-1).phase,'committed');zero(f.receiver);
 }finally{await f.dispose();}
});
test('D10/D20: malformed commit acknowledgement still has independent attempt recovery',async()=>{
 const f=await fixture();try{const b=f.bind(),fake=fixtures(),destination={...b.destination,async create(context){const tx=await b.destination.create(context);return {...tx,async commit(){await tx.commit();return {status:'committed'};}};}};
  const e=createExternalVideoExporter({...fake.options(),destination});await e.ready;await e.addFrame(canvas(),{timestampUs:0,durationUs:1000});await assert.rejects(e.finish(),/malformed/);const closed=await e.closed;assert.equal(closed.publication,'indeterminate');assert.equal(closed.recovery,undefined);const recovered=await b.recovery.inspect(b.key);assert.equal(recovered.publication.status,'committed');assert.ok((await recovered.publication.receipt.value.read()).length);zero(f.receiver);
 }finally{await f.dispose();}
});
