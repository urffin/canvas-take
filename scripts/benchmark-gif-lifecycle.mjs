import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {cpus,platform,release,totalmem,freemem} from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {processMemory,validateResources,validateGif,summarize,markdownReport} from './lib/gif-lifecycle-metrics.mjs';

const args=process.argv.slice(2);
if(args.some(a=>!['--quick','--full'].includes(a))||args.includes('--quick')&&args.includes('--full'))throw new Error('Usage: npm run benchmark:gif:lifecycle -- [--quick | --full]');
const quick=args.includes('--quick'),full=args.includes('--full');
const settings={fps:20,maxColors:128,quality:'high',scene:'mixed',repeats:quick?1:3,cycles:quick?3:8,
    resolutions:quick?[[320,180],[640,360]]:full?[[640,360],[1280,720],[1920,1080]]:[[640,360],[1280,720]],
    seconds:quick?[1,2]:full?[3,10,30]:[3,10],sampleIntervalMs:100,cancelFrame:3,cancelDelayMs:1};
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=join(root,'benchmark-results','gif-lifecycle-'+new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(directory,{recursive:true});
const routes=new Map([
    ['/',new URL('../benchmarks/gif-lifecycle.html',import.meta.url)],
    ['/throughput',new URL('../benchmarks/gif.html',import.meta.url)],
    ...['gif-lifecycle.mjs','gif-lifecycle-worker.mjs','gif-scene.mjs'].map(n=>['/benchmarks/'+n,new URL('../benchmarks/'+n,import.meta.url)]),
    ...['gif.js','gifenc.js','gif-worker.js','gif-worker-runtime.js'].map(n=>['/dist/'+n,new URL('../dist/'+n,import.meta.url)])
]);
const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/favicon.ico'){res.writeHead(204).end();return;}
    if(!routes.has(path)){res.writeHead(404).end();return;}
    try{res.writeHead(200,{'Content-Type':['/','/throughput'].includes(path)?'text/html':'text/javascript','Cache-Control':'no-store','Content-Security-Policy':"worker-src 'self'"}).end(await readFile(routes.get(path)));}
    catch{res.writeHead(500).end();}
});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const errors=[],rows=[],hashes=new Map();
let browser,page,cdp,browserCdp,report;
const observed={created:0,closed:0};
async function memorySample(){
    const start=performance.now(),events=[];
    const collect=e=>{for(const item of e.value)if(item.args?.dumps?.process_totals)events.push(item);};
    browserCdp.on('Tracing.dataCollected',collect);
    try{
        await browserCdp.send('Tracing.start',{traceConfig:{includedCategories:['disabled-by-default-memory-infra'],memoryDumpConfig:{triggers:[]}}});
        const dumped=await browserCdp.send('Tracing.requestMemoryDump',{levelOfDetail:'light',deterministic:false});
        const ended=new Promise(r=>browserCdp.once('Tracing.tracingComplete',r));await browserCdp.send('Tracing.end');await ended;
        assert.equal(dumped.success,true,'Memory dump failed');
        const memory=processMemory(events);assert.ok(memory.privateFootprintBytes>0,'Private footprint unavailable');
        return{...memory,heap:await cdp.send('Runtime.getHeapUsage'),sampleMs:performance.now()-start,atMs:start};
    }finally{browserCdp.off('Tracing.dataCollected',collect);}
}
async function workersGone(){
    const start=performance.now();
    for(;;){
        const {targetInfos}=await browserCdp.send('Target.getTargets');
        if(!targetInfos.some(t=>t.type==='worker')&&observed.created===observed.closed)return;
        if(performance.now()-start>10000)throw new Error('Owned Worker still alive after cleanup');
        await pause(20);
    }
}
async function checkpoint(){
    await workersGone();
    await cdp.send('HeapProfiler.collectGarbage');await page.evaluate(()=>new Promise(r=>setTimeout(r,0)));
    await cdp.send('HeapProfiler.collectGarbage');
    return{...await memorySample(),dom:await cdp.send('Memory.getDOMCounters')};
}
async function persist(){
    report.rows=rows;report.summary=summarize(rows);
    await writeFile(join(directory,'results.json'),JSON.stringify(report,null,2));
    if(report.calibration)await writeFile(join(directory,'summary.md'),markdownReport(report));
    const fields=['lane','adapter','mode','width','height','frames','repeat','cycle','elapsedMs','bytes','sha256','peakPrivateBytes','peakPrivateDeltaBytes',
        'before.privateFootprintBytes','held.privateFootprintBytes','after.privateFootprintBytes','after.heap.usedSize','after.heap.backingStorageSize',
        'cancellation.deliveryLagMs','cancellation.settleAfterAbortMs','cancellation.deadlineToSettleMs','cancellation.phaseAtAbort'];
    await writeFile(join(directory,'results.csv'),[fields.join(','),...rows.map(row=>fields.map(f=>f.split('.').reduce((v,k)=>v?.[k],row)??'').join(','))].join('\n')+'\n');
}
async function run(parameters,{sample=false,record=true}={}){
    const options={...settings,...parameters},before=await checkpoint();
    const initialWorkers={...observed},samples=[];
    let active=true,timer,result,row;
    const work=Promise.race([
        page.evaluate(options=>window.lifecycle.run(options),options),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Lifecycle case exceeded five minutes')),300000);})
    ]);
    void work.finally(()=>{active=false;clearTimeout(timer);}).catch(()=>{});
    const sampling=sample?(async()=>{
        while(active){samples.push(await memorySample());if(active)await pause(settings.sampleIntervalMs);}
    })():Promise.resolve();
    void sampling.catch(()=>{});
    try{
        result=await work;await sampling;
        const held=await checkpoint();
        assert.equal(observed.created-initialWorkers.created,options.adapter==='worker'?1:0);
        assert.equal(observed.closed-initialWorkers.closed,options.adapter==='worker'?1:0);
        row={...parameters,scene:options.scene,fps:settings.fps,...result,before,held,samples};
        validateResources(row);
        if(options.mode==='success'){
            const bytes=Buffer.from(await page.evaluate(()=>window.lifecycle.bytes()),'base64');
            Object.assign(row,validateGif(bytes,options));
            const key=[options.width,options.height,options.frames,options.scene].join('/');
            if(hashes.has(key))assert.equal(row.sha256,hashes.get(key),'Sync/Worker/repeat GIF bytes changed');else hashes.set(key,row.sha256);
            // Save one file per configuration, not every repeated artifact.
            if(!report.fixtures[key]){const name='output-'+key.replaceAll('/','-')+'.gif';await writeFile(join(directory,name),bytes);report.fixtures[key]=name;}
        }
        const clean=await page.evaluate(()=>window.lifecycle.release());assert.deepEqual(clean,{timers:0,workers:0});
        row.after=await checkpoint();row.workerTargetsAfter=0;
        row.peakPrivateBytes=Math.max(before.privateFootprintBytes,held.privateFootprintBytes,...samples.map(s=>s.privateFootprintBytes));
        row.peakPrivateDeltaBytes=row.peakPrivateBytes-before.privateFootprintBytes;
        assert.deepEqual(errors,[],'Browser errors');
        if(record){rows.push(row);await persist();}
        return row;
    }catch(error){
        report.failedCase={parameters,result,row,message:error.message};await persist();throw error;
    }finally{
        active=false;clearTimeout(timer);await sampling.catch(()=>{});
        await page.evaluate(()=>window.lifecycle.release()).catch(()=>{});
    }
}
try{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    browser=await chromium.launch();page=await browser.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    page.on('worker',worker=>{observed.created++;worker.on('close',()=>observed.closed++);});
    await page.goto('http://127.0.0.1:'+server.address().port);await page.waitForFunction(()=>!!window.lifecycle);
    cdp=await page.context().newCDPSession(page);browserCdp=await browser.newBrowserCDPSession();
    report={status:'running',metadata:{startedAt:new Date().toISOString(),packageVersion:JSON.parse(await readFile(join(root,'package.json'),'utf8')).version,
        commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:!!execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim(),
        browser:browser.version(),node:process.version,os:platform()+' '+release(),cpu:cpus()[0]?.model,logicalCpus:cpus().length,
        totalMemoryBytes:totalmem(),freeMemoryAtStartBytes:freemem(),settings},fixtures:{},errors,rows};
    // Warm imports, JIT, trace buffers and codec paths before establishing baselines.
    for(const adapter of ['sync','worker'])await run({adapter,mode:'success',width:320,height:180,frames:10},{record:false});
    const clean=await checkpoint();
    assert.equal(await page.evaluate(()=>window.lifecycle.calibration(true)),32*1024*1024);
    const retained=await checkpoint();await page.evaluate(()=>window.lifecycle.calibration(false));const freed=await checkpoint();
    const addedBacking=retained.heap.backingStorageSize-clean.heap.backingStorageSize,remainingBacking=freed.heap.backingStorageSize-clean.heap.backingStorageSize;
    assert.ok(addedBacking>=32*1024*1024,'Profiler missed deliberately retained ArrayBuffer');assert.ok(Math.abs(remainingBacking)<1024*1024,'Calibration buffer did not release');
    report.calibration={bytes:32*1024*1024,addedBackingBytes:addedBacking,remainingBackingBytes:remainingBacking,
        addedPrivateBytes:retained.privateFootprintBytes-clean.privateFootprintBytes,remainingPrivateBytes:freed.privateFootprintBytes-clean.privateFootprintBytes};
    await persist();
    let pair=0;
    for(const [width,height] of settings.resolutions)for(const seconds of settings.seconds)for(let repeat=1;repeat<=settings.repeats;repeat++){
        for(const adapter of pair%2?['worker','sync']:['sync','worker']){
            console.log(`memory ${adapter} ${width}x${height} ${seconds}s ${repeat}/${settings.repeats}`);
            await run({lane:'memory',adapter,mode:'success',width,height,frames:seconds*settings.fps,repeat},{sample:true});
        }pair++;
    }
    for(const [width,height] of settings.resolutions)for(const mode of ['prepare','blend','encode'])for(let repeat=1;repeat<=settings.repeats;repeat++){
        for(const adapter of pair%2?['worker','sync']:['sync','worker']){
            console.log(`cancel ${mode} ${adapter} ${width}x${height} ${repeat}/${settings.repeats}`);
            await run({lane:'cancel',adapter,mode,scene:mode==='blend'?'gradient':settings.scene,width,height,frames:0,repeat});
        }pair++;
    }
    const [width,height]=settings.resolutions[0];
    for(let cycle=1;cycle<=settings.cycles;cycle++)for(const adapter of cycle%2?['sync','worker']:['worker','sync']){
        for(const mode of ['success','encode']){
            console.log(`repeat ${cycle}/${settings.cycles} ${adapter} ${mode}`);
            await run({lane:'repeat',adapter,mode,width,height,frames:2*settings.fps,cycle});
        }
    }
    // The existing throughput page still imports the extracted, unchanged renderer.
    await page.goto('http://127.0.0.1:'+server.address().port+'/throughput');
    await page.waitForFunction(()=>!!window.runBenchmark);
    const throughput=await page.evaluate(()=>window.runBenchmark({adapter:'sync',width:320,height:180,seconds:0.5,fps:20,maxColors:128,quality:'high',scene:'mixed'}));
    assert.equal(throughput.frameCount,10);assert.equal(throughput.sha256,hashes.get('320/180/10/mixed'));
    assert.deepEqual(errors,[]);assert.equal(observed.created,observed.closed);
    report.status='passed';report.workers={...observed};report.completedAt=new Date().toISOString();await persist();
    console.log(`PASS ${rows.length} cases; ${observed.closed} Workers closed. Results: ${directory}`);
}catch(error){
    if(report){report.status='failed';report.failure={message:error.message,stack:error.stack};await persist();}
    console.error(error);process.exitCode=1;
}finally{
    try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}
}
