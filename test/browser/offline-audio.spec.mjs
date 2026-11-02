import {test,expect} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
import {readAudioLayout,decodeOfflineAudio,bestLag,toneStarts} from './helpers/offline-audio.mjs';
import {makeOfflinePcm} from './helpers/offline-audio-input.mjs';

async function exportAv(page,options){
    await page.goto('/');
    return page.evaluate(async options=>{
        const {createOfflineVideoExporter}=await import('/dist/video.js');
        const {createWebCodecsVideoEncoder}=await import('/dist/video-webcodecs.js');
        const {createAacAudioEncoder}=await import('/dist/video-aac.js');
        const {createMp4Muxer}=await import('/dist/video-mp4.js');
        const {makeOfflinePcm}=await import('/offline-audio-input.js');
        const {rate,channels,samples,offset=0,markers=false,delay=0}=options;
        const config={codec:'avc1.42E01F',bitstreamFormat:'avc',width:90,height:160,bitrate:500000};
        const video=createWebCodecsVideoEncoder(),support=await video.checkSupport(config);if(!support.supported)return{unsupported:support.reason};
        const factory=createAacAudioEncoder(),events=[];
        const encoder={checkSupport:factory.checkSupport,create(c,x){return factory.create(c,{...x,output:{fail:x.output.fail,write(e){
            if(e.type==='end')events.push(e);return x.output.write(e);
        }}});}};
        const canvas=document.createElement('canvas');canvas.width=90;canvas.height=160;const ctx=canvas.getContext('2d');
        const exporter=await createOfflineVideoExporter({video:{encoder:video,config},
            audio:{encoder,config:{codec:'mp4a.40.2',bitstreamFormat:'aac',sampleRate:rate,numberOfChannels:channels,bitrate:channels===1?128000:192000},
                source:{sampleRate:rate,channels:makeOfflinePcm(rate,channels,samples+offset)},endPolicy:offset?'trim-or-pad':'error'},muxer:createMp4Muxer()});
        try{
            const end=Math.round(samples*1e6/rate),count=markers?Math.ceil(end/1e6*30):1;
            for(let i=0;i<count;i++){
                const start=markers?Math.round(i*1e6/30):0,stop=i===count-1?end:Math.round((i+1)*1e6/30);
                ctx.fillStyle=markers&&[3,4,21,22,39,40,63,64].includes(i)?'white':'black';ctx.fillRect(0,0,90,160);
                if(delay)await new Promise(r=>setTimeout(r,delay));
                await exporter.addFrame(canvas,{timestampUs:start,durationUs:stop-start});
            }
            const result=await exporter.finish();let playbackDuration;
            if(markers){
                const url=URL.createObjectURL(result.blob),player=document.createElement('video');player.muted=true;
                try{
                    const metadata=new Promise((resolve,reject)=>{player.onloadedmetadata=resolve;player.onerror=()=>reject(new Error('AAC/MP4 metadata failed'));});
                    player.src=url;await metadata;playbackDuration=player.duration;
                    const ended=new Promise((resolve,reject)=>{player.onended=resolve;player.onerror=()=>reject(new Error('AAC/MP4 playback failed'));});
                    player.playbackRate=4;await player.play();await ended;
                }finally{player.pause();player.removeAttribute('src');player.load();URL.revokeObjectURL(url);}
            }
            return{bytes:[...new Uint8Array(await result.blob.arrayBuffer())],samples:result.audioPresentationSamples,durationUs:result.durationUs,codec:result.audioCodec,events,playbackDuration};
        }finally{exporter.dispose();}
    },options);
}
async function verify(page,testInfo,options,name){
    const result=await exportAv(page,options);
    if(result.unsupported){expect(testInfo.project.name,result.unsupported).not.toBe('chromium');test.skip(true,result.unsupported);}
    const bytes=Buffer.from(result.bytes),path=testInfo.outputPath(name+'.mp4');await writeFile(path,bytes);await testInfo.attach(name,{path,contentType:'video/mp4'});
    const layout=readAudioLayout(bytes),decoded=await decodeOfflineAudio(path,options.channels,layout),end=result.events[0];
    expect(result.samples).toBe(options.samples);expect(result.codec).toBe('mp4a.40.2');expect(layout.scale).toBe(options.rate);
    if(options.markers)expect(Math.abs(result.playbackDuration-options.samples/options.rate)).toBeLessThan(2/57600);
    expect(layout.presentationSamples).toBe(options.samples);expect(layout.leading).toBe(end.leadingDiscardSamples);expect(layout.leading).toBe(1024);
    expect(layout.trailing).toBe(end.trailingDiscardSamples);expect(layout.trailing).toBe((1024-options.samples%1024)%1024);
    expect(decoded.audioFirst).toBe(0);expect(decoded.untrimmed[0].length).toBe(layout.packets*1024);
    expect(decoded.normal[0].length).toBe(options.samples+layout.trailing);expect(decoded.presentation[0].length).toBe(options.samples);
    expect(Math.abs(layout.editDuration/layout.movieScale-options.samples/options.rate)).toBeLessThanOrEqual(1/layout.movieScale+1e-9);
    const reference=makeOfflinePcm(options.rate,options.channels,options.samples+(options.offset??0));
    if(options.samples>8192)for(let c=0;c<options.channels;c++){
        const lag=bestLag(reference[c],decoded.presentation[c]);expect(lag.lag).toBe(0);expect(lag.correlation).toBeGreaterThan(0.9);
        const rawLag=bestLag(reference[c],decoded.untrimmed[c]);expect(rawLag.lag).toBe(layout.leading);expect(rawLag.lag).not.toBe(0);
        if((options.offset??0)>=0){
            const tail=bestLag(reference[c].subarray(0,options.samples),decoded.presentation[c],options.samples-4096);
            expect(tail.lag).toBe(0);expect(tail.correlation).toBeGreaterThan(0.9);
        }
    }
    const metrics={layout,end,normalSamples:decoded.normal[0].length,presentationSamples:decoded.presentation[0].length};
    await writeFile(testInfo.outputPath(name+'-metrics.json'),JSON.stringify(metrics,null,2));
    return{result,layout,decoded,reference,metrics};
}
for(const [rate,channels,samples]of [[44100,1,50003],[48000,2,120017]])test(`AAC ${rate} Hz ${channels} channels: exact presentation samples and measured priming`,async({page},testInfo)=>{
    await verify(page,testInfo,{rate,channels,samples},'samples');
});

