import assert from 'node:assert/strict';
import {openBrowserResultStore} from '../../dist/internal/video-browser-results.js';
export const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
export const turn=()=>new Promise(resolve=>setImmediate(resolve));
export function backend(){
 const scope={schema:2,backendId:'canvastake-opfs-managed-v2',scopeId:'scope1',directoryId:'dir1'};
 let state={scope:{...scope,sequence:0,revision:0},attempts:new Map(),versions:new Map(),names:new Map(),holds:new Map()},serial=Promise.resolve(),serialId=0;
 const files=new Map(),held=new Set(),urls=new Map(),hooks=new Map(),syncFaults=new Map(),earlyUnknown=new Map(),connections=[];
 const stats={connections:0,locks:0,writers:0,physical:0,borrowedBytes:0,urls:0,reads:0,transactions:0,writes:0,removes:0,lockRequests:0,requests:[],trace:[]};
 const step=async(point,info={})=>{stats.trace.push(point);await hooks.get(point)?.(info);};
 const sync=point=>{if(syncFaults.has(point)){const e=syncFaults.get(point);syncFaults.delete(point);throw e;}};
 const enqueue=body=>{const work=serial.then(body);serial=work.then(()=>{},()=>{});return work;};
 const objects={scopeId:scope.scopeId,directoryId:scope.directoryId,positioned:true,
  async create(objectId,ownerToken){await step('object.create.before');if(files.has(objectId))throw new Error('Object already exists');const item={ownerToken,bytes:new Uint8Array()};files.set(objectId,item);stats.writers++;let ended=false;
   const work=async(point,fn,data)=>{if(ended)throw Error('Writer closed');stats.physical++;if(data)stats.borrowedBytes+=data.length;try{await step(point,{objectId,item,data});return fn();}finally{stats.physical--;if(data)stats.borrowedBytes-=data.length;}};
   const writer={ready:()=>work('writer.ready',()=>{}),writeAt:(position,data)=>work('writer.write',()=>{const out=new Uint8Array(Math.max(item.bytes.length,position+data.length));out.set(item.bytes);out.set(data,position);item.bytes=out;stats.writes++;},data),truncate:size=>work('writer.truncate',()=>{const bytes=new Uint8Array(size);bytes.set(item.bytes.subarray(0,size));item.bytes=bytes;}),
    close:async()=>{if(ended)return;await work('writer.close',()=>{});ended=true;stats.writers--;},abort:async()=>{if(ended)return;await work('writer.abort',()=>{});ended=true;stats.writers--;}};
   try{await step('object.create.after',{writer});return writer;}catch(e){await writer.abort();if(files.get(objectId)===item)files.delete(objectId);throw e;}
  },
  async stat(objectId,token){await step('object.stat',{objectId});const item=files.get(objectId);return !item?{status:'absent'}:item.ownerToken!==token?{status:'foreign'}:{status:'present',size:item.bytes.length};},
  async read(objectId,token){await step('object.read',{objectId});stats.reads++;const item=files.get(objectId);if(!item)throw new DOMException('Missing original','NotFoundError');if(item.ownerToken!==token)throw Error('Foreign object');return new File([item.bytes],'private.bin');},
  async remove(objectId,token,allowMissing){await step('object.remove.before',{objectId});const item=files.get(objectId);if(!item){if(!allowMissing)throw Error('Missing object without deletion claim');}else{if(item.ownerToken!==token)throw Error('Foreign object');files.delete(objectId);stats.removes++;}await step('object.remove.after',{objectId});}
 };
 const locks={sharedExclusive:true,async tryAcquire(name,mode){stats.lockRequests++;await step('lock.acquire',{name,mode});if([...held].some(l=>l.name===name&&(l.mode==='exclusive'||mode==='exclusive')))return undefined;const record={name,mode,released:false};held.add(record);stats.locks++;
  return {async release(){if(record.released)return;await step('lock.release',{name,mode});if(!record.released){record.released=true;held.delete(record);stats.locks--;}}};
 }};
 const ui={enabled:true,activation:true,available(){return this.enabled;},hasActivation(){return this.activation;},createURL(file){sync('ui.create');const url='blob:controlled-'+(++serialId);urls.set(url,file);stats.urls++;return url;},revokeURL(url){sync('ui.revoke');if(urls.delete(url))stats.urls--;},request(url,fileName){sync('ui.request');assert.ok(urls.has(url));stats.requests.push({url,fileName});}};
 function connection(){let closed=false;stats.connections++;const port={atomic:true,
  async read(body){await step('metadata.read.before');return enqueue(async()=>{if(closed)throw Error('Connection closed');stats.reads++;await step('metadata.read');return body(structuredClone(state));});},
  async transact(label,body){await step('tx.enqueue:'+label);const work=enqueue(async()=>{
   if(closed)throw Error('Connection closed');stats.transactions++;await step('tx.enter:'+label);const draft=structuredClone(state);let value;
   try{value=body(draft);if(value&&typeof value.then==='function')throw Error('Async metadata callback forbidden');await step('tx.commit:'+label,{draft});}catch(reason){return {status:'aborted',reason};}
   state=draft;try{await step('tx.ack:'+label);}catch(reason){return {status:'indeterminate',reason};}return {status:'committed',value};
  });if(earlyUnknown.has(label)){const reason=earlyUnknown.get(label);earlyUnknown.delete(label);void work.catch(()=>{});return {status:'indeterminate',reason};}return work;},async close(){await step('metadata.close');if(!closed){closed=true;stats.connections--;}}
 };port.invalidate=()=>{if(!closed){closed=true;stats.connections--;}};connections.push(port);return port;}
 async function open(extra={}){const metadata=connection();try{return await openBrowserResultStore({publication:'opfs-catalog',trust:'cooperating-origin-namespace',scope,metadata,objects,locks,download:ui,newId:()=> 'id'+(++serialId),...extra});}catch(e){await metadata.close();throw e;}}
 function gate(point){const entered=deferred(),finish=deferred();hooks.set(point,async info=>{entered.resolve(info);await finish.promise;});return {entered:entered.promise,release(){hooks.delete(point);finish.resolve();}};}
 function fail(point,reason=Error(point)){hooks.set(point,()=>{hooks.delete(point);throw reason;});return reason;}
 return {scope,stats,files,held,urls,hooks,objects,locks,ui,connection,connections,open,gate,fail,syncFaults,earlyUnknown,get state(){return state;},set state(value){state=value;},
  dropLocks(predicate=()=>true){for(const record of held)if(predicate(record)){record.released=true;held.delete(record);stats.locks--; }},
  idle(){for(const k of ['connections','locks','writers','physical','borrowedBytes','urls'])assert.equal(stats[k],0,k);}
 };
}
export const request=(name='movie.mp4',ifExists='error',abort=new AbortController())=>({format:{mimeType:'video/'+name.split('.').at(-1),extension:name.split('.').at(-1)},ifExists,maxWriteBytes:4096,signal:abort.signal});
export async function stage(store,{name='movie.mp4',ifExists='error',bytes=new Uint8Array([1,2,3]),abort=new AbortController()}={}){
 const binding=store.bind(name),context=request(name,ifExists,abort),transaction=await binding.destination.create(context);await transaction.ready(context.signal);await transaction.writeAt(0,bytes,context.signal);await transaction.truncate(bytes.length,context.signal);return {binding,context,transaction};
}
export async function publish(store,options={}){
 const staged=await stage(store,options);let outcome;
 try{outcome=await staged.transaction.commit();if(outcome.status==='not-committed')await staged.transaction.abort(outcome.reason);return {...staged,outcome,value:outcome.value};}
 finally{await staged.transaction.release({publication:outcome?.status??'indeterminate'});}
}
export async function superseded(store){const first=await publish(store);await publish(store,{ifExists:'replace',bytes:new Uint8Array([8,9])});return first;}
export async function deletion(store,item){await store.releaseHold(item.binding.ownerHold);const snapshot=await store.inspectVersion(item.binding.key);return store.deleteVersion(item.binding.key,{expectedRevision:snapshot.revision});}
