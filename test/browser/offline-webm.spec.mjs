import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {readWebm,decodeWebm,removeOpusDiscards} from './helpers/offline-webm.mjs';
import {makeOfflinePcm} from './helpers/offline-audio-input.mjs';
import {bestLag,toneStarts} from './helpers/offline-audio.mjs';

async function exportWebm(page,options){
    await page.goto('/',{waitUntil:'domcontentloaded'});
    return page.evaluate(async({samples,channels,markers=false,durations,delay=0,sourceSamples=samples,endPolicy='error'})=>{
        const{createOfflineVideoExporter}=await import('/dist/video.js');
        const{createWebCodecsVideoEncoder}=await import('/dist/video-webcodecs.js');
        const{createWebCodecsAudioEncoder}=await import('/dist/video-opus.js');
        const{createWebmMuxer}=await import('/dist/video-webm.js');
        const{makeOfflinePcm}=await import('/offline-audio-input.js');
        const ends=[],audioFactory=createWebCodecsAudioEncoder(),videoFactory=createWebCodecsVideoEncoder();
        const canvas=document.createElement('canvas');canvas.width=90;canvas.height=160;const ctx=canvas.getContext('2d');
        const config={codec:'vp8',bitstreamFormat:'vp8',width:90,height:160,bitrate:500000};
        const exporter=await createOfflineVideoExporter({video:{encoder:videoFactory,config},
            ...(channels?{audio:{encoder:{checkSupport:audioFactory.checkSupport,create(c,x){return audioFactory.create(c,{...x,output:{fail:x.output.fail,write(e){if(e.type==='end')ends.push(e);return x.output.write(e);}}});}},
                config:{codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:channels,bitrate:channels===1?128000:192000},source:{sampleRate:48000,channels:makeOfflinePcm(48000,channels,sourceSamples)},endPolicy}}:{}),
            muxer:createWebmMuxer(),maxPendingInputs:2,maxPendingBytes:1000000});
        try{
            if(!durations){const end=Math.round(samples*1e6/48000),n=markers?Math.ceil(end/1e6*30):1;durations=Array.from({length:n},(_,i)=>(i===n-1?end:Math.round((i+1)*1e6/30))-(markers?Math.round(i*1e6/30):0));}
            let time=0;
            for(let i=0;i<durations.length;i++){
                ctx.fillStyle=markers?([3,4,21,22,39,40,63,64].includes(i)?'white':'black'):['rgb(235,30,30)','rgb(30,220,30)','rgb(30,30,235)'][i%3];ctx.fillRect(0,0,90,160);
                if(delay)await new Promise(r=>setTimeout(r,delay));
                await exporter.addFrame(canvas,{timestampUs:time,durationUs:durations[i],keyFrame:i%10===0});time+=durations[i];
            }
            const result=await exporter.finish();
            return{bytes:[...new Uint8Array(await result.blob.arrayBuffer())],durationUs:result.durationUs,samples:result.audioPresentationSamples,frames:result.videoFrames,durations,ends,mime:result.mimeType,extension:result.extension};
        }finally{exporter.dispose();}
    },options);
}
async function playWebm(page,bytes,channels,samples,audioLayout){
    return page.evaluate(async({bytes,channels,samples,audioLayout})=>{
        const buffer=Uint8Array.from(bytes).buffer,url=URL.createObjectURL(new Blob([buffer],{type:'video/webm'})),video=document.createElement('video');video.muted=true;
        let timer;
        try{
            const timeout=new Promise((_,no)=>{timer=setTimeout(()=>no(new Error(`WebM playback stalled: time=${video.currentTime}, ready=${video.readyState}`)),10000);});
            const playback=(async()=>{
                const loaded=new Promise((yes,no)=>{video.onloadedmetadata=yes;video.onerror=()=>no(new Error('WebM metadata failed'));});video.src=url;await loaded;
                const duration=video.duration,ended=new Promise((yes,no)=>{video.onended=yes;video.onerror=()=>no(new Error('WebM playback failed'));});video.playbackRate=4;await video.play();await ended;return duration;
            })();
            const duration=await Promise.race([playback,timeout]);
            // A second independent container/Opus decoder checks actual presentation length, including tiny files.
            let audio;
            if(channels){
                const decoded=await new OfflineAudioContext(channels,1,48000).decodeAudioData(buffer.slice(0));
                const normalizedLeading=audioLayout.singlePacket&&audioLayout.padding>0&&decoded.length===audioLayout.presentationSamples+audioLayout.preSkip?audioLayout.preSkip:0;
                const correlations=[];
                if(samples>8192){
                    const{makeOfflinePcm}=await import('/offline-audio-input.js');
                    const reference=makeOfflinePcm(48000,channels,samples);
                    for(let c=0;c<channels;c++){
                        const plane=decoded.getChannelData(c).subarray(normalizedLeading);
                        function lag(start){
                            let best={lag:0,correlation:-1};
                            for(let offset=-2;offset<=2;offset++){
                                let dot=0,a=0,b=0;
                                for(let i=start;i<start+1024;i++){const x=reference[c][i],y=plane[i+offset];dot+=x*y;a+=x*x;b+=y*y;}
                                const correlation=dot/Math.sqrt(a*b);if(correlation>best.correlation)best={lag:offset,correlation};
                            }return best;
                        }
                        correlations.push({channel:c,first:lag(256),last:lag(Math.min(samples,decoded.length)-2048)});
                    }
                }
                audio={samples:decoded.length-normalizedLeading,rawSamples:decoded.length,normalizedLeading,channels:decoded.numberOfChannels,sampleRate:decoded.sampleRate,correlations};
            }
            return{duration,audio};
        }finally{clearTimeout(timer);video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
    },{bytes,channels,samples,audioLayout});
}
async function verify(page,testInfo,options,name){
    const result=await test.step('Export WebM',()=>exportWebm(page,options)),bytes=Buffer.from(result.bytes),path=testInfo.outputPath(name+'.webm');await writeFile(path,bytes);await testInfo.attach(name,{path,contentType:'video/webm'});
    const layout=readWebm(bytes),decoded=await test.step('Decode complete file with FFmpeg',()=>decodeWebm(path,options.channels));expect(layout.scale).toBe(1000);expect(layout.duration).toBe(result.durationUs);
    const audioTrack=layout.tracks.find(t=>t.codec==='A_OPUS'),audioBlocks=audioTrack?layout.blocks.filter(b=>b.track===audioTrack.number):[];
    const audioLayout=audioTrack?{singlePacket:audioBlocks.length===1,padding:audioBlocks.reduce((sum,b)=>sum+(b.discard??0),0),preSkip:audioTrack.head.readUInt16LE(10),presentationSamples:decoded.containerSamples}:undefined;
    const playback=await test.step('Native playback and independent Web Audio decode',()=>playWebm(page,result.bytes,options.channels,options.samples,audioLayout));result.duration=playback.duration;
    expect(result.mime).toBe('video/webm');expect(result.extension).toBe('webm');expect(Math.abs(result.duration*1e6-result.durationUs)).toBeLessThanOrEqual(1.001);
    const video=layout.tracks.find(t=>t.codec==='V_VP8'),blocks=layout.blocks.filter(b=>b.track===video.number);expect([video.width,video.height]).toEqual([90,160]);expect(blocks).toHaveLength(result.frames);expect(decoded.pts).toHaveLength(result.frames);
    let time=0;for(let i=0;i<blocks.length;i++){expect(blocks[i].time).toBe(time);if(blocks[i].duration!==undefined)expect(blocks[i].duration).toBe(result.durations[i]);expect(Math.abs(decoded.pts[i]-time)).toBeLessThan(6);time+=result.durations[i];}
    if(options.channels){
        const audio=audioTrack,end=result.ends[0];
        expect(audio.head.toString('ascii',0,8)).toBe('OpusHead');const skip=audio.head.readUInt16LE(10);expect(audio.delay).toBe(Math.round(skip*1e9/48000));expect(audio.preRoll).toBeGreaterThanOrEqual(80000000);
        const discard=audioBlocks.reduce((sum,b)=>sum+(b.discard??0),0),padding=Math.round(discard*48000/1e9);
        expect(audioBlocks.length*960-skip-padding).toBe(options.samples);expect(end.leadingDiscardSamples).toBe(skip);expect(end.trailingDiscardSamples).toBe(padding);expect(decoded.first).toBe(0);expect(decoded.planes[0].length).toBe(options.samples);
        expect(playback.audio.channels).toBe(options.channels);expect(playback.audio.sampleRate).toBe(48000);
        // Firefox Web Audio can differ by one sample; container + FFmpeg remain exact.
        expect(playback.audio.samples).toBeGreaterThan(0);expect(Math.abs(playback.audio.samples-options.samples)).toBeLessThanOrEqual(1);
        if(testInfo.project.name==='chromium'){expect(playback.audio.samples).toBe(options.samples);expect(playback.audio.normalizedLeading).toBe(0);}
        if(options.samples===1)expect(playback.audio.samples).toBe(1);
        for(const c of playback.audio.correlations)for(const lag of[c.first,c.last]){expect(lag.lag).toBe(0);expect(lag.correlation).toBeGreaterThan(0.9);}
        const reference=makeOfflinePcm(48000,options.channels,options.samples),correlations=[];
        if(options.samples>8192)for(let c=0;c<options.channels;c++){
            const first=bestLag(reference[c],decoded.planes[c]),last=bestLag(reference[c],decoded.planes[c],options.samples-4096);
            for(const lag of[first,last]){expect(lag.lag).toBe(0);expect(lag.correlation).toBeGreaterThan(0.9);}correlations.push({channel:c,first,last});
        }
        await writeFile(testInfo.outputPath(name+'-metrics.json'),JSON.stringify({samples:options.samples,end,delayNs:audio.delay,discardNs:discard,decodedSamples:decoded.planes[0].length,rawSamples:decoded.rawSamples,rawFirst:decoded.rawFirst,normalizedLeading:decoded.normalizedLeading,nativeAudio:playback.audio,correlations,durationUs:layout.duration},null,2));
    }else expect(layout.tracks.map(t=>t.codec)).toEqual(['V_VP8']);
    return{result,bytes,layout,decoded};
}
test('VP8 WebM preserves variable frame intervals and the final hold',async({page},testInfo)=>{
    await verify(page,testInfo,{durations:[33333,33334,123457,10000,700001]},'variable');
});
test('fractional WebM timing is independent of rendering delay',async({page},testInfo)=>{
    const boundary=i=>Math.round(i*1e6*1001/30000),durations=Array.from({length:30},(_,i)=>boundary(i+1)-boundary(i));durations.push(500001);
    const fast=await verify(page,testInfo,{durations},'fractional-fast'),slow=await verify(page,testInfo,{durations,delay:3},'fractional-slow');
    const intervals=layout=>layout.blocks.map(b=>[b.time,b.duration]);expect(intervals(slow.layout)).toEqual(intervals(fast.layout));
});
for(const[channels,samples]of[[1,50003],[2,120017]])test(`VP8/Opus ${channels} channel: exact direct-decoded samples, CodecDelay and DiscardPadding`,async({page},testInfo)=>{
    await verify(page,testInfo,{channels,samples},'opus');
});
test('VP8/Opus A/V markers with delayed rendering and a missing-discard negative control',async({page},testInfo)=>{
    const{result,bytes,layout,decoded}=await verify(page,testInfo,{channels:1,samples:137003,markers:true,delay:3},'av');
    const flashes=decoded.pts.filter((t,i)=>decoded.colors[i][0]>200&&(i===0||decoded.colors[i-1][0]<200)).map(us=>us/1e6),tones=toneStarts(decoded.planes[0],48000);
    expect(flashes).toHaveLength(4);expect(tones).toHaveLength(4);const shifts=tones.map((t,i)=>(t-flashes[i])*1000);for(const shift of shifts)expect(Math.abs(shift)).toBeLessThan(3);
    const bad=testInfo.outputPath('no-discards.webm');await writeFile(bad,removeOpusDiscards(bytes,layout));const negative=await decodeWebm(bad,1),rawTones=toneStarts(negative.planes[0],48000);
    expect(negative.planes[0].length).toBeGreaterThan(result.samples);expect(rawTones).toHaveLength(4);for(let i=0;i<4;i++)expect((rawTones[i]-flashes[i])*1000).toBeGreaterThan(4);
    await writeFile(testInfo.outputPath('av-sync.json'),JSON.stringify({shiftsMs:shifts,withoutDiscardMs:rawTones.map((t,i)=>(t-flashes[i])*1000)},null,2));
});

test('Opus tiny endpoints and explicit PCM trim/pad preserve decoded sample counts',async({page},testInfo)=>{
    test.setTimeout(120000);
    for(const samples of[1,647,648,649,959,960,961])await verify(page,testInfo,{channels:1,samples},'tiny-'+samples);
    await verify(page,testInfo,{channels:1,samples:2001,sourceSamples:3001,endPolicy:'trim-or-pad'},'trim');
    const padded=await verify(page,testInfo,{channels:1,samples:3001,sourceSamples:1001,endPolicy:'trim-or-pad'},'pad');
    expect(Math.max(...padded.decoded.planes[0].subarray(2500).map(Math.abs))).toBeLessThan(0.005);
    await expect(exportWebm(page,{channels:1,samples:2001,sourceSamples:2000})).rejects.toThrow(/audio|samples|length/i);
});

test('real WebM encoder cancellation and size failure close resources; retry decodes',async({page},testInfo)=>{
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('/');
    const result=await page.evaluate(async()=>{
        const{createOfflineVideoExporter}=await import('/dist/video.js');
        const{createWebCodecsVideoEncoder}=await import('/dist/video-webcodecs.js');
        const{createWebCodecsAudioEncoder}=await import('/dist/video-opus.js');
        const{createWebmMuxer}=await import('/dist/video-webm.js');
        const video={codec:'vp8',bitstreamFormat:'vp8',width:90,height:160,bitrate:500000},audio={codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:1,bitrate:128000};
        const NativeVideo=VideoEncoder,NativeAudio=AudioEncoder,resources=[];
        globalThis.VideoEncoder=class extends NativeVideo{constructor(init){super(init);resources.push(this);}};
        globalThis.AudioEncoder=class extends NativeAudio{constructor(init){super(init);resources.push(this);}};
        const canvas=document.createElement('canvas');canvas.width=90;canvas.height=160;canvas.getContext('2d').fillRect(0,0,90,160);
        const outcomes=[];
        try{
            for(const mode of['abort','limit']){
                const controller=new AbortController();let exporter;
                try{
                    exporter=await createOfflineVideoExporter({video:{config:video,encoder:createWebCodecsVideoEncoder()},audio:{config:audio,encoder:createWebCodecsAudioEncoder(),source:{sampleRate:48000,channels:[new Float32Array(4800)]},endPolicy:'error'},muxer:createWebmMuxer(),signal:controller.signal,
                        ...(mode==='limit'?{maxOutputBytes:400}:{}),onProgress(p){if(mode==='abort'&&p.audioPacketsWritten)controller.abort(new Error('requested WebM stop'));}});
                    await exporter.addFrame(canvas,{timestampUs:0,durationUs:100000});await exporter.finish();outcomes.push('unexpected success');
                }catch(e){outcomes.push([e.message,e.cause?.message,e.cause?.cause?.message].join('/'));}
                finally{exporter?.dispose();}
            }
            return{outcomes,states:resources.map(r=>r.state)};
        }finally{globalThis.VideoEncoder=NativeVideo;globalThis.AudioEncoder=NativeAudio;}
    });
    expect(result.outcomes[0]).toContain('requested WebM stop');expect(result.outcomes[1]).toContain('maxOutputBytes');expect(result.states.length).toBeGreaterThanOrEqual(2);expect(result.states.every(s=>s==='closed')).toBe(true);
    await verify(page,testInfo,{channels:1,samples:4800},'retry');
    expect(errors).toEqual([]);
});

test('offline example selects WebM with Opus and shares container runtime with MP4',async({page})=>{
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    await page.goto('/examples/offline-video.html');await page.locator('#format').selectOption('webm');await page.getByRole('button',{name:'Export WebM',exact:true}).click();
    await expect(page.locator('#download')).toBeVisible({timeout:30000});await expect(page.locator('#download')).toHaveAttribute('download','offline-video.webm');await expect(page.locator('#status')).toContainText('120 frames, 5 s');
    expect(errors).toEqual([]);
});
