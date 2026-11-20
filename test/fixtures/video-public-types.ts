import {createExternalVideoExporter, createOfflineVideoExporter} from '@grundyjs/canvas-take/video';
import type {ExternalVideoExporter, ExternalVideoDestination, MuxerFactory, OfflineVideoOptions, OfflineVideoExporter} from '@grundyjs/canvas-take/video';
import {createMp4Muxer} from '@grundyjs/canvas-take/video/mp4';
import {createWebmMuxer} from '@grundyjs/canvas-take/video/webm';
import {openBrowserVideoResultStore} from '@grundyjs/canvas-take/video/browser';
import type {BrowserResultReference} from '@grundyjs/canvas-take/video/browser';
import {provisionNodeVideoDestination} from '@grundyjs/canvas-take/video/node';
import type {NodeVideoReceipt} from '@grundyjs/canvas-take/video/node';

declare const options: OfflineVideoOptions;
declare const custom: ExternalVideoDestination<{id: number}>;
declare const legacyMp4: ReturnType<typeof createMp4Muxer>;
declare const legacyWebm: ReturnType<typeof createWebmMuxer>;
const legacyFactories: MuxerFactory[] = [legacyMp4, legacyWebm];
const original: Promise<OfflineVideoExporter> = createOfflineVideoExporter({...options, muxer: createMp4Muxer()});
const mp4: ExternalVideoExporter<{id: number}, 'mp4'> = createExternalVideoExporter({...options,
    muxer: createMp4Muxer({output: 'external'}), destination: custom});
void original; void mp4; void legacyFactories;

async function adapters(scopeId: string, path: string) {
    const browser = await openBrowserVideoResultStore({scopeId, mode: 'reopen'});
    const file = await provisionNodeVideoDestination(path, {trust: 'controlled-local-directory'});
    const browserSession: ExternalVideoExporter<BrowserResultReference, 'mp4'> = createExternalVideoExporter({...options,
        muxer: createMp4Muxer({output: 'external'}), destination: browser.bind('movie.mp4').destination});
    const nodeSession: ExternalVideoExporter<NodeVideoReceipt, 'webm'> = createExternalVideoExporter({...options,
        muxer: createWebmMuxer({output: 'external'}), destination: file.bind('movie.webm').destination});
    const outcome = await browserSession.finish();
    const exactMime: 'video/mp4' = outcome.mimeType;
    const originalPath: string = (await nodeSession.finish()).output.value.path;
    void exactMime; void originalPath;
    // @ts-expect-error externally published output has no Blob property
    outcome.blob;
    // @ts-expect-error adapter diagnostics are private
    browser.stats;
    // @ts-expect-error adapter invalidation is private
    file.invalidate();
}
void adapters;

// @ts-expect-error a transaction factory is required
createExternalVideoExporter({...options, muxer: createWebmMuxer({output: 'external'}), destination: new WritableStream()});
// @ts-expect-error the Blob constructor accepts only Blob muxers
createOfflineVideoExporter({...options, muxer: createMp4Muxer({output: 'external'})});
// @ts-expect-error external output requires an external muxer
createExternalVideoExporter({...options, muxer: createMp4Muxer(), destination: custom});
// @ts-expect-error no append mode
createWebmMuxer({output: 'append'});
// @ts-expect-error opening a browser namespace requires explicit create or reopen
openBrowserVideoResultStore({scopeId: 'scope'});
// @ts-expect-error Node fault injection is private
provisionNodeVideoDestination('directory', {trust: 'controlled-local-directory', shortWrite: 1});
