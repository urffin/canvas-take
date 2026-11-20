// Internal Node implementation. Recovery is scoped to the live receiver instance.
import {open,mkdir,lstat,realpath,access,link,rename,unlink,readFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join,parse} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

const backendId='canvastake-node-local-v1',MAX_WRITE=16*1024*1024;
const integer=(n,min=0)=>Number.isSafeInteger(n)&&n>=min;
const fail=message=>new Error('Private file destination: '+message);
const digest=data=>createHash('sha256').update(data).digest('hex');
const id=s=>s?`${s.dev}:${s.ino}`:null;
const same=(a,b)=>a!==null&&a===b;
async function info(path){try{return await lstat(path,{bigint:true});}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function writeAll(file,data,position,step=data.byteLength){
    for(let offset=0;offset<data.length;){const length=Math.min(step,data.length-offset);
        const {bytesWritten}=await file.write(data,offset,length,position+offset);
        if(!integer(bytesWritten,1)||bytesWritten>length)throw fail('write made no valid progress');offset+=bytesWritten;
    }
}
function validLeaf(name){return typeof name==='string'&&name.length<=100&&/^[a-z0-9][a-z0-9._-]*\.(mp4|webm)$/.test(name)&&!name.includes('..')&&!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(name);}
async function canonical(path){
    const absolute=resolve(path),root=parse(absolute).root;let part=root;
    for(const segment of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)){part=join(part,segment);const s=await lstat(part);if(s.isSymbolicLink()||!s.isDirectory())throw fail('scope ancestors must be real directories');}
    const actual=await realpath(absolute);if(process.platform==='win32'?actual.toLowerCase()!==absolute.toLowerCase():actual!==absolute)throw fail('scope must be canonical');return absolute;
}

