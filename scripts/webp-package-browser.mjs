import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {chromium,firefox} from '@playwright/test';
import assert from 'node:assert/strict';
import {verifyPublicWebp,waitForWorkerClosure} from './webp-public-check.mjs';
import {inspect} from './webp-libwebp/oracle.mjs';
export async function verifyWebpPackage(root,dist) {
    const output=join(root,'benchmark-results/webp-public-package');await mkdir(output,{recursive:true});
    const server=createServer(async(req,res)=>{
        try {
            res.setHeader('Content-Security-Policy',"worker-src 'self'");const path=new URL(req.url,'http://localhost').pathname;
            if(path==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Installed WebP consumer</title><script type="importmap">'+JSON.stringify({imports:{'@grundyjs/canvas-take/webp':'/dist/webp.js','@grundyjs/canvas-take/webp/worker':'/dist/webp-worker.js'}})+'</script>');return;}
            let file;
            if(path.startsWith('/dist/')) {file=resolve(dist,'.'+path.slice('/dist'.length));if(!file.startsWith(resolve(dist)+sep))throw Error('Invalid asset path');}
            else if(path==='/fixture.mjs')file=join(root,'test/fixtures/webp-public.mjs');
            else if(path==='/examples/webp.html')file=join(dist,'../examples/webp.html');
            else if(path==='/copied/runtime.js')file=join(dist,'webp-worker-runtime.js');
            else if(path==='/copied/webp-codec.js')file=join(dist,'webp-codec.js');
            else if(path==='/separate/codec.wasm')file=join(dist,'webp-codec.wasm');
            else {res.writeHead(404).end();return;}
            const data=await readFile(file);res.setHeader('Content-Type',file.endsWith('.html')?'text/html':file.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(data);
        }catch{res.writeHead(404).end();}
    });
    await new Promise((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
    const origin='http://127.0.0.1:'+server.address().port,results=[];
    const version=JSON.parse(await readFile(join(dist,'../package.json'),'utf8')).version;
    await writeFile(join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),version,status:'running',browsers:[]},null,2)+'\n');
    try {
        for(const [name,engine]of[['chromium',chromium],['firefox',firefox]]) {
            const diagnostics={console:[],requests:[],responses:[],requestFailures:[],navigations:[],pageErrors:[]},events={opened:0,closed:0};let browser,page;
            try {
                browser=await engine.launch();page=await browser.newPage();
                page.on('worker',worker=>{events.opened++;worker.on('close',()=>events.closed++);});page.on('pageerror',error=>diagnostics.pageErrors.push(error.message));
                page.on('console',message=>diagnostics.console.push(message.text()));page.on('request',request=>diagnostics.requests.push(request.url()));
                page.on('response',response=>diagnostics.responses.push({url:response.url(),status:response.status()}));
                page.on('requestfailed',request=>diagnostics.requestFailures.push({url:request.url(),error:request.failure()}));
                page.on('framenavigated',frame=>diagnostics.navigations.push(frame.url()));
                await page.goto(origin);const cases=[];
                for(const options of [{},{plays:1,delays:[2000]},{plays:0,delays:[1,10,11]},{workerUrl:'/copied/runtime.js',wasmUrl:'/separate/codec.wasm'}]) {
                    diagnostics.phase='export-'+(cases.length+1);
                    const result=await page.evaluate(async o=>(await import('/fixture.mjs')).exportWebpCase(o),options);cases.push(verifyPublicWebp(result,name));
                    await writeFile(join(output,name+'-'+cases.length+'.webp'),Uint8Array.from(result.bytes));
                }
                await waitForWorkerClosure(page,events);diagnostics.phase='cancel-after-admission';const beforeCancel=events.opened;
                const cancellation=await page.evaluate(async()=>{
                    const {exportWebpCase}=await import('/fixture.mjs'),abort=new AbortController(),reason=new Error('packed cancellation'),phases=[];
                    try{await exportWebpCase({signal:abort.signal,onProgress(p){phases.push(p.phase);if(p.phase==='collecting'&&p.framesAccepted===1)abort.abort(reason);}});return {producedResult:true,phases};}
                    catch(error){return {producedResult:false,sameReason:error===reason,phases};}
                });assert.equal(cancellation.producedResult,false);assert.equal(cancellation.sameReason,true);assert.deepEqual(cancellation.phases,['collecting','aborted']);assert.equal(events.opened,beforeCancel+1);
                await waitForWorkerClosure(page,events);diagnostics.phase='decoded-retry';const beforeRetry=events.opened;
                const retried=await page.evaluate(async()=>(await import('/fixture.mjs')).exportWebpCase({plays:1,delays:[70,90,2100]}));
                const retry=verifyPublicWebp(retried,name);assert.equal(events.opened,beforeRetry+1);assert.equal(retry.plays,1);assert.equal(retry.durationMs,2260);
                await writeFile(join(output,name+'-retry.webp'),Uint8Array.from(retried.bytes));await waitForWorkerClosure(page,events);
                diagnostics.phase='example-download';await page.goto(origin+'/examples/webp.html');await page.getByRole('button',{name:'Export WebP',exact:true}).click();
                await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('finished:'));
                await page.waitForFunction(()=>document.querySelector('#result').complete&&document.querySelector('#result').naturalWidth===320);
                diagnostics.example=await page.locator('#download').evaluate(link=>({href:link.href,download:link.download,hidden:link.hidden}));
                const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'Download WebP',exact:true}).click()]);const saved=join(output,name+'-example.webp');await download.saveAs(saved);
                const ui=inspect(await readFile(saved));assert.equal(ui.width,320);assert.equal(ui.height,180);assert.equal(ui.durationMs,2265);assert.equal(ui.loopCount,3);
                diagnostics.phase='example-cancel';await Promise.all([page.waitForEvent('worker'),page.getByRole('button',{name:'Export WebP',exact:true}).click()]);await page.getByRole('button',{name:'Cancel',exact:true}).click();
                await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('AbortError:'));assert.equal(await page.locator('#download').isVisible(),false);
                diagnostics.phase='example-retry';await page.getByRole('button',{name:'Export WebP',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('finished:'));
                await page.waitForFunction(()=>document.querySelector('#result').complete&&document.querySelector('#result').naturalWidth===320);
                await waitForWorkerClosure(page,events);assert.deepEqual(diagnostics.pageErrors,[]);await page.screenshot({path:join(output,name+'.png'),fullPage:true});
                results.push({name,version:browser.version(),cases,cancellation,retry,example:{width:ui.width,height:ui.height,durationMs:ui.durationMs,plays:ui.loopCount},workers:{...events},liveWorkers:page.workers().length});
                await writeFile(join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),version,status:'running',browsers:results},null,2)+'\n');
                console.log('Packed public WebP '+name+': imports/assets, native+FFmpeg decode, cancel/retry and example passed; '+events.closed+'/'+events.opened+' Workers closed');
            }catch(error){
                await writeFile(join(output,name+'-failure.json'),JSON.stringify({date:new Date().toISOString(),error:String(error),url:page?.url(),workers:{...events},liveWorkers:page?.workers().length,...diagnostics},null,2)+'\n');
                if(page&&!page.isClosed())await page.screenshot({path:join(output,name+'-failure.png'),fullPage:true,timeout:5000}).catch(()=>{});
                await writeFile(join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),version,status:'failed',failedBrowser:name,browsers:results},null,2)+'\n');throw error;
            }finally{await browser?.close();}
        }
        await writeFile(join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),version,status:'passed',browsers:results},null,2)+'\n');
    }finally{server.closeAllConnections();await new Promise(yes=>server.close(yes));}
}
