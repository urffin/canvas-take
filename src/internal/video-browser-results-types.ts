/** Private managed browser-result contract. No package entry point. */
import type {ExternalVideoDestination,ExternalVideoFormat} from './video-external-types.js';
import type {Awaitable} from '../video.js';
export interface DestinationRecoveryKey {readonly version:1;readonly backendId:string;readonly scopeId:string;readonly attemptId:string}
export type RecoveredReceipt<V>={readonly status:'available';readonly value:V}|{readonly status:'unavailable';readonly reason:unknown};
export type ReconciledPublication<V>={readonly status:'committed';readonly receipt:RecoveredReceipt<V>}|{readonly status:'not-committed';readonly reason:unknown}|{readonly status:'indeterminate';readonly reason:unknown};
export type DestinationRecoverySnapshot<V>={readonly key:DestinationRecoveryKey;readonly revision:string;readonly currentTarget:'this-attempt'|'other-publication'|'absent'|'unknown';readonly staging:'retained'|'absent'|'unknown'} & ({readonly quiescent:false;readonly publication:{readonly status:'indeterminate';readonly reason:unknown}}|{readonly quiescent:true;readonly publication:ReconciledPublication<V>});
export type DestinationRecoveryCleanup={readonly status:'cleaned'|'already-clean'}|{readonly status:'blocked';readonly reason:unknown};
export interface DestinationRecoveryService<V> {inspect(key:DestinationRecoveryKey):Awaitable<DestinationRecoverySnapshot<V>>;cleanup(key:DestinationRecoveryKey,request:{readonly expectedRevision:string}):Awaitable<DestinationRecoveryCleanup>}

declare const revisionBrand:unique symbol;
declare const cursorBrand:unique symbol;
export type BrowserResultRevision=string & {readonly [revisionBrand]:'browser-result-revision'};
export type BrowserResultCursor=string & {readonly [cursorBrand]:'browser-result-cursor'};

/** Serializable application locator, never proof of ownership/publication or an OS path. */
export interface BrowserResultKey extends DestinationRecoveryKey {
    readonly backendId:'canvastake-opfs-managed-v2';
}
export interface BrowserResultReference {
    readonly key:BrowserResultKey;
    readonly name:string;
    readonly size:number;
    readonly format:ExternalVideoFormat;
    /** Strictly increasing within this catalogue; not wall-clock time. */
    readonly publicationSequence:number;
}
export interface BrowserOwnerHoldKey {
    readonly version:BrowserResultKey;
    readonly holdId:string;
    readonly kind:'commit-owner';
}
export interface BrowserExplicitHoldKey {
    readonly version:BrowserResultKey;
    readonly holdId:string;
    readonly kind:'explicit';
}
export type BrowserHoldKey=BrowserOwnerHoldKey|BrowserExplicitHoldKey;

export type BrowserLifecycleBlockCode=
    | 'unsupported'|'foreign-key'|'legacy-scope'|'closed'|'busy'|'selected'
    | 'retained'|'stale-revision'|'uncertain'|'io-unsettled'|'ownership-unverified'
    | 'document-required'|'invalid-filename'|'retired-hold'|'storage-unavailable';
export interface BrowserLifecycleBlocked {
    readonly status:'blocked';
    readonly code:BrowserLifecycleBlockCode;
    readonly reason:unknown;
}
export type BrowserAccess<T>=
    | {readonly status:'available';readonly value:T}
    | {readonly status:'unavailable';readonly code:'deleted'|'missing'|'changed';readonly reason:unknown}
    | BrowserLifecycleBlocked;

/** Borrowed File: use/stream only until release; do not pass it beyond the lease lifetime. */
export interface BrowserFileLease {
    readonly version:BrowserResultReference;
    readonly file:File;
    readonly state:'active'|'released';
    readonly closed:Promise<void>;
    /** Idempotent; caller must finish all external File consumers first. Does not delete bytes. */
    release():Promise<void>;
}
export interface BrowserDownloadRequest {
    readonly status:'requested';
    readonly completion:'unobservable';
}
export interface BrowserPreparedDownload {
    readonly version:BrowserResultReference;
    readonly fileName:string;
    readonly state:'prepared'|'requested'|'disposed';
    readonly closed:Promise<void>;
    /** Synchronous, one-shot, from application user gesture. No promise of download completion. */
    request():BrowserDownloadRequest;
    /** Explicit URL revocation + owned read-lease release; may interrupt a still-running download. */
    dispose():Promise<void>;
}
export type BrowserHoldObservation=
    | {readonly status:'active'|'released'|'absent';readonly key:BrowserHoldKey}
    | {readonly status:'unknown';readonly key:BrowserHoldKey;readonly reason:unknown};
export type BrowserHoldMutation=
    | {readonly status:'active'|'released';readonly key:BrowserHoldKey}
    | {readonly status:'indeterminate';readonly key:BrowserHoldKey;readonly reason:unknown}
    | BrowserLifecycleBlocked;

