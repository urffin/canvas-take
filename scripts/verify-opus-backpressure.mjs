import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {join,resolve,dirname,basename,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {chromium,firefox} from '@playwright/test';
import {buildStudy} from './video-output-study/build.mjs';
import {readWebm,decodeWebm} from '../test/browser/helpers/offline-webm.mjs';
import {makeOfflinePcm} from '../test/browser/helpers/offline-audio-input.mjs';
import {bestLag} from '../test/browser/helpers/offline-audio.mjs';
const output=resolve('benchmark-results/opus-backpressure');await mkdir(output,{recursive:true});
const build=await buildStudy(output),hash=async path=>createHash('sha256').update(await readFile(path)).digest('hex');
const result={status:'running',base:'e1857789ab84a6e0820d064e5a7a1b4bd9582562',node:process.version,build,hashes:Object.fromEntries(await Promise.all(['src/video-opus.ts','dist/video-opus.js','scripts/verify-opus-backpressure.mjs','scripts/opus-backpressure/browser.mjs'].map(async p=>[p,await hash(p)]))),rows:[]};
const save=()=>writeFile(join(output,'results.json'),JSON.stringify(result,null,2)+'\n');await save();
const server=createServer(async(req,res)=>{try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Opus pressure verification</title><a hidden>Download</a><script type="module" src="/browser.mjs"></script>');return;}
    let file;
    if(path==='/browser.mjs')file=resolve('scripts/opus-backpressure/browser.mjs');
    else if(path==='/pcm.mjs')file=resolve('test/browser/helpers/offline-audio-input.mjs');
    else if(path.startsWith('/study/'))file=resolve(output,'.'+path.slice(6));
    else if(path.startsWith('/dist/'))file=resolve('dist','.'+path.slice(5));
    if(!file||!(file.startsWith(output+sep)||file.startsWith(resolve('dist')+sep)||['/browser.mjs','/pcm.mjs'].includes(path))){res.writeHead(404).end();return;}
    res.setHeader('Content-Type','text/javascript');res.end(await readFile(file));
}catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port,empty={audioEncoders:0,audioData:0,videoEncoders:0,videoFrames:0,dequeueListeners:0};
async function deadline(work){let timer;try{return await Promise.race([work,new Promise((yes,no)=>{timer=setTimeout(()=>no(Error('Opus verification did not settle within 60 seconds')),60000);})]);}finally{clearTimeout(timer);}}
const cases=[
    {id:'limit-1',pendingInputs:1,samples:108001,channels:1,delayMs:5},
    {id:'limit-2',pendingInputs:2,samples:108001,channels:1,delayMs:25},
    {id:'defaults',samples:108001,channels:1,delayMs:5},
    {id:'stereo-slow',samples:108001,channels:2,delayMs:50},
    {id:'tiny',samples:1,channels:1,delayMs:25},
    {id:'partial',samples:961,channels:2,delayMs:25},
    {id:'long-stereo',samples:1440001,channels:2,delayMs:5},
    {id:'limit-2-slowest',pendingInputs:2,samples:108001,channels:1,delayMs:100},
    ...['cancel-feed','cancel-flush','fail-flush'].flatMap(scenario=>[
        {id:scenario,scenario,pendingInputs:2,samples:108001,channels:1,delayMs:5},
        {id:scenario+'-retry',pendingInputs:2,samples:24001,channels:1,delayMs:5}
    ])
];
let activeRow;
try{for(const [name,type]of Object.entries({chromium,firefox})){
    const profile=await mkdtemp(join(tmpdir(),'canvastake-opus-pressure-'));let context;
    try{
        context=await type.launchPersistentContext(profile,{headless:true,acceptDownloads:true,...(name==='firefox'?{firefoxUserPrefs:{'gfx.webrender.software':true,'layers.acceleration.disabled':true,'dom.ipc.processPrelaunch.enabled':false}}:{})});
        assert.ok(context.pages().length<=1);const page=context.pages()[0]??await context.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
        await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof window.opusBegin==='function');
        result.browsers??={};result.browsers[name]={userAgent:await page.evaluate(()=>navigator.userAgent),windowsSoftwareRenderer:name==='firefox'};
        for(const options of cases){
            console.log(name+' '+options.id);await page.evaluate(o=>window.opusBegin(o),options);
            if(options.scenario?.startsWith('cancel')){await page.waitForFunction(()=>window.opusStats().gated);await page.evaluate(()=>window.opusAbort());}
            const row=activeRow={browser:name,...options,...await deadline(page.evaluate(()=>window.opusWait()))};
            assert.deepEqual(row.stats.live,empty);assert.equal(row.stats.gateListeners,0);assert.equal(row.stats.receiver.ownedBytes,0);assert.deepEqual(errors,[]);
            assert.ok(row.stats.peakUnacknowledged<=(options.pendingInputs??4));assert.ok(row.stats.peakNativeQueue<=(options.pendingInputs??4));
            if(options.scenario){assert.equal(row.success,false);assert.equal(row.fileExists,false);assert.equal(row.stats.receiver.commits,0);
                if(options.scenario.startsWith('cancel')){assert.equal(row.cancelReasonPreserved,true);assert.equal(row.stats.audioEnds.length,0);}
                // A later container write can fail after the audio track has already ended.
                else{assert.equal(row.injectedCausePreserved,true);assert.equal(row.stats.writeFailures,1);}
            }else{
                assert.equal(row.success,true);assert.equal(row.stats.nativeFlushes,1);assert.equal(row.stats.receiver.commits,1);assert.equal(row.stats.audioEnds.length,1);
                const meta=await page.evaluate(()=>window.opusDownload());const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download',exact:true}).click()]);const path=join(output,name+'-'+options.id+'.webm');await download.saveAs(path);
                const bytes=await readFile(path),layout=readWebm(bytes),video=layout.tracks.find(t=>t.codec==='V_VP8'),audio=layout.tracks.find(t=>t.codec==='A_OPUS'),blocks=layout.blocks.filter(b=>b.track===video.number),decoded=await decodeWebm(path,options.channels);
                assert.equal(Math.round(layout.duration*layout.scale/1000),row.durationUs);assert.equal(blocks.length,1);assert.equal(blocks[0].time,0);assert.equal(Math.round(blocks[0].duration*layout.scale/1000),row.durationUs);assert.equal(decoded.pts.length,1);
                assert.equal(decoded.containerSamples,options.samples);assert.equal(decoded.first,0);assert.ok(decoded.planes.every(p=>p.length===options.samples));
                const correlations=[];if(options.samples>8192){const pcm=makeOfflinePcm(48000,options.channels,options.samples);for(let c=0;c<options.channels;c++){const first=bestLag(pcm[c],decoded.planes[c]),last=bestLag(pcm[c],decoded.planes[c],options.samples-4096);for(const lag of [first,last]){assert.equal(lag.lag,0);assert.ok(lag.correlation>0.9);}correlations.push({first,last});}}
                row.decoded={frames:1,samples:decoded.containerSamples,rawSamples:decoded.rawSamples,normalizedLeading:decoded.normalizedLeading,preSkip:audio.head.readUInt16LE(10),correlations,bytes:meta.size};
            }
            await page.evaluate(()=>window.opusRelease());result.rows.push(row);activeRow=undefined;await save();
        }
    }finally{try{await context?.close();}finally{const target=await realpath(profile);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-opus-pressure-'));await rm(target,{recursive:true,force:true,maxRetries:8,retryDelay:100});}}
}
result.status='passed';await save();console.log('Opus pressure verification passed: '+result.rows.length+' cases');
}catch(error){result.status='failed';result.error=String(error);result.failedRow=activeRow;await save();throw error;}
finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
