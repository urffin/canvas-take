// DESIGN ONLY: compile-only contract checks; never execute/import this as a runtime example.
import {
    createExternalVideoExporter,createOfflineVideoExporter,createMp4Muxer,createWebmMuxer
} from './external-video-public-api.js';
import type {
    ExternalVideoDestination,ExternalVideoCommit,ExternalVideoTransaction,ExternalVideoExporter,
    ExternalVideoCloseReport,ExternalVideoResult,ExternalVideoWriteSink
} from './external-video-public-api.js';
import type {OfflineVideoOptions,OfflineVideoExporter,OfflineVideoState,MuxerFactory} from '@grundyjs/canvas-take/video';

declare const options: OfflineVideoOptions;
declare const fileDestination: ExternalVideoDestination<FileSystemFileHandle>;
declare const idDestination: ExternalVideoDestination<{readonly id: string}>;
declare const canvas: HTMLCanvasElement;
declare const appendStream: WritableStream<Uint8Array>;

const oldMuxer: MuxerFactory = createMp4Muxer();
const oldWebm: MuxerFactory = createWebmMuxer();
const oldExporter: Promise<OfflineVideoExporter> = createOfflineVideoExporter({...options,muxer:oldMuxer});
void oldWebm;

const mp4 = createExternalVideoExporter({...options,muxer:createMp4Muxer({output:'external'}),destination:fileDestination});
const webm = createExternalVideoExporter({...options,muxer:createWebmMuxer({output:'external'}),destination:idDestination,ifExists:'replace'});
const exactMp4: ExternalVideoExporter<FileSystemFileHandle, 'mp4'> = mp4;
const exactWebm: ExternalVideoExporter<{readonly id: string}, 'webm'> = webm;
const ready: Promise<void> = mp4.ready;
const closed: Promise<ExternalVideoCloseReport<FileSystemFileHandle, 'mp4'>> = mp4.closed;
void exactMp4;void exactWebm;void ready;void closed;
mp4.addFrame(canvas,{timestampUs:0,durationUs:1});

// @ts-expect-error new synchronous handle is not the old initialization Promise
const notAsyncConstructor: Promise<OfflineVideoExporter> = mp4;
// @ts-expect-error initializing belongs only to the new exporter state
const oldState: OfflineVideoState = mp4.state;
// @ts-expect-error read-only stable cleanup Promise
mp4.closed = Promise.resolve({publication:'not-committed',reason:null,cleanupIssues:[]});
// @ts-expect-error ready resolves void, not an exporter
const notReadyValue: Promise<ExternalVideoExporter<FileSystemFileHandle,'mp4'>> = mp4.ready;

// @ts-expect-error old Blob muxers cannot be passed to the external constructor
createExternalVideoExporter({...options,muxer:createMp4Muxer(),destination:fileDestination});
// @ts-expect-error the old constructor retains its Blob-only muxer contract
createOfflineVideoExporter({...options,muxer:createMp4Muxer({output:'external'})});
// @ts-expect-error no implicit output mode for an empty object
createMp4Muxer({});
// @ts-expect-error no append-only output mode
createWebmMuxer({output:'append'});
// @ts-expect-error overwrite is not an arbitrary string or in-place mode
createExternalVideoExporter({...options,muxer:createMp4Muxer({output:'external'}),destination:fileDestination,ifExists:'in-place'});
// @ts-expect-error plain WritableStream lacks positioned transactional acquisition
createExternalVideoExporter({...options,muxer:createMp4Muxer({output:'external'}),destination:appendStream});
// @ts-expect-error explicit external constructor always requires a destination
createExternalVideoExporter({...options,muxer:createMp4Muxer({output:'external'})});

export async function resultContracts() {
    const legacy = await oldExporter;
    const blob: Blob = (await legacy.finish()).blob;
    // @ts-expect-error no new output property is required on existing results
    (await legacy.finish()).output;
    const result = await mp4.finish();
    const file: FileSystemFileHandle = result.output.value;
    const mime: 'video/mp4' = result.mimeType;
    const ext: 'mp4' = result.extension;
    const receiptMime: 'video/mp4' = result.output.mimeType;
    // @ts-expect-error external results do not pretend to contain a Blob
    result.blob;
    // @ts-expect-error opaque result value inferred from the destination
    const incorrectValue: string = result.output.value;
    // @ts-expect-error container inference is not a union for a concrete WebM factory
    const incorrectMime: 'video/mp4' = (await webm.finish()).mimeType;
    const id: string = (await webm.finish()).output.value.id;
    void blob;void file;void mime;void ext;void receiptMime;void incorrectValue;void incorrectMime;void id;
}

declare const transaction: ExternalVideoTransaction<FileSystemFileHandle>;
const falsyValue: ExternalVideoCommit<null> = {status:'committed',value:null};
const refused: ExternalVideoCommit<FileSystemFileHandle> = {status:'not-committed',reason:null};
const uncertain: ExternalVideoCommit<FileSystemFileHandle> = {status:'indeterminate',reason:0,recovery:'backend token'};
const undefinedValue: ExternalVideoCommit<undefined> = {status:'committed',value:undefined};
const falseValue: ExternalVideoCommit<boolean> = {status:'committed',value:false};
void transaction;void falsyValue;void refused;void uncertain;void undefinedValue;void falseValue;
transaction.release({publication:'indeterminate'});
// @ts-expect-error publication result must be discriminated
const bareCommit: ExternalVideoCommit<FileSystemFileHandle> = {} as FileSystemFileHandle;
// @ts-expect-error a committed value is mandatory even when its generic type allows null
const missingValue: ExternalVideoCommit<null> = {status:'committed'};
// @ts-expect-error known refusal has no published value
const wrongRefusal: ExternalVideoCommit<FileSystemFileHandle> = {status:'not-committed',reason:0,value:{} as FileSystemFileHandle};
// @ts-expect-error release is a required session-resource operation
const missingRelease: ExternalVideoTransaction<FileSystemFileHandle> = {writeAt(){},truncate(){},commit(){return {status:'not-committed',reason:null};},abort(){}};

export function publicationContracts(report: ExternalVideoCloseReport<FileSystemFileHandle,'mp4'>) {
    // @ts-expect-error only committed reports have an output receipt
    report.output;
    if (report.publication==='committed') {
        const handle: FileSystemFileHandle = report.output.value;void handle;
        // @ts-expect-error published reports do not carry an unsuccessful commit reason
        report.reason;
    } else if (report.publication==='indeterminate') {
        const recovery: unknown = report.recovery;void recovery;
        // @ts-expect-error uncertain publication cannot be used as a known committed value
        report.output;
    }
}

declare const external: ExternalVideoResult<FileSystemFileHandle,'mp4'>;
// @ts-expect-error result metadata is immutable
external.output.size = 0;
// @ts-expect-error broad result unions still correlate MIME, extension and receipt
const mismatchedContainer: ExternalVideoResult<FileSystemFileHandle> = {...external,extension:'webm'};

declare const workSignal: AbortSignal;
declare const managedSink: ExternalVideoWriteSink;
// @ts-expect-error the commit boundary does not accept a cancellable signal
transaction.commit(workSignal);
// @ts-expect-error cleanup is not cancelled by an already-aborted work signal
transaction.release(workSignal);
// @ts-expect-error the muxer-visible sink cannot publish a destination
managedSink.commit();
// @ts-expect-error the muxer-visible sink does not own destination cleanup
managedSink.abort(null);
// @ts-expect-error destination receives an owned ordinary ArrayBuffer view
transaction.writeAt(0,new Uint8Array(new SharedArrayBuffer(4)),workSignal);
