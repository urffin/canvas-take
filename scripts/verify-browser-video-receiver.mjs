import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,realpath,rm,open} from 'node:fs/promises';
import {resolve,join,sep,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium,firefox} from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import {mp4Headers} from '../test/browser/helpers/offline-video.mjs';
import {readAudioLayout,decodeOfflineAudio,bestLag} from '../test/browser/helpers/offline-audio.mjs';
import {readWebm,decodeWebm} from '../test/browser/helpers/offline-webm.mjs';
import {makeOfflinePcm} from '../test/browser/helpers/offline-audio-input.mjs';

// Opt-in verification: explicit external-browser debugging permission is required by AGENTS.md.
const output=resolve('benchmark-results/browser-video-receiver');await mkdir(output,{recursive:true});
const execute=promisify(execFile),result={date:new Date().toISOString(),status:'running',profile:'cooperating OPFS namespace + IndexedDB logical names; not user filesystem names',node:process.version,rows:[],namespaces:[],hashes:{}};
for(const path of ['src/internal/video-browser-catalog.ts','scripts/browser-video-receiver/browser.mjs','scripts/verify-browser-video-receiver.mjs'])result.hashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
const save=()=>writeFile(join(output,'results.json'),JSON.stringify(result,null,2)+'\n');await save();
const server=createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Browser receiver verification</title><a hidden>Download</a><script type="module" src="/browser.mjs"></script>');return;}
 const file=path==='/browser.mjs'?resolve('scripts/browser-video-receiver/browser.mjs'):path==='/pcm.mjs'?resolve('test/browser/helpers/offline-audio-input.mjs'):path.startsWith('/dist/')?resolve('dist','.'+path.slice(5)):undefined;
 if(!file||(!['/browser.mjs','/pcm.mjs'].includes(path)&&!file.startsWith(resolve('dist')+sep))){res.writeHead(404).end();return;}
 res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));
 }catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const base=[{id:'create',silent:true,ifExists:'error'},{id:'collision',scenario:'collision',silent:true,ifExists:'error'},
 {id:'replace-av',samples:108001},{id:'limit-1',samples:108001,pendingInputs:1},{id:'stereo-slow',channels:2,pendingInputs:2,delayMs:5},
 {id:'tiny',samples:1,pendingInputs:1},{id:'partial',samples:961,channels:2,pendingInputs:2},{id:'long-av',samples:1440001,channels:2,frames:121}];
