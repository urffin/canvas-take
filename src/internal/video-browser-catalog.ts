// Private prototype: immutable OPFS objects + atomic IndexedDB logical-name publication.
import type {ExternalVideoDestination,ExternalVideoDestinationRequest,ExternalVideoCommit} from './video-external-types.js';
import type {Support} from '../video.js';

export interface BrowserVideoReceipt {
    readonly name:string;
    readonly attemptId:string;
    readonly objectName:string;
    readonly size:number;
    /** Read-only original version, independent of catalogue connection/selected logical name. */
    getFile():Promise<File>;
}
export interface BrowserCatalogOptions {
    readonly directory:FileSystemDirectoryHandle;
    readonly databaseName:string;
    /** Explicitly not an OS/user-visible filename replacement adapter. */
    readonly publication:'opfs-catalog';
    readonly trust:'cooperating-origin-namespace';
    readonly maxAttempts?:number;
    /** Private verification hooks; no production backend customization. */
    readonly fault?:(point:string,info:Readonly<{attemptId:string;objectName:string;name:string}>)=>void|Promise<void>;
    /** Synchronous fault inside the publication transaction, for atomic-abort verification. */
    readonly transactionFault?:()=>void;
}
type Phase='reserved'|'writing'|'sealed'|'committed'|'not-committed';
interface Attempt {
    id:string;scopeId:string;name:string;objectName:string;phase:Phase;revision:number;
    handle?:FileSystemFileHandle;size:number;released:boolean;removed:boolean;cleanup?:string;
}
interface Scope {version:1;id:string;directory:FileSystemDirectoryHandle}
interface Entry {name:string;attemptId:string;scopeId:string}
const bad=(message:string)=>new Error('Private browser catalogue: '+message);
const integer=(value:number,min=0)=>Number.isSafeInteger(value)&&value>=min;
const leaf=(value:string)=>typeof value==='string'&&value.length<=100&&/^[a-z0-9][a-z0-9._-]*\.(mp4|webm)$/.test(value)&&!value.includes('..');

/** Native handles do not establish portable atomic named no-replace/overwrite guarantees. */
export function checkNativeBrowserFileDestination():Support {
    return {supported:false,reason:'Native named create-new/replace has no verified portable profile; this prototype publishes logical OPFS catalogue entries only'};
}

