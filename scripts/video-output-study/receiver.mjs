// Research-only positioned destination. Not exported or included in the npm runtime.
export function createPositionedReceiver(destination,{signal,maxOutputBytes=512*1024*1024,maxWriteBytes=16*1024*1024}={}) {
    for(const [name,value]of Object.entries({maxOutputBytes,maxWriteBytes}))if(!Number.isSafeInteger(value)||value<1)throw new RangeError(name);
    let state='ready',failure,failed=false,busy=false,size=0,physical,cleanup,finishPromise,operation;
    const workAbort=new AbortController();
    let rejectCancelled;const cancelled=new Promise((_,no)=>{rejectCancelled=no;});void cancelled.catch(()=>{});
    const stats={writes:0,trafficBytes:0,rewrites:0,ownedBytes:0,peakOwnedBytes:0,aborts:0,commits:0,cleanupError:undefined};
    const terminal=()=>['failed','aborted','committed'].includes(state);
    const reason=()=>signal?signal.reason:new DOMException('Receiver aborted','AbortError');
    const guard=()=>{if(failed)throw failure;if(state==='committed')throw new Error('Receiver already committed');};
    const race=p=>Promise.race([Promise.resolve(p),cancelled]);
    const detach=()=>signal?.removeEventListener('abort',onAbort);
    function stop(next,error) {
        if(terminal())return cleanup??Promise.resolve();
        state=next;failed=true;failure=error;detach();workAbort.abort(error);rejectCancelled(error);stats.aborts++;
        const active=physical;
        cleanup=(async()=>{if(active)await active.catch(()=>{});await destination.abort(error);})().catch(error=>{stats.cleanupError=error;});
        return cleanup;
    }
    function onAbort(){void stop('aborted',reason());}
    function physicalOperation(fn) {
        const p=Promise.resolve().then(()=>{guard();return fn();});physical=p;
        void p.finally(()=>{if(physical===p)physical=undefined;}).catch(()=>{});return p;
    }
    const api={
        get state(){return state;},get size(){return size;},get stats(){return {...stats};},
        check(){guard();},
        writeAt(position,input) {
            try {
                guard();if(busy)throw new Error('Receiver overlap');
                if(!Number.isSafeInteger(position)||position<0||!(input instanceof Uint8Array)||!(input.buffer instanceof ArrayBuffer))throw new TypeError('Invalid positioned write');
                const end=position+input.byteLength;
                if(!Number.isSafeInteger(end)||end>maxOutputBytes||input.byteLength>maxWriteBytes)throw new RangeError('Receiver output/write limit');
                if(!input.byteLength)return Promise.resolve();
                busy=true;state='writing';
                // Snapshot before yielding; cancellation can reject before non-cancellable I/O ends.
                let data=input.slice();stats.ownedBytes=data.byteLength;stats.peakOwnedBytes=Math.max(stats.peakOwnedBytes,stats.ownedBytes);
                const release=()=>{data=undefined;stats.ownedBytes=0;};let handedOff=false;
                const result=(async()=>{
                    try {
                        await race(destination.ready?.(workAbort.signal));guard();
                        const owned=data;const io=physicalOperation(()=>destination.writeAt(position,owned,workAbort.signal));handedOff=true;
                        void io.finally(release).catch(()=>{});
                        await race(io);guard();stats.writes++;stats.trafficBytes+=owned.byteLength;if(position<size)stats.rewrites++;
                        size=Math.max(size,end);state='ready';
                    }catch(error){void stop('failed',error);throw failed?failure:error;}
                    finally{if(!handedOff)release();busy=false;}
                })();operation=result;void result.finally(()=>{if(operation===result)operation=undefined;}).catch(()=>{});return result;
            }catch(error){return Promise.reject(error);}
        },
        finish(type) {
            if(finishPromise)return finishPromise;
            try{guard();if(busy)throw new Error('Receiver overlap');if(!size)throw new Error('Receiver empty');}catch(error){return Promise.reject(error);}
            state='closing';busy=true;
            finishPromise=(async()=>{
                try{
                    await race(physicalOperation(()=>destination.truncate(size)));guard();
                    const handle=await race(physicalOperation(()=>destination.commit()));guard();
                    state='committed';stats.commits++;detach();return Object.freeze({kind:'external-output',type,size,handle});
                }catch(error){void stop('failed',error);throw failed?failure:error;}
                finally{busy=false;}
            })();operation=finishPromise;void finishPromise.finally(()=>{if(operation===finishPromise)operation=undefined;}).catch(()=>{});return finishPromise;
        },
        abort(error=new DOMException('Receiver aborted','AbortError')){return stop('aborted',error);},
        async settled(){if(operation)await operation.catch(()=>{});if(physical)await physical.catch(()=>{});if(cleanup)await cleanup;}
    };
    signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();return api;
}

// Replacement for the in-memory store ONLY in the guarded experimental build.
export function createPrototypeStore(context) {
    const receiver=context.__prototypeReceiver;if(!receiver)throw new Error('Prototype receiver missing');
    return {
        get size(){return receiver.size;},check(){receiver.check();},
        write(position,data){return receiver.writeAt(position,data);},
        finalize(type){return receiver.finish(type);},
        clear(){if(receiver.state!=='committed')void receiver.abort(context.signal.aborted?context.signal.reason:new DOMException('Prototype disposed','AbortError'));}
    };
}
