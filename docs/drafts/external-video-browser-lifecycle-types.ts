// DESIGN ONLY / noEmit: do not execute. Positive composition and deliberately invalid calls.
import type {OfflineVideoOptions} from '@grundyjs/canvas-take/video';
import {createExternalVideoExporter} from '../../dist/internal/video-external.js';
import {createExternalMp4Muxer} from '../../dist/internal/video-external-mp4.js';
import type {ExternalVideoDestination} from './external-video-public-api.js';
import type {DestinationRecoveryService} from './external-video-destination-contract.js';
import type {
    BrowserResultStoreDraft,BrowserResultKey,BrowserResultReference,BrowserResultRevision,
    BrowserFileLease,BrowserAccess,BrowserPreparedDownload,BrowserRecoverySnapshot,
    BrowserLifecycleSupport,BrowserExplicitHoldKey,BrowserManagedAttempt,BrowserRecoveryOutcome
} from './external-video-browser-lifecycle.js';
// @ts-expect-error B32: no public browser result lifecycle entry point is introduced
import type {BrowserResultStoreDraft as PublicStore} from '@grundyjs/canvas-take/video/browser-results';

declare const store:BrowserResultStoreDraft,key:BrowserResultKey,ref:BrowserResultReference;
declare const revision:BrowserResultRevision,binding:BrowserManagedAttempt,hold:BrowserExplicitHoldKey;
declare const lease:BrowserFileLease,access:BrowserAccess<BrowserFileLease>,download:BrowserPreparedDownload;
declare const observed:BrowserRecoverySnapshot,video:OfflineVideoOptions['video'],canvas:HTMLCanvasElement;

// B3/B29: both the previous draft and actual private controller accept the generic value unchanged.
const destination:ExternalVideoDestination<BrowserResultReference>=binding.destination;
const recovery:DestinationRecoveryService<BrowserResultReference>=store.recovery;
export async function composeAndRead(consume:(file:File)=>Promise<void>){
 const attempt=store.bind('movie.mp4');
 // Persist attempt.key + attempt.ownerHold before this constructor in a real application.
 const exporter=createExternalVideoExporter({video,destination:attempt.destination,muxer:createExternalMp4Muxer()});
 await exporter.ready;await exporter.addFrame(canvas,{timestampUs:0,durationUs:100000});
 const result=await exporter.finish(),value:BrowserResultReference=result.output.value;
 const opened=await store.acquireFile(value.key);
 if(opened.status==='available'){try{await consume(opened.value.file);}finally{await opened.value.release();await opened.value.closed;}}
 const savedOwnerHold=attempt.ownerHold;void savedOwnerHold;
 exporter.dispose();await exporter.closed;return value;
}
// B9/B10/B11: prepare before user gesture, request synchronously; explicit UI teardown owns disposal.
export async function prepareButton(button:HTMLButtonElement){
 const ready=await store.prepareDownload(key,{fileName:'short.mp4'});if(ready.status!=='available')return ready;
 const handle=ready.value;
 button.onclick=()=>{const request=handle.request();const completion:'unobservable'=request.completion;void completion;};
 return async()=>{button.onclick=null;await handle.dispose();await handle.closed;};
}
// B14/B15: release known ownership, then obtain a new deletion revision; blocked is a normal result.
export async function releaseAndDelete(){
 const result=await store.releaseHold(binding.ownerHold);if(result.status!=='released')return result;
 const current=await store.inspectVersion(binding.key);if(current.selection==='selected')return current;
 return store.deleteVersion(current.version.key,{expectedRevision:current.revision});
}
// B19/B20/B21: recover original version, not whatever now occupies its logical name.
export async function readRecovered(){
 const state=await store.recovery.inspect(binding.key);
 if(state.ownerHold)await store.inspectHold(state.ownerHold);
 if(state.publication.status==='committed'&&state.publication.receipt.status==='available')return store.acquireFile(state.publication.receipt.value.key);
 if(state.publication.status==='indeterminate')return store.recovery.recover(binding.key,{expectedRevision:state.revision});
 return state;
}
const correctSupport:BrowserLifecycleSupport={supported:true,profile:'opfs-managed-v2',coordination:'web-locks-and-idb',nativeUserFileNames:false};
store.retain(hold);store.releaseHold(hold);store.inspectHold(hold);store.scanVersions({limit:32});
store.deleteVersion(key,{expectedRevision:revision});
declare const action:BrowserRecoveryOutcome;
if(action.status==='fenced'){const outcome:'not-committed'=action.snapshot.publication.status;void outcome;}

