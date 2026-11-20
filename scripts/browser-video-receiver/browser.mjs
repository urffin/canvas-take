import {openBrowserVideoCatalog,checkNativeBrowserFileDestination} from '/dist/internal/video-browser-catalog.js';
import {createExternalVideoExporter} from '/dist/internal/video-external.js';
import {createExternalMp4Muxer} from '/dist/internal/video-external-mp4.js';
import {createExternalWebmMuxer} from '/dist/internal/video-external-webm.js';
import {createWebCodecsVideoEncoder} from '/dist/video-webcodecs.js';
import {createWebCodecsAudioEncoder} from '/dist/video-opus.js';
import {createAacAudioEncoder} from '/dist/video-aac.js';
import {makeOfflinePcm} from '/pcm.mjs';

let world,current;
const live={workers:0,videoEncoders:0,videoFrames:0,audioEncoders:0,audioData:0,writers:0,connections:0,urls:0};
for(const [name,key]of [['Worker','workers'],['VideoEncoder','videoEncoders'],['VideoFrame','videoFrames'],['AudioEncoder','audioEncoders'],['AudioData','audioData']]){
 const Original=globalThis[name];if(!Original)continue;
 globalThis[name]=new Proxy(Original,{construct(Target,args){const value=Reflect.construct(Target,args,Target),method=name==='Worker'?'terminate':'close',close=value[method].bind(value);let closed=false;live[key]++;value[method]=()=>{if(!closed){closed=true;live[key]--;}return close();};return value;}});
}
const nativeWritable=FileSystemFileHandle.prototype.createWritable;
FileSystemFileHandle.prototype.createWritable=async function(...args){
 const stream=await nativeWritable.apply(this,args);live.writers++;let ended=false;
 const stop=()=>{if(!ended){ended=true;live.writers--;}};
 const wrap=object=>{for(const name of ['close','abort']){const original=object[name].bind(object);object[name]=async(...values)=>{try{return await original(...values);}finally{stop();}};}return object;};
 const original=stream.getWriter.bind(stream);stream.getWriter=(...values)=>wrap(original(...values));return wrap(stream);
};
const nativeOpen=indexedDB.open.bind(indexedDB);
indexedDB.open=(...args)=>{const request=nativeOpen(...args);request.addEventListener('success',()=>{const db=request.result,close=db.close.bind(db);let closed=false;live.connections++;const stop=()=>{if(!closed){closed=true;live.connections--;}};db.close=()=>{stop();return close();};db.addEventListener('close',stop);});return request;};
const hash=async file=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(n=>n.toString(16).padStart(2,'0')).join('');
const points={'cancel-acquire':'after-open-writer','cancel-ready':'ready','cancel-write':'write','cancel-truncate':'truncate','cancel-commit':'before-publish','fail-write':'write','fail-truncate':'truncate','fail-close':'before-close','fail-after-close':'after-close','ack-lost':'after-publish'};
function options(){return {directory:world.directory,databaseName:world.databaseName,publication:'opfs-catalog',trust:'cooperating-origin-namespace',
 async fault(point){const s=current;if(!s)return;if(s.options.delayMs&&['ready','write'].includes(point))await new Promise(r=>setTimeout(r,s.options.delayMs));
  if(points[s.options.scenario]===point){if(s.options.scenario.startsWith('cancel')){s.gated=true;await s.gate;}else throw s.injected;}
 },transactionFault(){if(current?.options.scenario==='fail-idb')throw current.injected;}};}