const cases=[...base,...['cancel-acquire','cancel-ready','cancel-write','cancel-truncate','cancel-commit','fail-write','fail-truncate','fail-close','fail-after-close','fail-idb','ack-lost'].flatMap(scenario=>[
 {id:scenario,scenario,samples:108001,pendingInputs:2},{id:scenario+'-retry',samples:24001,pendingInputs:2}
])];
const zero={workers:0,videoEncoders:0,videoFrames:0,audioEncoders:0,audioData:0,writers:0,connections:1,urls:0};
function resources(row){assert.deepEqual(row.cleanupIssues,[]);assert.deepEqual(row.stats.live,zero);for(const key of ['sessions','activeWriters','physical','borrowedBytes'])assert.equal(row.stats.catalog[key],0,key);assert.equal(row.stats.catalog.connections,1);assert.ok(row.stats.catalog.peakBorrowedBytes<=16*1024*1024);}
async function deadline(promise){let timer;try{return await Promise.race([promise,new Promise((yes,no)=>{timer=setTimeout(()=>no(Error('Browser receiver case exceeded 60 seconds')),60000);})]);}finally{clearTimeout(timer);}}
async function decode(path,row,opts){
 const bytes=await readFile(path),kind=opts.kind,expected=row.timings;let pts,planes,samples,first;const rates=48000;
 if(kind==='webm'){
  const layout=readWebm(bytes),track=layout.tracks.find(t=>t.codec==='V_VP8'),blocks=layout.blocks.filter(b=>b.track===track.number);
  assert.equal(layout.duration,row.durationUs);assert.equal(blocks.length,expected.length);for(let i=0;i<blocks.length;i++){assert.equal(blocks[i].time,expected[i].timestampUs);assert.equal(blocks[i].duration,expected[i].durationUs);}
  const d=await decodeWebm(path,opts.silent?0:opts.channels??1);pts=d.pts;planes=d.planes;samples=d.containerSamples;first=d.first;
 }else{
  const headers=mp4Headers(bytes),video=headers.tracks.find(t=>t.type==='vide');assert.ok(Math.abs(video.duration/video.timescale*1e6-row.durationUs)<20);
  if(opts.silent){const d=await execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-err_detect','explode','-copyts','-i',path,'-map','0:v:0','-vf','showinfo','-vsync','0','-f','null','-'],{encoding:'utf8',timeout:30000});pts=d.stderr.split('\n').filter(l=>l.includes('Parsed_showinfo')&&l.includes('pts_time:')).map(l=>Number(l.match(/pts_time:([\d.e+-]+)/)[1])*1e6);}
  else{const layout=readAudioLayout(bytes),d=await decodeOfflineAudio(path,opts.channels??1,layout);pts=d.videoFrames.map(n=>n*1e6);planes=d.presentation;samples=layout.presentationSamples;first=d.audioFirst;}
  const packets=await execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-copyts','-i',path,'-map','0:v:0','-c:v','copy','-f','framecrc','pipe:1'],{encoding:'utf8',timeout:30000});const tb=packets.stdout.match(/#tb 0:\s*(\d+)\/(\d+)/),rows=packets.stdout.split('\n').filter(l=>/^0,/.test(l)).map(l=>l.split(',').map(n=>Number(n.trim())));assert.equal(rows.length,expected.length);
  for(let i=0;i<rows.length;i++){const unit=Number(tb[1])/Number(tb[2])*1e6;assert.ok(Math.abs(rows[i][2]*unit-expected[i].timestampUs)<20);assert.ok(Math.abs(rows[i][3]*unit-expected[i].durationUs)<20);}
 }
 assert.equal(pts.length,expected.length);
 if(expected.length>3){
  // pts_time is printed with limited significant digits; use decoded integer PTS for long files.
  const d=await execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-copyts','-i',path,'-map','0:v:0','-vf','showinfo','-vsync','0','-f','null','-'],{encoding:'utf8',timeout:30000});
  const tb=d.stderr.match(/config in time_base:\s*(\d+)\/(\d+)/);assert.ok(tb);
  pts=d.stderr.split('\n').filter(l=>l.includes('Parsed_showinfo')&&l.includes('pts_time:')).map(l=>Number(l.match(/pts:\s*(-?\d+)/)[1])*Number(tb[1])/Number(tb[2])*1e6);
 }
 for(let i=0;i<pts.length;i++)assert.ok(Math.abs(pts[i]-expected[i].timestampUs)<20);
 const correlations=[];if(!opts.silent){const count=opts.samples??108001;assert.equal(samples,count);assert.equal(first,0);assert.ok(planes.every(p=>p.length===count));
  if(count>8192){const pcm=makeOfflinePcm(rates,opts.channels??1,count);for(let c=0;c<pcm.length;c++){const a=bestLag(pcm[c],planes[c]),b=bestLag(pcm[c],planes[c],count-4096);for(const x of [a,b]){assert.equal(x.lag,0);assert.ok(x.correlation>0.9);}correlations.push({beginning:a,end:b});}}
 }
 return {bytes:bytes.length,frames:pts.length,samples,first,correlations};
}
async function download(page,id,name,row,options){
 const path=join(output,name+'.'+options.kind);let meta;
 if(options.id==='create'){
  meta=await page.evaluate(id=>window.browserReceiverDownload(id),id);
  try{const [file]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download',exact:true}).click()]);await file.saveAs(path);}
  finally{await page.evaluate(()=>window.browserReceiverRevoke());}
  row.transfer='native-download';
 }else{
  meta=await page.evaluate(id=>window.browserReceiverFileMeta(id),id);const file=await open(path,'w');
  try{for(let offset=0;offset<meta.size;offset+=65536){const encoded=await page.evaluate(chunk=>window.browserReceiverFileChunk(chunk),{offset,length:65536});const bytes=Buffer.from(encoded,'base64');assert.equal(bytes.length,Math.min(65536,meta.size-offset));await file.writeFile(bytes);}}
  finally{await file.close();await page.evaluate(()=>window.browserReceiverClearTransfer());}
  row.transfer='opfs-chunks';
 }
 const bytes=await readFile(path);assert.equal(bytes.length,meta.size);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.selected.hash);row.decoded=await decode(path,row,options);row.file=path;
}
let active;
try{for(const [browserName,type]of Object.entries({chromium,firefox})){
 const profile=await realpath(await mkdtemp(join(tmpdir(),'canvastake-browser-receiver-')));let context,page;
 try{
  context=await type.launchPersistentContext(profile,{headless:true,acceptDownloads:true,...(browserName==='firefox'?{firefoxUserPrefs:{'gfx.webrender.software':true,'layers.acceleration.disabled':true,'dom.ipc.processPrelaunch.enabled':false}}:{})});assert.ok(context.pages().length<=1);page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(60000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.waitForFunction(()=>typeof window.browserReceiverInit==='function');result.browsers??={};result.browsers[browserName]=await page.evaluate(()=>navigator.userAgent);
  for(const kind of ['mp4','webm']){
   const config=await page.evaluate(()=>window.browserReceiverInit());assert.equal(config.nativeNamedPolicy.supported,false);assert.equal((await page.evaluate(k=>window.browserReceiverReadOnlyProbe(k),kind)).readOnly,true);let selected;
   for(const options of cases){
    console.log(browserName+' '+kind+' '+options.id);await page.evaluate(o=>window.browserReceiverBegin(o),{...options,kind});
    if(options.scenario?.startsWith('cancel')){
     await page.waitForFunction(()=>window.browserReceiverStats().gated);await page.evaluate(()=>window.browserReceiverAbort());
     const s=await page.evaluate(()=>window.browserReceiverStats());assert.equal(s.closed,false);if(options.scenario==='cancel-commit')assert.equal(s.outputPhase,'committing');else assert.ok(s.live.writers>0);
     await page.evaluate(()=>window.browserReceiverUngate());
    }
    const row=active={browser:browserName,kind,...options,...await deadline(page.evaluate(()=>window.browserReceiverWait()))};resources(row);assert.deepEqual(errors,[]);
    const publishes=!options.scenario||options.scenario==='cancel-commit'||options.scenario==='ack-lost';
    if(publishes){assert.equal(row.record.phase,'committed');assert.equal(row.record.released,true);assert.equal(row.selected.attemptId,row.attemptId);assert.ok(row.objects.includes(row.record.objectName));
     assert.equal(row.success,options.scenario!=='ack-lost');assert.equal(row.publication,options.scenario==='ack-lost'?'indeterminate':'committed');selected=row.selected;await download(page,row.attemptId,browserName+'-'+kind+'-'+options.id,row,{...options,kind});
    }else{assert.equal(row.success,false);assert.equal(row.publication,'not-committed');assert.equal(row.record.phase,'not-committed');assert.equal(row.record.released,true);assert.equal(row.record.removed,true);assert.ok(!row.objects.includes(row.record.objectName));assert.deepEqual(row.selected,selected);if(options.scenario.startsWith('cancel'))assert.equal(row.cancelReasonPreserved,true);
     await page.evaluate(()=>window.browserReceiverCleanupFailed());
    }
    row.savedVersions=await page.evaluate(()=>window.browserReceiverVerifySaved());result.rows.push(row);active=undefined;await save();await page.evaluate(()=>window.browserReceiverReleaseCase());
   }
   // Two tabs, same OPFS/IDB namespace, distinct attempts: exactly one create-new winner.
   const second=await context.newPage();second.on('pageerror',e=>errors.push(e.message));try{
    await second.goto(origin);await second.waitForFunction(()=>typeof window.browserReceiverInit==='function');await second.evaluate(c=>window.browserReceiverInit(c),config);
    const raceOptions={id:'two-tab-create',name:'race.'+kind,kind,silent:true,ifExists:'error'};
    await Promise.all([page.evaluate(o=>window.browserReceiverBegin(o),raceOptions),second.evaluate(o=>window.browserReceiverBegin(o),raceOptions)]);
    const pair=await Promise.all([page.evaluate(()=>window.browserReceiverWait()),second.evaluate(()=>window.browserReceiverWait())]);
    assert.equal(pair.filter(r=>r.success).length,1);const winner=pair.find(r=>r.success);
    await download(page,'lookup',browserName+'-'+kind+'-two-tab-winner',winner,raceOptions);
    for(const [i,row]of pair.entries()){resources(row);assert.equal(row.publication,row.success?'committed':'not-committed');assert.equal(row.selected.attemptId,winner.attemptId);result.rows.push({browser:browserName,kind,id:'two-tab-create-'+i,...row});}
    await second.evaluate(()=>window.browserReceiverFinishNamespace(false));await page.evaluate(()=>window.browserReceiverReleaseCase());
   }finally{await second.close();}
   const reopened=await page.evaluate(()=>window.browserReceiverReopen());assert.equal(reopened.live.connections,1);assert.equal(reopened.catalog.connections,1);
   const final=await page.evaluate(()=>window.browserReceiverFinishNamespace(true));assert.deepEqual(final.live,{...zero,connections:0});assert.equal(final.catalog.connections,0);result.namespaces.push({browser:browserName,kind,scope:config.directoryName,readOnlyPreflight:true,closedAndRemoved:true,stats:final});assert.deepEqual(errors,[]);await save();
  }
 }finally{await context?.close();const target=await realpath(profile);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-browser-receiver-'));await rm(target,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
}result.status='passed';await save();console.log('Browser OPFS catalogue receiver passed: '+result.rows.length+' cases');
}catch(error){result.status='failed';result.error=String(error);result.failedRow=active;await save();throw error;}
finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
