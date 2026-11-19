import {StreamTarget} from 'mediabunny';
import type {ExternalVideoMuxerContext} from './video-external-types.js';

/** Private bridge: the controller owns snapshots, pressure, truncation and publication. */
export function createExternalTarget(context:ExternalVideoMuxerContext) {
    let stopped=false,failed=false,reason:unknown;
    const fail=(error:unknown)=>{
        if(failed||stopped)return;
        failed=true;reason=error;context.output.fail(error);
    };
    const check=()=>{if(failed)throw reason;};
    const target=new StreamTarget(new WritableStream({
        async write({data,position}) {
            // Keep the vendor stream closable after failure. Its operation guards surface
            // the first error; rejecting this callback would poison writer.close().
            if(stopped||failed||context.signal.aborted)return;
            try {
                // Vendor flushes may combine several packets. Bound every admitted snapshot
                // without buffering the entire container or queuing parallel sink writes.
                for(let offset=0;offset<data.byteLength;offset+=context.maxPendingBytes) {
                    if(stopped||failed||context.signal.aborted)return;
                    await context.output.writeAt(position+offset,data.subarray(offset,offset+context.maxPendingBytes));
                }
            } catch(error) {fail(error);}
        }
    }),{chunked:false});
    target.on('write',({end})=>{
        if(context.maxOutputBytes!==undefined&&end>context.maxOutputBytes)fail(new RangeError('maxOutputBytes exceeded'));
    });
    return {target,check,stop(){stopped=true;}};
}
