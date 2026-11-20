import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,unlink,rm,realpath} from 'node:fs/promises';
import {join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import {createExternalVideoExporter} from '../dist/internal/video-external.js';
import {createExternalMp4Muxer} from '../dist/internal/video-external-mp4.js';
import {createExternalWebmMuxer} from '../dist/internal/video-external-webm.js';
import {createExternalTarget} from '../dist/internal/video-external-target.js';
import {createMp4Muxer} from '../dist/video-mp4.js';
import {createWebmMuxer} from '../dist/video-webm.js';
import {fileDestination} from './fixtures/video-external-file.mjs';
import {deferred,turn} from './fixtures/video-external.mjs';
import {mp4Headers} from './browser/helpers/offline-video.mjs';
import {readWebm} from './browser/helpers/offline-webm.mjs';
import {patchExternalMediaSource} from '../scripts/external-video-containers/media-source-patch.mjs';

const run=promisify(execFile),timings=[300000,500000,700000],durationUs=1500000;
const color={primaries:'bt709',transfer:'bt709',matrix:'smpte170m',fullRange:false};
const context=()=>({signal:new AbortController().signal,maxPendingInputs:4,maxPendingBytes:4096});
const canvas={width:2,height:2,getContext(){return {getImageData(){return {data:new Uint8ClampedArray([255,0,0,255,255,0,0,255,255,0,0,255,255,0,0,255])};}};}};
async function cleanup(directory){const target=await realpath(directory);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-'));await rm(target,{recursive:true,force:true});}
async function coded(kind){
 const output=await run(ffmpeg,['-hide_banner','-nostdin','-f','lavfi','-i','color=c=red:s=2x2:r=1','-frames:v','1','-pix_fmt','yuv420p','-c:v',kind==='mp4'?'libx264':'libvpx',...(kind==='mp4'?['-profile:v','baseline','-f','h264']:['-f','ivf']),'pipe:1'],{encoding:'buffer',timeout:30000});
 let data,description,codec;
 if(kind==='mp4'){
  const bytes=output.stdout,starts=[];for(let i=0;i<bytes.length-3;i++){if(bytes[i]===0&&bytes[i+1]===0&&(bytes[i+2]===1||(bytes[i+2]===0&&bytes[i+3]===1))){const n=bytes[i+2]===1?3:4;starts.push([i,n]);i+=n-1;}}
  const nals=starts.map(([p,n],i)=>bytes.subarray(p+n,starts[i+1]?.[0]??bytes.length)),sps=nals.find(n=>(n[0]&31)===7),pps=nals.find(n=>(n[0]&31)===8);
  assert.ok(sps&&pps);codec='avc1.'+sps.subarray(1,4).toString('hex');
  description=Buffer.concat([Buffer.from([1,...sps.subarray(1,4),255,225,sps.length>>8,sps.length&255]),sps,Buffer.from([1,pps.length>>8,pps.length&255]),pps]);
  data=Buffer.concat(nals.filter(n=>![7,8].includes(n[0]&31)).flatMap(n=>{const size=Buffer.alloc(4);size.writeUInt32BE(n.length);return [size,n];}));
 }else{codec='vp8';const bytes=output.stdout;data=bytes.subarray(44,44+bytes.readUInt32LE(32));}
 const config={codec,bitstreamFormat:kind==='mp4'?'avc':'vp8',width:2,height:2,bitrate:10000};
 const events=[];const encoder={checkSupport:async()=>({supported:true}),create(c,ctx){let started=false;return {
  async encodeFrame(frame){if(!started){started=true;const e={type:'config',track:'video',config:{...config,color,...(description?{description}: {})}};events.push(e);await ctx.output.write(e);}const e={type:'packet',packet:{track:'video',timestampUs:frame.timestampUs,decodeTimestampUs:frame.timestampUs,durationUs:frame.durationUs,type:'key',data}};events.push(e);await ctx.output.write(e);},
  async flush(){const e={type:'end',track:'video'};events.push(e);await ctx.output.write(e);},dispose(){}
 };}};
 return {config,encoder,events};
}
const external=kind=>kind==='mp4'?createExternalMp4Muxer():createExternalWebmMuxer();
const blob=kind=>kind==='mp4'?createMp4Muxer():createWebmMuxer();
async function frames(e){let timestampUs=0;for(const length of timings){await e.addFrame(canvas,{timestampUs,durationUs:length});timestampUs+=length;}}
async function decode(path,kind){
 const {stdout,stderr}=await run(ffmpeg,['-hide_banner','-nostdin','-xerror','-err_detect','explode','-copyts','-i',path,'-map','0:v:0','-vf','scale=1:1,format=rgb24,showinfo','-vsync','0','-f','rawvideo','pipe:1'],{encoding:'buffer',timeout:30000});
 assert.match(stderr.toString(),kind==='mp4'?/Video:\s*h264/:/Video:\s*vp8/);assert.equal(stdout.length,9);
 const pts=stderr.toString().split('\n').filter(l=>l.includes('Parsed_showinfo')&&l.includes('pts_time:')).map(l=>Math.round(Number(l.match(/pts_time:([\d.e+-]+)/)[1])*1e6));
 assert.deepEqual(pts,[0,300000,800000]);for(let i=0;i<3;i++){assert.ok(stdout[i*3]>240);assert.ok(stdout[i*3+1]<15,JSON.stringify([...stdout]));assert.ok(stdout[i*3+2]<=20,JSON.stringify([...stdout]));}return pts;
}
for(const kind of ['mp4','webm'])test('real '+kind+' external controller: file publication, decode, rewinds and byte parity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canvastake-real-container-'));
 const OriginalDate=globalThis.Date,random=Math.random;globalThis.Date=class extends OriginalDate{constructor(...a){super(...(a.length?a:[1735689600000]));}static now(){return 1735689600000;}};Math.random=()=>0.25;
 try{
  const path=join(directory,'movie.'+kind),d=fileDestination(path,{shortWrite:17}),c=await coded(kind);
  const e=createExternalVideoExporter({video:{encoder:c.encoder,config:c.config},muxer:external(kind),destination:d,maxPendingBytes:4096});await e.ready;await frames(e);const result=await e.finish(),closed=await e.closed;
  assert.equal(closed.publication,'committed');assert.deepEqual(closed.cleanupIssues,[]);assert.equal(result.output.value,path);assert.equal(result.durationUs,durationUs);
  const bytes=await readFile(path);assert.equal(result.output.size,bytes.length);assert.ok(d.stats.writes.some((w,i,a)=>i&&w.position<a[i-1].position));
  const legacy=await blob(kind).create({video:c.config},context());try{for(const event of c.events)await legacy.write(event);const old=await legacy.finalize({durationUs,videoFrames:3});assert.deepEqual(bytes,Buffer.from(await old.arrayBuffer()));}finally{legacy.dispose();}
  await decode(path,kind);
  if(kind==='mp4'){const h=mp4Headers(bytes);assert.equal(h.movie.duration/h.movie.timescale,1.5);}else{const h=readWebm(bytes);assert.equal(h.duration, durationUs);assert.deepEqual(h.blocks.map(b=>b.duration),timings);}
  e.dispose();assert.deepEqual(await readFile(path),bytes);assert.equal(d.stats.liveHandles,0);assert.equal(d.stats.ownedBytes,0);assert.equal(d.stats.peakPhysical,1);assert.equal(d.stats.releases,1);assert.deepEqual(await readdir(directory),['movie.'+kind]);
 }finally{globalThis.Date=OriginalDate;Math.random=random;await cleanup(directory);}
});
for(const kind of ['mp4','webm'])test('real '+kind+' filesystem: collision, intervening creator, concurrent create-new and whole replacement',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canvastake-container-policy-')),path=join(directory,'movie.'+kind),old=Buffer.alloc(20000,123);
 try{
  await writeFile(path,old);
  const prepare=async(extra={},hooks={})=>{const c=await coded(kind),d=fileDestination(path,hooks),e=createExternalVideoExporter({video:{encoder:c.encoder,config:c.config},muxer:external(kind),destination:d,...extra});await e.ready;await frames(e);return {e,d};};
  const first=await prepare();await assert.rejects(first.e.finish());assert.equal((await first.e.closed).publication,'not-committed');assert.deepEqual(await readFile(path),old);assert.equal(first.d.stats.aborts,1);
  const replacement=await prepare({ifExists:'replace'},{beforeCommit:async()=>assert.deepEqual(await readFile(path),old)});await replacement.e.finish();await replacement.e.closed;const bytes=await readFile(path);assert.ok(bytes.length<old.length);await decode(path,kind);
  await unlink(path);const late=await prepare();await writeFile(path,old);await assert.rejects(late.e.finish());await late.e.closed;assert.deepEqual(await readFile(path),old);
  await unlink(path);const a=await prepare(),b=await prepare();const results=await Promise.allSettled([a.e.finish(),b.e.finish()]);await Promise.all([a.e.closed,b.e.closed]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);await decode(path,kind);
  for(const {d}of[first,replacement,late,a,b]){assert.equal(d.stats.liveHandles,0);assert.equal(d.stats.releases,1);assert.equal(d.stats.ownedBytes,0);}assert.deepEqual(await readdir(directory),['movie.'+kind]);
 }finally{await cleanup(directory);}
});
for(const kind of ['mp4','webm'])for(const phase of ['ready','write','truncate','failure','unknown','unknown-create'])test('real '+kind+' '+phase+': cleanup fence and fresh export',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canvastake-container-cancel-')),path=join(directory,'movie.'+kind),gate=deferred(),entered=deferred(),abort=new AbortController(),reason=Error('injected '+phase);
 try{
  const old=Buffer.from('existing published target');if(phase!=='unknown-create')await writeFile(path,old);
  const hook=async()=>{entered.resolve();await gate.promise;if(phase==='failure')throw reason;};
  const hooks=phase==='ready'?{ready:hook}:phase==='write'||phase==='failure'?{write:hook}:phase==='truncate'?{truncate:hook}:{afterPublication:async()=>{throw reason;}};
  const d=fileDestination(path,hooks),c=await coded(kind),e=createExternalVideoExporter({video:{encoder:c.encoder,config:c.config},muxer:external(kind),destination:d,ifExists:phase==='unknown-create'?'error':'replace',signal:abort.signal});
  const work=(async()=>{await e.ready;await frames(e);return e.finish();})();void work.catch(()=>{});
  if(phase.startsWith('unknown')){await assert.rejects(work,error=>error===reason);const report=await e.closed;assert.equal(report.publication,'indeterminate');assert.equal(d.stats.aborts,0);await decode(path,kind);
   if(phase==='unknown-create'){assert.equal((await readdir(directory)).length,2);assert.deepEqual(await readFile(d.stats.stages[0]),await readFile(path));await unlink(d.stats.stages[0]);await decode(path,kind);}
  }
  else{
   await entered.promise;let closed=false;void e.closed.then(()=>closed=true);
   if(phase!=='failure'){abort.abort(reason);await assert.rejects(work,error=>error===reason);await turn();assert.equal(closed,false);assert.equal(d.stats.aborts,0);}
   gate.resolve();if(phase==='failure')await assert.rejects(work);const report=await e.closed;assert.equal(report.publication,'not-committed');assert.deepEqual(report.cleanupIssues,[]);assert.deepEqual(await readFile(path),old);assert.equal(d.stats.commits,0);assert.equal(d.stats.aborts,1);
  }
  assert.equal(d.stats.liveHandles,0);assert.equal(d.stats.ownedBytes,0);assert.equal(d.stats.physical,0);assert.equal(d.stats.releases,1);
  const fresh=await coded(kind),destination=fileDestination(path),retry=createExternalVideoExporter({video:{encoder:fresh.encoder,config:fresh.config},muxer:external(kind),destination,ifExists:'replace'});await retry.ready;await frames(retry);await retry.finish();await retry.closed;await decode(path,kind);assert.equal(destination.stats.liveHandles,0);assert.deepEqual(await readdir(directory),['movie.'+kind]);
 }finally{gate.resolve();await cleanup(directory);}
});
test('external target serializes and splits vendor chunks, retains exact failure and stays closable',async()=>{
 const calls=[],reason=Error('disk failed');let size=0,fail;
 const bridge=createExternalTarget({...context(),maxPendingBytes:3,output:{get size(){return size;},async writeAt(position,data){calls.push([position,[...data]]);size=Math.max(size,position+data.length);if(position===6)throw reason;},fail(e){fail=e;}}});
 // Mediabunny starts its target on Output.start; drive this pinned bridge boundary directly.
 bridge.target._start();bridge.target._write(new Uint8Array([1,2,3,4,5,6,7,8]),0);await bridge.target._flush();await bridge.target._finalize();
 assert.deepEqual(calls,[[0,[1,2,3]],[3,[4,5,6]],[6,[7,8]]]);assert.equal(fail,reason);assert.throws(bridge.check,e=>e===reason);bridge.stop();
});
test('the pinned MediaSource transform ships once in the shared container graph',async()=>{
 const path='node_modules/mediabunny/dist/modules/src/media-source.js',source=(await readFile(path,'utf8')).replaceAll('\r\n','\n'),patched=patchExternalMediaSource(source);
 assert.match(patched,/await connectedTrack.output._muxer.onTrackClose/);assert.throws(()=>patchExternalMediaSource(patched),/anchor changed/);
 assert.equal((await readFile(path,'utf8')).replaceAll('\r\n','\n'),source);
 assert.equal(await readFile('dist/internal/external-video-sources/media-source-patch.mjs','utf8'),await readFile('scripts/external-video-containers/media-source-patch.mjs','utf8'));
 const maps=(await readdir('dist')).filter(n=>/^video-container-.*\.js\.map$/.test(n));assert.ok(maps.length);
 const sources=(await Promise.all(maps.map(async n=>JSON.parse(await readFile('dist/'+n,'utf8')).sourcesContent))).flat();
 assert.equal(sources.filter(value=>value.includes('await connectedTrack.output._muxer.onTrackClose')).length,1);
 assert.equal((await readdir('dist/internal')).filter(n=>/^external-container-/.test(n)).length,0);
});
for(const kind of ['mp4','webm'])test('real '+kind+' rejects unsupported config and header byte limits without leaking acquisition',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'canvastake-container-limits-')),path=join(directory,'movie.'+kind);
 try{for(const scenario of ['unsupported','output-limit']){
  const c=await coded(kind),destination=fileDestination(path),e=createExternalVideoExporter({video:{encoder:c.encoder,config:scenario==='unsupported'?{...c.config,codec:'invalid'}:c.config},muxer:external(kind),destination,...(scenario==='output-limit'?{maxOutputBytes:1}:{})});
  await assert.rejects((async()=>{await e.ready;await frames(e);return e.finish();})());const report=await e.closed;
  assert.equal(report.publication,'not-committed');assert.deepEqual(report.cleanupIssues,[]);assert.equal(destination.stats.liveHandles,0);assert.equal(destination.stats.ownedBytes,0);assert.equal(destination.stats.commits,0);assert.deepEqual(await readdir(directory),[]);
  if(scenario==='unsupported')assert.equal(destination.stats.stages.length,0);
 }}finally{await cleanup(directory);}
});
