import {open,link,rename,unlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';

/** Test-only same-directory transaction on the verified local filesystem, not a storage API. */
export function fileDestination(path,hooks={}) {
    const stats={liveHandles:0,physical:0,peakPhysical:0,ownedBytes:0,peakOwnedBytes:0,writes:[],commits:0,aborts:0,releases:0,stages:[],trace:[]};
    return {stats,kind:'positioned-transactional',checkSupport(){return {supported:true};},async create(context){
        const staging=join(dirname(path),'.canvastake-'+randomUUID()+'.partial');
        const file=await open(staging,'wx');stats.liveHandles++;stats.stages.push(staging);
        let closed=false,removed=false;
        const close=async()=>{if(!closed){await file.close();closed=true;stats.liveHandles--;}};
        const remove=async()=>{if(!removed){await unlink(staging).catch(e=>{if(e.code!=='ENOENT')throw e;});removed=true;}};
        return {
            async ready(signal){await hooks.ready?.(signal);},
            async writeAt(position,data,signal){
                stats.physical++;stats.ownedBytes+=data.byteLength;stats.peakPhysical=Math.max(stats.peakPhysical,stats.physical);stats.peakOwnedBytes=Math.max(stats.peakOwnedBytes,stats.ownedBytes);
                stats.writes.push({position,length:data.length});
                try{await hooks.write?.(position,data,signal);for(let offset=0;offset<data.length;){
                    const length=Math.min(data.length-offset,hooks.shortWrite??data.length);
                    const {bytesWritten}=await file.write(data,offset,length,position+offset);
                    if(!Number.isSafeInteger(bytesWritten)||bytesWritten<1||bytesWritten>length)throw Error('File write made no progress');
                    offset+=bytesWritten;
                }}finally{stats.physical--;stats.ownedBytes-=data.byteLength;}
            },
            async truncate(size,signal){stats.trace.push('truncate');await hooks.truncate?.(size,signal);await file.truncate(size);},
            async commit(){
                stats.commits++;stats.trace.push('commit');await close();await hooks.beforeCommit?.();
                try{
                    // Exclusive link is publication-time no-replace, never exists()+rename().
                    if(context.ifExists==='error')await link(staging,path);
                    else{await rename(staging,path);removed=true;}
                }catch(reason){return {status:'not-committed',reason};}
                await hooks.afterPublication?.();
                return {status:'committed',value:path};
            },
            async abort(reason){stats.aborts++;stats.trace.push('abort');await close();await remove();await hooks.abort?.(reason);},
            async release(info){stats.releases++;stats.trace.push('release');stats.publication=info.publication;await close();if(info.publication==='committed')await remove();await hooks.release?.(info);}
        };
    }};
}
