import {createServer} from 'node:http';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {buildStudy} from './video-output-study/build.mjs';
import {sampleBrowserMemory} from './lib/gif-worker-memory.mjs';
import {verifyStudyFile} from './video-output-study/oracle.mjs';
import {launchStudyBrowser} from './video-output-study/browser-profile.mjs';
const root=process.cwd(),quick=process.argv.includes('--quick'),incognito=process.argv.includes('--incognito'),audioOnly=process.argv.includes('--audio-only'),controlsOnly=process.argv.includes('--controls-only'),probeOnly=process.argv.includes('--opus-probe'),output=resolve('benchmark-results/video-output-study'+(probeOnly?'-opus-probe':controlsOnly?'-controls':audioOnly?'-audio':quick?'-quick':incognito?'-incognito':''));await mkdir(output,{recursive:true});
const build=await buildStudy(output);const rows=[],controls=[],probes=[],failures=[],resultsPath=join(output,'results.json');
async function save(status){await writeFile(resultsPath,JSON.stringify({date:new Date().toISOString(),status,quick,profileMode:incognito?'incognito-memory-filesystem':'fresh-persistent-disk-profile',node:process.version,platform:process.platform,build,rows,controls,probes,failures},null,2)+'\n');}
const server=createServer(async(req,res)=>{try{
    const path=new URL(req.url,'http://localhost').pathname;if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Offline video output study</title><a hidden>Download</a><script type="module" src="/browser.mjs"></script>');return;}
    let file;if(path==='/browser.mjs')file=resolve('scripts/video-output-study/browser.mjs');else if(path.startsWith('/study/'))file=resolve(output,'.'+path.slice(6));else if(path.startsWith('/dist/'))file=resolve('dist','.'+path.slice(5));else{res.writeHead(404).end();return;}
    if(!(file.startsWith(output+sep)||file.startsWith(resolve('dist')+sep)||file===resolve('scripts/video-output-study/browser.mjs')))throw Error('Invalid path');
    res.setHeader('Content-Type','text/javascript');res.setHeader('Cache-Control','no-store');res.end(await readFile(file));
}catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
const emptyNative={encoders:0,frames:0,audioEncoders:0,audioData:0};
const cases=[];
// Alternate order each repeat. A fresh browser and one page per measured export.
if(!audioOnly&&!controlsOnly&&!probeOnly)for(let repeat=0;repeat<(quick?1:3);repeat++)for(const seconds of quick?[3,9]:[60,180])for(const kind of ['mp4','webm'])for(const mode of repeat%2?['file','blob']:['blob','file'])cases.push({kind,mode,seconds,repeat,audio:false});
// Short real-codec audio checks are separate from the video-only memory matrix.
if(!controlsOnly&&!probeOnly)for(const kind of ['mp4','webm'])for(const mode of ['blob','file'])cases.push({kind,mode,seconds:2,repeat:0,audio:true,pendingInputs:32});
try{
    await save('running');
    if(!audioOnly&&!probeOnly)for(const kind of ['mp4','webm'])for(const failureStage of ['cancel','write','commit']){
        console.log('Control '+kind+' '+failureStage);const session=await launchStudyBrowser(incognito);
        try{
            const page=session.page;await page.goto(origin);await page.waitForFunction(()=>typeof window.studySetup==='function');
            const setupResult=await page.evaluate(o=>window.studySetup(o),{kind,mode:'file',seconds:1,width:128,height:72,...(failureStage==='cancel'?{delayMs:500}:{failureStage})});
            let result=setupResult.result;
            if(!setupResult.setupFailed){const pending=page.evaluate(()=>window.studyTryAll());if(failureStage==='cancel'){await page.waitForFunction(()=>window.studyStats().receiver.ownedBytes>0);await page.evaluate(()=>window.studyAbort());}result=await pending;}
            assert.equal(result.success,false);assert.equal(result.fileExists,false);assert.equal(result.stats.receiver.ownedBytes,0);assert.deepEqual(result.stats.native,emptyNative);
            assert.equal(failureStage==='cancel'?result.sameCancelReason:result.hasInjectedCause,true);
            await page.evaluate(()=>window.studyRelease());
            const setup=await page.evaluate(o=>window.studySetup(o),{kind,mode:'file',seconds:0.5,width:128,height:72});await page.evaluate(()=>window.studyAdvance(window.studyStats().frames));await page.evaluate(()=>window.studyFinish());await page.evaluate(()=>window.studyDispose());
            const meta=await page.evaluate(()=>window.studyDownload());const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download',exact:true}).click()]);const path=join(output,kind+'-'+failureStage+'-retry.'+kind);await download.saveAs(path);
            const decoded=await verifyStudyFile(path,{kind,frames:setup.frames,durationUs:setup.durationUs,fps:24});await page.evaluate(()=>window.studyRelease());controls.push({kind,failureStage,result,retry:meta,decoded});await save('running');
        }catch(error){failures.push({kind,failureStage,error:String(error)});await save('failed');throw error;}finally{await session.close();}
    }
    if(!audioOnly&&!controlsOnly)for(const pendingInputs of [2,4,8,16,32]){
        console.log('Opus slow-output probe '+pendingInputs);const session=await launchStudyBrowser(incognito);
        try{
            const page=session.page;await page.goto(origin);await page.waitForFunction(()=>typeof window.studySetup==='function');
            const setup=await page.evaluate(o=>window.studySetup(o),{kind:'webm',mode:'file',seconds:2,width:128,height:72,audio:true,pendingInputs,delayMs:5});
            const result=await page.evaluate(()=>window.studyTryAll());let decoded;
            if(result.success){await page.evaluate(()=>window.studyDispose());await page.evaluate(()=>window.studyDownload());const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download',exact:true}).click()]);const path=join(output,'opus-budget-'+pendingInputs+'.webm');await download.saveAs(path);decoded=await verifyStudyFile(path,{kind:'webm',audio:true,frames:setup.frames,durationUs:setup.durationUs,fps:24});}
            else{assert.ok(result.causes.some(c=>c.includes('Opus maxPendingBytes/maxPendingInputs output budget exceeded')),JSON.stringify(result.causes));assert.equal(result.fileExists,false);assert.equal(result.stats.receiver.ownedBytes,0);}
            assert.deepEqual(result.stats.native,emptyNative);await page.evaluate(()=>window.studyRelease());probes.push({pendingInputs,delayMs:5,result,decoded});await save('running');
        }catch(error){failures.push({probe:pendingInputs,error:String(error)});await save('failed');throw error;}finally{await session.close();}
    }
    for(const options of cases){
        const id=[options.kind,options.mode,options.seconds,options.repeat,options.audio?'av':'video'].join('-');console.log('Starting '+id);let browser,page,session;
        const row={...options,id,width:640,height:360,fps:24,maxPendingInputs:options.pendingInputs??4,maxPendingBytes:16*1024*1024,checkpoints:[],errors:[],dumpFailures:[]};
        try{
            session=await launchStudyBrowser(incognito);browser=session.browser;page=session.page;page.setDefaultTimeout(120000);
            page.on('pageerror',e=>row.errors.push(e.message));const browserCdp=browser?await browser.newBrowserCDPSession():await session.context.newCDPSession(page),cdp=await page.context().newCDPSession(page);
            await page.goto(origin);await page.waitForFunction(()=>typeof window.studySetup==='function');row.browser=browser?.version()??(await cdp.send('Browser.getVersion')).product;row.profileMode=session.mode;
            const measure=async phase=>{const stats=await page.evaluate(()=>window.studyStats()),memory=await sampleBrowserMemory(browserCdp,cdp,{onFailure:e=>row.dumpFailures.push({phase,...e})});row.checkpoints.push({phase,stats,memory});};
            await cdp.send('HeapProfiler.collectGarbage');await measure('page-ready');
            const setup=await page.evaluate(o=>window.studySetup(o),options);row.frames=setup.frames;row.durationUs=setup.durationUs;await measure('initialized');
            const started=performance.now();
            for(const fraction of [0.25,0.5,0.75,1]){await page.evaluate(async n=>{try{return await window.studyAdvance(n);}catch(error){const chain=[];for(let e=error;e;e=e.cause)chain.push(e.message??String(e));throw Error(chain.join(' <- '));}},Math.round(row.frames*fraction));await measure('frames-'+fraction);}
            row.encodeMs=performance.now()-started;await page.evaluate(async()=>{try{return await window.studyFinish();}catch(error){const chain=[];for(let e=error;e;e=e.cause)chain.push(e.message??String(e));throw Error(chain.join(' <- '));}});await measure('finished-result-retained');
            const disposed=await page.evaluate(()=>window.studyDispose());assert.deepEqual(disposed.native,emptyNative);assert.deepEqual(row.errors,[]);await cdp.send('HeapProfiler.collectGarbage');await measure('disposed-result-retained');
            if(options.mode==='file')row.diskEvidence=await session.diskEvidence(disposed.receiver.size);
            row.result=await page.evaluate(()=>window.studyDownload());const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download',exact:true}).click()]);
            const path=join(output,id+'.'+options.kind);await download.saveAs(path);row.file=path;
            const released=await page.evaluate(()=>window.studyRelease());assert.deepEqual(released.native,emptyNative);
            for(let i=0;i<200;i++){if(!(await browserCdp.send('Target.getTargets')).targetInfos.some(t=>t.type==='worker'))break;await new Promise(r=>setTimeout(r,10));}
            assert.ok(!(await browserCdp.send('Target.getTargets')).targetInfos.some(t=>t.type==='worker'));await cdp.send('HeapProfiler.collectGarbage');await measure('released-after-download');
            // The independent decoder runs after the measured browser checkpoints.
            row.decoded=await verifyStudyFile(path,row);rows.push(row);await save('running');console.log('Passed '+id+': '+row.result.size+' bytes, '+row.frames+' decoded frames');
        }catch(error){failures.push({id,error:String(error),row});if(page)await page.screenshot({path:join(output,id+'-failure.png')}).catch(()=>{});await save('failed');throw error;}
        finally{await session?.close();}
    }
    await save('passed');console.log('Video output study passed: '+rows.length+' cases; '+resultsPath);
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
