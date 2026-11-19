import {createExternalVideoExporter} from '/dist/internal/video-external.js';
import {createExternalMp4Muxer} from '/dist/internal/video-external-mp4.js';
import {createExternalWebmMuxer} from '/dist/internal/video-external-webm.js';
import {createWebCodecsVideoEncoder} from '/dist/video-webcodecs.js';
import {createWebCodecsAudioEncoder} from '/dist/video-opus.js';
import {createAacAudioEncoder} from '/dist/video-aac.js';
import {createMp4Muxer} from '/dist/video-mp4.js';
import {createWebmMuxer} from '/dist/video-webm.js';
import {makeOfflinePcm} from '/pcm.mjs';

let current;
// Container metadata only. The native performance clock and codec scheduling stay real.
const NativeDate=globalThis.Date;globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[1735689600000]));}static now(){return 1735689600000;}};Math.random=()=>0.25;
const live={workers:0,videoEncoders:0,videoFrames:0,audioEncoders:0,audioData:0,dequeueListeners:0};
for(const [name,key]of [['Worker','workers'],['VideoEncoder','videoEncoders'],['VideoFrame','videoFrames'],['AudioEncoder','audioEncoders'],['AudioData','audioData']]){
 const Original=globalThis[name];if(!Original)continue;
 globalThis[name]=new Proxy(Original,{construct(Target,args){
  const value=Reflect.construct(Target,args,Target),method=name==='Worker'?'terminate':'close',close=value[method].bind(value);let closed=false;live[key]++;
  value[method]=()=>{if(!closed){closed=true;live[key]--;}return close();};
  if(name==='AudioEncoder'){
   const encode=value.encode.bind(value),flush=value.flush.bind(value),add=value.addEventListener.bind(value),remove=value.removeEventListener.bind(value);
   value.encode=input=>{current.inputs++;current.peakUnacknowledged=Math.max(current.peakUnacknowledged,current.inputs-current.acknowledged);const result=encode(input);current.peakNativeQueue=Math.max(current.peakNativeQueue,value.encodeQueueSize);return result;};
   value.flush=()=>{current.nativeFlushes++;return flush();};
   value.addEventListener=(name,...args)=>{if(name==='dequeue')live.dequeueListeners++;return add(name,...args);};
   value.removeEventListener=(name,...args)=>{if(name==='dequeue')live.dequeueListeners--;return remove(name,...args);};
  }
  return value;
 }});
}
async function rpc(operation,body={}){
 const response=await fetch('/rpc/'+operation,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const result=await response.json();if(!result.ok)throw Error(result.error);return result.value;
}
function waitAbort(signal){return new Promise((yes,no)=>{const abort=()=>{signal.removeEventListener('abort',abort);no(signal.reason);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
window.externalBegin=async options=>{
 if(current)throw Error('Release previous session');
 const s=current={options,phase:'feed',gated:false,inputs:0,acknowledged:0,peakUnacknowledged:0,peakNativeQueue:0,nativeFlushes:0,ends:[],closed:false};
 s.abort=new AbortController();s.reason=Error('requested cancellation');s.id=await rpc('create',options);
 const destination={kind:'positioned-transactional',checkSupport:()=>({supported:true}),async create(){await rpc('acquire',{id:s.id});return {
  ready:()=>rpc('ready',{id:s.id}),writeAt:(position,data)=>rpc('write',{id:s.id,position,data:Array.from(data)}),truncate:size=>rpc('truncate',{id:s.id,size}),
  commit:()=>rpc('commit',{id:s.id}),abort:()=>rpc('abort',{id:s.id}),release:info=>rpc('release',{id:s.id,info})
 };}};
 const kind=options.kind,channels=options.channels??1,samples=options.samples??108001,durationUs=options.silent?600001:Math.round(samples*1e6/48000);
 const factory=kind==='mp4'?createAacAudioEncoder({workerUrl:new URL('/dist/video-aac-worker.js',location.href)}):createWebCodecsAudioEncoder();
 const audio={encoder:{checkSupport:c=>factory.checkSupport(c),async create(c,ctx){
  const encoder=await factory.create(c,{...ctx,output:{fail:ctx.output.fail,async write(event){
   if(event.type==='packet'){
    if(options.scenario==='cancel-flush'&&s.phase==='flush'){s.gated=true;await waitAbort(ctx.signal);}
    await ctx.output.write(event);s.acknowledged++;return;
   }
   if(event.type==='end')s.ends.push(event);return ctx.output.write(event);
  }}});
  return {encodeAudio:b=>encoder.encodeAudio(b),flush:()=>{s.phase='flush';return encoder.flush();},dispose:()=>encoder.dispose()};
 }},config:{codec:kind==='mp4'?'mp4a.40.2':'opus',bitstreamFormat:kind==='mp4'?'aac':'opus',sampleRate:48000,numberOfChannels:channels,bitrate:channels===1?128000:192000},source:{sampleRate:48000,channels:makeOfflinePcm(48000,channels,samples)},endPolicy:'error'};
 const realMuxer=kind==='mp4'?createExternalMp4Muxer():createExternalWebmMuxer(),events=[];
 const muxer={...realMuxer,async create(config,context){s.config=config;const m=await realMuxer.create(config,context);return {...m,write(event){events.push(structuredClone(event));return m.write(event);}};}};
 const canvas=new OffscreenCanvas(90,160),ctx=canvas.getContext('2d');
 s.exporter=createExternalVideoExporter({video:{encoder:createWebCodecsVideoEncoder(),config:{codec:kind==='mp4'?'avc1.42E01F':'vp8',bitstreamFormat:kind==='mp4'?'avc':'vp8',width:90,height:160,bitrate:500000}},
  ...(options.silent?{}:{audio}),muxer,destination,signal:s.abort.signal,ifExists:options.ifExists??'replace',...(options.pendingInputs===undefined?{}:{maxPendingInputs:options.pendingInputs})});
 s.exporter.closed.then(report=>{s.closed=true;s.closeReport=report;});
 s.work=(async()=>{try{
  await s.exporter.ready;const durations=durationUs>100000?[33333,66667,durationUs-100000]:[durationUs];let timestampUs=0;
  for(const [i,length]of durations.entries()){ctx.fillStyle=['red','green','blue'][i];ctx.fillRect(0,0,90,160);await s.exporter.addFrame(canvas,{timestampUs,durationUs:length});timestampUs+=length;}
  const result=await s.exporter.finish();s.exporter.dispose();await s.exporter.closed;
  const legacy=await (kind==='mp4'?createMp4Muxer():createWebmMuxer()).create(s.config,{signal:new AbortController().signal,maxPendingInputs:options.pendingInputs??4,maxPendingBytes:16*1024*1024});
  let byteParity;try{for(const event of events)await legacy.write(event);const blob=await legacy.finalize(result);byteParity=await rpc('compare',{id:s.id,data:Array.from(new Uint8Array(await blob.arrayBuffer()))});}finally{legacy.dispose();events.length=0;}
  return {success:true,durationUs,frames:durations.length,result,byteParity,stats:window.externalStats()};
 }catch(error){s.exporter.dispose();await s.exporter.closed;const causes=[];for(let e=error;e;e=e.cause)causes.push(e.message??String(e));return {success:false,cancelReasonPreserved:error===s.reason,causes,stats:window.externalStats()};}})();void s.work.catch(()=>{});
 return {id:s.id};
};
window.externalStats=()=>{const s=current;return {phase:s.phase,gated:s.gated,closed:s.closed,publication:s.closeReport?.publication,cleanupIssues:s.closeReport?.cleanupIssues.map(i=>({operation:i.operation,reason:String(i.reason)})),inputs:s.inputs,acknowledged:s.acknowledged,peakUnacknowledged:s.peakUnacknowledged,peakNativeQueue:s.peakNativeQueue,nativeFlushes:s.nativeFlushes,ends:s.ends,live:{...live}};};
window.externalAbort=()=>current.abort.abort(current.reason);
window.externalWait=()=>current.work;
window.externalRelease=()=>{current=undefined;};
