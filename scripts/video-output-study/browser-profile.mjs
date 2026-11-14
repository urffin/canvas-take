import {chromium} from '@playwright/test';
import {mkdtemp,realpath,rm,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename,relative} from 'node:path';
import assert from 'node:assert/strict';
export async function launchStudyBrowser(incognito=false){
    if(incognito){const browser=await chromium.launch(),page=await browser.newPage();return {browser,page,context:page.context(),mode:'incognito-memory-filesystem',close:()=>browser.close(),async diskEvidence(){return {mode:'incognito-memory-filesystem',files:[]};}};}
    const profile=await mkdtemp(join(tmpdir(),'canvastake-video-output-profile-'));let context;
    const remove=async()=>{const target=await realpath(profile);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-video-output-profile-'));await rm(target,{recursive:true,force:true,maxRetries:8,retryDelay:100});};
    try{
        context=await chromium.launchPersistentContext(profile,{headless:true,acceptDownloads:true});
        assert.ok(context.pages().length<=1);const page=context.pages()[0]??await context.newPage(),browser=context.browser();
        return {browser,page,context,mode:'fresh-persistent-disk-profile',version:browser?.version(),
            async diskEvidence(size){
                const files=[];
                async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await walk(path);else if(entry.isFile()){const name=relative(profile,path).replaceAll('\\','/');if((name.includes('/File System/')||name.includes('/Storage/'))&&(await stat(path)).size===size)files.push({path:name,size});}}}
                await walk(profile);assert.ok(files.length,'No physical OPFS backing file with expected size: '+size);return {mode:'fresh-persistent-disk-profile',files};
            },
            async close(){try{await context.close();}finally{await remove();}}
        };
    }catch(error){await context?.close().catch(()=>{});await remove();throw error;}
}
