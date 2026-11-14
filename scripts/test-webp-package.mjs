import {mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)),npm=process.env.npm_execpath;
if(!npm)throw Error('Use npm run test:webp:package');
const workspace=await mkdtemp(join(tmpdir(),'canvastake-webp-consumer-'));
const run=(args,cwd)=>execFileSync(process.execPath,[npm,...args],{cwd,encoding:'utf8',stdio:['ignore','pipe','inherit'],timeout:300000});
try {
    const [packed]=JSON.parse(run(['pack','--json','--pack-destination',workspace],root));
    await writeFile(join(workspace,'package.json'),JSON.stringify({private:true,type:'module'}));
    run(['install','--offline','--ignore-scripts','--no-audit','--no-fund',join(workspace,packed.filename)],workspace);
    const dist=join(workspace,'node_modules/@grundyjs/canvas-take/dist'),pkg=JSON.parse(await readFile(join(dist,'../package.json'),'utf8'));
    assert.equal(pkg.version,'0.7.0'); assert.equal(pkg.exports['./webp'].import,'./dist/webp.js');
    assert.equal(pkg.exports['./webp/worker'].types,'./dist/webp-worker.d.ts'); assert.equal(pkg.exports['./webp/codec.wasm'],'./dist/webp-codec.wasm');
    for(const name of ['webp.js','webp.d.ts','webp-worker.js','webp-worker.d.ts','webp-worker-runtime.js','webp-worker-runtime.js.map','webp-codec.js','webp-codec.wasm']) assert.ok(packed.files.some(f=>f.path==='dist/'+name),'Missing '+name);
    for(const name of ['docs/webp-export.md','docs/drafts/webp-public-verification.md','docs/drafts/webp-public-results.json','examples/webp.html'])assert.ok(packed.files.some(f=>f.path===name),'Missing WebP documentation/example: '+name);
    const manifest=JSON.parse(await readFile(join(dist,'webp-notices/manifest.json'),'utf8'));
    for(const file of manifest.files) {
        const bytes=await readFile(join(dist,file.file.startsWith('webp-codec.')?file.file:'webp-notices/'+file.file));
        assert.equal(bytes.length,file.bytes); assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
    }
    await writeFile(join(workspace,'consumer.ts'),`import {createWebpExporter,type WebpExporter,type WebpExportOptions,type WebpEncoderFactory,type WebpExportLimits,type WebpExportProgress,type WebpFrame,type WebpFrameEncoder,type WebpEncoderContext,type WebpExportState} from '@grundyjs/canvas-take/webp';
import {createWebpWorkerEncoder,type WebpWorkerOptions} from '@grundyjs/canvas-take/webp/worker';
const worker:WebpWorkerOptions={workerUrl:new URL('./worker.js',import.meta.url),wasmUrl:new URL('./codec.wasm',import.meta.url),lossless:true,quality:100,method:4,timeoutMs:30000};
const encoder:WebpEncoderFactory=createWebpWorkerEncoder(worker), options:WebpExportOptions={encoder,plays:3,maxFrames:5,onProgress(p){const n:number=p.framesAccepted;void n;}};
const create:()=>WebpExporter=()=>createWebpExporter(options);void create;
// @ts-expect-error encoder selection is required
const missing:WebpExportOptions={plays:1};void missing;
// @ts-expect-error plays is numeric
const bad:WebpExportOptions={encoder,plays:'once'};void bad;
// @ts-expect-error codec method is numeric
const badWorker:WebpWorkerOptions={method:'fast'};void badWorker;
// @ts-expect-error internal implementation path is not exported
import {createWebpController} from '@grundyjs/canvas-take/internal/webp-controller.js';void createWebpController;
`);
    execFileSync(process.execPath,[join(root,'node_modules/typescript/bin/tsc'),'--ignoreConfig','--strict','--exactOptionalPropertyTypes','--noEmit','--target','ES2022','--module','NodeNext','--lib','ES2022,DOM',join(workspace,'consumer.ts')],{stdio:'inherit'});
    await writeFile(join(workspace,'runtime.mjs'),`import {createWebpExporter} from '@grundyjs/canvas-take/webp';
import {createWebpWorkerEncoder} from '@grundyjs/canvas-take/webp/worker';
import {access} from 'node:fs/promises';
await access(new URL(import.meta.resolve('@grundyjs/canvas-take/webp/worker-runtime')));
await access(new URL(import.meta.resolve('@grundyjs/canvas-take/webp/codec.wasm')));
const factory=createWebpWorkerEncoder();
try{createWebpExporter({encoder:factory});throw Error('Unexpected Worker');}catch(error){if(!error.cause?.message.includes('not supported'))throw error;}
for(const path of ['/internal/webp-controller.js','/internal/webp-worker.js']){try{await import('@grundyjs/canvas-take'+path);throw Error('Internal export');}catch(e){if(e.code!=='ERR_PACKAGE_PATH_NOT_EXPORTED')throw e;}}
`);
    execFileSync(process.execPath,[join(workspace,'runtime.mjs')],{cwd:workspace,stdio:'inherit'});
    if(process.argv.includes('--browser')) await (await import('./webp-package-browser.mjs')).verifyWebpPackage(root,dist);
    console.log('Packed public WebP passed: strict types, Node imports, assets/notices'+(process.argv.includes('--browser')?', browser Worker/example checks':'')+'.');
} finally {
    const parent=await realpath(tmpdir()),target=await realpath(workspace),child=relative(parent,target);
    if(!child||child.startsWith('..')||isAbsolute(child)||dirname(target)!==parent)throw Error('Unsafe WebP consumer cleanup');
    await rm(target,{recursive:true,force:true});
}
