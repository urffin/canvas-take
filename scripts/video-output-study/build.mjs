import {build} from 'esbuild';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {patchWebmMuxer} from '../webm-muxer-patch.mjs';
export async function buildStudy(directory) {
    await mkdir(directory,{recursive:true});const sourceHashes={},transforms=[];
    const banner=`const Date=class extends globalThis.Date{constructor(...a){super(...(a.length?a:[1735689600000]));}static now(){return 1735689600000;}};const Math=Object.create(globalThis.Math);Math.random=()=>0.25;`;
    for(const mode of ['baseline','external']){
        const plugin={name:'guarded-output-study',setup(b){
            b.onLoad({filter:/[\\/]src[\\/](video(?:-mp4|-webm)?\.ts)$/},async({path})=>{
                let source=await readFile(path,'utf8');sourceHashes[path.split(/[\\/]/).at(-1)]=createHash('sha256').update(source).digest('hex');source=source.replaceAll('\r\n','\n');
                const once=(before,after)=>{assert.equal(source.split(before).length,2,'Research transform drift: '+before);source=source.replace(before,after);transforms.push({mode,file:path.split(/[\\/]/).at(-1),before});};
                if(mode==='external'){
                    if(path.endsWith('video.ts')){
                        once('!(blob instanceof Blob)','(!blob || blob.kind !== "external-output")');
                        once('...timeline, blob, ...cfg.format','...timeline, output: blob, ...cfg.format');
                    }else{
                        const imported=source.includes("import { createPagedByteStore }")?"import { createPagedByteStore } from './internal/paged-bytes.js';":"import {createPagedByteStore} from './internal/paged-bytes.js';";
                        once(imported,`import {createPrototypeStore as createPagedByteStore} from ${JSON.stringify(resolve('scripts/video-output-study/receiver.mjs'))};`);
                        once('createPagedByteStore()','createPagedByteStore(context)');
                        const write=source.includes('bytes.write(position, data);')?'bytes.write(position, data);':'bytes.write(position,data);';once(write,'return '+write);
                        const guard=source.includes('const guard = () => {')?'const guard = () => {':'const guard=()=>{';once(guard,guard+' bytes.check();');
                        const final=path.endsWith('video-mp4.ts')?"const blob = new Blob(bytes.parts(), { type: 'video/mp4' }); bytes.clear();\n                    return blob;":"const blob=new Blob(bytes.parts(),{type:'video/webm'});bytes.clear();return blob;";
                        once(final,`return await bytes.finalize('${path.endsWith('video-mp4.ts')?'video/mp4':'video/webm'}');`);
                    }
                }
                return {contents:source,loader:'ts',resolveDir:dirname(path)};
            });
            b.onLoad({filter:/[\\/]src[\\/]internal[\\/]paged-bytes\.ts$/},async({path})=>{
                let source=await readFile(path,'utf8');
                sourceHashes['paged-bytes.ts']=createHash('sha256').update(source).digest('hex');
                assert.equal(source.split('size = Math.max(size, end);').length,2);assert.equal(source.split('pages.clear(); size = 0;').length,2);
                source=source.replace('size = Math.max(size, end);','size = Math.max(size, end); const s=globalThis.__studyStorage; if(s){s.current=Math.ceil(size/pageSize)*pageSize;s.peak=Math.max(s.peak,s.current);s.writes++;}');
                source=source.replace('pages.clear(); size = 0;','pages.clear(); size = 0; if(globalThis.__studyStorage)globalThis.__studyStorage.current=0;');
                return {contents:source,loader:'ts',resolveDir:dirname(path)};
            });
            b.onLoad({filter:/[\\/]matroska[\\/]matroska-muxer\.js$/},async({path})=>({contents:patchWebmMuxer((await readFile(path,'utf8')).replaceAll('\r\n','\n').replace(/^\/\/# sourceMappingURL=.*$/gm,'')),loader:'js',resolveDir:dirname(path)}));
        }};
        await build({entryPoints:['scripts/video-output-study/prototype-entry.mjs'],outfile:resolve(directory,mode+'.mjs'),bundle:true,format:'esm',platform:'browser',target:'es2022',plugins:[plugin],banner:{js:banner}});
    }
    const harnessHashes={};for(const path of ['scripts/benchmark-video-output.mjs','scripts/video-output-study/build.mjs','scripts/video-output-study/browser.mjs','scripts/video-output-study/browser-profile.mjs','scripts/video-output-study/prototype-entry.mjs','scripts/video-output-study/receiver.mjs','scripts/video-output-study/file-destination.mjs','scripts/video-output-study/oracle.mjs'])harnessHashes[path]=createHash('sha256').update(await readFile(path)).digest('hex');
    await writeFile(resolve(directory,'build.json'),JSON.stringify({sourceHashes,harnessHashes,transforms,banner:'Fixed container Date/Math.random only; native performance clock unchanged.'},null,2)+'\n');
    return {sourceHashes,harnessHashes,transforms};
}
