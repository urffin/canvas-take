// Private implementation/type compatibility only. Compile with noEmit; not a package entry point.
import {createExternalVideoExporter as implemented} from '../../dist/internal/video-external.js';
import {createExternalVideoExporter as proposed} from './external-video-public-api.js';
import type {ExternalVideoDestination,ExternalVideoMuxerFactory} from '../../dist/internal/video-external-types.js';
import type {OfflineVideoOptions,MuxerFactory} from '@grundyjs/canvas-take/video';
import {createExternalMp4Muxer} from '../../dist/internal/video-external-mp4.js';
import {createExternalWebmMuxer} from '../../dist/internal/video-external-webm.js';
import {createMp4Muxer as publicMp4} from '@grundyjs/canvas-take/video/mp4';
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
const realMp4:ExternalVideoMuxerFactory<'mp4'>=createExternalMp4Muxer();
const realWebm:ExternalVideoMuxerFactory<'webm'>=createExternalWebmMuxer();
// @ts-expect-error concrete containers must not be widened or interchangeable
const wrongContainer:ExternalVideoMuxerFactory<'mp4'>=createExternalWebmMuxer();
// @ts-expect-error private integration must not change the public Blob factory
publicMp4({output:'external'});
void realMp4;void realWebm;void wrongContainer;
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