window.browserReceiverInit=async supplied=>{
 if(world)throw Error('Previous namespace retained');const root=await navigator.storage.getDirectory();
 const directoryName=supplied?.directoryName??'canvastake-browser-video-'+crypto.randomUUID(),databaseName=supplied?.databaseName??directoryName;
 const directory=await root.getDirectoryHandle(directoryName,{create:!supplied});world={root,directory,directoryName,databaseName,receipts:new Map(),owns:!supplied};world.catalog=await openBrowserVideoCatalog(options());
 return {directoryName,databaseName,userAgent:navigator.userAgent,nativeNamedPolicy:checkNativeBrowserFileDestination(),stats:window.browserReceiverStats()};
};
window.browserReceiverBegin=async opts=>{
 if(current)throw Error('Release previous case');let release;const s=current={options:opts,gate:new Promise(yes=>release=yes),release:()=>release(),gated:false,closed:false,reason:Error('requested browser cancellation'),injected:Error('injected '+opts.scenario)};
 const kind=opts.kind,samples=opts.samples??108001,channels=opts.channels??1,durationUs=opts.silent?600001:Math.round(samples*1e6/48000),count=opts.frames??(durationUs>100000?3:1);
 const boundaries=Array.from({length:count+1},(_,i)=>i===0?0:i===count?durationUs:count===3?[0,33333,100000][i]:Math.round(i*(durationUs-250000)/(count-1)));
 s.timings=boundaries.slice(0,-1).map((timestampUs,i)=>({timestampUs,durationUs:boundaries[i+1]-timestampUs}));
 s.abort=new AbortController();s.name=opts.name??'movie.'+kind;s.binding=world.catalog.bind(s.name);
 const audio=kind==='mp4'?createAacAudioEncoder({workerUrl:new URL('/dist/video-aac-worker.js',location.href)}):createWebCodecsAudioEncoder();
 s.exporter=createExternalVideoExporter({video:{encoder:createWebCodecsVideoEncoder(),config:{codec:kind==='mp4'?'avc1.42E01F':'vp8',bitstreamFormat:kind==='mp4'?'avc':'vp8',width:90,height:160,bitrate:500000}},
  ...(opts.silent?{}:{audio:{encoder:audio,config:{codec:kind==='mp4'?'mp4a.40.2':'opus',bitstreamFormat:kind==='mp4'?'aac':'opus',sampleRate:48000,numberOfChannels:channels,bitrate:channels===1?128000:192000},source:{sampleRate:48000,channels:makeOfflinePcm(48000,channels,samples)},endPolicy:'error'}}),
  muxer:kind==='mp4'?createExternalMp4Muxer():createExternalWebmMuxer(),destination:s.binding.destination,ifExists:opts.ifExists??'replace',signal:s.abort.signal,...(opts.pendingInputs===undefined?{}:{maxPendingInputs:opts.pendingInputs})});
 s.exporter.closed.then(report=>{s.closed=true;s.closeReport=report;});
 s.work=(async()=>{
  let success=false,result,cancelReasonPreserved=false,causes=[];
  try{await s.exporter.ready;const canvas=new OffscreenCanvas(90,160),context=canvas.getContext('2d');for(const [i,timing]of s.timings.entries()){context.fillStyle=['red','green','blue'][(i+(opts.variant??0))%3];context.fillRect(0,0,90,160);await s.exporter.addFrame(canvas,timing);}result=await s.exporter.finish();success=true;}
  catch(error){cancelReasonPreserved=error===s.reason;for(let e=error;e;e=e.cause)causes.push(e.message??String(e));}
  finally{s.exporter.dispose();await s.exporter.closed;}
  const record=await world.catalog.inspect(s.binding.key.attemptId).catch(error=>({error:String(error)}));
  const value=result?.output.value??record.value;
  if(value){const file=await value.getFile();world.receipts.set(value.attemptId,{value,hash:await hash(file)});}
  const selected=await world.catalog.lookup(s.name),objects=[];for await(const name of world.directory.keys())objects.push(name);
  return {success,cancelReasonPreserved,causes,attemptId:s.binding.key.attemptId,publication:s.closeReport.publication,cleanupIssues:s.closeReport.cleanupIssues.map(i=>({operation:i.operation,reason:String(i.reason)})),
   record:{...record,value:undefined},selected:selected?{attemptId:selected.attemptId,objectName:selected.objectName,size:selected.size,hash:await hash(await selected.getFile())}:null,
   result:result?{size:result.output.size,durationUs:result.durationUs,videoFrames:result.videoFrames,audioPresentationSamples:result.audioPresentationSamples}:undefined,
   durationUs,timings:s.timings,objects:objects.sort(),stats:window.browserReceiverStats()};
 })();void s.work.catch(()=>{});return {attemptId:s.binding.key.attemptId};
};
window.browserReceiverStats=()=>({gated:current?.gated??false,closed:current?.closed??false,state:current?.exporter?.state,outputPhase:current?.exporter?.outputPhase,catalog:world?.catalog.stats,live:{...live}});
window.browserReceiverAbort=()=>{current.abort.abort(current.reason);current.exporter.dispose();};
window.browserReceiverUngate=()=>current.release();
window.browserReceiverWait=()=>current.work;
window.browserReceiverReleaseCase=()=>{current=undefined;};
window.browserReceiverVerifySaved=async()=>{for(const {value,hash:expected}of world.receipts.values()){if(await hash(await value.getFile())!==expected)throw Error('Published original version changed');}return world.receipts.size;};
async function receiptFile(id){
 const value=id==='lookup'?await world.catalog.lookup(current.name):world.receipts.get(id)?.value;if(!value)throw Error('Receipt unavailable');
 return value.getFile();
}
window.browserReceiverDownload=async(id)=>{
 const file=await receiptFile(id),link=document.querySelector('a');current.url=URL.createObjectURL(file);live.urls++;link.href=current.url;link.download='catalogue-'+crypto.randomUUID()+'.'+current.options.kind;link.hidden=false;return {size:file.size};
};
// Verification transport only: avoid coupling every independent decode to download UI events.
window.browserReceiverFileMeta=async id=>{current.transferFile=await receiptFile(id);return {size:current.transferFile.size};};
window.browserReceiverFileChunk=async({offset,length})=>{
 if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>65536)throw Error('Invalid verification chunk');
 const bytes=new Uint8Array(await current.transferFile.slice(offset,offset+length).arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary);
};
window.browserReceiverClearTransfer=()=>{current.transferFile=undefined;};
window.browserReceiverRevoke=()=>{if(current?.url){URL.revokeObjectURL(current.url);live.urls--;current.url=undefined;}const link=document.querySelector('a');link.removeAttribute('href');link.hidden=true;};
window.browserReceiverReopen=async()=>{await world.catalog.close();await window.browserReceiverVerifySaved();world.catalog=await openBrowserVideoCatalog(options());return window.browserReceiverStats();};
window.browserReceiverReadOnlyProbe=async kind=>{
 const before=[];for await(const name of world.directory.keys())before.push(name);const b=world.catalog.bind('probe.'+kind),stats=world.catalog.stats;
 const request={format:{mimeType:'video/'+kind,extension:kind},ifExists:'error',maxWriteBytes:4096};
 for(let i=0;i<3;i++)if(!(await b.destination.checkSupport(request)).supported)throw Error('Support unexpectedly failed');
 if((await b.destination.checkSupport({...request,ifExists:'append'})).supported)throw Error('Append was silently accepted');
 const after=[];for await(const name of world.directory.keys())after.push(name);
 if(JSON.stringify(before.sort())!==JSON.stringify(after.sort())||JSON.stringify(stats)!==JSON.stringify(world.catalog.stats))throw Error('Preflight mutated storage');
 return {readOnly:true,nativeNamedPolicy:checkNativeBrowserFileDestination()};
};
window.browserReceiverCleanupFailed=async()=>{
 const s=await world.catalog.inspect(current.binding.key.attemptId);await world.catalog.cleanup(s.attemptId,s.revision);return world.catalog.inspect(s.attemptId);
};
window.browserReceiverFinishNamespace=async remove=>{
 if(current){current.release();current.exporter.dispose();await current.exporter.closed;}await world.catalog.close();await window.browserReceiverVerifySaved();world.receipts.clear();
 const {root,directoryName,databaseName,owns,directory}=world;const stats=window.browserReceiverStats();
 if(remove){if(!owns||JSON.stringify(await root.resolve(directory))!==JSON.stringify([directoryName])||!directoryName.startsWith('canvastake-browser-video-'))throw Error('Foreign namespace cleanup refused');
  await new Promise((yes,no)=>{const req=indexedDB.deleteDatabase(databaseName);req.onsuccess=yes;req.onerror=()=>no(req.error);req.onblocked=()=>no(Error('Leaked catalogue connection'));});await root.removeEntry(directoryName,{recursive:true});
 }
 world=undefined;current=undefined;return stats;
};
