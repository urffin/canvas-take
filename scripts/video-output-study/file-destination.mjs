import {open,rename,unlink} from 'node:fs/promises';
// Own a NEW file in the study workspace; never open or replace user files.
export async function createFileDestination(path,{beforeWrite=async()=>{},beforeCommit=async()=>{},write=async(handle,data,offset,length,position)=>handle.write(data,offset,length,position)}={}) {
    const temporary=path+'.partial',handle=await open(temporary,'wx');let closed=false,committed=false;
    return {
        async writeAt(position,data){
            await beforeWrite(position,data);let offset=0;
            while(offset<data.byteLength){const result=await write(handle,data,offset,data.byteLength-offset,position+offset);if(!Number.isSafeInteger(result.bytesWritten)||result.bytesWritten<1||result.bytesWritten>data.byteLength-offset)throw new Error('File destination made no valid progress');offset+=result.bytesWritten;}
        },
        truncate(size){return handle.truncate(size);},
        async commit(){await beforeCommit();await handle.close();closed=true;await rename(temporary,path);committed=true;return path;},
        async abort(){try{if(!closed){await handle.close();closed=true;}}finally{await unlink(committed?path:temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}}
    };
}
