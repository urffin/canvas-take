// Private integration; no package entry point. Keep legacy Blob adapters unchanged.
import {Output,WebMOutputFormat,EncodedVideoPacketSource,EncodedAudioPacketSource,EncodedPacket} from 'mediabunny';
import type {MuxerConfig,VideoDescription,AudioDescription,EncodedPacket as Packet} from '../video.js';
import {createExternalTarget} from './video-external-target.js';
import type {ExternalVideoMuxerFactory} from './video-external-types.js';

function unsupported(c:MuxerConfig):string|undefined {
    if(c.video.codec!=='vp8'||c.video.bitstreamFormat!=='vp8')return 'WebM requires vp8/vp8 video';
    if(c.audio&&(c.audio.codec!=='opus'||c.audio.bitstreamFormat!=='opus'||c.audio.sampleRate!==48000||![1,2].includes(c.audio.numberOfChannels)))return 'WebM audio requires opus/opus, 48000 Hz mono/stereo';
    return undefined;
}
const sample=(us:number)=>Math.sign(us)*Number((BigInt(Math.abs(us))*48000n+500000n)/1000000n);
const ns=(samples:number)=>Number((BigInt(samples)*1000000000n+24000n)/48000n);
/** Private WebM streaming integration. Packet/timeline rules mirror the existing Blob adapter. */
export function createExternalWebmMuxer():ExternalVideoMuxerFactory<'webm'> {
    return {
        outputKind:'external',
        format:Object.freeze({mimeType:'video/webm',extension:'webm'}),
        async checkSupport(config){const reason=unsupported(config);return reason?{supported:false,reason}:{supported:true};},
        async create(config,context){
            const reason=unsupported(config);if(reason)throw new DOMException(reason,'NotSupportedError');
            let output:Output|undefined,video:EncodedVideoPacketSource|undefined,audio:EncodedAudioPacketSource|undefined;
            let videoConfig:VideoDescription|undefined,audioConfig:AudioDescription|undefined,lastAudio:Packet|undefined;
            let endedVideo=false,endedAudio=false,frames=0,videoEnd=0,audioNext:number|undefined,preSkip:number|undefined,audioSamples:number|undefined;
            let mediaBytes=0,disposed=false;
            const bridge=createExternalTarget(context);
            let finalizing:Promise<void>|undefined,disposing:Promise<void>|undefined;
            const pending=new Set<Promise<void>>();
            const guard=()=>{bridge.check();if(disposed||context.signal.aborted)throw context.signal.reason??new DOMException('WebM muxer disposed','AbortError');};
            const onAbort=()=>{void dispose().catch(()=>{});};
            function dispose():Promise<void>{
                if(disposing)return disposing;
                disposed=true;context.signal.removeEventListener('abort',onAbort);bridge.stop();
                const previous=output;output=undefined;video=undefined;audio=undefined;lastAudio=undefined;videoConfig=undefined;audioConfig=undefined;
                return disposing=(async()=>{
                    await Promise.allSettled([...pending]);
                    if(finalizing)await finalizing.catch(()=>{});
                    if(previous&&previous.state!=='finalized'&&previous.state!=='canceled')await previous.cancel();
                })();
            }
            function reserve(bytes:number):void{
                if(context.maxOutputBytes!==undefined&&bytes>context.maxOutputBytes-mediaBytes)throw new RangeError('WebM maxOutputBytes exceeded');mediaBytes+=bytes;
            }
            try{
                guard();
                const target=bridge.target;
                const format=Object.assign(new WebMOutputFormat(),{canvastakeMaxPendingBytes:context.maxPendingBytes});
                output=new Output({format,target});video=new EncodedVideoPacketSource('vp8');output.addVideoTrack(video);
                if(config.audio){audio=new EncodedAudioPacketSource('opus');output.addAudioTrack(audio);}
                await output.start();guard();context.signal.addEventListener('abort',onAbort,{once:true});guard();
            }catch(error){try{await dispose();}catch{}throw error;}
            async function writeAudio(packet:Packet,padding:number):Promise<void>{
                const c=audioConfig!,start=sample(packet.timestampUs);
                const coded=Object.assign(new EncodedPacket(packet.data,'key',start/48000,960/48000),{canvastakeDiscardPaddingNs:ns(padding)});
                await audio!.add(coded,{decoderConfig:{codec:'opus',sampleRate:48000,numberOfChannels:c.numberOfChannels,description:c.description as Uint8Array<ArrayBuffer>}});guard();
            }
            return {
                write(event){
                    const work=Promise.resolve().then(async()=>{
                    guard();const track=event.type==='packet'?event.packet.track:event.track;
                    if(track==='audio'){
                        if(!audio||endedAudio)throw new Error('WebM audio unavailable or ended');
                        if(event.type==='config'&&event.track==='audio'){
                            const c=event.config,d=c.description;
                            if(!d||d.length!==19||new TextDecoder().decode(d.subarray(0,8))!=='OpusHead'||d[8]!==1||d[9]!==config.audio!.numberOfChannels||d[18]!==0)throw new Error('WebM requires mono/stereo OpusHead');
                            preSkip=d[10]|d[11]<<8;if(preSkip>5760)throw new Error('WebM Opus pre-skip unsupported');audioConfig={...c,description:d.slice()};return;
                        }
                        if(!audioConfig||preSkip===undefined)throw new Error('WebM requires audio decoder configuration');
                        if(event.type==='packet'){
                            const p=event.packet,start=sample(p.timestampUs),end=sample(p.timestampUs+p.durationUs);
                            if(start!==(audioNext??-preSkip)||end-start!==960||p.timestampUs!==p.decodeTimestampUs||p.type!=='key'||p.data.byteLength+64>context.maxPendingBytes)throw new Error('WebM invalid Opus packet interval/budget');
                            reserve(p.data.byteLength);if(lastAudio)await writeAudio(lastAudio,0);lastAudio={...p,data:p.data.slice()};audioNext=end;return;
                        }
                        if(event.type!=='end'||event.track!=='audio'||!lastAudio||event.leadingDiscardSamples!==preSkip||audioNext!==event.presentationSamples+event.trailingDiscardSamples||event.trailingDiscardSamples>=960)throw new Error('WebM Opus discard accounting mismatch');
                        await writeAudio(lastAudio,event.trailingDiscardSamples);lastAudio=undefined;audioSamples=event.presentationSamples;endedAudio=true;await audio.close();return;
                    }
                    if(endedVideo)throw new Error('WebM video ended');
                    if(event.type==='config'&&event.track==='video'){videoConfig={...event.config,color:{...event.config.color}};return;}
                    if(event.type==='end'&&event.track==='video'){endedVideo=true;await video!.close();return;}
                    if(event.type!=='packet'||event.packet.track!=='video'||!videoConfig)throw new Error('WebM requires configured video packets');
                    const p=event.packet,end=p.timestampUs+p.durationUs;
                    if(p.timestampUs!==videoEnd||p.decodeTimestampUs!==p.timestampUs||Math.round(p.timestampUs/1e6*1e6)!==p.timestampUs||Math.round(p.durationUs/1e6*1e6)!==p.durationUs)throw new Error('WebM video timeline cannot be represented');
                    reserve(p.data.byteLength);
                    await video!.add(new EncodedPacket(p.data,p.type,p.timestampUs/1e6,p.durationUs/1e6),{decoderConfig:{codec:'vp8',codedWidth:videoConfig.width,codedHeight:videoConfig.height,colorSpace:videoConfig.color as VideoColorSpaceInit}});
                    guard();frames++;videoEnd=end;
                    });pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
                },
                async finalize(timeline){
                    guard();if(!endedVideo||frames!==timeline.videoFrames||videoEnd!==timeline.durationUs||(config.audio?!endedAudio||audioSamples!==timeline.audioPresentationSamples:timeline.audioPresentationSamples!==undefined))throw new Error('WebM final timeline mismatch');
                    finalizing=output!.finalize();await finalizing;guard();if(!context.output.size)throw new Error('WebM output missing');
                    return {kind:'external-container',mimeType:'video/webm',size:context.output.size};
                },dispose
            };
        }
    };
}
