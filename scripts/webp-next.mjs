import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium,firefox} from '@playwright/test';
import assert from 'node:assert/strict';
import {verifyPublicWebp,waitForWorkerClosure} from './webp-public-check.mjs';
import {verify} from './webp-libwebp/oracle.mjs';
export async function prepareWebpNext(root, workspace) {
    const source = join(workspace,'node_modules/@grundyjs/canvas-take/dist'), dest = join(workspace,'public/canvastake-webp'); await mkdir(dest,{recursive:true});
    for (const name of ['webp.js','webp-worker.js','webp-worker-runtime.js','webp-worker-runtime.js.map','webp-codec.js','webp-codec.wasm']) await cp(join(source,name),join(dest,name));
    await cp(join(source,'webp-notices'),join(dest,'webp-notices'),{recursive:true});
    await cp(join(root,'test/fixtures/webp-public.mjs'),join(workspace,'app/webp-fixture.js'));
    await writeFile(join(workspace,'public/webp-preview.html'),(await readFile(join(source,'../examples/webp.html'),'utf8')).replaceAll('../dist/','/canvastake-webp/'));
}
export async function verifyWebpNext(root,workspace) {
    const output=join(root,'benchmark-results/webp-public-next');await mkdir(output,{recursive:true});
    const probe=createServer();await new Promise(yes=>probe.listen(0,'127.0.0.1',yes));const port=probe.address().port;await new Promise(yes=>probe.close(yes));
    const origin='http://127.0.0.1:'+port,server=spawn(process.execPath,[join(workspace,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let logs='';server.stdout.on('data',data=>logs=(logs+data).slice(-64000));server.stderr.on('data',data=>logs=(logs+data).slice(-64000));const exited=once(server,'exit'),results=[];
    try {
        let ready=false;for(let i=0;i<200&&server.exitCode===null;i++){try{if((await fetch(origin+'/webp/')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
        if(!ready)throw Error('Next WebP server not ready: '+logs);
        for(const [name,engine]of[['chromium',chromium],['firefox',firefox]]) {
            const browser=await engine.launch(),diagnostics={console:[],requests:[]};
            try {
                const page=await browser.newPage(),events={opened:0,closed:0},workers=[],errors=[],wasm=[];diagnostics.wasm=wasm;
                page.on('worker',w=>{events.opened++;workers.push(w);w.on('close',()=>events.closed++);});page.on('pageerror',e=>errors.push(e.message));
                page.on('console',m=>diagnostics.console.push(m.text()));page.on('request',r=>diagnostics.requests.push(r.url()));
                page.on('response',r=>{if(new URL(r.url()).pathname.endsWith('.wasm'))wasm.push({url:r.url(),status:r.status(),type:r.headers()['content-type']});});
                await page.goto(origin+'/webp/');await page.waitForFunction(()=>typeof window.runNextWebpCase==='function');const cases=[];
                for(const mode of ['bundled','package','copied']) {
                    const result=await page.evaluate(mode=>window.runNextWebpCase(mode==='copied'?{workerUrl:'/canvastake-webp/webp-worker-runtime.js',wasmUrl:'/canvastake-webp/webp-codec.wasm'}:{workerMode:mode}),mode);
                    cases.push({mode,...verifyPublicWebp(result,name)});await writeFile(join(output,name+'-'+mode+'.webp'),Uint8Array.from(result.bytes));
                    const path=new URL(workers.at(-1).url(),page.url()).pathname;if(mode==='copied')assert.equal(path,'/canvastake-webp/webp-worker-runtime.js');else assert.ok(path.startsWith('/_next/'),'Next asset URL: '+path);
                }
                const cancelled=await page.evaluate(async()=>{const abort=new AbortController(),reason=new Error('Next WebP cancellation');try{await window.runNextWebpCase({signal:abort.signal,onProgress(p){if(p.framesAccepted===1)abort.abort(reason);}});return false;}catch(error){return error===reason;}});assert.equal(cancelled,true);
                verifyPublicWebp(await page.evaluate(()=>window.runNextWebpCase()),name);
                await page.getByRole('button',{name:'Export until cancelled',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.startsWith('collecting:'));
                await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.startsWith('AbortError:'));assert.equal(await page.getByRole('link',{name:'Download WebP'}).count(),0);
                await page.getByRole('button',{name:'Export WebP',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.startsWith('finished:'));
                const downloading=page.waitForEvent('download');await page.getByRole('link',{name:'Download WebP',exact:true}).click();const saved=join(output,name+'-ui.webp');await(await downloading).saveAs(saved);
                const expected={width:7,height:3,lossless:true,frames:[0,1,2].map((frame)=>({duration:frame===2?2000:55,data:Uint8Array.from({length:84},(_,i)=>frame===0?(i%4===0||i%4===3?255:0):frame===1?(i%4===1?255:i%4===3?128:0):0)}))};
                verify(await readFile(saved),{name:'Next UI',plays:3},expected);await waitForWorkerClosure(page,events);
                await page.goto(origin+'/webp-preview.html');await page.getByRole('button',{name:'Export WebP',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('finished:'));await page.waitForFunction(()=>document.querySelector('#result').complete&&document.querySelector('#result').naturalWidth===320);
                await waitForWorkerClosure(page,events);assert.deepEqual(errors,[]);assert.ok(wasm.some(r=>r.url.includes('/_next/')));assert.ok(wasm.some(r=>r.url.includes('/canvastake-webp/')));
                assert.ok(wasm.every(r=>r.status===200||r.status===304),'WASM response status: '+JSON.stringify(wasm));
                for(const url of new Set(wasm.map(r=>r.url))) {const response=await page.request.get(url);assert.equal(response.status(),200);assert.ok(response.headers()['content-type']?.includes('application/wasm'),'WASM fresh GET MIME: '+url);}
                const manifest=JSON.parse(await readFile(join(workspace,'public/canvastake-webp/webp-notices/manifest.json'),'utf8'));
                for(const file of ['PROVENANCE.md','manifest.json',...manifest.files.filter(f=>!f.file.startsWith('webp-codec.')).map(f=>f.file)])assert.equal((await page.request.get(origin+'/canvastake-webp/webp-notices/'+file)).status(),200);
                await page.screenshot({path:join(output,name+'.png'),fullPage:true});results.push({name,version:browser.version(),cases,wasm,cancellation:true,example:true,workers:{...events},liveWorkers:page.workers().length});
                console.log('Next public WebP '+name+': emitted/package/copied Worker+WASM, native+FFmpeg decode, cancel/retry and UI passed; '+events.closed+'/'+events.opened+' Workers closed');
            }catch(error){await writeFile(join(output,name+'-failure.json'),JSON.stringify({error:String(error),...diagnostics},null,2)+'\n');throw error;}
            finally{await browser.close();}
        }
        await writeFile(join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),workspace,version:'0.7.0',browsers:results},null,2)+'\n');
    }finally{server.kill();await exited;await writeFile(join(output,'server.log'),logs);}
}
