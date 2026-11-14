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
    try {
        for(const [name,engine]of[['chromium',chromium],['firefox',firefox]]) {
            const browser=await engine.launch();
            try {
                const page=await browser.newPage(),events={opened:0,closed:0},errors=[];
                page.on('worker',worker=>{events.opened++;worker.on('close',()=>events.closed++);});page.on('pageerror',error=>errors.push(error.message));
                await page.goto(origin);const cases=[];
                for(const options of [{},{plays:1,delays:[2000]},{plays:0,delays:[1,10,11]},{workerUrl:'/copied/runtime.js',wasmUrl:'/separate/codec.wasm'}]) {
                    const result=await page.evaluate(async o=>(await import('/fixture.mjs')).exportWebpCase(o),options);cases.push(verifyPublicWebp(result,name));
                    await writeFile(join(output,name+'-'+cases.length+'.webp'),Uint8Array.from(result.bytes));
                }
                const cancelled=await page.evaluate(async()=>{
                    const {exportWebpCase}=await import('/fixture.mjs'),abort=new AbortController(),reason=new Error('packed cancellation');
                    try{await exportWebpCase({signal:abort.signal,onProgress(p){if(p.framesAccepted===1)abort.abort(reason);}});return false;}catch(error){return error===reason;}
                });assert.equal(cancelled,true);
                verifyPublicWebp(await page.evaluate(async()=>(await import('/fixture.mjs')).exportWebpCase()),name);await waitForWorkerClosure(page,events);
                await page.goto(origin+'/examples/webp.html');await page.getByRole('button',{name:'Export WebP',exact:true}).click();
                await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('finished:'));
                const download=page.waitForEvent('download');await page.getByRole('link',{name:'Download WebP',exact:true}).click();const saved=join(output,name+'-example.webp');await(await download).saveAs(saved);
                const ui=inspect(await readFile(saved));assert.equal(ui.width,320);assert.equal(ui.height,180);assert.equal(ui.durationMs,2265);assert.equal(ui.loopCount,3);
                const started=page.waitForEvent('worker');await page.getByRole('button',{name:'Export WebP',exact:true}).click();await started;await page.getByRole('button',{name:'Cancel',exact:true}).click();
                await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('AbortError:'));assert.equal(await page.locator('#download').isVisible(),false);
                await page.getByRole('button',{name:'Export WebP',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('finished:'));
                await page.waitForFunction(()=>document.querySelector('#result').complete&&document.querySelector('#result').naturalWidth===320);
                await waitForWorkerClosure(page,events);assert.deepEqual(errors,[]);await page.screenshot({path:join(output,name+'.png'),fullPage:true});
                results.push({name,version:browser.version(),cases,cancellation:true,example:{width:ui.width,height:ui.height,durationMs:ui.durationMs,plays:ui.loopCount},workers:{...events},liveWorkers:page.workers().length});
                console.log('Packed public WebP '+name+': imports/assets, native+FFmpeg decode, cancel/retry and example passed; '+events.closed+'/'+events.opened+' Workers closed');
            }finally{await browser.close();}
        }
        await writeFile(join(output,'results.json'),JSON.stringify({date:new Date().toISOString(),version:'0.7.0',browsers:results},null,2)+'\n');
    }finally{server.closeAllConnections();await new Promise(yes=>server.close(yes));}
}
