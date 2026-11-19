// Compile-only private receiver compatibility; no package entry point.
import {provisionNodeVideoDestination,type NodeVideoReceipt} from '../../dist/internal/video-file-node.mjs';
import {createExternalVideoExporter} from '../../dist/internal/video-external.js';
import {createExternalMp4Muxer} from '../../dist/internal/video-external-mp4.js';
import type {DestinationAttemptBinding,DestinationRecoveryService} from './external-video-destination-contract.js';
import type {OfflineVideoOptions} from '@grundyjs/canvas-take/video';
// @ts-expect-error private receiver must not become a public package entry point
import {provisionNodeVideoDestination as notPublic} from '@grundyjs/canvas-take/video/file';
declare const input:OfflineVideoOptions;
// @ts-expect-error local scope trust is an explicit provisioning precondition
provisionNodeVideoDestination('/scratch',{});
// @ts-expect-error there is no implicit profile/picker/fallback
provisionNodeVideoDestination('/scratch');
export async function use(){
    const receiver=await provisionNodeVideoDestination('/scratch',{trust:'controlled-local-directory'}),binding=receiver.bind('movie.mp4');
    const contract:DestinationAttemptBinding<NodeVideoReceipt>=binding;
    const recovery:DestinationRecoveryService<NodeVideoReceipt>=receiver.recovery;
    const supported=await binding.destination.checkSupport({format:{mimeType:'video/mp4',extension:'mp4'},ifExists:'error',maxWriteBytes:4096});
    if(supported.supported){const policy:'error'=supported.guarantees.policy;void policy;}
    const exporter=createExternalVideoExporter({...input,muxer:createExternalMp4Muxer(),destination:binding.destination});
    await exporter.ready;const result=await exporter.finish();const bytes:Uint8Array<ArrayBuffer>=await result.output.value.read();
    // @ts-expect-error published receipts are detached immutable metadata
    result.output.value.path='/other';
    // @ts-expect-error recovered outcome/receipt must be narrowed first
    (await recovery.inspect(binding.key)).publication.receipt.value.read();
    void contract;void bytes;
}
