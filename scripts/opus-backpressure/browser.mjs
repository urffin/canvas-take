import {createOfflineVideoExporter,createStudyMuxer,createPositionedReceiver,createWebCodecsVideoEncoder} from '/study/external.mjs';
import {createWebCodecsAudioEncoder} from '/dist/video-opus.js';
import {makeOfflinePcm} from '/pcm.mjs';
let current;
const live={audioEncoders:0,audioData:0,videoEncoders:0,videoFrames:0,dequeueListeners:0};
for(const [name,key]of [['AudioEncoder','audioEncoders'],['AudioData','audioData'],['VideoEncoder','videoEncoders'],['VideoFrame','videoFrames']]){
    const Original=globalThis[name];
    globalThis[name]=new Proxy(Original,{construct(Target,args){
        const value=Reflect.construct(Target,args,Target),close=value.close.bind(value);let closed=false;live[key]++;
        value.close=()=>{if(!closed){closed=true;live[key]--;}return close();};
        if(name==='AudioEncoder'){
            const encode=value.encode.bind(value),flush=value.flush.bind(value),add=value.addEventListener.bind(value),remove=value.removeEventListener.bind(value);
            value.encode=input=>{current.inputs++;current.peakUnacknowledged=Math.max(current.peakUnacknowledged,current.inputs-current.acknowledged);const result=encode(input);current.peakNativeQueue=Math.max(current.peakNativeQueue,value.encodeQueueSize);return result;};
            value.flush=()=>{current.phase='flush';current.nativeFlushes++;return flush();};
            value.addEventListener=(name,...args)=>{if(name==='dequeue')live.dequeueListeners++;return add(name,...args);};
            value.removeEventListener=(name,...args)=>{if(name==='dequeue')live.dequeueListeners--;return remove(name,...args);};
        }
        return value;
    }});
}
function waitForAbort(signal){return new Promise((yes,no)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);current.gateListeners--;no(signal.reason);};
    current.gateListeners++;signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
});}
window.opusBegin=async options=>{
    if(current)throw Error('Release previous export');
    const s=current={options,inputs:0,acknowledged:0,peakUnacknowledged:0,peakNativeQueue:0,nativeFlushes:0,phase:'feed',gated:false,gateListeners:0,audioEnds:[],writes:0,writeFailures:0};
    s.abort=new AbortController();s.cancelReason=new Error('requested '+options.scenario);s.injectedError=new Error('injected flush write failure');
    s.directory=await navigator.storage.getDirectory();s.name='canvastake-opus-pressure-'+crypto.randomUUID()+'.webm';s.handle=await s.directory.getFileHandle(s.name,{create:true});
    const writable=await s.handle.createWritable({keepExistingData:false});
    s.receiver=createPositionedReceiver({
        async ready(signal){if(options.delayMs)await new Promise((yes,no)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};const abort=()=>{done();no(signal.reason);};const timer=setTimeout(()=>{done();yes();},options.delayMs);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});},
        writeAt(position,data){if(options.scenario==='fail-flush'&&s.phase==='flush'){s.writeFailures++;throw s.injectedError;}s.writes++;return writable.write({type:'write',position,data});},
        truncate(size){return writable.truncate(size);},
        async commit(){await writable.close();return s.name;},
        async abort(){await writable.abort().catch(()=>{});await s.directory.removeEntry(s.name).catch(error=>{if(error.name!=='NotFoundError')throw error;});}
    },{signal:s.abort.signal});
    const audio=createWebCodecsAudioEncoder(),durationUs=Math.round(options.samples*1e6/48000);
    const canvas=new OffscreenCanvas(90,160);canvas.getContext('2d').fillRect(0,0,90,160);
    s.exporter=await createOfflineVideoExporter({video:{encoder:createWebCodecsVideoEncoder(),config:{codec:'vp8',bitstreamFormat:'vp8',width:90,height:160,bitrate:500000}},
        audio:{encoder:{checkSupport:audio.checkSupport,create(config,context){return audio.create(config,{...context,output:{fail:context.output.fail,async write(event){
            if(event.type==='packet'){
                if((options.scenario==='cancel-feed'&&s.phase==='feed')||(options.scenario==='cancel-flush'&&s.phase==='flush')){s.gated=true;await waitForAbort(context.signal);}
                await context.output.write(event);s.acknowledged++;return;
            }
            if(event.type==='end')s.audioEnds.push(event);return context.output.write(event);
        }}});}},config:{codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:options.channels,bitrate:options.channels===1?128000:192000},source:{sampleRate:48000,channels:makeOfflinePcm(48000,options.channels,options.samples)},endPolicy:'error'},
        muxer:createStudyMuxer('webm',s.receiver),signal:s.abort.signal,
        // Omitted options exercise the controller's actual defaults (4 / 16 MiB).
        ...(options.pendingInputs===undefined?{}:{maxPendingInputs:options.pendingInputs})});
    s.work=(async()=>{try{
        await s.exporter.addFrame(canvas,{timestampUs:0,durationUs});s.result=await s.exporter.finish();
        s.exporter.dispose();await s.receiver.settled();return {success:true,durationUs,stats:window.opusStats()};
    }catch(error){
        s.exporter.dispose();await s.receiver.settled();let fileExists=true;try{await s.directory.getFileHandle(s.name);}catch(e){if(e.name!=='NotFoundError')throw e;fileExists=false;}
        const causes=[];for(let e=error;e;e=e.cause)causes.push(e);
        return {success:false,cancelReasonPreserved:error===s.cancelReason,injectedCausePreserved:causes.includes(s.injectedError),causes:causes.map(e=>e.message??String(e)),fileExists,stats:window.opusStats()};
    }})();void s.work.catch(()=>{});return {ready:true};
};
window.opusStats=()=>{const s=current;return {inputs:s.inputs,acknowledged:s.acknowledged,peakUnacknowledged:s.peakUnacknowledged,peakNativeQueue:s.peakNativeQueue,nativeFlushes:s.nativeFlushes,phase:s.phase,gated:s.gated,gateListeners:s.gateListeners,audioEnds:s.audioEnds,writes:s.writes,writeFailures:s.writeFailures,receiver:{state:s.receiver.state,size:s.receiver.size,...s.receiver.stats},live:{...live}};};
window.opusAbort=()=>current.abort.abort(current.cancelReason);
window.opusWait=()=>current.work;
window.opusDownload=async()=>{const file=await current.handle.getFile(),link=document.querySelector('a');current.url=URL.createObjectURL(file);link.href=current.url;link.download='opus.webm';link.hidden=false;return {size:file.size};};
window.opusRelease=async()=>{const s=current;if(!s)return;s.exporter?.dispose();await s.receiver?.settled();if(s.url)URL.revokeObjectURL(s.url);await s.directory.removeEntry(s.name).catch(e=>{if(e.name!=='NotFoundError')throw e;});current=undefined;document.querySelector('a').removeAttribute('href');};