// @ts-expect-error B1/B26: a v1 recovery key cannot silently opt into managed deletion semantics
const legacyKey:BrowserResultKey={version:1,backendId:'canvastake-browser-catalog-v1',scopeId:'s',attemptId:'a'};
// @ts-expect-error B4: committed reference metadata is readonly
ref.key=key;
// @ts-expect-error B4/B26: a name/path is not an attempt/version key
store.acquireFile('movie.mp4');
// @ts-expect-error B4/B5: an opaque result is not itself a File
const rawFile:File=ref;
// @ts-expect-error B1/B5: v1 raw getFile is not the managed read ownership API
ref.getFile();
// @ts-expect-error B5: reading requires discriminating the access result
access.value.file;
// @ts-expect-error B5: File acquisition is asynchronous and returns an access/lease result
const unawaited:File=store.acquireFile(key);
// @ts-expect-error B4: the result reference does not expose a native filesystem path
ref.path;
// @ts-expect-error B5: a borrowed File is not a writable native handle
lease.file.createWritable();
// @ts-expect-error B6: a lease cannot be retargeted to a different result
lease.version=ref;
// @ts-expect-error B10: a download request is synchronous, not a completion Promise
const downloadComplete:Promise<void>=download.request();
// @ts-expect-error B10: request cannot report a confirmed saved download
const saved:'saved'=download.request().completion;
// @ts-expect-error B10: no confirmed native save path is exposed
download.request().path;
// @ts-expect-error B11: callers cannot take over the internal object's URL lifetime
download.url;
// @ts-expect-error B11: a download request cannot automatically delete the retained version
store.prepareDownload(key,{deleteAfterDownload:true});
// @ts-expect-error B12: native user-folder picker is a separate profile, not a silent fallback
store.prepareDownload(key,{directoryHandle:{}});
// @ts-expect-error B15: deletion requires an observed revision
store.deleteVersion(key,{});
// @ts-expect-error B15/B26: arbitrary string is not an observed deletion revision
store.deleteVersion(key,{expectedRevision:'guessed'});
// @ts-expect-error B15: held or active consumers cannot be bypassed with force
store.deleteVersion(key,{expectedRevision:revision,force:true});
// @ts-expect-error B15: mutable logical names cannot identify an immutable version for deletion
store.deleteVersion('movie.mp4',{expectedRevision:revision});
// @ts-expect-error B14: commit-owner holds are created by publication, never manually retained
store.retain(binding.ownerHold);
// @ts-expect-error B14: persistent hold identities cannot be changed after acquisition
hold.holdId='new';
// @ts-expect-error B14: a File lease is separate from a durable retention key
store.releaseHold(lease);
// @ts-expect-error B18/B26: cursors are scoped opaque observations, not arbitrary strings
store.scanVersions({cursor:'foreign'});
// @ts-expect-error B13/B18: no age-based automatic retention or TTL deletion API
store.scanVersions({ttlMs:1000});
// @ts-expect-error B23: explicit recovery must revalidate a revision
store.recovery.recover(key,{});
// @ts-expect-error B19: uncertain publication must be narrowed before a receipt is available
observed.publication.receipt.value;
if(observed.publication.status==='committed'){
 // @ts-expect-error B21: historical commit does not imply its original bytes/receipt are available
 observed.publication.receipt.value;
}
// @ts-expect-error B19/B23: recovery never automatically republishes an uncertain attempt
store.recovery.commit(key);
// @ts-expect-error B7: close cannot force-release borrowed consumer lifetimes
store.close({force:true});
// @ts-expect-error B2: support cannot promise native filenames through the catalogue profile
const wrongSupport:BrowserLifecycleSupport={supported:true,profile:'opfs-managed-v2',coordination:'web-locks-and-idb',nativeUserFileNames:true};
// @ts-expect-error B23: metadata fencing cannot claim a successfully published snapshot
const falseFence:BrowserRecoveryOutcome={status:'fenced',snapshot:{...observed,quiescent:true,publication:{status:'committed',receipt:{status:'available',value:ref}}}};
void destination;void recovery;void correctSupport;