/** Explicit provisioning mutates only a fresh private directory. Preflight never runs probes. */
export async function provisionNodeVideoDestination(directory,options={}){
    if(options.trust!=='controlled-local-directory')throw fail('explicit controlled local directory profile required');
    if(!['win32','linux'].includes(process.platform)||![22,24].includes(Number(process.versions.node.split('.')[0])))throw fail('unverified runtime/platform profile');
    const root=await canonical(directory),rootId=id(await info(root)),run=join(root,'.canvastake-'+randomUUID());
    const maxWriteBytes=options.maxWriteBytes??MAX_WRITE,maxAttempts=options.maxAttempts??1024;
    if(!integer(maxWriteBytes,1)||maxWriteBytes>MAX_WRITE||!integer(maxAttempts,1))throw new RangeError('Invalid receiver bounds');
    if(options.shortWrite!==undefined&&!integer(options.shortWrite,1))throw new RangeError('Invalid short-write bound');
    await mkdir(run,{mode:0o700});const runId=id(await info(run)),scope=Object.freeze({backendId,scopeId:randomUUID(),profileRevision:randomUUID()});
    let valid=true;
    const stats={liveHandles:0,physical:0,peakPhysical:0,borrowedBytes:0,peakBorrowedBytes:0,publications:0,journalWrites:0,cleanupFailures:0};
    const attempts=new Map();
    async function validateIdentity(){
        if(id(await info(root))!==rootId||id(await info(run))!==runId||(await canonical(root))!==root)throw fail('stale or moved scope');
    }
    async function validate(){if(!valid)throw fail('profile invalidated');await validateIdentity();}
    async function permissions(){await access(root,constants.R_OK|constants.W_OK);await access(run,constants.R_OK|constants.W_OK);}
    async function owned(path,identity){const s=await info(path);return !!s&&s.isFile()&&!s.isSymbolicLink()&&same(id(s),identity);}
    async function removeOwned(path,identity){
        await validateIdentity();const s=await info(path);if(!s)return false;
        if(!s.isFile()||s.isSymbolicLink()||!same(id(s),identity))throw fail('artifact ownership changed');await unlink(path);return true;
    }
    async function openOwned(path){const file=await open(path,'wx',0o600);stats.liveHandles++;try{return {file,identity:id(await file.stat({bigint:true})),closed:false};}catch(e){await file.close();stats.liveHandles--;throw e;}}
    async function close(handle){if(handle?.file&&!handle.closed){await handle.file.close();handle.closed=true;stats.liveHandles--;}}
    // Provision both policy primitives outside checkSupport. No target name is involved.
    const probes=[];
    try{
        await validate();await permissions();
        const a=join(run,'probe-a'),b=join(run,'probe-b'),c=join(run,'probe-c');
        for(const path of [a,b]){const h=await openOwned(path);probes.push([path,h]);try{await writeAll(h.file,new Uint8Array(path===a?[1,2,3]:[9,9,9,9]),0);}finally{await close(h);}}
        if(probes[0][1].identity===probes[1][1].identity)throw fail('filesystem lacks distinct stable file identities');
        await link(a,c);probes.push([c,{identity:probes[0][1].identity}]);
        try{await link(b,c);throw fail('no-replace probe unexpectedly replaced target');}catch(e){if(e.code!=='EEXIST')throw e;}
        if(!(await readFile(c)).equals(Buffer.from([1,2,3])))throw fail('no-replace probe modified winner');
        await rename(b,c);probes[2][1]={identity:probes[1][1].identity};
        if(!(await readFile(c)).equals(Buffer.from([9,9,9,9])))throw fail('replace probe mismatch');
        const h=await open(c,'r+');stats.liveHandles++;
        try{await writeAll(h,new Uint8Array([8]),1);await h.truncate(2);}finally{await h.close();stats.liveHandles--;}
        if(!(await readFile(c)).equals(Buffer.from([9,8])))throw fail('positioned/truncate probe mismatch');
    }catch(error){valid=false;throw error;}
    finally{
        // Known probe entries only. No recursive sweep or deletion by a filename pattern.
        for(const [path,h]of probes){await close(h);if(await owned(path,h.identity))await unlink(path);}
    }

    const fault=async(point,a)=>{await options.fault?.(point,Object.freeze({key:a.key,target:a.target,journalPath:a.journal,stagePath:a.stage,receiptPath:a.receiptPath}));};
    function keyRecord(key){
        if(!key||key.version!==1||key.backendId!==scope.backendId||key.scopeId!==scope.scopeId||typeof key.attemptId!=='string'||!attempts.has(key.attemptId))throw fail('unknown or foreign recovery key');
        return attempts.get(key.attemptId);
    }
    async function append(a,phase){
        await fault('before-journal-'+phase,a);
        await validate();if(!await owned(a.journal,a.journalHandle.identity))throw fail('journal ownership changed');
        const row={version:1,key:a.key,sequence:a.sequence+1,phase,target:a.name,policy:a.policy,size:a.size,stageId:a.stageId,receiptId:a.receiptId};
        const data=Buffer.from(JSON.stringify(row)+'\n');await writeAll(a.journalHandle.file,data,a.journalBytes.length,options.shortWrite??data.length);
        a.journalBytes=Buffer.concat([a.journalBytes,data]);a.sequence++;a.epoch++;stats.journalWrites++;
        await fault('after-journal-'+phase,a);
    }
    async function journalValid(a){
        if(!a.journalHandle||!await owned(a.journal,a.journalHandle.identity))return false;
        return (await readFile(a.journal)).equals(a.journalBytes);
    }
    const stamp=s=>`${id(s)}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
    async function hashFile(path,identity){
        const file=await open(path,'r');stats.liveHandles++;
        try{const before=await file.stat({bigint:true});if(id(before)!==identity||!before.isFile())throw fail('file identity changed');
            const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
            for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
            if(stamp(before)!==stamp(await file.stat({bigint:true})))throw fail('file changed during inspection');return hash.digest('hex');
        }finally{await file.close();stats.liveHandles--;}
    }
    async function retainVersion(a){
        // Separate inode/data, not a hard link: external in-place writes must not alter a receipt.
        a.receiptHandle=await openOwned(a.receiptPath);a.receiptId=a.receiptHandle.identity;
        const source=await open(a.stage,'r');stats.liveHandles++;
        try{const before=await source.stat({bigint:true});if(id(before)!==a.stageId||Number(before.size)!==a.size)throw fail('sealed source changed');
            const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let position=0;
            for(;;){const {bytesRead}=await source.read(buffer,0,buffer.length,position);if(!bytesRead)break;hash.update(buffer.subarray(0,bytesRead));await writeAll(a.receiptHandle.file,buffer.subarray(0,bytesRead),position,options.shortWrite??bytesRead);position+=bytesRead;}
            if(stamp(before)!==stamp(await source.stat({bigint:true}))||position!==a.size)throw fail('sealed source changed during retention');
            a.contentHash=hash.digest('hex');
        }finally{await source.close();stats.liveHandles--;await close(a.receiptHandle);}
    }
    function receipt(a){
        return Object.freeze({attemptId:a.key.attemptId,size:a.size,path:a.receiptPath,async read(){
            await validateIdentity();if(!await owned(a.receiptPath,a.receiptId))throw fail('original receipt unavailable');
            const file=await open(a.receiptPath,'r');stats.liveHandles++;
            try{if(id(await file.stat({bigint:true}))!==a.receiptId)throw fail('receipt identity changed');const bytes=new Uint8Array(await file.readFile());if(bytes.length!==a.size||digest(bytes)!==a.contentHash)throw fail('receipt content changed');return bytes;}
            finally{await file.close();stats.liveHandles--;}
        }});
    }
    async function snapshot(a){
        await validateIdentity();const [s,r,t,j]=await Promise.all([info(a.stage),info(a.receiptPath),info(a.target),info(a.journal)]);
        const correctJournal=await journalValid(a);
        const receiptAvailable=r&&r.isFile()&&!r.isSymbolicLink()&&id(r)===a.receiptId&&a.contentHash&&await hashFile(a.receiptPath,a.receiptId).then(h=>h===a.contentHash,()=>false);
        const publication=!a.active&&a.evidence==='committed'?{status:'committed',receipt:receiptAvailable?{status:'available',value:receipt(a)}:{status:'unavailable',reason:fail('original publication is no longer retained')}}:
            !a.active&&a.evidence==='not-committed'?{status:'not-committed',reason:a.reason}:{status:'indeterminate',reason:a.hasReason?a.reason:fail('no authoritative publication outcome')};
        // A valid current object is an observation, never publication evidence.
        const targetMatches=t&&t.isFile()&&!t.isSymbolicLink()&&id(t)===a.stageId&&a.contentHash&&await hashFile(a.target,a.stageId).then(h=>h===a.contentHash,()=>false);
        const currentTarget=!t?'absent':t.isSymbolicLink()||!t.isFile()?'unknown':targetMatches?'this-attempt':'other-publication';
        const staging=!s?'absent':s.isFile()&&!s.isSymbolicLink()&&id(s)===a.stageId?'retained':'unknown';
        const journalHash=j&&j.isFile()&&!j.isSymbolicLink()?digest(await readFile(a.journal)):'missing';
        const revision=digest(JSON.stringify([a.epoch,a.active,a.evidence,s&&stamp(s),r&&stamp(r),j&&stamp(j),journalHash,correctJournal]));
        return {value:Object.freeze({key:a.key,revision,quiescent:a.active===0,publication:Object.freeze(publication),currentTarget,staging}),correctJournal,s,r};
    }
    const recovery=Object.freeze({
        async inspect(key){const a=keyRecord(key);await fault('before-inspect',a);return (await snapshot(a)).value;},
        async cleanup(key,request){
            const a=keyRecord(key);if(a.cleanupBusy)return {status:'blocked',reason:fail('cleanup already active')};a.cleanupBusy=true;
            try{
                await fault('before-cleanup',a);const observed=await snapshot(a);
                if(request?.expectedRevision!==observed.value.revision||a.active||a.evidence==='unknown'||!a.released||!observed.correctJournal)throw fail('stale, active, unresolved or invalid recovery state');
                if(observed.value.staging==='unknown')throw fail('staging ownership changed');
                // Committed receipts and the journal are retained independently of obsolete staging.
                let changed=false;
                if(observed.s)changed=await removeOwned(a.stage,a.stageId)||changed;
                if(a.evidence==='not-committed'&&observed.r)changed=await removeOwned(a.receiptPath,a.receiptId)||changed;
                if(changed)a.epoch++;
                return {status:changed?'cleaned':'already-clean'};
            }catch(reason){return {status:'blocked',reason};}finally{a.cleanupBusy=false;}
        }
    });
    function bind(name){
        if(!validLeaf(name))throw fail('target must be a canonical lowercase mp4/webm leaf');
        if(attempts.size>=maxAttempts)throw fail('attempt retention quota exceeded');
        const key=Object.freeze({version:1,backendId,scopeId:scope.scopeId,attemptId:randomUUID()}),prefix=join(run,key.attemptId);
        const a={key,name,target:join(root,name),stage:prefix+'.stage',receiptPath:prefix+'.receipt',journal:prefix+'.journal',stageId:null,receiptId:null,journalHandle:null,stageHandle:null,receiptHandle:null,journalBytes:Buffer.alloc(0),sequence:0,epoch:0,active:0,claimed:false,released:false,cleanupBusy:false,evidence:'unknown',reason:undefined,hasReason:false,size:0,sealed:false,commitInvoked:false,failed:false,policy:undefined,contentHash:null};
        attempts.set(key.attemptId,a);
        async function checkSupport(request){
            const no=(code,reason)=>({supported:false,code,reason});
            if(!valid||a.claimed)return no('stale-profile','Profile invalidated or attempt already consumed');
            try{await validate();}catch{return no('unknown-scope','Scope identity/profile is unavailable');}
            try{await fault('check-permission',a);await permissions();}catch(error){return no(error?.code==='PERMISSION_REQUIRED'?'permission-required':'permission-denied','Read/write permission unavailable; no prompt is requested');}
            if(request?.ifExists!=='error'&&request?.ifExists!=='replace')return no('unsupported-policy','Only create-new and whole replacement are supported');
            const extension=name.split('.').at(-1);
            if(request.format?.extension!==extension||request.format.mimeType!=='video/'+extension)return no('unsupported-io','Target format mismatch');
            if(!integer(request.maxWriteBytes,1)||request.maxWriteBytes>maxWriteBytes||(request.maxOutputBytes!==undefined&&!integer(request.maxOutputBytes,1)))return no('unsupported-limits','Receiver bounds unsupported');
            const target=await info(a.target);if(target&&(!target.isFile()||target.isSymbolicLink()))return no('unsupported-io','Target must be absent or a regular non-symlink file');
            return {supported:true,request:Object.freeze({...request}),guarantees:Object.freeze({scope,policy:request.ifExists,positionedWrites:'all-or-reject',staging:'isolated-unpublished',truncate:'exact-before-publication',publication:'atomic-at-target',recovery:'journal-before-publication',durability:'no-portable-crash-guarantee'})};
        }
        const destination=Object.freeze({kind:'positioned-transactional',checkSupport,async create(context){
            const supported=await checkSupport(context);if(!supported.supported)throw fail(supported.reason);if(context.signal.aborted)throw context.signal.reason;
            // Claim before the next yield; competing acquisitions cannot share this transaction.
            if(a.claimed)throw fail('attempt already acquired');a.claimed=true;a.policy=context.ifExists;a.active++;a.epoch++;
            const guard=()=>{if(context.signal.aborted)throw context.signal.reason;if(a.released||a.failed)throw fail('transaction terminated');};
            async function discard(){
                await close(a.stageHandle);await close(a.receiptHandle);await close(a.journalHandle);
                if(a.stageId)await removeOwned(a.stage,a.stageId);
                if(a.receiptId)await removeOwned(a.receiptPath,a.receiptId);
            }
            try{
                await validate();await permissions();guard();
                a.journalHandle=await openOwned(a.journal);await append(a,'registered');await fault('after-registered-journal',a);guard();
                a.stageHandle=await openOwned(a.stage);a.stageId=a.stageHandle.identity;await fault('after-stage-open',a);guard();
                await append(a,'prepared');await fault('after-prepared-journal',a);guard();
            }catch(reason){
                a.reason=reason;a.hasReason=true;a.evidence='not-committed';a.failed=true;
                try{await discard();}catch{stats.cleanupFailures++;}finally{a.released=true;a.active--;a.epoch++;}throw reason;
            }
            a.active--;a.epoch++;
            function work(body){
                if(a.active||a.released||a.failed||a.commitInvoked)throw fail('overlapping or terminated transaction operation');
                a.active++;a.epoch++;
                return Promise.resolve().then(body).catch(error=>{a.failed=true;a.reason=error;a.hasReason=true;throw error;}).finally(()=>{a.active--;a.epoch++;});
            }
            return Object.freeze({
                ready(signal){return work(async()=>{if(signal.aborted)throw signal.reason;guard();await validate();await fault('before-ready',a);guard();});},
                writeAt(position,data,signal){return work(async()=>{
                    guard();if(signal.aborted)throw signal.reason;if(a.sealed||!integer(position)||!(data instanceof Uint8Array)||!(data.buffer instanceof ArrayBuffer)||!integer(position+data.byteLength)||data.byteLength>context.maxWriteBytes||(context.maxOutputBytes!==undefined&&position+data.byteLength>context.maxOutputBytes))throw fail('invalid positioned write/bounds');
                    // Validate attachment, including detached empty views. Core owns the borrowed view.
                    new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
                    await validate();if(!await owned(a.stage,a.stageId))throw fail('staging identity changed');
                    stats.physical++;stats.borrowedBytes+=data.byteLength;stats.peakPhysical=Math.max(stats.peakPhysical,stats.physical);stats.peakBorrowedBytes=Math.max(stats.peakBorrowedBytes,stats.borrowedBytes);
                    try{await fault('before-write',a);guard();if(signal.aborted)throw signal.reason;await writeAll(a.stageHandle.file,data,position,options.shortWrite??Math.max(1,data.byteLength));a.size=Math.max(a.size,position+data.length);}
                    finally{stats.physical--;stats.borrowedBytes-=data.byteLength;}
                });},
                truncate(size,signal){return work(async()=>{guard();if(signal.aborted)throw signal.reason;if(a.sealed||!integer(size)||size!==a.size)throw fail('truncate must seal the authoritative extent once');await validate();await fault('before-truncate',a);guard();if(!await owned(a.stage,a.stageId))throw fail('staging identity changed');await a.stageHandle.file.truncate(size);a.sealed=true;await append(a,'sealed');});},
                commit(){
                    if(a.commitInvoked||a.active||a.released||a.failed)throw fail('commit already invoked or transaction unavailable');
                    a.commitInvoked=true;a.active++;a.epoch++;
                    return (async()=>{
                        let issued=false,definiteCollision=false;
                        try{
                            if(!a.sealed||!a.size)throw fail('container must be sealed and nonempty');
                            await fault('before-commit',a);await validate();await permissions();
                            if(!await owned(a.stage,a.stageId))throw fail('staging identity changed');
                            const target=await info(a.target);if(target&&(!target.isFile()||target.isSymbolicLink()))throw fail('target identity kind changed');
                            await close(a.stageHandle);await retainVersion(a);
                            await append(a,'publishing');await fault('after-publishing-journal',a);
                            await fault('before-publish',a);await validate();
                            if(!await owned(a.stage,a.stageId)||!await owned(a.receiptPath,a.receiptId)||!await journalValid(a))throw fail('publication artifacts changed');
                            const current=await info(a.target);if(current&&(!current.isFile()||current.isSymbolicLink()))throw fail('target identity kind changed');
                            const publish=()=>a.policy==='error'?link(a.stage,a.target):rename(a.stage,a.target);
                            issued=true;
                            if(options.publish)await options.publish(publish,{key:a.key,policy:a.policy});
                            else try{await publish();}catch(error){definiteCollision=a.policy==='error'&&error.code==='EEXIST';throw error;}
                            a.evidence='committed';a.epoch++;stats.publications++;
                            await fault('after-publish',a);await append(a,'committed');await fault('after-committed-journal',a);await fault('before-ack',a);
                            return {status:'committed',value:receipt(a)};
                        }catch(reason){
                            a.reason=reason;a.hasReason=true;
                            if(!issued||definiteCollision){a.evidence='not-committed';return {status:'not-committed',reason};}
                            // A known witness survives an acknowledgement/journal failure. Otherwise
                            // publishing checkpoint/target contents alone cannot resolve the outcome.
                            throw reason;
                        }finally{a.active--;a.epoch++;}
                    })();
                },
                async abort(reason){
                    if(a.active||a.evidence==='committed')throw fail('cannot abort active/published transaction');
                    if(a.commitInvoked&&a.evidence!=='not-committed')throw fail('cannot abort uncertain publication');
                    a.active++;a.epoch++;
                    try{if(!a.hasReason){a.reason=reason;a.hasReason=true;}a.evidence='not-committed';await discard();}finally{a.active--;a.epoch++;}
                },
                async release(context){
                    if(a.active)throw fail('release must wait for physical operations');if(a.released)return;
                    a.active++;a.epoch++;
                    try{await close(a.stageHandle);await close(a.receiptHandle);await close(a.journalHandle);
                        if(context.publication==='committed'&&a.evidence==='committed')await removeOwned(a.stage,a.stageId);
                    }finally{a.released=true;a.active--;a.epoch++;}
                }
            });
        }});
        return Object.freeze({key,destination,recovery});
    }
    return Object.freeze({scope,bind,recovery,get stats(){return Object.freeze({...stats});},invalidate(){valid=false;}});
}