/** Explicit provisioning, outside exporter preflight. DB and OPFS directory must be app-owned. */
export async function openBrowserVideoCatalog(options:BrowserCatalogOptions){
    if(options?.publication!=='opfs-catalog'||options.trust!=='cooperating-origin-namespace'||!/^canvastake-browser-video-[a-z0-9-]+$/.test(options.databaseName))throw new TypeError('Explicit private OPFS catalogue/name/trust required');
    if(!options.directory||options.directory.kind!=='directory')throw new TypeError('Private OPFS directory required');
    const maxAttempts=options.maxAttempts??256;
    if(!integer(maxAttempts,1))throw new RangeError('Invalid retained-attempt bound');
    if(typeof indexedDB==='undefined'||typeof navigator==='undefined'||!navigator.storage?.getDirectory)throw new DOMException('OPFS and IndexedDB required','NotSupportedError');
    const directory=options.directory,root=await navigator.storage.getDirectory();
    const location=await root.resolve(directory);
    if(!location||location.length!==1||!/^canvastake-browser-video-[a-z0-9-]+$/.test(directory.name))throw new DOMException('Dedicated private OPFS child directory required','NotSupportedError');
    let closing=false,closed=false;
    const stats={connections:0,sessions:0,activeWriters:0,physical:0,peakPhysical:0,borrowedBytes:0,peakBorrowedBytes:0,writes:0,rewrites:0,commits:0,aborts:0};
    const pending=new Set<Promise<unknown>>(),ownedAttempts=new Set<string>();
    const db=await new Promise<IDBDatabase>((yes,no)=>{
        const request=indexedDB.open(options.databaseName,1);let rejected=false;
        request.onupgradeneeded=()=>{for(const name of ['meta','attempts','entries'])request.result.createObjectStore(name);};
        request.onsuccess=()=>{if(rejected)request.result.close();else yes(request.result);};request.onerror=()=>no(request.error);
        request.onblocked=()=>{rejected=true;no(bad('database provisioning blocked'));};
    });stats.connections=1;
    const closeConnection=()=>{if(!closed){closed=true;closing=true;db.close();stats.connections=0;}};
    db.onversionchange=closeConnection;
    function database<T>(stores:string[],mode:IDBTransactionMode,body:(tx:IDBTransaction,set:(value:T)=>void,safe:(fn:()=>void)=>void)=>void,aborted?:()=>void):Promise<T>{
        if(closing||closed)return Promise.reject(bad('catalogue closed'));
        const work=new Promise<T>((yes,no)=>{
            let tx:IDBTransaction;try{tx=db.transaction(stores,mode);}catch(error){aborted?.();no(error);return;}
            let result:T,failed=false,reason:unknown;
            const safe=(fn:()=>void)=>{try{fn();}catch(error){failed=true;reason=error;try{tx.abort();}catch{}}};
            tx.oncomplete=()=>yes(result);tx.onabort=()=>{aborted?.();no(failed?reason:tx.error??bad('transaction aborted'));};
            safe(()=>body(tx,value=>{result=value;},safe));
        });
        pending.add(work);void work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
    }
    try{for(const name of ['meta','attempts','entries'])if(!db.objectStoreNames.contains(name))throw bad('foreign catalogue schema');}
    catch(error){closeConnection();throw error;}
    let scope:Scope;
    try{
        const candidate:Scope={version:1,id:crypto.randomUUID(),directory};
        scope=await database<Scope>(['meta'],'readwrite',(tx,set,safe)=>{
            const store=tx.objectStore('meta'),request=store.get('scope');
            request.onsuccess=()=>safe(()=>{if(request.result)set(request.result);else{store.add(candidate,'scope');set(candidate);}});
        });
        if(scope.version!==1||typeof scope.id!=='string'||!await scope.directory.isSameEntry(directory))throw bad('catalogue directory/scope mismatch');
    }catch(error){closeConnection();throw error;}
    async function validate(){
        if(closing||closed)throw bad('catalogue closed');
        const stored=await database<Scope|undefined>(['meta'],'readonly',(tx,set)=>{const r=tx.objectStore('meta').get('scope');r.onsuccess=()=>set(r.result);});
        if(!stored||stored.id!==scope.id||!await stored.directory.isSameEntry(directory)||!await root.resolve(directory))throw bad('catalogue scope changed');
    }
    const get=async(id:string)=>database<Attempt|undefined>(['attempts'],'readonly',(tx,set)=>{const r=tx.objectStore('attempts').get(id);r.onsuccess=()=>set(r.result);});
    function update(id:string,change:(record:Attempt)=>void){
        return database<Attempt>(['attempts'],'readwrite',(tx,set,safe)=>{
            const store=tx.objectStore('attempts'),r=store.get(id);r.onsuccess=()=>safe(()=>{const record:Attempt=r.result;if(!record||record.scopeId!==scope.id)throw bad('unknown attempt');change(record);record.revision++;store.put(record,id);set(record);});
        });
    }
    function receipt(record:Attempt):BrowserVideoReceipt {
        const handle=record.handle;if(!handle)throw bad('file handle missing');
        const name=record.name,id=record.id,objectName=record.objectName,size=record.size;
        return Object.freeze({name,attemptId:id,objectName,size,async getFile(){const file=await handle.getFile();if(file.size!==size)throw bad('original version unavailable/changed');return file;}});
    }
    function bind(name:string){
        if(!leaf(name))throw new TypeError('Canonical lower-case MP4/WebM catalogue name required');
        if(ownedAttempts.size>=maxAttempts)throw new RangeError('Retained-attempt limit exceeded');
        const id=crypto.randomUUID(),objectName=id+'.'+name.split('.').at(-1);
        ownedAttempts.add(id);
        const key=Object.freeze({version:1,backendId:'canvastake-browser-catalog-v1',scopeId:scope.id,attemptId:id});
        const fault=(point:string)=>options.fault?.(point,Object.freeze({attemptId:id,objectName,name}));
        let claimed=false,active=0,handle:FileSystemFileHandle|undefined,writer:WritableStreamDefaultWriter<FileSystemWriteChunkType>|undefined;
        let ended=false,commitInvoked=false,sealed=false,failed=false,released=false,size=0,previousPosition=-1;
        const destination:ExternalVideoDestination<BrowserVideoReceipt>={
            kind:'positioned-transactional',
            async checkSupport(request){
                if(claimed||closing||closed)return {supported:false,reason:'Closed catalogue or consumed attempt'};
                try{await validate();}catch{return {supported:false,reason:'Catalogue scope unavailable'};}
                if(request.ifExists!=='error'&&request.ifExists!=='replace')return {supported:false,reason:'Unsupported publication policy'};
                const extension=name.split('.').at(-1);
                if(request.format.extension!==extension||request.format.mimeType!=='video/'+extension)return {supported:false,reason:'Container/name mismatch'};
                if(!integer(request.maxWriteBytes,1)||request.maxWriteBytes>16*1024*1024||(request.maxOutputBytes!==undefined&&!integer(request.maxOutputBytes,1)))return {supported:false,reason:'Unsupported output limits'};
                return {supported:true};
            },
            async create(context){
                const support=await destination.checkSupport(context);if(!support.supported)throw new DOMException(support.reason,'NotSupportedError');
                if(context.signal.aborted)throw context.signal.reason;if(claimed||closing||closed)throw bad('attempt/catalogue unavailable');claimed=true;active++;stats.sessions++;
                let reserved=false;
                const guard=()=>{if(context.signal.aborted)throw context.signal.reason;if(failed||closing||closed)throw bad('session/catalogue unavailable');};
                async function finishWriter(abort:boolean,reason?:unknown){
                    if(!writer||ended)return;
                    try{if(abort)await writer.abort(reason);else await writer.close();}
                    finally{ended=true;stats.activeWriters--;writer.releaseLock();}
                }
                async function removePrivate(){
                    if(!handle)return;
                    try{const current=await directory.getFileHandle(objectName);if(!await current.isSameEntry(handle!))throw bad('private object identity changed');await directory.removeEntry(objectName);}
                    catch(error){if(!(error instanceof DOMException)||error.name!=='NotFoundError')throw error;}
                }
                try{
                    await validate();guard();
                    const record:Attempt={id,scopeId:scope.id,name,objectName,phase:'reserved',revision:1,size:0,released:false,removed:false};
                    await database<void>(['attempts'],'readwrite',(tx,set)=>{tx.objectStore('attempts').add(record,id);set();});
                    reserved=true;
                    // IDB reserves every object ID across cooperative connections before FS creation.
                    try{await directory.getFileHandle(objectName);throw bad('unexpected existing private object');}catch(error){if(!(error instanceof DOMException)||error.name!=='NotFoundError')throw error;}
                    guard();handle=await directory.getFileHandle(objectName,{create:true});
                    await update(id,r=>{r.handle=handle;r.phase='writing';});guard();await fault('before-open-writer');guard();
                    const stream=await handle.createWritable({keepExistingData:false});writer=stream.getWriter();stats.activeWriters++;void writer.closed.catch(()=>{});
                    await fault('after-open-writer');guard();
                }catch(reason){
                    try{await finishWriter(true,reason);}catch{}
                    // No publication can have been issued during construction.
                    if(reserved)try{await removePrivate();await update(id,r=>{r.phase='not-committed';r.released=true;r.removed=!!handle;});}catch{}
                    active--;stats.sessions--;throw reason;
                }
                active--;
                function work(body:()=>Promise<void>):Promise<void>{
                    if(active||ended||commitInvoked||failed)return Promise.reject(bad('overlapping or terminated operation'));
                    active++;
                    return Promise.resolve().then(body).catch(error=>{failed=true;throw error;}).finally(()=>{active--;});
                }
                return {
                    ready(signal){return work(async()=>{if(signal.aborted)throw signal.reason;guard();await fault('ready');guard();await writer!.ready;});},
                    writeAt(position,data,signal){return work(async()=>{
                        guard();if(signal.aborted)throw signal.reason;
                        if(sealed||!integer(position)||!(data instanceof Uint8Array)||!(data.buffer instanceof ArrayBuffer)||!integer(position+data.byteLength)||data.length>context.maxWriteBytes||(context.maxOutputBytes!==undefined&&position+data.length>context.maxOutputBytes))throw new RangeError('Invalid positioned OPFS write');
                        new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
                        stats.physical++;stats.borrowedBytes+=data.byteLength;stats.peakPhysical=Math.max(stats.peakPhysical,stats.physical);stats.peakBorrowedBytes=Math.max(stats.peakBorrowedBytes,stats.borrowedBytes);
                        try{await fault('write');guard();await writer!.write({type:'write',position,data:data as Uint8Array<ArrayBuffer>});size=Math.max(size,position+data.length);stats.writes++;if(position<previousPosition)stats.rewrites++;previousPosition=position;}
                        finally{stats.physical--;stats.borrowedBytes-=data.byteLength;}
                    });},
                    truncate(length,signal){return work(async()=>{guard();if(signal.aborted)throw signal.reason;if(sealed||!integer(length)||length!==size)throw bad('seal must match written extent');await fault('truncate');guard();await writer!.write({type:'truncate',size:length});await update(id,r=>{r.phase='sealed';r.size=length;});sealed=true;});},
                    async commit():Promise<ExternalVideoCommit<BrowserVideoReceipt>>{
                        if(active||commitInvoked||failed||!sealed||!size)throw bad('invalid commit admission');commitInvoked=true;active++;
                        let publicationStarted=false,publicationAborted=false;
                        try{
                            await fault('before-close');await finishWriter(false);await fault('after-close');await validate();await fault('before-publish');
                            // No await in the transaction callbacks. Entry and outcome are one IDB commit.
                            publicationStarted=true;
                            const outcome=await database<{committed:boolean;record:Attempt}>(['entries','attempts'],'readwrite',(tx,set,safe)=>{
                                const attempts=tx.objectStore('attempts'),entries=tx.objectStore('entries'),r=attempts.get(id);
                                r.onsuccess=()=>safe(()=>{
                                    const record:Attempt=r.result;if(!record||record.scopeId!==scope.id||record.phase!=='sealed'||record.released)throw bad('invalid publication record');
                                    const existing=entries.get(name);existing.onsuccess=()=>safe(()=>{
                                        const collision=context.ifExists==='error'&&existing.result!==undefined;
                                        record.phase=collision?'not-committed':'committed';record.revision++;attempts.put(record,id);
                                        if(!collision)entries.put({name,attemptId:id,scopeId:scope.id} satisfies Entry,name);
                                        options.transactionFault?.();
                                        set({committed:!collision,record});
                                    });
                                });
                            },()=>{publicationAborted=true;});
                            if(!outcome.committed)return {status:'not-committed',reason:new DOMException('Catalogue name already exists','ConstraintError')};
                            stats.commits++;await fault('after-publish');return {status:'committed',value:receipt(outcome.record)};
                        }catch(reason){
                            if(!publicationStarted||publicationAborted){
                                await update(id,r=>{r.phase='not-committed';});return {status:'not-committed',reason};
                            }
                            throw reason;
                        }finally{active--;}
                    },
                    async abort(reason){
                        if(active)throw bad('abort must wait for physical work');active++;
                        try{const record=await get(id);if(record?.phase==='committed')throw bad('published object cannot be aborted');
                            // A transaction failure/exception may be ambiguous; the persisted record must
                            // first be definitive. Before publication no catalogue entry exists for this ID.
                            if(commitInvoked&&record?.phase!=='not-committed')throw bad('uncertain commit cannot be aborted');
                            await finishWriter(true,reason);await update(id,r=>{r.phase='not-committed';});await removePrivate();await update(id,r=>{r.removed=true;});stats.aborts++;
                        }finally{active--;}
                    },
                    async release(){if(active)throw bad('release must wait for physical work');if(released)return;active++;
                        try{await finishWriter(true);await update(id,r=>{r.released=true;});}finally{released=true;stats.sessions--;active--;}
                    }
                };
            }
        };
        return Object.freeze({key,destination:Object.freeze(destination),get active(){return active;}});
    }
    async function lookup(name:string):Promise<BrowserVideoReceipt|undefined>{
        if(!leaf(name))throw new TypeError('Invalid catalogue name');await validate();
        const record=await database<Attempt|undefined>(['entries','attempts'],'readonly',(tx,set,safe)=>{
            const r=tx.objectStore('entries').get(name);r.onsuccess=()=>safe(()=>{
                const entry:Entry|undefined=r.result;if(!entry){set(undefined);return;}if(entry.scopeId!==scope.id)throw bad('foreign entry');
                const attempt=tx.objectStore('attempts').get(entry.attemptId);attempt.onsuccess=()=>safe(()=>{const value:Attempt=attempt.result;if(value?.phase!=='committed')throw bad('invalid committed entry');set(value);});
            });
        });return record?receipt(record):undefined;
    }
    async function inspect(id:string){
        const record=await get(id);if(!record||record.scopeId!==scope.id)throw bad('unknown attempt');
        return Object.freeze({attemptId:id,phase:record.phase,revision:record.revision,released:record.released,removed:record.removed,objectName:record.objectName,
            ...(record.phase==='committed'?{value:receipt(record)}:{})});
    }
    async function cleanup(id:string,revision:number){
        const token=crypto.randomUUID();
        const record=await database<Attempt>(['attempts'],'readwrite',(tx,set,safe)=>{
            const store=tx.objectStore('attempts'),r=store.get(id);r.onsuccess=()=>safe(()=>{
                const value:Attempt=r.result;if(!value||value.scopeId!==scope.id||value.revision!==revision||!value.released||value.phase!=='not-committed'||value.cleanup)throw bad('cleanup blocked by stale/unknown/published state');
                value.cleanup=token;value.revision++;store.put(value,id);set(value);
            });
        });
        if(record.removed){await update(id,r=>{delete r.cleanup;});return;}
        try{
            if(!record.handle)throw bad('private ownership unavailable');
            const current=await directory.getFileHandle(record.objectName);if(!await current.isSameEntry(record.handle))throw bad('foreign private object');
            await directory.removeEntry(record.objectName);await update(id,r=>{if(r.cleanup!==token)throw bad('cleanup ownership changed');r.removed=true;delete r.cleanup;});
        }catch(error){await update(id,r=>{if(r.cleanup===token)delete r.cleanup;});throw error;}
    }
    return Object.freeze({publication:'opfs-catalog' as const,scopeId:scope.id,bind,lookup,inspect,cleanup,
        get stats(){return Object.freeze({...stats});},
        async close(){if(stats.sessions||stats.activeWriters)throw bad('close requires settled export sessions');closing=true;while(pending.size)await Promise.allSettled([...pending]);closeConnection();}
    });
}
