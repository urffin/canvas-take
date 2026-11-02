import type { AudioEncodeConfig, AudioEncoderFactory, CodecEvent } from './video.js';

const RATE = 48000, FRAME = 960;
const timestamp = (samples: number) => Math.sign(samples) * Number((BigInt(Math.abs(samples)) * 1_000_000n + 24000n) / 48000n);
function nativeConfig(config: AudioEncodeConfig): AudioEncoderConfig {
    if (config.codec !== 'opus' || config.bitstreamFormat !== 'opus' || config.sampleRate !== RATE || ![1,2].includes(config.numberOfChannels)) throw new DOMException('Opus requires opus/opus, 48000 Hz mono/stereo', 'NotSupportedError');
    if (!Number.isSafeInteger(config.bitrate) || config.bitrate < 8000 || config.bitrate > 512000) throw new RangeError('Opus bitrate must be an integer in 8000..512000');
    return { codec:'opus',sampleRate:RATE,numberOfChannels:config.numberOfChannels,bitrate:config.bitrate,
        opus:{format:'opus',frameDuration:20000,usedtx:false} };
}
/** Native 48 kHz Opus, 20 ms packets, explicit OpusHead pre-skip; no per-input flush. */
export function createWebCodecsAudioEncoder(): AudioEncoderFactory {
    return {
        async checkSupport(config) {
            try {
                const native = nativeConfig(config);
                if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return {supported:false,reason:'WebCodecs AudioEncoder/AudioData unavailable'};
                return (await AudioEncoder.isConfigSupported(native)).supported ? {supported:true} : {supported:false,reason:'Native Opus configuration unsupported'};
            } catch(error) { return {supported:false,reason:error instanceof Error?error.message:String(error)}; }
        },
        create(config,context) {
            const native = nativeConfig(config), channels = config.numberOfChannels;
            if (FRAME*channels*4>context.maxPendingBytes) throw new RangeError('Opus maxPendingBytes cannot hold one input frame');
            let encoder: AudioEncoder | undefined, disposed=false, failure:unknown, flushing=false;
            let accepted=0,submitted=0,filled=0,packets=0,outputEnd:number|undefined,preSkip:number|undefined;
            let head:Uint8Array|undefined,pcm:Float32Array|undefined=new Float32Array(FRAME*channels);
            let nativeClock:'zero'|'shifted'|undefined,tail=Promise.resolve(),bytes=0,events=0;
            let rejectFailure!:(reason:unknown)=>void;
            const failed=new Promise<never>((_,reject)=>{rejectFailure=reject;});void failed.catch(()=>{});
            const wakes=new Set<()=>void>();
            const guard=()=>{if(failure!==undefined)throw failure;if(disposed||context.signal.aborted)throw context.signal.reason??new DOMException('Opus encoder disposed','AbortError');};
            const wait=async<T>(work:Promise<T>):Promise<T>=>{const value=await Promise.race([work,failed]);guard();return value;};
            function dequeue():void { for(const wake of wakes)wake();wakes.clear(); }
            function dispose():void {
                if(disposed)return;disposed=true;context.signal.removeEventListener('abort',dispose);
                rejectFailure(failure??context.signal.reason??new DOMException('Opus encoder disposed','AbortError'));
                encoder?.removeEventListener('dequeue',dequeue);if(encoder&&encoder.state!=='closed')encoder.close();
                encoder=undefined;pcm=undefined;head=undefined;dequeue();
            }
            function fail(reason:unknown):void { if(disposed||failure!==undefined)return;failure=reason instanceof Error?reason:new Error('Native Opus failed',{cause:reason});rejectFailure(failure);context.output.fail(failure); }
            function enqueue(event:CodecEvent,cost:number):void {
                if(cost>context.maxPendingBytes-bytes||events>=context.maxPendingInputs+2)throw new RangeError('Opus maxPendingBytes/maxPendingInputs output budget exceeded');
                bytes+=cost;events++;tail=tail.then(()=>{guard();return context.output.write(event);}).then(()=>{bytes-=cost;events--;});void tail.catch(fail);
            }
            try {
                guard();
                encoder=new AudioEncoder({error:fail,output(chunk,metadata){
                    if(disposed||failure!==undefined)return;
                    try {
                        guard();
                        if(metadata?.decoderConfig){
                            const c=metadata.decoderConfig,d=c.description;
                            if(!d)throw new Error('OpusHead is required to account for pre-skip');
                            const next=(ArrayBuffer.isView(d)?new Uint8Array(d.buffer,d.byteOffset,d.byteLength):new Uint8Array(d)).slice();
                            if(next.length!==19||new TextDecoder().decode(next.subarray(0,8))!=='OpusHead'||next[8]!==1||next[9]!==channels||next[18]!==0||c.codec!=='opus'||c.sampleRate!==RATE||c.numberOfChannels!==channels)throw new Error('Unsupported OpusHead/configuration');
                            const skip=next[10]|next[11]<<8;
                            if(skip>5760||(head&&next.some((n,i)=>n!==head![i])))throw new Error('Opus pre-skip/configuration changed');
                            head=next;preSkip=skip;
                            enqueue({type:'config',track:'audio',config:{codec:'opus',bitstreamFormat:'opus',sampleRate:RATE,numberOfChannels:channels,description:head}},head.byteLength+64);
                        }
                        if(preSkip===undefined)throw new Error('Opus output before pre-skip description');
                        const zero=packets*20000,shifted=timestamp(packets*FRAME-preSkip),nativeTime=chunk.timestamp;
                        if(nativeClock===undefined&&packets>0){
                            if(Math.abs(nativeTime-zero)<=1)nativeClock='zero';else if(Math.abs(nativeTime-shifted)<=1)nativeClock='shifted';else throw new Error('Opus native timestamps changed');
                        }
                        if((packets===0&&Math.abs(nativeTime)>1&&Math.abs(nativeTime-shifted)>1)||(nativeClock&&Math.abs(nativeTime-(nativeClock==='zero'?zero:shifted))>1))throw new Error('Opus native timestamps reordered or dropped');
                        if(chunk.type!=='key'||(chunk.duration!==null&&chunk.duration!==20000)||chunk.byteLength+64>context.maxPendingBytes-bytes)throw new Error('Invalid/oversized Opus packet');
                        const data=new Uint8Array(chunk.byteLength);chunk.copyTo(data);
                        const toc=data[0]>>>3,frames=(data[0]&3)===0?1:(data[0]&3)===3?(data[1]&63):2;
                        const frameSamples=toc<12?[480,960,1920,2880][toc&3]:toc<16?[480,960][toc&1]:[120,240,480,960][toc&3];
                        if(!data.length||!frames||frameSamples*frames!==FRAME)throw new Error('Opus packet is not 20 ms');
                        const start=packets++*FRAME-preSkip,end=start+FRAME;
                        if(!Number.isSafeInteger(end))throw new RangeError('Opus sample timeline overflow');
                        // Native flush can emit full packets entirely beyond the final presentation endpoint.
                        if(flushing&&start>=accepted)return;
                        enqueue({type:'packet',packet:{track:'audio',timestampUs:timestamp(start),decodeTimestampUs:timestamp(start),durationUs:timestamp(end)-timestamp(start),type:'key',data}},data.byteLength+64);
                        outputEnd=end;
                    }catch(error){fail(error);}
                }});
                encoder.configure(native);encoder.addEventListener('dequeue',dequeue);context.signal.addEventListener('abort',dispose,{once:true});guard();
            }catch(error){dispose();throw error;}
            async function submit(size:number):Promise<void>{
                while(encoder!.encodeQueueSize>=context.maxPendingInputs)await wait(new Promise<void>(resolve=>wakes.add(resolve)));
                await wait(tail);
                const data=new Float32Array(size*channels);
                for(let c=0;c<channels;c++)data.set(pcm!.subarray(c*FRAME,c*FRAME+size),c*size);
                let input:AudioData|undefined;
                try{input=new AudioData({format:'f32-planar',sampleRate:RATE,numberOfFrames:size,numberOfChannels:channels,timestamp:timestamp(submitted),data});encoder!.encode(input);}
                finally{input?.close();}
                submitted+=size;filled=0;
            }
            return {
                async encodeAudio(block){
                    guard();if(flushing||block.sampleRate!==RATE||block.sampleOffset!==accepted||block.channels.length!==channels||block.channels.some(c=>c.length!==block.channels[0].length))throw new Error('Invalid Opus input timeline/configuration');
                    for(let offset=0;offset<block.channels[0].length;){
                        const count=Math.min(FRAME-filled,block.channels[0].length-offset);
                        for(let c=0;c<channels;c++)pcm!.set(block.channels[c].subarray(offset,offset+count),c*FRAME+filled);
                        offset+=count;filled+=count;accepted+=count;if(filled===FRAME)await submit(FRAME);
                    }
                    await wait(tail);
                },
                async flush(){
                    guard();if(flushing)throw new Error('Opus track already ended');
                    flushing=true;if(filled)await submit(filled);
                    await wait(encoder!.flush());await wait(tail);
                    if(preSkip===undefined||outputEnd===undefined||outputEnd<accepted||outputEnd-accepted>=FRAME)throw new Error('Opus flush did not cover the presentation timeline');
                    await wait(context.output.write({type:'end',track:'audio',presentationSamples:accepted,leadingDiscardSamples:preSkip,trailingDiscardSamples:outputEnd-accepted}));
                },dispose
            };
        }
    };
}
