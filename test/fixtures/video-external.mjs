export const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
export const turn=()=>new Promise(resolve=>setTimeout(resolve,0));
export function canvas(){const data=new Uint8ClampedArray([1,2,3,255]);return {width:1,height:1,data,getContext(){return {getImageData(){return {data};}};}};}
export function fixtures(hooks={},store=new Map()){
    const stats={trace:[],resources:[],transactions:[],contexts:{},frames:[],blocks:[],events:[],borrowed:[],physical:0,peakPhysical:0};
    const resource=name=>{const r={name,disposals:0,async dispose(){r.disposals++;stats.trace.push(name+'.dispose');await hooks.dispose?.(name);}};stats.resources.push(r);return r;};
    const name=hooks.name??'movie';
    const destination={kind:'positioned-transactional',checkSupport(request){stats.trace.push('destination.support');stats.request=request;return hooks.destinationSupport?.(request)??{supported:true};},async create(context){
        stats.trace.push('destination.create');stats.contexts.destination=context;
        const t={writes:0,aborts:0,releases:0,commits:0,staging:new Uint8Array(),size:0,
            async ready(signal){await hooks.ready?.(t,signal);},
            async writeAt(position,data,signal){
                t.writes++;stats.borrowed.push(data);stats.physical++;stats.peakPhysical=Math.max(stats.peakPhysical,stats.physical);
                try{await hooks.write?.(t,position,data,signal);
                    const end=position+data.length;if(end>t.staging.length){const next=new Uint8Array(end);next.set(t.staging);t.staging=next;}
                    for(let offset=0;offset<data.length;){const step=Math.min(hooks.shortWrite??data.length,data.length-offset);if(!step)throw hooks.zeroReason??new Error('No write progress');t.staging.set(data.subarray(offset,offset+step),position+offset);offset+=step;}
                }finally{stats.physical--;}
            },
            async truncate(size,signal){await hooks.truncate?.(t,size,signal);t.size=size;t.staging=t.staging.slice(0,size);},
            async commit(){t.commits++;stats.trace.push('destination.commit');if(hooks.commit)return hooks.commit(t,context,store,name);
                if(context.ifExists==='error'&&store.has(name))return {status:'not-committed',reason:new Error('Target exists')};
                store.set(name,t.staging.slice());return {status:'committed',value:Object.hasOwn(hooks,'value')?hooks.value:{name}};
            },
            async abort(reason){t.aborts++;stats.trace.push('destination.abort');t.abortReason=reason;await hooks.abort?.(t,reason);t.staging=new Uint8Array();},
            async release(context){t.releases++;stats.trace.push('destination.release');t.releaseContext=context;await hooks.release?.(t,context);}
        };stats.transactions.push(t);return hooks.acquireDestination?hooks.acquireDestination(t):t;
    }};
    const muxer={outputKind:'external',format:{mimeType:'video/mp4',extension:'mp4'},checkSupport(){stats.trace.push('muxer.support');return hooks.muxerSupport?.()??{supported:true};},create(config,context){
        stats.trace.push('muxer.create');stats.contexts.muxer=context;let position=0;
        const r=Object.assign(resource('muxer'),{
            async write(event){stats.events.push(event);await hooks.muxerWrite?.(event,context);const bytes=event.type==='packet'?new Uint8Array([2,...event.packet.data]):new Uint8Array([event.type==='config'?1:3]);await context.output.writeAt(position,bytes);position+=bytes.length;},
            async finalize(timeline){stats.timeline=timeline;if(hooks.finalizeResult)return hooks.finalizeResult(context,timeline);await hooks.finalize?.(context,timeline);await context.output.writeAt(0,new Uint8Array([9]));return hooks.container?.(context,timeline)??{kind:'external-container',mimeType:muxer.format.mimeType,size:context.output.size};}
        });return hooks.acquireMuxer?hooks.acquireMuxer(r):r;
    }};
    const video={checkSupport(){stats.trace.push('video.support');return hooks.videoSupport?.()??{supported:true};},create(c,context){
        stats.trace.push('video.create');stats.contexts.video=context;let configured=false;
        const r=Object.assign(resource('video'),{
            async encodeFrame(frame){stats.frames.push({...frame,data:frame.data.slice()});await hooks.frame?.(frame,context);
                if(!configured){configured=true;await context.output.write({type:'config',track:'video',config:{...c,color:{primaries:'bt709',transfer:'srgb',matrix:'rgb',fullRange:true}}});}
                await context.output.write(hooks.event?.({type:'packet',packet:{track:'video',timestampUs:frame.timestampUs,decodeTimestampUs:frame.timestampUs,durationUs:frame.durationUs,type:frame.keyFrame?'key':'delta',data:new Uint8Array([frame.data[0]])}})??{type:'packet',packet:{track:'video',timestampUs:frame.timestampUs,decodeTimestampUs:frame.timestampUs,durationUs:frame.durationUs,type:frame.keyFrame?'key':'delta',data:new Uint8Array([frame.data[0]])}});
            },
            async flush(){await hooks.videoFlush?.(context);if(!hooks.omitEnd)await context.output.write({type:'end',track:'video'});}
        });return hooks.acquireVideo?hooks.acquireVideo(r):r;
    }};
    const audio={checkSupport(){stats.trace.push('audio.support');return {supported:true};},create(c,context){
        stats.trace.push('audio.create');stats.contexts.audio=context;let configured=false,samples=0;
        const packet=(start,end)=>context.output.write({type:'packet',packet:{track:'audio',timestampUs:Math.round(start*1e6/c.sampleRate),decodeTimestampUs:Math.round(start*1e6/c.sampleRate),durationUs:Math.round(end*1e6/c.sampleRate)-Math.round(start*1e6/c.sampleRate),type:'key',data:new Uint8Array([4])}});
        const r=Object.assign(resource('audio'),{
            async encodeAudio(block){stats.blocks.push({...block,channels:block.channels.map(p=>p.slice())});await hooks.audio?.(block,context);
                if(!configured){configured=true;await context.output.write({type:'config',track:'audio',config:{...c}});if(hooks.leading)await packet(-hooks.leading,0);}
                const start=samples;samples+=block.channels[0].length;await packet(start,samples);
            },
            async flush(){if(hooks.trailing)await packet(samples,samples+hooks.trailing);const end={type:'end',track:'audio',presentationSamples:samples,leadingDiscardSamples:hooks.leading??0,trailingDiscardSamples:hooks.trailing??0};await context.output.write(hooks.audioEnd?.(end)??end);}
        });return hooks.acquireAudio?hooks.acquireAudio(r):r;
    }};
    const options=(extra={})=>({video:{encoder:video,config:{codec:'test-video',bitstreamFormat:'test',width:1,height:1,bitrate:1000}},muxer,destination,...extra});
    const withAudio=(length,policy='error')=>({encoder:audio,config:{codec:'test-audio',bitstreamFormat:'test',sampleRate:1000,numberOfChannels:1,bitrate:1000},source:{sampleRate:1000,channels:[new Float32Array(length).fill(0.25)]},endPolicy:policy});
    return {stats,options,withAudio,destination,muxer,video,audio,store};
}
