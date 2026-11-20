/** Private port boundary shared by the native browser adapter and the controlled tests. */
import type {BrowserResultKey,BrowserOwnerHoldKey,BrowserResultReference,BrowserHoldKey} from './video-browser-results-types.js';
export interface ManagedScope {schema:2;backendId:'canvastake-opfs-managed-v2';scopeId:string;directoryId:string;sequence:number;revision:number}
export interface ManagedAttempt {
    key:BrowserResultKey;name:string;ownerHold:BrowserOwnerHoldKey;objectId:string;ownerToken:string;
    epoch:number;revision:number;phase:'registered'|'writing'|'sealed'|'bytes-closed'|'committed'|'not-committed';
    physicalIO:'settled'|'unknown';size:number;released:boolean;staging:'present'|'deleting'|'deleted';reason?:unknown;
}
export interface ManagedVersion {value:BrowserResultReference;objectId:string;ownerToken:string;revision:number;bytes:'present'|'deleting'|'deleted'}
export interface ManagedHold {key:BrowserHoldKey;state:'active'|'released'}
export interface ManagedState {scope:ManagedScope;attempts:Map<string,ManagedAttempt>;versions:Map<string,ManagedVersion>;names:Map<string,string>;holds:Map<string,ManagedHold>}
export type MetadataCommit<T>={status:'committed';value:T}|{status:'aborted'|'indeterminate';reason:unknown};
export interface BrowserResultMetadataPort {
    readonly atomic:boolean;
    /** Synchronous callback, isolated read snapshot; never create missing schema/scope. */
    read<T>(body:(state:ManagedState)=>T):Promise<T>;
    /** Serial atomic mutation across connections, including work with a lost acknowledgement.
     * An indeterminate reply is not cancellation of that transaction. No callback awaits. */
    transact<T>(label:string,body:(state:ManagedState)=>T):Promise<MetadataCommit<T>>;
    close():Promise<void>;
}
export interface BrowserResultWriterPort {
    /** These Promises track issued physical work. Successful close/abort proves it has settled;
     * a rejection alone must never be interpreted as such proof. */
    ready():Promise<void>;
    writeAt(position:number,data:Uint8Array<ArrayBuffer>):Promise<void>;
    truncate(size:number):Promise<void>;
    close():Promise<void>;
    abort(reason?:unknown):Promise<void>;
}
export type BrowserObjectStatus={status:'present';size:number}|{status:'absent'|'foreign'};
export interface BrowserResultObjectPort {
    readonly scopeId:string;readonly directoryId:string;readonly positioned:boolean;
    /** Rejecting acquisition owns cleanup of unreturned resources and waits for its issued work. */
    create(objectId:string,ownerToken:string):Promise<BrowserResultWriterPort>;
    stat(objectId:string,ownerToken:string):Promise<BrowserObjectStatus>;
    read(objectId:string,ownerToken:string):Promise<File>;
    /** Exact private object identity; tolerate absence only after an owned deletion claim. */
    remove(objectId:string,ownerToken:string,allowMissing:boolean):Promise<void>;
}
export interface BrowserResultLockPort {
    readonly sharedExclusive:boolean;
    /** Non-waiting; no steal/TTL. Release settles only once the actual lock is released. */
    tryAcquire(name:string,mode:'shared'|'exclusive'):Promise<{release():Promise<void>}|undefined>;
}
export interface BrowserResultDownloadPort {
    available():boolean;
    hasActivation():boolean;
    createURL(file:File):string;
    revokeURL(url:string):void;
    request(url:string,fileName:string):void;
}
export interface BrowserResultStoreOptions {
    readonly publication:'opfs-catalog';readonly trust:'cooperating-origin-namespace';
    readonly scope:Readonly<Pick<ManagedScope,'schema'|'backendId'|'scopeId'|'directoryId'>>;
    readonly metadata:BrowserResultMetadataPort;readonly objects:BrowserResultObjectPort;
    readonly locks:BrowserResultLockPort;readonly download?:BrowserResultDownloadPort;
    readonly newId?:()=>string;readonly maxBindings?:number;
}
