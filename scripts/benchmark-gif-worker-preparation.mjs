// Compare actual 0.6.0 entry points with raw preparation, including process memory.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release, totalmem, freemem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { build, transform } from 'esbuild';
import { chromium } from '@playwright/test';
import { validateResources, validateGif, summarize, markdownReport, median } from './lib/gif-lifecycle-metrics.mjs';
import { sampleBrowserMemory } from './lib/gif-worker-memory.mjs';

const args=process.argv.slice(2);assert(args.every(a=>['--quick','--full','--throughput-study'].includes(a))&&args.length<=1,'Usage: node scripts/benchmark-gif-worker-preparation.mjs [--quick | --full | --throughput-study]');
const quick=args.includes('--quick'),full=args.includes('--full'),study=args.includes('--throughput-study'),baseline='09299d7fc184f43f661eeba105aabd9a7cbca40b';
const root=fileURLToPath(new URL('../',import.meta.url)),directory=join(root,'benchmark-results','gif-worker-preparation-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(directory,{recursive:true});
const settings={fps:20,maxColors:128,quality:'high',repeats:study?10:quick?1:3,cancelRepeats:quick?1:5,cycles:quick?2:8,
    memoryResolutions:quick?[[640,360]]:[[1280,720],[1920,1080]],seconds:quick?[1]:full?[3,10]:[3],
    resolutions:study?[[1920,1080]]:quick?[[640,360]]:[[640,360],[1280,720],[1920,1080]],cancelResolutions:quick?[[640,360]]:[[1280,720],[1920,1080]],
    scenes:study?['mixed']:quick?['gradient']:['opaque','mixed','gradient'],cancelFrame:3,cancelDelayMs:1,sampleIntervalMs:100,throughputStudy:study};
const oldSource=name=>execFileSync('git',['show',baseline+':src/'+name],{cwd:root,encoding:'utf8'});
const oldHelper=oldSource('gif-preparation.ts'),oldCore=oldSource('gif.ts'),routes=new Map(),sources={};
const beforeCore=(await build({stdin:{contents:oldCore,resolveDir:join(root,'src'),loader:'ts',sourcefile:'gif.ts'},bundle:true,write:false,format:'esm',target:'es2022',plugins:[{name:'frozen-preparation',setup(b){b.onLoad({filter:/gif-preparation\.ts$/},()=>({contents:oldHelper,loader:'ts'}));}}]})).outputFiles[0].text;
for(const name of ['gif.js','gif-worker.js','gif-worker-runtime.js','gifenc.js']){
    const current=await readFile(join(root,'dist',name),'utf8');
    const old=name==='gif.js'?beforeCore:name==='gifenc.js'?current:(await transform(oldSource(name.replace('.js','.ts')),{loader:'ts',format:'esm',target:'es2022'})).code;
    routes.set('/dist/'+name,current);routes.set('/before/dist/'+name,old);
    for(const[variant,code]of[['before',old],['after',current]]){await writeFile(join(directory,variant+'-'+name),code);sources[variant+'/'+name]=createHash('sha256').update(code).digest('hex');}
}
for(const name of ['gif-lifecycle.mjs','gif-lifecycle-worker.mjs','gif-scene.mjs'])routes.set('/benchmarks/'+name,await readFile(join(root,'benchmarks',name),'utf8'));
routes.set('/',await readFile(join(root,'benchmarks/gif-lifecycle.html'),'utf8'));
const server=createServer((req,res)=>{const path=new URL(req.url,'http://localhost').pathname;if(path==='/favicon.ico')return res.writeHead(204).end();
    if(!routes.has(path))return res.writeHead(404).end();res.writeHead(200,{'Content-Type':path==='/'?'text/html':'text/javascript','Cache-Control':'no-store','Content-Security-Policy':"worker-src 'self'"}).end(routes.get(path));});
let browser,browserCdp,page,cdp,report,activeCase;
const pages={},sessions={},rows=[],errors=[],dumpFailures=[],hashes=new Map(),observed={created:0,closed:0},pause=ms=>new Promise(r=>setTimeout(r,ms));
async function memory(){
    return sampleBrowserMemory(browserCdp,cdp,{onFailure:failure=>dumpFailures.push({...failure,activeCase})});
}
async function workersGone(){for(let i=0;i<500;i++){
    if(!(await browserCdp.send('Target.getTargets')).targetInfos.some(t=>t.type==='worker')&&observed.created===observed.closed)return;
    await pause(20);
}throw Error('Worker still alive after cleanup');}
async function checkpoint(){await workersGone();await cdp.send('HeapProfiler.collectGarbage');await page.evaluate(()=>new Promise(r=>setTimeout(r,0)));await cdp.send('HeapProfiler.collectGarbage');return memory();}
async function persist(){
    report.rows=rows;report.errors=errors;report.dumpFailures=dumpFailures;report.summary=Object.fromEntries(['before','after'].map(v=>[v,summarize(rows.filter(r=>r.variant===v))]));
    report.throughput=[];
    for(const variant of ['before','after'])for(const[width,height]of settings.resolutions)for(const scene of settings.scenes){const group=rows.filter(r=>r.lane==='throughput'&&r.variant===variant&&r.width===width&&r.scene===scene);
        if(group.length)report.throughput.push({variant,width,height,scene,n:group.length,elapsedMs:median(group.map(r=>r.elapsedMs)),schedulingP95Ms:median(group.map(r=>r.scheduling.p95Ms))});}
    await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));
    if(report.calibration){const parts=['# GIF Worker preparation comparison','',JSON.stringify(report.metadata),''];
        for(const variant of ['before','after'])parts.push('## '+variant,'',markdownReport({...report,summary:report.summary[variant],rows:rows.filter(r=>r.variant===variant)}));
        parts.push('## Unprofiled throughput','',...report.throughput.map(r=>JSON.stringify(r)));await writeFile(join(directory,'summary.md'),parts.join('\n')+'\n');}
}
async function run(parameters,{sample=false,record=true}={}){
    const options={...settings,adapter:'worker',scene:'mixed',...parameters};activeCase=parameters;page=pages[options.variant];cdp=sessions[options.variant];
    const before=await checkpoint(),initial={...observed},samples=[];let active=true,timer,result;
    const work=Promise.race([page.evaluate(opts=>window.lifecycle.run(opts),options),new Promise((_,no)=>{timer=setTimeout(()=>no(Error('Case exceeded five minutes')),300000);})]);
    void work.finally(()=>{active=false;clearTimeout(timer);}).catch(()=>{});
    const sampling=sample?(async()=>{while(active){samples.push(await memory());if(active)await pause(settings.sampleIntervalMs);}})():Promise.resolve();void sampling.catch(()=>{});
    try{
        result=await work;await sampling;const held=await checkpoint();
        const row={...parameters,adapter:'worker',scene:options.scene,fps:settings.fps,...result,before,held,samples};validateResources(row);
        assert.equal(observed.created-initial.created,1);assert.equal(observed.closed-initial.closed,1);
        if(options.variant==='before')assert.equal(row.stats.rawFrames,0);
        if(options.mode==='success'){
            assert.equal(row.stats.rawFrames,options.variant==='after'?options.frames:0,'Benchmark did not execute the intended raw/fallback path');
            if(options.variant==='after')assert.equal(row.stats.rawAttempts,options.frames);
            const bytes=Buffer.from(await page.evaluate(()=>window.lifecycle.bytes()),'base64');Object.assign(row,validateGif(bytes,options));
            const key=[options.width,options.height,options.frames,options.scene].join('/');if(hashes.has(key))assert.equal(row.sha256,hashes.get(key));else hashes.set(key,row.sha256);
            if(!report.fixtures[key]){const name=key.replaceAll('/','-')+'.gif';await writeFile(join(directory,name),bytes);report.fixtures[key]=name;}
        }
        assert.deepEqual(await page.evaluate(()=>window.lifecycle.release()),{timers:0,workers:0});row.after=await checkpoint();row.workerTargetsAfter=0;
        row.peakPrivateBytes=Math.max(before.privateFootprintBytes,held.privateFootprintBytes,...samples.map(s=>s.privateFootprintBytes));row.peakPrivateDeltaBytes=row.peakPrivateBytes-before.privateFootprintBytes;
        assert.deepEqual(errors,[]);if(record){rows.push(row);await persist();}activeCase=undefined;return row;
    }finally{active=false;clearTimeout(timer);await sampling.catch(()=>{});await page.evaluate(()=>window.lifecycle.release()).catch(()=>{});}
}
try{
    await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch();browserCdp=await browser.newBrowserCDPSession();
    for(const variant of ['before','after']){
        page=pages[variant]=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
        page.on('worker',w=>{observed.created++;w.on('close',()=>observed.closed++);});
        await page.goto('http://127.0.0.1:'+server.address().port+'/?variant='+variant);await page.waitForFunction(()=>!!window.lifecycle);sessions[variant]=await page.context().newCDPSession(page);
    }
    report={status:'running',metadata:{startedAt:new Date().toISOString(),baseline,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),packageVersion:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,
        cpu:cpus()[0].model,os:platform()+' '+release(),browser:browser.version(),node:process.version,totalMemoryBytes:totalmem(),freeMemoryAtStartBytes:freemem(),settings,sources},fixtures:{}};
    for(const variant of ['before','after'])await run({variant,mode:'success',width:study?1920:320,height:study?1080:180,frames:study?20:10},{record:false});
    const clean=await checkpoint();await page.evaluate(()=>window.lifecycle.calibration(true));const retained=await checkpoint();await page.evaluate(()=>window.lifecycle.calibration(false));const freed=await checkpoint();
    report.calibration={bytes:32*1024*1024,addedBackingBytes:retained.heap.backingStorageSize-clean.heap.backingStorageSize,remainingBackingBytes:freed.heap.backingStorageSize-clean.heap.backingStorageSize};
    assert(report.calibration.addedBackingBytes>=32*1024*1024);assert(Math.abs(report.calibration.remainingBackingBytes)<1024*1024);
    const order=repeat=>repeat%2?['after','before']:['before','after'];
    if(!study)for(const[width,height]of settings.memoryResolutions)for(const seconds of settings.seconds)for(const scene of settings.scenes)for(let repeat=0;repeat<settings.repeats;repeat++)for(const variant of order(repeat)){
        console.log('memory',variant,width,height,seconds,scene,repeat+1);await run({variant,lane:'memory',mode:'success',width,height,frames:seconds*20,scene,repeat},{sample:true});}
    if(!study)for(const[width,height]of settings.cancelResolutions)for(const mode of ['prepare','blend','encode'])for(let repeat=0;repeat<settings.cancelRepeats;repeat++)for(const variant of order(repeat)){
        console.log('cancel',variant,width,height,mode,repeat+1);await run({variant,lane:'cancel',mode,width,height,frames:0,scene:'gradient',repeat});}
    for(const[width,height]of settings.resolutions)for(const scene of settings.scenes)for(let repeat=0;repeat<settings.repeats;repeat++)for(const variant of order(repeat)){
        console.log('throughput',variant,width,height,scene,repeat+1);await run({variant,lane:'throughput',mode:'success',width,height,frames:20,scene,repeat,measureHeartbeat:true});}
    if(!study)for(let cycle=0;cycle<settings.cycles;cycle++)for(const variant of order(cycle))for(const mode of ['success','blend']){
        console.log('repeat',variant,cycle+1,mode);await run({variant,lane:'repeat',mode,width:640,height:360,frames:20,scene:'mixed',cycle});}
    report.status='complete';report.workers=observed;await persist();console.log(directory);
}catch(error){if(report){report.status='failed';report.failure={activeCase,message:error.message};await persist();}throw error;}
finally{await browser?.close();await new Promise(r=>server.close(r));}
