/** Private lifecycle algorithm. Storage/locks/UI are explicit ports; no browser globals at import. */
import type {ExternalVideoDestination,ExternalVideoTransaction,ExternalVideoCommit} from './video-external-types.js';
import type {
    BrowserResultStoreDraft,BrowserResultKey,BrowserResultReference,BrowserHoldKey,BrowserExplicitHoldKey,
    BrowserResultRevision,BrowserResultCursor,BrowserLifecycleBlockCode,BrowserLifecycleBlocked,
    BrowserAccess,BrowserFileLease,BrowserPreparedDownload,BrowserHoldMutation,BrowserHoldObservation,
    BrowserVersionSnapshot,BrowserDeleteOutcome,BrowserRecoverySnapshot,BrowserRecoveryOutcome,
    DestinationRecoveryKey,DestinationRecoveryCleanup,BrowserResultRecoveryService,BrowserStoreClose
} from './video-browser-results-types.js';
import type {BrowserResultStoreOptions,ManagedState,ManagedAttempt,ManagedVersion,BrowserResultWriterPort} from './video-browser-results-ports.js';

const backend='canvastake-opfs-managed-v2' as const;
const integer=(n:unknown,min=0):n is number=>Number.isSafeInteger(n)&&Number(n)>=min;
const id=(s:unknown):s is string=>typeof s==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(s);
const leaf=(s:unknown):s is string=>typeof s==='string'&&s.length<=100&&/^[a-z0-9][a-z0-9._-]*\.(mp4|webm)$/.test(s)&&!s.includes('..');
class Blocked extends Error {constructor(readonly code:BrowserLifecycleBlockCode,message:string){super(message);}}
class TransactionFailure {constructor(readonly status:'aborted'|'indeterminate',readonly reason:unknown){}}
const cause=(e:unknown)=>e instanceof TransactionFailure?e.reason:e;
const blocked=(code:BrowserLifecycleBlockCode,reason:unknown):BrowserLifecycleBlocked=>({status:'blocked',code,reason});
const failure=(e:unknown)=>blocked(cause(e) instanceof Blocked?(cause(e) as Blocked).code:'storage-unavailable',cause(e));
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(yes=>resolve=yes);return {promise,resolve};};