export interface BrowserVersionSnapshot {
    readonly version:BrowserResultReference;
    readonly revision:BrowserResultRevision;
    readonly selection:'selected'|'superseded';
    readonly bytes:'present'|'deleting'|'deleted'|'missing'|'unknown';
    readonly retentionHolds:number;
}
export interface BrowserVersionPage {
    readonly versions:readonly BrowserVersionSnapshot[];
    readonly next?:BrowserResultCursor;
}
export type BrowserDeleteOutcome=
    | {readonly status:'deleted'|'already-deleted';readonly key:BrowserResultKey}
    | {readonly status:'indeterminate';readonly key:BrowserResultKey;readonly reason:unknown}
    | BrowserLifecycleBlocked;

/** Publication fencing and physical-I/O settlement are separate evidence. */
export type BrowserRecoverySnapshot=DestinationRecoverySnapshot<BrowserResultReference> & {
    readonly key:BrowserResultKey;
    readonly revision:BrowserResultRevision;
    readonly physicalIO:'settled'|'unknown';
    /** Original registered key when authoritative metadata exists; not proof the hold is active. */
    readonly ownerHold?:BrowserOwnerHoldKey;
};
export type BrowserRecoveryOutcome=
    | {readonly status:'observed';readonly snapshot:BrowserRecoverySnapshot}
    | {readonly status:'fenced';readonly snapshot:BrowserRecoverySnapshot & {
        readonly quiescent:true;
        readonly publication:{readonly status:'not-committed';readonly reason:unknown};
    }}
    | {readonly status:'indeterminate';readonly key:BrowserResultKey;readonly reason:unknown}
    | BrowserLifecycleBlocked;
export interface BrowserResultRecoveryService extends DestinationRecoveryService<BrowserResultReference> {
    /** Read-only snapshot. Missing/incomplete evidence is never automatically negative. */
    inspect(key:DestinationRecoveryKey):Promise<BrowserRecoverySnapshot>;
    /** Explicit metadata fence; never resumes encoding, republishes or deletes any file. */
    recover(key:BrowserResultKey,request:{readonly expectedRevision:BrowserResultRevision}):Promise<BrowserRecoveryOutcome>;
    /** Inherited cleanup touches owned definitively uncommitted staging only; requires settled I/O. */
}
export interface BrowserManagedAttempt {
    /** Persist these before starting export if later recovery/release is required. */
    readonly key:BrowserResultKey;
    readonly ownerHold:BrowserOwnerHoldKey;
    readonly destination:ExternalVideoDestination<BrowserResultReference>;
    readonly recovery:BrowserResultRecoveryService;
}
export type BrowserLifecycleSupport=
    | {readonly supported:true;readonly profile:'opfs-managed-v2';readonly coordination:'web-locks-and-idb';readonly nativeUserFileNames:false}
    | {readonly supported:false;readonly code:BrowserLifecycleBlockCode;readonly reason:string};
export type BrowserStoreClose=
    | {readonly status:'closed'}
    | {readonly status:'busy';readonly readers:number;readonly downloads:number;readonly attempts:number};

/** No factory is proposed here: provisioning/reopen is explicit, and no v1 auto-upgrade is allowed. */
export interface BrowserResultStoreDraft {
    readonly profile:'opfs-managed-v2';
    readonly recovery:BrowserResultRecoveryService;
    /** Read-only: no new database/directory, lock, writer, prompt or probing mutation. */
    checkSupport():Promise<BrowserLifecycleSupport>;
    bind(name:string):BrowserManagedAttempt;
    lookup(name:string):Promise<BrowserResultReference|undefined>;
    acquireFile(key:BrowserResultKey,options?:{readonly signal?:AbortSignal}):Promise<BrowserAccess<BrowserFileLease>>;
    prepareDownload(key:BrowserResultKey,options?:{readonly fileName?:string;readonly signal?:AbortSignal}):Promise<BrowserAccess<BrowserPreparedDownload>>;
    /** Allocates in memory only; persist before retain. IDs cannot be reused after release. */
    makeHoldKey(key:BrowserResultKey):BrowserExplicitHoldKey;
    retain(key:BrowserExplicitHoldKey):Promise<BrowserHoldMutation>;
    releaseHold(key:BrowserHoldKey):Promise<BrowserHoldMutation>;
    inspectHold(key:BrowserHoldKey):Promise<BrowserHoldObservation>;
    inspectVersion(key:BrowserResultKey):Promise<BrowserVersionSnapshot>;
    /** Bounded weak scan, not an atomic retention decision; limit defaults to32, max128. */
    scanVersions(request?:{readonly limit?:number;readonly cursor?:BrowserResultCursor}):Promise<BrowserVersionPage>;
    /** Superseded, unheld, unread committed versions only. No force/TTL/target deletion. */
    deleteVersion(key:BrowserResultKey,request:{readonly expectedRevision:BrowserResultRevision}):Promise<BrowserDeleteOutcome>;
    /** Busy does not poison the connection or invalidate outstanding leases/downloads. */
    close():Promise<BrowserStoreClose>;
}
