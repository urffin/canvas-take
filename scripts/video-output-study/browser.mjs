let current;
function delay(ms,signal){return new Promise((yes,no)=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};const abort=()=>{done();no(signal.reason);};const timer=setTimeout(()=>{done();yes();},ms);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
const native={encoders:0,frames:0,audioEncoders:0,audioData:0};
for(const [name,key]of [['VideoEncoder','encoders'],['VideoFrame','frames'],['AudioEncoder','audioEncoders'],['AudioData','audioData']]){
    const Original=globalThis[name];
    globalThis[name]=new Proxy(Original,{construct(Target,args){const value=Reflect.construct(Target,args,Target),close=value.close.bind(value);native[key]++;let closed=false;value.close=()=>{if(!closed){closed=true;native[key]--;}return close();};return value;}});
}
window.studySetup=async options=>{
    if(current)throw Error('Previous study session retained');
    const module=await import('/study/'+(options.mode==='blob'?'baseline':'external')+'.mjs');
    const width=options.width??640,height=options.height??360,fps=options.fps??24,frames=Math.round(options.seconds*fps),durationUs=Math.round(frames*1e6/fps)+250000;
    const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d',{willReadFrequently:true});
    let seed=0x12345678;const textures=[];
    for(let t=0;t<8;t++){const image=ctx.createImageData(width,height),pixels=new Uint32Array(image.data.buffer);for(let i=0;i<pixels.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;pixels[i]=0xff000000|(seed&0xffffff);}textures.push(image);}
    const abort=new AbortController(),injectedError=new Error('study '+options.failureStage);let receiver,directory,handle,fileName;
    if(options.mode==='file'){
        directory=await navigator.storage.getDirectory();fileName='canvastake-output-study-'+crypto.randomUUID()+'.'+options.kind;handle=await directory.getFileHandle(fileName,{create:true});
        const writable=await handle.createWritable({keepExistingData:false});
        receiver=module.createPositionedReceiver({
            async ready(signal){if(options.delayMs)await delay(options.delayMs,signal);},
            writeAt(position,data){if(options.failureStage==='write')throw injectedError;return writable.write({type:'write',position,data});},
            truncate(size){return writable.truncate(size);},
            async commit(){if(options.failureStage==='commit')throw injectedError;await writable.close();return fileName;},
            async abort(){await writable.abort().catch(()=>{});await directory.removeEntry(fileName).catch(error=>{if(error.name!=='NotFoundError')throw error;});}
        },{signal:abort.signal,maxOutputBytes:512*1024*1024,maxWriteBytes:16*1024*1024});
    }
    globalThis.__studyStorage={current:0,peak:0,writes:0};
    let progress;
    const config={codec:options.kind==='mp4'?'avc1.42E01F':'vp8',bitstreamFormat:options.kind==='mp4'?'avc':'vp8',width,height,bitrate:options.bitrate??2000000,frameRateHint:{numerator:fps,denominator:1}};
    const cfg={video:{encoder:module.createWebCodecsVideoEncoder(),config},muxer:module.createStudyMuxer(options.kind,receiver),signal:abort.signal,totalFrames:frames,maxFrames:frames,maxDurationUs:durationUs,maxOutputBytes:512*1024*1024,maxPendingInputs:options.pendingInputs??4,maxPendingBytes:16*1024*1024,onProgress:p=>{progress=p;}};
    if(options.audio){
        const rate=48000,pcm=new Float32Array(Math.round(durationUs*rate/1e6));for(let i=0;i<pcm.length;i++)pcm[i]=0.15*Math.sin(i*2*Math.PI*440/rate);
        const audioModule=await import(options.kind==='mp4'?'/dist/video-aac.js':'/dist/video-opus.js');
        cfg.audio={encoder:options.kind==='mp4'?audioModule.createAacAudioEncoder():audioModule.createWebCodecsAudioEncoder(),config:{codec:options.kind==='mp4'?'mp4a.40.2':'opus',bitstreamFormat:options.kind==='mp4'?'aac':'opus',sampleRate:rate,numberOfChannels:1,bitrate:96000},source:{sampleRate:rate,channels:[pcm]},endPolicy:'error'};
    }
    try{
        const exporter=await module.createOfflineVideoExporter(cfg);
        current={exporter,receiver,canvas,ctx,textures,options,frames,fps,durationUs,at:0,progress:()=>progress,abort,directory,handle,fileName,result:undefined,injectedError};
        return window.studyStats();
    }catch(error){
        await receiver?.abort(error);await receiver?.settled();const chain=[];for(let e=error;e;e=e.cause)chain.push(e);
        if(options.failureStage){let fileExists=true;try{await directory.getFileHandle(fileName);}catch(e){if(e.name!=='NotFoundError')throw e;fileExists=false;}return {setupFailed:true,result:{success:false,hasInjectedCause:chain.includes(injectedError),fileExists,stats:{receiver:{...receiver.stats},native:{...native}}}};}
        throw new Error(chain.map(e=>e.message??String(e)).join(' <- '),{cause:error});
    }
};
window.studyAdvance=async until=>{
    const s=current;
    for(;s.at<until;s.at++){
        s.ctx.putImageData(s.textures[s.at%8],0,0);s.ctx.fillStyle=s.at%2?'#ffffff':'#000000';s.ctx.fillRect(s.at%s.canvas.width,0,12,16);
        const start=Math.round(s.at*1e6/s.fps),end=s.at+1===s.frames?s.durationUs:Math.round((s.at+1)*1e6/s.fps);
        await s.exporter.addFrame(s.canvas,{timestampUs:start,durationUs:end-start});
    }
    return window.studyStats();
};
window.studyStats=()=>current?{at:current.at,frames:current.frames,durationUs:current.durationUs,progress:current.progress(),storage:{...globalThis.__studyStorage},receiver:current.receiver?{state:current.receiver.state,size:current.receiver.size,...current.receiver.stats}:null,native:{...native}}:{native:{...native}};
window.studyFinish=async()=>{const s=current;s.result=await s.exporter.finish();return window.studyStats();};
window.studyDispose=async()=>{current.exporter.dispose();await current.receiver?.settled();return window.studyStats();};
window.studyAbort=()=>{const reason=new Error('study browser cancel');current.cancelReason=reason;current.abort.abort(reason);};
window.studyTryAll=async()=>{const s=current;try{await window.studyAdvance(s.frames);await window.studyFinish();return {success:true,stats:window.studyStats()};}catch(error){const chain=[];for(let e=error;e;e=e.cause)chain.push(e);await s.receiver?.settled();let fileExists=true;try{await s.directory.getFileHandle(s.fileName);}catch(e){if(e.name!=='NotFoundError')throw e;fileExists=false;}return {success:false,sameCancelReason:error===s.cancelReason,hasInjectedCause:chain.includes(s.injectedError),causes:chain.map(e=>e.message??String(e)),fileExists,state:s.exporter.state,stats:window.studyStats()};}};
window.studyDownload=async()=>{
    const s=current,file=s.result.blob??await s.handle.getFile(),link=document.querySelector('a');
    s.url=URL.createObjectURL(file);link.href=s.url;link.download='study.'+s.options.kind;link.hidden=false;
    return {size:file.size,type:file.type||s.result.output.type,frames:s.result.videoFrames,durationUs:s.result.durationUs,samples:s.result.audioPresentationSamples};
};
window.studyRelease=async()=>{
    const s=current;if(!s)return;s.exporter.dispose();if(s.url)URL.revokeObjectURL(s.url);await s.receiver?.settled();
    if(s.fileName)await s.directory.removeEntry(s.fileName).catch(e=>{if(e.name!=='NotFoundError')throw e;});
    s.textures.length=0;s.result=undefined;current=undefined;const a=document.querySelector('a');a.removeAttribute('href');a.hidden=true;return window.studyStats();
};