test('AAC Worker cancellation, output failure and retry release resources and preserve source PCM',async({page},testInfo)=>{
    const workers=[],closed=[];page.on('worker',w=>{workers.push(w);w.on('close',()=>closed.push(w));});
    await page.goto('/');
    const result=await page.evaluate(async()=>{
        const {createOfflineVideoExporter}=await import('/dist/video.js');
        const {createWebCodecsVideoEncoder}=await import('/dist/video-webcodecs.js');
        const {createAacAudioEncoder}=await import('/dist/video-aac.js');
        const {createMp4Muxer}=await import('/dist/video-mp4.js');
        const {makeOfflinePcm}=await import('/offline-audio-input.js');
        const config={codec:'avc1.42E01F',bitstreamFormat:'avc',width:90,height:160,bitrate:500000},video=createWebCodecsVideoEncoder();
        const support=await video.checkSupport(config);if(!support.supported)return{unsupported:support.reason};
        const source=makeOfflinePcm(48000,1,48000),first=source[0][0],outcomes=[];
        const canvas=document.createElement('canvas');canvas.width=90;canvas.height=160;canvas.getContext('2d').fillRect(0,0,90,160);
        for(const mode of ['abort','limit','bad-worker','retry']){
            const controller=new AbortController();let exporter;
            try{
                exporter=await createOfflineVideoExporter({video:{encoder:video,config},
                    audio:{encoder:createAacAudioEncoder(mode==='bad-worker'?{workerUrl:'/missing-aac-worker.js'}:{}),config:{codec:'mp4a.40.2',bitstreamFormat:'aac',sampleRate:48000,numberOfChannels:1,bitrate:128000},source:{sampleRate:48000,channels:source},endPolicy:'error'},
                    muxer:createMp4Muxer(),signal:controller.signal,...(mode==='limit'?{maxOutputBytes:2000}:{}),
                    onProgress(p){if(mode==='abort'&&p.audioPacketsWritten)controller.abort(new Error('stop AAC'));}});
                await exporter.addFrame(canvas,{timestampUs:0,durationUs:1000000});await exporter.finish();outcomes.push(mode+':ok');
            }catch(e){outcomes.push(mode+':'+[e.message,e.cause?.message,e.cause?.cause?.message].filter(Boolean).join('/'));}
            finally{exporter?.dispose();}
        }
        return{outcomes,sourcePreserved:source[0].length===48000&&source[0][0]===first};
    });
    if(result.unsupported){expect(testInfo.project.name,result.unsupported).not.toBe('chromium');test.skip(true,result.unsupported);}
    expect(result.outcomes[0]).toContain('stop AAC');expect(result.outcomes[1]).toContain('maxOutputBytes');expect(result.outcomes[2]).not.toBe('bad-worker:ok');expect(result.outcomes[3]).toBe('retry:ok');
    expect(result.sourcePreserved).toBe(true);await expect.poll(()=>closed.length).toBe(workers.length);expect(workers.length).toBeGreaterThanOrEqual(3);
});
test('AAC packet boundaries, tiny audio, explicit trim and silence padding',async({page},testInfo)=>{
    test.setTimeout(90000);
    for(const samples of [1,1023,1024,1025])await verify(page,testInfo,{rate:48000,channels:1,samples},'boundary-'+samples);
    await verify(page,testInfo,{rate:44100,channels:1,samples:50003,offset:1000},'trim');
    const padded=await verify(page,testInfo,{rate:48000,channels:1,samples:50003,offset:-5000},'pad');
    let energy=0;const tail=padded.decoded.presentation[0].subarray(48000);for(const value of tail)energy+=value*value;
    expect(Math.sqrt(energy/tail.length)).toBeLessThan(0.005);
});
test('offline H.264/AAC markers stay synchronized with delayed rendering; missing priming edit is detected',async({page},testInfo)=>{
    const options={rate:48000,channels:1,samples:137003,markers:true,delay:3};
    const {decoded,layout}=await verify(page,testInfo,options,'av-markers');
    const flashes=decoded.videoFrames.filter((time,i)=>decoded.videoGray[i]>200&&(i===0||decoded.videoGray[i-1]<200));
    const tones=toneStarts(decoded.presentation[0],options.rate),untrimmed=toneStarts(decoded.untrimmed[0],options.rate);
    expect(flashes).toHaveLength(4);expect(tones).toHaveLength(4);expect(untrimmed).toHaveLength(4);
    const shifts=tones.map((t,i)=>(t-flashes[i])*1000),negative=untrimmed.map((t,i)=>(t-flashes[i])*1000);
    for(const shift of shifts)expect(Math.abs(shift)).toBeLessThan(3);
    expect(Math.max(...shifts)-Math.min(...shifts)).toBeLessThan(2);
    for(const shift of negative)expect(shift).toBeGreaterThan(15);
    await writeFile(testInfo.outputPath('av-sync.json'),JSON.stringify({shiftsMs:shifts,ignoredEditShiftsMs:negative,priming:layout.leading},null,2));
});
