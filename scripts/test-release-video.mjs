// Release smoke test: install the tarball, serve only its assets, encode full-HD portrait H.264/AAC.
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import ffmpeg from 'ffmpeg-static';
import {readAudioLayout,decodeOfflineAudio,toneStarts} from '../test/browser/helpers/offline-audio.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),npm=process.env.npm_execpath;
if(!npm)throw new Error('Use npm run test:release-video');
const workspace=await mkdtemp(join(tmpdir(),'canvastake-release-'));
const output=resolve(root,'test-results/release-video');await mkdir(output,{recursive:true});
const run=args=>execFileSync(process.execPath,[npm,...args],{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','inherit']});
let server,browser;
try{
    const [packed]=JSON.parse(execFileSync(process.execPath,[npm,'pack','--json','--pack-destination',workspace],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','inherit']}));
    assert.equal(packed.filename,packed.filename.split(/[\\/]/).at(-1));
    await writeFile(join(workspace,'package.json'),JSON.stringify({private:true,type:'module'}));
    run(['install','--offline','--ignore-scripts','--no-audit','--no-fund',join(workspace,packed.filename)]);
    const installed=join(workspace,'node_modules/@grundyjs/canvas-take');
    const pkg=JSON.parse(await readFile(join(installed,'package.json'),'utf8'));
    const candidate=JSON.parse(await readFile(join(root,'package.json'),'utf8'));assert.equal(pkg.version,candidate.version);
    const names=new Set(['video.js','video-webcodecs.js','video-mp4.js','video-aac.js','video-aac-worker.js']);
    server=createServer(async(req,res)=>{
        const path=new URL(req.url,'http://localhost').pathname;
        if(path==='/'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"worker-src 'self'"}).end('<!doctype html><title>Packed CanvasTake release check</title>');return;}
        if(path==='/favicon.ico'){res.writeHead(204).end();return;}
        const name=path.slice('/package/'.length);
        if(!path.startsWith('/package/')||!names.has(name)){res.writeHead(404).end();return;}
        try{res.writeHead(200,{'Content-Type':'text/javascript'}).end(await readFile(join(installed,'dist',name)));}catch{res.writeHead(404).end();}
    }).listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));
    browser=await chromium.launch();const page=await browser.newPage();
    page.on('console',message=>{if(message.type()==='log')console.log(message.text());});
    await page.goto('http://127.0.0.1:'+server.address().port);
    const result=await page.evaluate(async()=>{
        const {createOfflineVideoExporter}=await import('/package/video.js');
        const {createWebCodecsVideoEncoder}=await import('/package/video-webcodecs.js');
        const {createAacAudioEncoder}=await import('/package/video-aac.js');
        const {createMp4Muxer}=await import('/package/video-mp4.js');
        const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1920;const ctx=canvas.getContext('2d');
        const rate=48000,pcm=new Float32Array(rate*10),markers=[0.5,3,6,9];
        for(let i=0;i<pcm.length;i++)pcm[i]=0.02*Math.sin(i*2*Math.PI*221/rate)+(markers.some(t=>i>=t*rate&&i<(t+0.04)*rate)?0.6*Math.sin(i*2*Math.PI*2003/rate):0);
        const exporter=await createOfflineVideoExporter({
            video:{encoder:createWebCodecsVideoEncoder(),config:{codec:'avc1.42E028',bitstreamFormat:'avc',width:1080,height:1920,bitrate:8000000,frameRateHint:{numerator:30,denominator:1}}},
            audio:{encoder:createAacAudioEncoder(),config:{codec:'mp4a.40.2',bitstreamFormat:'aac',sampleRate:rate,numberOfChannels:1,bitrate:128000},source:{sampleRate:rate,channels:[pcm]},endPolicy:'error'},
            muxer:createMp4Muxer(),totalFrames:300,maxFrames:300,maxDurationUs:10000000,maxOutputBytes:64000000
        });
        try{
            const boundary=i=>Math.round(i*1e6/30);
            for(let i=0;i<300;i++){
                const flash=markers.some(t=>i===t*30||i===t*30+1);
                ctx.fillStyle=flash?'white':'#102030';ctx.fillRect(0,0,1080,1920);
                if(!flash){ctx.fillStyle='#35a7ff';ctx.fillRect(40+i*3%900,800,120,120);ctx.fillStyle='white';ctx.font='48px sans-serif';ctx.fillText(`Frame ${i+1}`,40,120);}
                await exporter.addFrame(canvas,{timestampUs:boundary(i),durationUs:boundary(i+1)-boundary(i)});
                if((i+1)%50===0)console.log(`Packed export: ${i+1}/300 frames`);
            }
            const result=await exporter.finish(),url=URL.createObjectURL(result.blob),video=document.createElement('video');video.muted=true;
            try{
                const ready=new Promise((yes,no)=>{video.onloadedmetadata=yes;video.onerror=()=>no(new Error('Packed video playback failed'));});video.src=url;await ready;
                const metadata={duration:video.duration,width:video.videoWidth,height:video.videoHeight};
                const ended=new Promise((yes,no)=>{video.onended=yes;video.onerror=()=>no(new Error('Packed video playback failed'));});video.playbackRate=4;await video.play();await ended;
                return{bytes:[...new Uint8Array(await result.blob.arrayBuffer())],metadata,frames:result.videoFrames,samples:result.audioPresentationSamples,durationUs:result.durationUs};
            }finally{video.pause();video.removeAttribute('src');video.load();URL.revokeObjectURL(url);}
        }finally{exporter.dispose();}
    });
    const bytes=Buffer.from(result.bytes),path=join(output,'portrait-1080x1920-h264-aac.mp4');await writeFile(path,bytes);
    const layout=readAudioLayout(bytes),decoded=await decodeOfflineAudio(path,1,layout);
    assert.equal(result.frames,300);assert.equal(result.samples,480000);assert.equal(result.durationUs,10000000);
    assert.deepEqual(result.metadata,{duration:10,width:1080,height:1920});
    assert.equal(layout.presentationSamples,480000);assert.equal(decoded.presentation[0].length,480000);assert.equal(decoded.audioFirst,0);
    assert.equal(decoded.videoFrames.length,300);decoded.videoFrames.forEach((time,i)=>assert.ok(Math.abs(time-i/30)<0.00001));
    const flashes=decoded.videoFrames.filter((t,i)=>decoded.videoGray[i]>200&&(i===0||decoded.videoGray[i-1]<200));
    const tones=toneStarts(decoded.presentation[0],48000);assert.equal(flashes.length,4);assert.equal(tones.length,4);
    const shifts=tones.map((t,i)=>(t-flashes[i])*1000);assert.ok(shifts.every(t=>Math.abs(t)<3));assert.ok(Math.max(...shifts)-Math.min(...shifts)<2);
    const image=execFileSync(ffmpeg,['-v','error','-nostdin','-i',path,'-map','0:v:0','-frames:v','1','-c:v','png','-f','image2pipe','pipe:1'],{maxBuffer:16*1024*1024});
    assert.equal(image.readUInt32BE(16),1080);assert.equal(image.readUInt32BE(20),1920);await writeFile(join(output,'first-frame.png'),image);
    const metrics={version:pkg.version,package:packed.filename,bytes:bytes.length,video:result.metadata,frames:result.frames,samples:result.samples,layout,avShiftsMs:shifts};
    await writeFile(join(output,'metrics.json'),JSON.stringify(metrics,null,2));console.log(JSON.stringify(metrics,null,2));
}finally{
    await browser?.close();if(server)await new Promise(r=>server.close(r));
    const parent=await realpath(tmpdir()),target=await realpath(workspace),child=relative(parent,target);
    if(!child||child.startsWith('..')||isAbsolute(child)||dirname(target)!==parent)throw new Error('Unsafe cleanup path');
    await rm(target,{recursive:true,force:true});
}
