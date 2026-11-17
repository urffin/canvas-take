// Private implementation/type compatibility only. Compile with noEmit; not a package entry point.
import {createExternalVideoExporter as implemented} from '../../dist/internal/video-external.js';
import {createExternalVideoExporter as proposed} from './external-video-public-api.js';
import type {ExternalVideoDestination,ExternalVideoMuxerFactory} from '../../dist/internal/video-external-types.js';
import type {OfflineVideoOptions,MuxerFactory} from '@grundyjs/canvas-take/video';
// @ts-expect-error this stage must not export the new controller from the public entry point
import {createExternalVideoExporter as notPublic} from '@grundyjs/canvas-take/video';

const matchesProposal: typeof proposed = implemented;
const matchesImplementation: typeof implemented = proposed;
void matchesProposal;void matchesImplementation;
declare const options: OfflineVideoOptions;
declare const destination: ExternalVideoDestination<FileSystemFileHandle>;
declare const mp4: ExternalVideoMuxerFactory<'mp4'>;
declare const webm: ExternalVideoMuxerFactory<'webm'>;
declare const blob: MuxerFactory;
const session=implemented({...options,muxer:mp4,destination});
const other=implemented({...options,muxer:webm,destination});
// @ts-expect-error a legacy Blob muxer cannot be silently adapted
implemented({...options,muxer:blob,destination});
// @ts-expect-error no in-place fallback
implemented({...options,muxer:mp4,destination,ifExists:'in-place'});
export async function results(){
    await session.ready;const result=await session.finish();
    const handle:FileSystemFileHandle=result.output.value,mime:'video/mp4'=result.mimeType,extension:'mp4'=result.extension;
    const webmMime:'video/webm'=(await other.finish()).mimeType;
    // @ts-expect-error external result has no fake Blob
    result.blob;
    const report=await session.closed;
    // @ts-expect-error only committed output can be used as a receipt
    report.output;
    if(report.publication==='committed'){const value:FileSystemFileHandle=report.output.value;void value;}
    void handle;void mime;void extension;void webmMime;
}
