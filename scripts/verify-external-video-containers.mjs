import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,readdir,unlink,stat,mkdtemp,realpath,rm} from 'node:fs/promises';
import {resolve,join,sep,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {chromium,firefox} from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import {fileDestination} from '../test/fixtures/video-external-file.mjs';
import {deferred} from '../test/fixtures/video-external.mjs';
import {mp4Headers} from '../test/browser/helpers/offline-video.mjs';
import {readAudioLayout,decodeOfflineAudio,bestLag} from '../test/browser/helpers/offline-audio.mjs';
import {readWebm,decodeWebm} from '../test/browser/helpers/offline-webm.mjs';
import {makeOfflinePcm} from '../test/browser/helpers/offline-audio-input.mjs';

// Explicitly opt-in: AGENTS.md requires browser-debugging permission for this script.
const output=resolve('benchmark-results/external-video-containers');await mkdir(output,{recursive:true});
const sessions=new Map(),execute=promisify(execFile),empty={workers:0,videoEncoders:0,videoFrames:0,audioEncoders:0,audioData:0,dequeueListeners:0};
const result={status:'running',date:new Date().toISOString(),node:process.version,platform:process.platform,filesystem:'same-directory local hard-link no-replace / rename replace; test-only receiver',rows:[],hashes:{}};
for(const p of ['src/internal/video-external.ts','src/internal/video-external-mp4.ts','src/internal/video-external-webm.ts','src/internal/video-external-target.ts','scripts/external-video-containers/browser.mjs','scripts/verify-external-video-containers.mjs','test/fixtures/video-external-file.mjs'])result.hashes[p]=createHash('sha256').update(await readFile(p)).digest('hex');
const save=()=>writeFile(join(output,'results.json'),JSON.stringify(result,null,2)+'\n');await save();
const old=Buffer.alloc(400000,123);
async function rpc(op,body){
 if(op==='create'){
  const id=randomUUID(),directory=join(output,id);await mkdir(directory);const path=join(directory,'movie.'+body.kind),s={id,options:body,directory,path,gate:deferred(),gated:false};
  if(body.ifExists!=='error'||body.scenario==='collision')await writeFile(path,old);
  const block=async()=>{s.gated=true;await s.gate.promise;};
  s.destination=fileDestination(path,{
   async ready(){if(body.delayMs)await new Promise(r=>setTimeout(r,body.delayMs));if(body.scenario==='cancel-ready')await block();},
   async write(){if(body.delayMs)await new Promise(r=>setTimeout(r,body.delayMs));if(body.scenario==='cancel-write')await block();if(body.scenario==='fail-write')throw Error('injected write failure');},
   async truncate(){if(body.scenario==='fail-truncate')throw Error('injected truncate failure');},
   async beforeCommit(){if(body.delayMs)await new Promise(r=>setTimeout(r,body.delayMs));if(body.scenario==='cancel-commit')await block();if(body.ifExists!=='error'||body.scenario==='collision')assert.deepEqual(await readFile(path),old,'Published target changed before commit');},
   async afterPublication(){if(body.scenario==='unknown')throw Error('injected unknown publication');}
  });sessions.set(id,s);return id;
 }
 const s=sessions.get(body.id);assert.ok(s);
 if(op==='acquire'){s.transaction=await s.destination.create({ifExists:s.options.ifExists??'replace'});return;}
 if(op==='compare'){assert.deepEqual(await readFile(s.path),Buffer.from(body.data));return true;}
 if(op==='ready')return s.transaction.ready();
 if(op==='write')return s.transaction.writeAt(body.position,new Uint8Array(body.data));
 if(op==='truncate')return s.transaction.truncate(body.size);
 if(op==='commit')return s.transaction.commit();
 if(op==='abort')return s.transaction.abort();
 if(op==='release')return s.transaction.release(body.info);
 throw Error('Unknown RPC');
}
const server=createServer(async(req,res)=>{try{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname.startsWith('/rpc/')){const chunks=[];for await(const c of req)chunks.push(c);const value=await rpc(pathname.slice(5),JSON.parse(Buffer.concat(chunks)));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,value}));return;}
 if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Private external containers</title><script type="module" src="/browser.mjs"></script>');return;}
 const file=pathname==='/browser.mjs'?resolve('scripts/external-video-containers/browser.mjs'):pathname==='/pcm.mjs'?resolve('test/browser/helpers/offline-audio-input.mjs'):pathname.startsWith('/dist/')?resolve('dist','.'+pathname.slice(5)):undefined;
 if(!file||(!file.startsWith(resolve('dist')+sep)&&!['/browser.mjs','/pcm.mjs'].includes(pathname))){res.writeHead(404).end();return;}
 res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));
 }catch(error){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error:String(error)}));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const scenarios=[
 {id:'silent',silent:true,ifExists:'error'},
 {id:'limit-1',pendingInputs:1,delayMs:5},
 {id:'limit-2',pendingInputs:2,delayMs:5},
 {id:'defaults',delayMs:5},
 {id:'stereo-slow',pendingInputs:2,channels:2,delayMs:25},
 {id:'tiny',samples:1,pendingInputs:1},
 {id:'partial',samples:961,pendingInputs:2},
 {id:'long-stereo',samples:1440001,channels:2,delayMs:5},
 {id:'cancel-commit',scenario:'cancel-commit',pendingInputs:2},
 ...['cancel-ready','cancel-write','cancel-flush','fail-write','fail-truncate','unknown','collision'].flatMap(scenario=>[
  {id:scenario,scenario,pendingInputs:2,...(scenario==='collision'?{ifExists:'error'}:{})},
  {id:scenario+'-retry',samples:24001,pendingInputs:2}
 ])
];
async function decode(s,row){
 const o=s.options,bytes=await readFile(s.path),expectedPts=row.frames===3?[0,33333,100000]:[0];let pts,sampleCount,planes,first;
 if(o.kind==='webm'){
  const layout=readWebm(bytes),track=layout.tracks.find(t=>t.codec==='V_VP8'),blocks=layout.blocks.filter(b=>b.track===track.number);assert.equal(layout.duration,row.durationUs);assert.equal(blocks.length,row.frames);assert.equal(blocks.at(-1).time+blocks.at(-1).duration,row.durationUs);
  const decoded=await decodeWebm(s.path,o.silent?0:o.channels??1);pts=decoded.pts;sampleCount=decoded.containerSamples;planes=decoded.planes;first=decoded.first;
 }else{
  const h=mp4Headers(bytes),v=h.tracks.find(t=>t.type==='vide');assert.ok(Math.abs(v.duration/v.timescale*1e6-row.durationUs)<20);
  if(o.silent){const decoded=await execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-err_detect','explode','-copyts','-i',s.path,'-map','0:v:0','-vf','showinfo','-vsync','0','-f','null','-'],{encoding:'utf8',timeout:30000});pts=decoded.stderr.split('\n').filter(l=>l.includes('Parsed_showinfo')&&l.includes('pts_time:')).map(l=>Number(l.match(/pts_time:([\d.e+-]+)/)[1])*1e6);}
  else{const layout=readAudioLayout(bytes),decoded=await decodeOfflineAudio(s.path,o.channels??1,layout);pts=decoded.videoFrames.map(n=>n*1e6);sampleCount=layout.presentationSamples;planes=decoded.presentation;first=decoded.audioFirst;}
  const packets=await execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-copyts','-i',s.path,'-map','0:v:0','-c:v','copy','-f','framecrc','pipe:1'],{encoding:'utf8',timeout:30000});const tb=packets.stdout.match(/#tb 0:\s*(\d+)\/(\d+)/),last=packets.stdout.split('\n').filter(l=>/^0,/.test(l)).at(-1).split(',').map(n=>Number(n.trim()));assert.ok(Math.abs((last[2]+last[3])*Number(tb[1])/Number(tb[2])*1e6-row.durationUs)<20);
 }
 assert.equal(pts.length,row.frames);pts.forEach((n,i)=>assert.ok(Math.abs(n-expectedPts[i])<20));
 const correlations=[];
 if(!o.silent){const samples=o.samples??108001;assert.equal(sampleCount,samples);assert.equal(first,0);assert.ok(planes.every(p=>p.length===samples));
  if(samples>8192){const source=makeOfflinePcm(48000,o.channels??1,samples);for(let c=0;c<source.length;c++){const beginning=bestLag(source[c],planes[c]),end=bestLag(source[c],planes[c],samples-4096);for(const lag of [beginning,end]){assert.equal(lag.lag,0);assert.ok(lag.correlation>0.9);}correlations.push({beginning,end});}}
 }
 return {size:bytes.length,frames:pts.length,pts,samples:sampleCount,first,correlations};
}
let active;
try{
 for(const [name,type]of Object.entries({chromium,firefox})){
  const profile=await mkdtemp(join(tmpdir(),'canvastake-external-containers-'));let context;
  try{
   context=await type.launchPersistentContext(profile,{headless:true,...(name==='firefox'?{firefoxUserPrefs:{'gfx.webrender.software':true,'layers.acceleration.disabled':true,'dom.ipc.processPrelaunch.enabled':false}}:{})});assert.ok(context.pages().length<=1);const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(60000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.goto(origin);await page.waitForFunction(()=>typeof window.externalBegin==='function');result.browsers??={};result.browsers[name]=await page.evaluate(()=>navigator.userAgent);
   for(const kind of ['mp4','webm'])for(const options of scenarios){
    console.log(name+' '+kind+' '+options.id);const {id}=await page.evaluate(o=>window.externalBegin(o),{...options,kind}),s=sessions.get(id);
    if(options.scenario?.startsWith('cancel')){
     if(options.scenario==='cancel-flush')await page.waitForFunction(()=>window.externalStats().gated);
     else{for(let i=0;!s.gated&&i<600;i++)await new Promise(r=>setTimeout(r,50));assert.ok(s.gated);}
     await page.evaluate(()=>window.externalAbort());
     if(options.scenario!=='cancel-flush'){if(options.scenario!=='cancel-commit')await page.waitForFunction(()=>Object.values(window.externalStats().live).every(n=>n===0));assert.equal(await page.evaluate(()=>window.externalStats().closed),false);assert.equal(s.destination.stats.aborts,0);s.gate.resolve();}
    }
    const row=active={browser:name,kind,...options,...await page.evaluate(()=>window.externalWait())},stats=s.destination.stats;
    assert.deepEqual(row.stats.live,empty);assert.deepEqual(row.stats.cleanupIssues,[]);assert.deepEqual(errors,[]);assert.equal(stats.liveHandles,0);assert.equal(stats.ownedBytes,0);assert.equal(stats.physical,0);assert.equal(stats.releases,1);
    assert.ok(stats.peakPhysical<=1);assert.ok(stats.peakOwnedBytes<=16*1024*1024);assert.ok(row.stats.peakUnacknowledged<=(options.pendingInputs??4));assert.ok(row.stats.peakNativeQueue<=(options.pendingInputs??4));
    if(options.scenario&&options.scenario!=='cancel-commit'){
     assert.equal(row.success,false);assert.equal(row.stats.publication,options.scenario==='unknown'?'indeterminate':'not-committed');
     if(options.scenario.startsWith('cancel'))assert.equal(row.cancelReasonPreserved,true);
     if(options.scenario==='unknown'){assert.equal(stats.aborts,0);const unknown={frames:3,durationUs:Math.round(108001*1e6/48000)};row.decoded=await decode(s,unknown);}
     else{assert.deepEqual(await readFile(s.path),old);assert.equal(stats.aborts,1);}
    }else{
     assert.equal(row.success,true);assert.equal(row.byteParity,true);assert.equal(row.stats.publication,'committed');assert.equal(stats.commits,1);assert.equal(stats.aborts,0);row.decoded=await decode(s,row);assert.equal(row.result.output.size,(await stat(s.path)).size);
     if(kind==='webm'&&!options.silent)assert.equal(row.stats.nativeFlushes,1);if(!options.silent)assert.equal(row.stats.ends.length,1);
    }
    assert.deepEqual(await readdir(s.directory),['movie.'+kind]);row.file=s.path;row.receiver={...stats,writes:stats.writes.length};result.rows.push(row);active=undefined;await save();await page.evaluate(()=>window.externalRelease());sessions.delete(id);
   }
  }finally{await context?.close();const resolved=await realpath(profile);assert.equal(dirname(resolved),await realpath(tmpdir()));assert.ok(basename(resolved).startsWith('canvastake-external-containers-'));await rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
 }
 result.status='passed';await save();console.log('External real-container verification passed: '+result.rows.length+' cases');
}catch(error){result.status='failed';result.error=String(error);result.failedRow=active;await save();throw error;}
finally{for(const s of sessions.values()){s.gate.resolve();await s.transaction?.abort().catch(()=>{});}server.closeAllConnections();await new Promise(r=>server.close(r));}
