import {Output,StreamTarget,WebMOutputFormat,EncodedVideoPacketSource,EncodedAudioPacketSource,EncodedPacket} from 'mediabunny';
import type {MuxerFactory,MuxerConfig,VideoDescription,AudioDescription,EncodedPacket as Packet} from './video.js';

function unsupported(c:MuxerConfig):string|undefined {
    if(c.video.codec!=='vp8'||c.video.bitstreamFormat!=='vp8')return 'WebM requires vp8/vp8 video';
    if(c.audio&&(c.audio.codec!=='opus'||c.audio.bitstreamFormat!=='opus'||c.audio.sampleRate!==48000||![1,2].includes(c.audio.numberOfChannels)))return 'WebM audio requires opus/opus, 48000 Hz mono/stereo';
    return undefined;
}
const sample=(us:number)=>Math.sign(us)*Number((BigInt(Math.abs(us))*48000n+500000n)/1000000n);
const ns=(samples:number)=>Number((BigInt(samples)*1000000000n+24000n)/48000n);
/** VP8 with optional Opus; microsecond WebM timebase, CodecDelay and final DiscardPadding. */
export function createWebmMuxer():MuxerFactory {
    return {
        format:Object.freeze({mimeType:'video/webm',extension:'webm'}),
        async checkSupport(config){const reason=unsupported(config);return reason?{supported:false,reason}:{supported:true};},
        async create(config,context){
            const reason=unsupported(config);if(reason)throw new DOMException(reason,'NotSupportedError');
            let output:Output|undefined,video:EncodedVideoPacketSource|undefined,audio:EncodedAudioPacketSource|undefined;
            let videoConfig:VideoDescription|undefined,audioConfig:AudioDescription|undefined,lastAudio:Packet|undefined;
            let endedVideo=false,endedAudio=false,frames=0,videoEnd=0,audioNext:number|undefined,preSkip:number|undefined,audioSamples:number|undefined;
            let size=0,mediaBytes=0,disposed=false,outputError:Error|undefined;
            const pageSize=65536,pages=new Map<number,Uint8Array<ArrayBuffer>>();
            const guard=()=>{if(outputError)throw outputError;if(disposed||context.signal.aborted)throw context.signal.reason??new DOMException('WebM muxer disposed','AbortError');};
            function dispose():void{
                if(disposed)return;disposed=true;context.signal.removeEventListener('abort',dispose);
                const previous=output;output=undefined;video=undefined;audio=undefined;lastAudio=undefined;videoConfig=undefined;audioConfig=undefined;pages.clear();
                if(previous&&previous.state!=='finalized'&&previous.state!=='canceled')void previous.cancel().catch(()=>{});
            }
            function reserve(bytes:number):void{
                if(context.maxOutputBytes!==undefined&&bytes>context.maxOutputBytes-mediaBytes)throw new RangeError('WebM maxOutputBytes exceeded');mediaBytes+=bytes;
            }
            try{
                guard();
                const target=new StreamTarget(new WritableStream({write({data,position}){
                    // Keep the owned sink closable after a terminal error/abort. Adapter guards
                    // surface the original error; queued vendor writes must retain no more pages.
                    if(disposed||context.signal.aborted||outputError)return;
                    const end=position+data.byteLength;
                    if(context.maxOutputBytes!==undefined&&end>context.maxOutputBytes){outputError=new RangeError('WebM maxOutputBytes exceeded');return;}
                    for(let offset=0;offset<data.byteLength;){
                        const absolute=position+offset,index=Math.floor(absolute/pageSize),within=absolute%pageSize;
                        let page=pages.get(index);if(!page){page=new Uint8Array(pageSize);pages.set(index,page);}
                        const count=Math.min(pageSize-within,data.byteLength-offset);page.set(data.subarray(offset,offset+count),within);offset+=count;
                    }size=Math.max(size,end);
                }}),{chunked:false});
                target.on('write',({end})=>{if(context.maxOutputBytes!==undefined&&end>context.maxOutputBytes)outputError??=new RangeError('WebM maxOutputBytes exceeded');});
                const format=Object.assign(new WebMOutputFormat(),{canvastakeMaxPendingBytes:context.maxPendingBytes});
                output=new Output({format,target});video=new EncodedVideoPacketSource('vp8');output.addVideoTrack(video);
                if(config.audio){audio=new EncodedAudioPacketSource('opus');output.addAudioTrack(audio);}
                await output.start();guard();context.signal.addEventListener('abort',dispose,{once:true});guard();
            }catch(error){dispose();throw error;}
            async function writeAudio(packet:Packet,padding:number):Promise<void>{
                const c=audioConfig!,start=sample(packet.timestampUs);
                const coded=Object.assign(new EncodedPacket(packet.data,'key',start/48000,960/48000),{canvastakeDiscardPaddingNs:ns(padding)});
                await audio!.add(coded,{decoderConfig:{codec:'opus',sampleRate:48000,numberOfChannels:c.numberOfChannels,description:c.description as Uint8Array<ArrayBuffer>}});guard();
            }
            return {
                async write(event){
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
                        await writeAudio(lastAudio,event.trailingDiscardSamples);lastAudio=undefined;audioSamples=event.presentationSamples;endedAudio=true;audio.close();return;
                    }
                    if(endedVideo)throw new Error('WebM video ended');
                    if(event.type==='config'&&event.track==='video'){videoConfig={...event.config,color:{...event.config.color}};return;}
                    if(event.type==='end'&&event.track==='video'){endedVideo=true;video!.close();return;}
                    if(event.type!=='packet'||event.packet.track!=='video'||!videoConfig)throw new Error('WebM requires configured video packets');
                    const p=event.packet,end=p.timestampUs+p.durationUs;
                    if(p.timestampUs!==videoEnd||p.decodeTimestampUs!==p.timestampUs||Math.round(p.timestampUs/1e6*1e6)!==p.timestampUs||Math.round(p.durationUs/1e6*1e6)!==p.durationUs)throw new Error('WebM video timeline cannot be represented');
                    reserve(p.data.byteLength);
                    await video!.add(new EncodedPacket(p.data,p.type,p.timestampUs/1e6,p.durationUs/1e6),{decoderConfig:{codec:'vp8',codedWidth:videoConfig.width,codedHeight:videoConfig.height,colorSpace:videoConfig.color as VideoColorSpaceInit}});
                    guard();frames++;videoEnd=end;
                },
                async finalize(timeline){
                    guard();if(!endedVideo||frames!==timeline.videoFrames||videoEnd!==timeline.durationUs||(config.audio?!endedAudio||audioSamples!==timeline.audioPresentationSamples:timeline.audioPresentationSamples!==undefined))throw new Error('WebM final timeline mismatch');
                    await output!.finalize();guard();if(!size)throw new Error('WebM output missing');
                    const parts:Uint8Array<ArrayBuffer>[]=[];for(let offset=0;offset<size;offset+=pageSize)parts.push(pages.get(offset/pageSize)!.subarray(0,Math.min(pageSize,size-offset)));
                    const blob=new Blob(parts,{type:'video/webm'});pages.clear();return blob;
                },dispose
            };
        }
    };
}