/** Ports are already provisioned, dedicated to this connection. Ownership transfers on success. */
export async function openBrowserResultStore(options:BrowserResultStoreOptions){
    if(options?.publication!=='opfs-catalog'||options.trust!=='cooperating-origin-namespace')throw new TypeError('Explicit managed catalogue/trust required');
    const {metadata,objects,locks,download}=options,scope=Object.freeze({...options.scope});
    if(scope.schema!==2||scope.backendId!==backend||!id(scope.scopeId)||!id(scope.directoryId))throw new Blocked('legacy-scope','Fresh managed-v2 scope required');
    const max=options.maxBindings??256;if(!integer(max,1))throw new RangeError('Invalid binding limit');
    let closing=false,closed=false,closeWork:Promise<BrowserStoreClose>|undefined,orphanCloseWork:Promise<BrowserStoreClose>|undefined;
    const stats={connections:1,operations:0,attempts:0,readers:0,downloads:0,borrowedBytes:0,physical:0,orphanLocks:0};
    const issued=new Set<string>();
    const orphanCleanups=new Set<()=>Promise<void>>(),cleanupIssues:unknown[]=[];
    async function releaseOwned(lease:Awaited<ReturnType<typeof locks.tryAcquire>>){
        if(!lease)return;try{await lease.release();}catch(e){cleanupIssues.push(e);stats.orphanLocks++;const clean=async()=>{await lease.release();stats.orphanLocks--;orphanCleanups.delete(clean);};orphanCleanups.add(clean);}
    }
    const nextId=()=>{const value=(options.newId??(()=>crypto.randomUUID()))();if(!id(value)||issued.has(value))throw new TypeError('Fresh bounded identity required');issued.add(value);return value;};
    function live(){if(closed||closing)throw new Blocked('closed','Result store closed');}
    function capability(){
        if(!metadata?.atomic||!objects?.positioned||!locks?.sharedExclusive)throw new Blocked('unsupported','Atomic metadata, positioned objects and shared/exclusive locks required');
        if(objects.scopeId!==scope.scopeId||objects.directoryId!==scope.directoryId)throw new Blocked('ownership-unverified','Object scope identity changed');
    }
    function validate(s:ManagedState){
        capability();const p=s?.scope;
        if(p?.schema!==2||p.backendId!==backend||p.scopeId!==scope.scopeId||p.directoryId!==scope.directoryId||!integer(p.sequence)||!integer(p.revision)||![s.attempts,s.versions,s.names,s.holds].every(m=>m instanceof Map))throw new Blocked('uncertain','Scope/schema unavailable or changed');
    }
    const read=<T>(body:(s:ManagedState)=>T)=>metadata.read(s=>{validate(s);return body(s);});
    async function tx<T>(label:string,body:(s:ManagedState)=>T):Promise<T>{
        const outcome=await metadata.transact(label,s=>{validate(s);return body(s);});
        if(outcome.status!=='committed')throw new TransactionFailure(outcome.status,outcome.reason);return outcome.value;
    }
    function run<T>(body:()=>Promise<T>):Promise<T>{
        try{live();}catch(e){return Promise.reject(e);}stats.operations++;
        return Promise.resolve().then(body).finally(()=>{stats.operations--;});
    }
    function key(value:DestinationRecoveryKey):BrowserResultKey {
        if(value?.version!==1||value.backendId!==backend||value.scopeId!==scope.scopeId||!id(value.attemptId))throw new Blocked('foreign-key','Invalid managed attempt key');
        return Object.freeze({version:1,backendId:backend,scopeId:scope.scopeId,attemptId:value.attemptId});
    }
    const revision=(n:number)=>(scope.scopeId+':'+n) as BrowserResultRevision;
    function expected(value:string){if(typeof value!=='string'||!value.startsWith(scope.scopeId+':')||!integer(Number(value.slice(scope.scopeId.length+1)),1)||value!==revision(Number(value.slice(scope.scopeId.length+1))))throw new Blocked('stale-revision','Invalid scope revision');}
    function bump(s:ManagedState){if(!integer(s.scope.revision+1,1))throw new RangeError('Revision exhausted');return ++s.scope.revision;}
    function fence(a:ManagedAttempt){if(!integer(a.epoch+1,1))throw new Blocked('uncertain','Publication fence exhausted');a.epoch++;}
    function attempt(s:ManagedState,k:BrowserResultKey):ManagedAttempt {
        key(k);
        const a=s.attempts.get(k.attemptId);
        if(!a||a.key.version!==1||a.key.backendId!==backend||a.key.scopeId!==scope.scopeId||a.key.attemptId!==k.attemptId||!leaf(a.name)||a.objectId!==k.attemptId+'.'+a.name.split('.').at(-1)||!id(a.ownerToken)||!integer(a.epoch)||!integer(a.revision,1)||!integer(a.size)||!['registered','writing','sealed','bytes-closed','committed','not-committed'].includes(a.phase)||!['settled','unknown'].includes(a.physicalIO)||!['present','deleting','deleted'].includes(a.staging)||a.ownerHold?.kind!=='commit-owner'||a.ownerHold.version.attemptId!==k.attemptId||a.ownerHold.version.scopeId!==scope.scopeId||!id(a.ownerHold.holdId))throw new Blocked('uncertain','Unknown or corrupt attempt evidence');
        if(a.revision>s.scope.revision||a.ownerHold.version.version!==1||a.ownerHold.version.backendId!==backend)throw new Blocked('uncertain','Attempt revision/hold evidence invalid');return a;
    }
    function version(s:ManagedState,k:BrowserResultKey):ManagedVersion {
        const a=attempt(s,k),v=s.versions.get(k.attemptId);
        if(a.phase!=='committed'||a.physicalIO!=='settled'||!v||v.value.key.attemptId!==k.attemptId||v.value.key.scopeId!==scope.scopeId||v.value.key.backendId!==backend||v.objectId!==a.objectId||v.ownerToken!==a.ownerToken||v.value.name!==a.name||v.value.size!==a.size||!integer(v.value.publicationSequence,1)||!integer(v.revision,1)||!['present','deleting','deleted'].includes(v.bytes)||v.value.format.extension!==a.name.split('.').at(-1)||v.value.format.mimeType!=='video/'+v.value.format.extension)throw new Blocked('uncertain','Committed version evidence unavailable');
        if(v.revision>s.scope.revision||v.value.publicationSequence>s.scope.sequence||v.value.key.version!==1)throw new Blocked('uncertain','Version revision/sequence invalid');return v;
    }
    const ref=(v:ManagedVersion):BrowserResultReference=>Object.freeze({...v.value,key:key(v.value.key),format:Object.freeze({...v.value.format})});
    function selected(s:ManagedState,v:ManagedVersion){
        const target=s.names.get(v.value.name);if(!target)throw new Blocked('uncertain','Selection evidence missing');
        const current=version(s,key({...v.value.key,attemptId:target}));
        if(current.value.name!==v.value.name||current.value.publicationSequence<v.value.publicationSequence)throw new Blocked('uncertain','Selection evidence corrupt');
        return target===v.value.key.attemptId;
    }
    function holdKey(h:BrowserHoldKey):BrowserHoldKey {
        if(!h||!['explicit','commit-owner'].includes(h.kind)||!id(h.holdId))throw new Blocked('foreign-key','Invalid retention key');return Object.freeze({kind:h.kind,holdId:h.holdId,version:key(h.version)});
    }
    function holdRecord(s:ManagedState,h:BrowserHoldKey){
        holdKey(h);
        const a=attempt(s,h.version);
        if((h.kind==='commit-owner')!==(h.holdId===a.ownerHold.holdId)||[...s.attempts.values()].some(other=>other.key.attemptId!==h.version.attemptId&&other.ownerHold.holdId===h.holdId))throw new Blocked('foreign-key','Hold identity/kind mismatch');
        const value=s.holds.get(h.holdId);
        if(value&&(value.key.kind!==h.kind||value.key.version.attemptId!==h.version.attemptId||value.key.version.scopeId!==scope.scopeId||!['active','released'].includes(value.state)))throw new Blocked('foreign-key','Foreign/corrupt retention record');return value;
    }
    function holds(s:ManagedState,k:BrowserResultKey){let n=0;for(const h of s.holds.values())if(h.key.version.attemptId===k.attemptId){holdRecord(s,h.key);if(h.state==='active')n++;}return n;}
    const lockName=(kind:'attempt'|'version',k:BrowserResultKey)=>[backend,scope.scopeId,kind,k.attemptId].map(encodeURIComponent).join('/');
    const signal=(s?:AbortSignal)=>{if(s?.aborted)throw s.reason;};
    const exact=(o:object,allowed:string[])=>{if(!o||Object.keys(o).some(k=>!allowed.includes(k)))throw new Blocked('unsupported','Unsupported lifecycle options');};
    await read(()=>{});

    async function inspectInner(k:BrowserResultKey):Promise<BrowserRecoverySnapshot>{
        const data=await read(s=>{const a=attempt(s,k);return {a,v:a.phase==='committed'?version(s,k):undefined,current:s.names.get(a.name)};});
        const {a,v,current}=data;let staging:'retained'|'absent'|'unknown'=a.staging==='deleted'||v?'absent':'unknown';
        let receipt:{status:'available';value:BrowserResultReference}|{status:'unavailable';reason:unknown}={status:'unavailable',reason:new Error('Original bytes unavailable')};
        if(v&&v.bytes==='present')try{const found=await objects.stat(v.objectId,v.ownerToken);if(found.status==='present'&&found.size===v.value.size)receipt={status:'available',value:ref(v)};}catch(e){receipt={status:'unavailable',reason:e};}
        if(!v&&a.staging!=='deleted')try{const found=await objects.stat(a.objectId,a.ownerToken);staging=found.status==='present'?'retained':found.status==='absent'?'absent':'unknown';}catch{}
        const common={key:k,revision:revision(a.revision),currentTarget:current===undefined?'absent' as const:current===k.attemptId?'this-attempt' as const:'other-publication' as const,staging,physicalIO:a.physicalIO,ownerHold:Object.freeze({...a.ownerHold,version:k})};
        if(a.phase==='committed')return {...common,quiescent:true,publication:{status:'committed',receipt}};
        if(a.phase==='not-committed')return {...common,quiescent:true,publication:{status:'not-committed',reason:a.reason}};
        return {...common,quiescent:false,publication:{status:'indeterminate',reason:new Error('No authoritative terminal outcome')}};
    }
    async function cleanupOwned(k:BrowserResultKey,rev:string){
        await tx('cleanup.claim',s=>{const a=attempt(s,k);if(revision(a.revision)!==rev)throw new Blocked('stale-revision','Cleanup revision changed');if(a.phase!=='not-committed')throw new Blocked('uncertain','Cleanup requires definite non-publication');if(a.physicalIO!=='settled')throw new Blocked('io-unsettled','Physical I/O remains uncertain');if(a.staging!=='deleted'){a.staging='deleting';a.revision=bump(s);}});
        const a=await read(s=>attempt(s,k));if(a.staging==='deleted')return 'already-clean' as const;
        await objects.remove(a.objectId,a.ownerToken,true);
        await tx('cleanup.deleted',s=>{const a=attempt(s,k);if(a.phase!=='not-committed'||a.staging!=='deleting'||a.physicalIO!=='settled')throw new Blocked('uncertain','Cleanup claim changed');a.staging='deleted';a.revision=bump(s);});return 'cleaned' as const;
    }
    const recovery:BrowserResultRecoveryService={
        inspect(value){return run(()=>inspectInner(key(value)));},
        recover(value,request){return run(async():Promise<BrowserRecoveryOutcome>=>{
            let owned:Awaited<ReturnType<typeof locks.tryAcquire>>;let k:BrowserResultKey;
            try{k=key(value);exact(request,['expectedRevision']);expected(request.expectedRevision);owned=await locks.tryAcquire(lockName('attempt',k),'exclusive');if(!owned)return blocked('busy','Publisher still owns attempt');
                const changed=await tx('recover.fence',s=>{const a=attempt(s,k);if(revision(a.revision)!==request.expectedRevision)throw new Blocked('stale-revision','Recovery revision changed');if(a.phase==='committed'||a.phase==='not-committed')return false;fence(a);a.phase='not-committed';a.reason=new Error('Abandoned publication fenced');a.revision=bump(s);return true;});
                const snapshot=await inspectInner(k);
                if(changed){if(!snapshot.quiescent||snapshot.publication.status!=='not-committed')throw new Blocked('uncertain','Fenced outcome unavailable');return {status:'fenced',snapshot:{...snapshot,quiescent:true,publication:snapshot.publication}};}
                return {status:'observed',snapshot};
            }catch(e){if(cause(e) instanceof Blocked)return failure(e);return {status:'indeterminate',key:key(value),reason:cause(e)};}finally{await releaseOwned(owned);}
        });},
        cleanup(value,request){return run(async():Promise<DestinationRecoveryCleanup>=>{
            let owned:Awaited<ReturnType<typeof locks.tryAcquire>>;
            try{const k=key(value);exact(request,['expectedRevision']);expected(request.expectedRevision);owned=await locks.tryAcquire(lockName('attempt',k),'exclusive');if(!owned)return {status:'blocked',reason:new Blocked('busy','Active publisher')};return {status:await cleanupOwned(k,request.expectedRevision)};}
            catch(e){return {status:'blocked',reason:cause(e)};}finally{await releaseOwned(owned);}
        });}
    };

    function bind(name:string){
        live();if(!leaf(name))throw new TypeError('Canonical MP4/WebM logical name required');if(bindings++>=max)throw new RangeError('Binding bound exceeded');
        const k=key({version:1,backendId:backend,scopeId:scope.scopeId,attemptId:nextId()}),ownerHold=Object.freeze({version:k,holdId:nextId(),kind:'commit-owner' as const}),ownerToken=nextId(),objectId=k.attemptId+'.'+name.split('.').at(-1);let claimed=false;
        const destination:ExternalVideoDestination<BrowserResultReference>={
            kind:'positioned-transactional',
            async checkSupport(request){try{live();await read(()=>{});if(claimed)throw new Error('Attempt consumed');if(!request||!['error','replace'].includes(request.ifExists)||request.format.extension!==name.split('.').at(-1)||request.format.mimeType!=='video/'+request.format.extension||!integer(request.maxWriteBytes,1)||request.maxWriteBytes>16777216||(request.maxOutputBytes!==undefined&&!integer(request.maxOutputBytes,1)))throw new Error('Unsupported exact request');return {supported:true};}catch(e){return {supported:false,reason:String(cause(e))};}},
            create(context){context={...context,format:Object.freeze({...context.format})};return run(async():Promise<ExternalVideoTransaction<BrowserResultReference>>=>{
                signal(context.signal);if(!(await destination.checkSupport(context)).supported)throw new Blocked('unsupported','Destination request unsupported');signal(context.signal);if(claimed)throw new Error('Attempt consumed');claimed=true;stats.attempts++;
                let owner:Awaited<ReturnType<typeof locks.tryAcquire>>,writer:BrowserResultWriterPort|undefined,registered=false,active=0,ended=false,sealed=false,failed=false,commitCalled=false,knownFalse=false,extent=0,localReleased=false,releaseStarted=false,releaseComplete=false,sessionAccounted=false;
                const guard=async()=>{signal(context.signal);await read(s=>{const a=attempt(s,k);if(a.epoch!==0||a.phase==='committed'||a.phase==='not-committed')throw new Blocked('uncertain','Attempt fenced/terminal');});signal(context.signal);};
                const finish=async(abort:boolean,reason?:unknown)=>{if(writer&&!ended){if(abort)await writer.abort(reason);else await writer.close();ended=true;}};
                const settle=()=>tx('attempt.settled',s=>{const a=attempt(s,k);a.physicalIO='settled';a.revision=bump(s);});
                const negative=(reason:unknown)=>tx('attempt.negative',s=>{const a=attempt(s,k);if(a.phase==='committed')throw new Blocked('uncertain','Cannot abort publication');fence(a);a.phase='not-committed';a.reason=reason;a.revision=bump(s);});
                try{
                    owner=await locks.tryAcquire(lockName('attempt',k),'exclusive');if(!owner)throw new Blocked('busy','Attempt lock unavailable');signal(context.signal);
                    await tx('attempt.register',s=>{if(s.attempts.has(k.attemptId)||s.versions.has(k.attemptId)||s.holds.has(ownerHold.holdId)||[...s.attempts.values()].some(a=>a.ownerHold.holdId===ownerHold.holdId))throw new Blocked('foreign-key','Attempt/hold identity already reserved');s.attempts.set(k.attemptId,{key:k,name,ownerHold,objectId,ownerToken,epoch:0,revision:bump(s),phase:'registered',physicalIO:'unknown',size:0,released:false,staging:'present'});});registered=true;
                    signal(context.signal);writer=await objects.create(objectId,ownerToken);await guard();await tx('attempt.writing',s=>{const a=attempt(s,k);if(a.epoch!==0)throw new Blocked('uncertain','Attempt fenced');a.phase='writing';a.revision=bump(s);});await guard();
                }catch(reason){
                    let accounted=false;
                    const clean=async()=>{
                        await finish(true,cause(reason));
                        if(registered)try{await settle();await negative(cause(reason));const a=await read(s=>attempt(s,k));await cleanupOwned(k,revision(a.revision));await tx('attempt.release',s=>{attempt(s,k).released=true;});}catch(e){cleanupIssues.push(cause(e));}
                        await owner?.release();owner=undefined;
                        if(!accounted){accounted=true;stats.attempts--;}orphanCleanups.delete(clean);
                    };
                    try{await clean();}catch(e){cleanupIssues.push(e);orphanCleanups.add(clean);}throw cause(reason);
                }
                function work(body:()=>Promise<void>){
                    if(active||ended||failed||commitCalled||releaseStarted)return Promise.reject(new Error('Overlapping or terminated operation'));active++;
                    return body().catch(e=>{failed=true;throw cause(e);}).finally(()=>{active--;});
                }
                const retryRelease=()=>releaseSession();
                async function releaseSession(){
                    if(releaseComplete)return;if(active)throw new Error('Release requires physical settlement');releaseStarted=true;active++;
                    let primary:unknown,hasError=false;
                    try{try{await finish(true);await settle();if(!commitCalled)await negative(new Error('Unpublished session released'));await tx('attempt.release',s=>{const a=attempt(s,k);a.released=true;a.revision=bump(s);});}catch(e){primary=cause(e);hasError=true;}
                        if(!localReleased)try{await owner!.release();localReleased=true;}catch(e){if(!hasError){primary=e;hasError=true;}}
                        if(localReleased&&ended){if(!sessionAccounted){sessionAccounted=true;stats.attempts--;}orphanCleanups.delete(retryRelease);}
                        if(hasError){cleanupIssues.push(primary);if(!localReleased||!ended)orphanCleanups.add(retryRelease);throw primary;}
                        releaseComplete=true;orphanCleanups.delete(retryRelease);
                    }finally{active--;}
                }
                return {
                    ready(s){return work(async()=>{signal(s);await guard();await writer!.ready();signal(s);await guard();});},
                    writeAt(position,data,s){return work(async()=>{signal(s);await guard();if(sealed||!integer(position)||!(data instanceof Uint8Array)||!(data.buffer instanceof ArrayBuffer)||!integer(position+data.length)||data.length>context.maxWriteBytes||(context.maxOutputBytes!==undefined&&position+data.length>context.maxOutputBytes))throw new RangeError('Invalid positioned write');new Uint8Array(data.buffer,data.byteOffset,data.byteLength);stats.borrowedBytes+=data.length;stats.physical++;try{await writer!.writeAt(position,data);extent=Math.max(extent,position+data.length);}finally{stats.borrowedBytes-=data.length;stats.physical--;}signal(s);await guard();});},
                    truncate(size,s){return work(async()=>{signal(s);await guard();if(sealed||!integer(size)||size!==extent)throw new RangeError('Seal extent mismatch');await writer!.truncate(size);signal(s);await guard();await tx('attempt.sealed',state=>{const a=attempt(state,k);if(a.epoch!==0)throw new Blocked('uncertain','Attempt fenced');a.phase='sealed';a.size=size;a.revision=bump(state);});sealed=true;});},
                    async commit():Promise<ExternalVideoCommit<BrowserResultReference>>{
                        if(active||commitCalled||failed||ended||releaseStarted||!sealed||!extent)throw new Error('Invalid commit admission');commitCalled=true;active++;let publishing=false;
                        try{
                            await finish(false);await tx('attempt.bytes-closed',s=>{const a=attempt(s,k);a.physicalIO='settled';a.revision=bump(s);if(a.epoch!==0||a.phase!=='sealed')throw new Blocked('uncertain','Attempt fenced');a.phase='bytes-closed';});
                            publishing=true;
                            return await tx('attempt.publish',s=>{
                                const a=attempt(s,k);if(a.epoch!==0||a.phase!=='bytes-closed'||a.physicalIO!=='settled')throw new Blocked('uncertain','Publication fence rejected');
                                if(context.ifExists==='error'&&s.names.has(name)){fence(a);a.phase='not-committed';a.reason=new DOMException('Catalogue name exists','ConstraintError');a.revision=bump(s);return {status:'not-committed' as const,reason:a.reason};}
                                const previous=s.names.get(name);if(previous){const old=version(s,key({...k,attemptId:previous}));old.revision=bump(s);}
                                if(s.holds.has(ownerHold.holdId)||!integer(s.scope.sequence+1,1))throw new Blocked('uncertain','Owner hold/sequence invalid');
                                const value:BrowserResultReference={key:k,name,size:extent,format:context.format,publicationSequence:++s.scope.sequence};
                                a.phase='committed';a.revision=bump(s);s.versions.set(k.attemptId,{value,objectId,ownerToken,revision:bump(s),bytes:'present'});s.names.set(name,k.attemptId);s.holds.set(ownerHold.holdId,{key:ownerHold,state:'active'});return {status:'committed' as const,value:ref(s.versions.get(k.attemptId)!)};
                            });
                        }catch(error){if(!publishing||(error instanceof TransactionFailure&&error.status==='aborted')){knownFalse=true;try{await negative(cause(error));}catch(e){cleanupIssues.push(cause(e));}return {status:'not-committed',reason:cause(error)};}throw cause(error);}
                        finally{active--;}
                    },
                    async abort(reason){if(active||releaseStarted)throw new Error('Abort requires physical settlement');active++;try{const a=await read(s=>attempt(s,k));if(a.phase==='committed'||(commitCalled&&!knownFalse&&a.phase!=='not-committed'))throw new Blocked('uncertain','Cannot abort committed/unknown publication');failed=true;await finish(true,reason);await settle();await negative(reason);const current=await read(s=>attempt(s,k));await cleanupOwned(k,revision(current.revision));}finally{active--; }},
                    release:releaseSession
                };
            });}
        };
        return Object.freeze({key:k,ownerHold,destination:Object.freeze(destination),recovery});
    }
    let bindings=0;

    async function acquireInner(k:BrowserResultKey,s?:AbortSignal):Promise<BrowserAccess<BrowserFileLease>>{
        signal(s);let owned:Awaited<ReturnType<typeof locks.tryAcquire>>;
        try{if(typeof File!=='function')return blocked('unsupported','File API unavailable');await read(state=>version(state,k));owned=await locks.tryAcquire(lockName('version',k),'shared');if(!owned)return blocked('busy','Version is exclusively owned');signal(s);
            const v=await read(state=>version(state,k));if(v.bytes!=='present')return {status:'unavailable',code:'deleted',reason:'Version deletion admitted'};
            const file=await objects.read(v.objectId,v.ownerToken);signal(s);if(file.size!==v.value.size)return {status:'unavailable',code:'changed',reason:'Original extent changed'};
            const named=new File([file],v.value.name,{type:v.value.format.mimeType,lastModified:file.lastModified}),done=deferred(),owner=owned;owned=undefined;stats.readers++;let released=false,releaseWork:Promise<void>|undefined;
            const lease:BrowserFileLease=Object.freeze({version:ref(v),file:named,get state(){return released?'released' as const:'active' as const;},closed:done.promise,release(){if(!releaseWork)releaseWork=Promise.resolve().then(()=>owner.release()).then(()=>{released=true;stats.readers--;done.resolve();}).catch(e=>{releaseWork=undefined;throw e;});return releaseWork;}});
            return {status:'available',value:lease};
        }catch(e){if(s?.aborted)throw s.reason;if(e instanceof DOMException&&e.name==='NotFoundError')return {status:'unavailable',code:'missing',reason:e};return failure(e);}finally{await releaseOwned(owned);}
    }
    async function mutateHold(h:BrowserHoldKey,retain:boolean):Promise<BrowserHoldMutation>{
        try{h=holdKey(h);if(retain&&h.kind!=='explicit')throw new Blocked('foreign-key','Owner hold is publication-owned');
            const state=await tx(retain?'hold.retain':'hold.release',s=>{
                const a=attempt(s,h.version),old=holdRecord(s,h);
                if(h.kind==='commit-owner'&&!['committed','not-committed'].includes(a.phase))throw new Blocked('uncertain','Owner hold may still publish');
                if(retain){const v=version(s,h.version);if(v.bytes!=='present')throw new Blocked('uncertain','Version is deleting/unavailable');if(old?.state==='released')throw new Blocked('retired-hold','Released identities cannot be reused');}
                const desired=retain?'active' as const:'released' as const;
                if(old?.state!==desired){s.holds.set(h.holdId,{key:h,state:desired});const v=s.versions.get(h.version.attemptId);if(v)v.revision=bump(s);a.revision=bump(s);}return desired;
            });return {status:state,key:h};
        }catch(e){if(cause(e) instanceof Blocked)return failure(e);return {status:'indeterminate',key:h,reason:cause(e)};}
    }
    async function snapshot(k:BrowserResultKey):Promise<BrowserVersionSnapshot>{
        const data=await read(s=>{const v=version(s,k);return {v,selected:selected(s,v),count:holds(s,k)};});let bytes:BrowserVersionSnapshot['bytes']=data.v.bytes;
        if(bytes==='present')try{const status=await objects.stat(data.v.objectId,data.v.ownerToken);bytes=status.status==='absent'?'missing':status.status!=='present'||status.size!==data.v.value.size?'unknown':'present';}catch{bytes='unknown';}
        return {version:ref(data.v),revision:revision(data.v.revision),selection:data.selected?'selected':'superseded',bytes,retentionHolds:data.count};
    }
    const store:BrowserResultStoreDraft={profile:'opfs-managed-v2',recovery,bind,
        checkSupport(){return run(async()=>{try{await read(()=>{});return {supported:true,profile:'opfs-managed-v2',coordination:'web-locks-and-idb',nativeUserFileNames:false};}catch(e){const f=failure(e);return {supported:false,code:f.code,reason:String(f.reason)};}});},
        lookup(name){return run(async()=>{if(!leaf(name))throw new TypeError('Invalid name');return read(s=>{const found=s.names.get(name);return found?ref(version(s,key({version:1,backendId:backend,scopeId:scope.scopeId,attemptId:found}))):undefined;});});},
        acquireFile(value,request={}){return run(()=>{exact(request,['signal']);return acquireInner(key(value),request.signal);});},
        prepareDownload(value,request={}){return run(async():Promise<BrowserAccess<BrowserPreparedDownload>>=>{
            exact(request,['fileName','signal']);signal(request.signal);const k=key(value);
            if(!download?.available())return blocked('document-required','Explicit document download adapter required');
            const v=await read(s=>version(s,k)),name=request.fileName??v.value.name;
            if(typeof name!=='string'||name.length>100||!name.length||/[\x00-\x1f\x7f/\\<>:"|?*]/.test(name)||name.includes('..')||!name.endsWith('.'+v.value.format.extension))return blocked('invalid-filename','Bounded matching file leaf required');
            const access=await acquireInner(k,request.signal);if(access.status!=='available')return access;
            const lease=access.value;let url:string;
            try{signal(request.signal);url=download.createURL(lease.file);signal(request.signal);}catch(primary){
                let revoked=false;const clean=async()=>{if(url!&&!revoked){download.revokeURL(url!);revoked=true;}await lease.release();orphanCleanups.delete(clean);};
                try{await clean();}catch(e){cleanupIssues.push(e);orphanCleanups.add(clean);}throw primary;
            }
            stats.downloads++;const done=deferred();let state:'prepared'|'requested'|'disposed'='prepared',disposing=false,revoked=false,disposeWork:Promise<void>|undefined;
            const handle:BrowserPreparedDownload=Object.freeze({version:lease.version,fileName:name,get state(){return state;},closed:done.promise,
                request(){if(disposing||state!=='prepared'||!download.available()||!download.hasActivation())throw new DOMException('Active document, user gesture and unused handle required','InvalidStateError');state='requested';download.request(url,name);return {status:'requested' as const,completion:'unobservable' as const};},
                dispose(){if(!disposeWork){disposing=true;disposeWork=Promise.resolve().then(async()=>{if(!revoked){download.revokeURL(url);revoked=true;}await lease.release();state='disposed';stats.downloads--;done.resolve();}).catch(e=>{disposeWork=undefined;throw e;});}return disposeWork;}
            });return {status:'available',value:handle};
        });},
        makeHoldKey(value){live();return Object.freeze({kind:'explicit',version:key(value),holdId:nextId()});},
        retain(value){return run(()=>mutateHold(value,true));},releaseHold(value){return run(()=>mutateHold(value,false));},
        inspectHold(value){return run(async():Promise<BrowserHoldObservation>=>{const h=holdKey(value);try{return await read(s=>({status:holdRecord(s,h)?.state??'absent',key:h}));}catch(e){if(cause(e) instanceof Blocked)throw cause(e);return {status:'unknown',key:h,reason:cause(e)};}});},
        inspectVersion(value){return run(()=>snapshot(key(value)));},
        scanVersions(request={}){return run(async()=>{
            exact(request,['limit','cursor']);const limit=request.limit??32;if(!integer(limit,1)||limit>128)throw new RangeError('Page limit must be1..128');let after=0;
            if(request.cursor!==undefined){const prefix=scope.scopeId+'/';if(typeof request.cursor!=='string'||!request.cursor.startsWith(prefix)||!integer(Number(request.cursor.slice(prefix.length)),1)||request.cursor!==prefix+Number(request.cursor.slice(prefix.length)))throw new Blocked('foreign-key','Invalid scope cursor');after=Number(request.cursor.slice(prefix.length));}
            const page=await read(s=>{if(after>s.scope.sequence)throw new Blocked('foreign-key','Future cursor');const selected:ManagedVersion[]=[];for(const raw of s.versions.values())if(raw.value.publicationSequence>after){const v=version(s,key(raw.value.key));let i=0;while(i<selected.length&&selected[i].value.publicationSequence<v.value.publicationSequence)i++;selected.splice(i,0,v);if(selected.length>limit+1)selected.pop();}return selected;});
            const values=await Promise.all(page.slice(0,limit).map(v=>snapshot(key(v.value.key))));return {versions:values,...(page.length>limit?{next:(scope.scopeId+'/'+page[limit-1].value.publicationSequence) as BrowserResultCursor}:{})};
        });},
        deleteVersion(value,request){return run(async():Promise<BrowserDeleteOutcome>=>{
            let owner:Awaited<ReturnType<typeof locks.tryAcquire>>,k:BrowserResultKey;
            try{k=key(value);exact(request,['expectedRevision']);expected(request.expectedRevision);owner=await locks.tryAcquire(lockName('version',k),'exclusive');if(!owner)return blocked('busy','Active reader/deleter');
                const before=await read(s=>{const v=version(s,k),a=attempt(s,k);if(revision(v.revision)!==request.expectedRevision)throw new Blocked('stale-revision','Deletion revision changed');if(selected(s,v))throw new Blocked('selected','Current result is selected');if(holds(s,k))throw new Blocked('retained','Version still retained');if(a.physicalIO!=='settled')throw new Blocked('io-unsettled','Physical work unknown');return v;});
                if(before.bytes==='deleted')return {status:'already-deleted',key:k};
                if(before.bytes==='present'){const native=await objects.stat(before.objectId,before.ownerToken);if(native.status!=='present'||native.size!==before.value.size)return blocked('ownership-unverified','Original owned object unavailable');}
                await tx('version.deleting',s=>{const v=version(s,k);if(revision(v.revision)!==request.expectedRevision)throw new Blocked('stale-revision','Deletion revision changed');if(selected(s,v)||holds(s,k))throw new Blocked('retained','Version became selected/retained');v.bytes='deleting';v.revision=bump(s);});
                await objects.remove(before.objectId,before.ownerToken,true);
                await tx('version.deleted',s=>{const v=version(s,k);if(v.bytes!=='deleting')throw new Blocked('uncertain','Deletion claim changed');v.bytes='deleted';v.revision=bump(s);});return {status:'deleted',key:k};
            }catch(e){if(cause(e) instanceof Blocked)return failure(e);return {status:'indeterminate',key:key(value),reason:cause(e)};}finally{await releaseOwned(owner);}
        });},
        close(){
            if(closed)return Promise.resolve({status:'closed'});
            if(closeWork)return closeWork;
            if(orphanCleanups.size){if(!orphanCloseWork)orphanCloseWork=Promise.allSettled([...orphanCleanups].map(clean=>clean())).then(()=>orphanCleanups.size?{status:'busy' as const,attempts:stats.attempts,readers:stats.readers,downloads:stats.downloads}:store.close()).finally(()=>{orphanCloseWork=undefined;});return orphanCloseWork;}
            if(stats.attempts||stats.readers||stats.downloads||stats.operations)return Promise.resolve({status:'busy',attempts:stats.attempts,readers:stats.readers,downloads:stats.downloads});
            closing=true;closeWork=Promise.resolve().then(()=>metadata.close()).then(()=>{closed=true;stats.connections=0;return {status:'closed' as const};}).catch(e=>{closing=false;closeWork=undefined;throw e;});return closeWork;
        }
    };
    return Object.freeze({...store,get stats(){return Object.freeze({...stats,cleanupIssues:[...cleanupIssues]});}});
}
