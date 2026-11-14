import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWebCodecsAudioEncoder} from '../dist/video-opus.js';
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};

const config={codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:1,bitrate:128000};
const time=n=>Math.round(n*1e6/48000);
const context=(extra={})=>({signal:new AbortController().signal,maxPendingInputs:2,maxPendingBytes:16384,output:{async write(){},fail(){}},...extra});
const block=(n,offset=0)=>({sampleRate:48000,sampleOffset:offset,channels:[Float32Array.from({length:n},(_,i)=>Math.sin(i))]});
function fixture(mode='zero'){
    const previous=[globalThis.AudioEncoder,globalThis.AudioData],encoders=[],inputs=[];
    class Data{constructor(init){this.init=init;this.closed=0;inputs.push(this);}close(){this.closed++;}}
    class Encoder extends EventTarget{
        state='unconfigured';encodeQueueSize=0;closed=0;flushes=0;count=0;accepted=0;pending=0;delivery=undefined;
        static async isConfigSupported(config){return{supported:true,config};}
        constructor(init){super();this.init=init;encoders.push(this);}
        configure(c){this.config=c;this.state='configured';if(mode==='configure')throw new Error('configure failure');}
        packet(){
            const i=this.count++,head=new Uint8Array([79,112,117,115,72,101,97,100,1,1,56,1,128,187,0,0,0,0,0]);
            if(mode==='long-priming'){head[10]=128;head[11]=22;}
            if(mode==='head')head[0]=0;
            const data=new Uint8Array([mode==='toc'?0:152,23]);
            this.init.output({timestamp:mode==='clock'&&i?999:mode==='shifted'&&i?time(i*960-312):i*20000,duration:20000,type:'key',byteLength:mode==='oversize'?20000:data.length,copyTo(out){out.set(data);}},i?{}:{decoderConfig:{...config,description:head}});
        }
        encode(input){
            this.accepted+=input.init.numberOfFrames;
            if(mode==='stall'){this.encodeQueueSize++;return;}
            if(mode==='flush-burst')return;
            if(mode==='burst'){
                this.encodeQueueSize++;this.pending++;
                queueMicrotask(()=>{this.encodeQueueSize--;this.dispatchEvent(new Event('dequeue'));});
                this.delivery??=new Promise(resolve=>setImmediate(()=>{const count=this.pending;this.pending=0;this.delivery=undefined;for(let i=0;i<count;i++)this.packet();resolve();}));
                return;
            }
            this.packet();
        }
        async flush(){this.flushes++;if(mode==='flush-stall')return new Promise(()=>{});await this.delivery;while(this.count<Math.ceil((this.accepted+(mode==='long-priming'?5760:312))/960))this.packet();}
        close(){this.closed++;this.state='closed';}
    }
    globalThis.AudioEncoder=Encoder;globalThis.AudioData=Data;
    return{encoders,inputs,restore(){[globalThis.AudioEncoder,globalThis.AudioData]=previous;}};
}
test('native Opus support is explicit and imports without browser globals',async()=>{
    assert.equal((await createWebCodecsAudioEncoder().checkSupport(config)).supported,false);
    const f=fixture();try{
        assert.equal((await createWebCodecsAudioEncoder().checkSupport(config)).supported,true);
        for(const invalid of[{codec:'aac'},{sampleRate:44100},{numberOfChannels:3},{bitrate:0}])assert.equal((await createWebCodecsAudioEncoder().checkSupport({...config,...invalid})).supported,false);
        assert.throws(()=>createWebCodecsAudioEncoder().create(config,context({maxPendingBytes:3839})),/input frame/);
        const abort=new AbortController();abort.abort(new Error('before create'));
        assert.throws(()=>createWebCodecsAudioEncoder().create(config,context({signal:abort.signal})),/before create/);assert.equal(f.encoders.length,0);
    }finally{f.restore();}
});
test('Opus reconciles both native clocks, closes input once and flushes only at track end',async()=>{
    for(const mode of['zero','shifted']){
        const f=fixture(mode),events=[];try{
            const e=createWebCodecsAudioEncoder().create(config,context({output:{async write(e){events.push(e);},fail(){}}}));
            await e.encodeAudio(block(1000));await e.encodeAudio(block(1001,1000));assert.equal(f.encoders[0].flushes,0);
            await e.flush();e.dispose();e.dispose();
            const packets=events.filter(e=>e.type==='packet').map(e=>e.packet);
            assert.deepEqual(packets.map(p=>p.timestampUs),[-6500,13500,33500]);
            assert.deepEqual(events.at(-1),{type:'end',track:'audio',presentationSamples:2001,leadingDiscardSamples:312,trailingDiscardSamples:567});
            assert.equal(f.encoders[0].closed,1);assert.equal(f.encoders[0].flushes,1);assert.ok(f.inputs.every(i=>i.closed===1));
            assert.deepEqual(f.inputs.map(i=>i.init.numberOfFrames),[960,960,81]);
        }finally{f.restore();}
    }
});
test('Opus rejects native metadata, packet and clock errors, output overflow and configuration failure',async()=>{
    for(const mode of['head','toc','clock','oversize','configure']){
        const f=fixture(mode),errors=[];let e;try{
            if(mode==='configure')assert.throws(()=>createWebCodecsAudioEncoder().create(config,context()),/configure failure/);
            else{e=createWebCodecsAudioEncoder().create(config,context({output:{async write(){},fail(error){errors.push(error);}}}));await assert.rejects(e.encodeAudio(block(1920)));assert.equal(errors.length,1);}
        }finally{e?.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));f.restore();}
    }
    const f=fixture();let e;try{
        e=createWebCodecsAudioEncoder().create(config,context({output:{write(){throw new Error('sink failure');},fail(){}}}));await assert.rejects(e.encodeAudio(block(960)),/sink failure/);
    }finally{e?.dispose();f.restore();}
});
test('Opus cancellation interrupts blocked output, native queue and flush, suppressing late callbacks',async()=>{
    for(const mode of['zero','stall','flush-stall']){
        const f=fixture(mode),abort=new AbortController(),events=[],errors=[];let e;
        try{
            e=createWebCodecsAudioEncoder().create(config,context({signal:abort.signal,output:{write(event){events.push(event);return mode==='zero'?new Promise(()=>{}):Promise.resolve();},fail(e){errors.push(e);}}}));
            const work=mode==='flush-stall'?e.encodeAudio(block(960)).then(()=>e.flush()):e.encodeAudio(block(2880));
            await new Promise(r=>setImmediate(r));abort.abort(new Error('stop Opus'));await assert.rejects(work,/stop Opus/);
            const count=events.length;f.encoders[0].init.output({},{});f.encoders[0].init.error(new Error('late'));assert.equal(events.length,count);assert.equal(errors.length,0);
            e.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));
        }finally{e?.dispose();f.restore();}
    }
});

test('Opus limits unacknowledged native inputs when dequeue precedes an output burst',async()=>{
    for(const maxPendingInputs of [1,2,4]){
        const f=fixture('burst'),gate=deferred(),events=[],errors=[];let encoder,work;
        try{
            encoder=createWebCodecsAudioEncoder().create(config,context({maxPendingInputs,output:{async write(event){events.push(event);await gate.promise;},fail(error){errors.push(error);}}}));
            work=encoder.encodeAudio(block(960*50));void work.catch(()=>{});
            await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
            assert.equal(f.encoders[0].encodeQueueSize,0,'native dequeue alone must not grant another input');
            assert.ok(f.inputs.length<=maxPendingInputs,'input credit is held until packet write acknowledgement');
            assert.equal(errors.length,0);assert.equal(f.encoders[0].flushes,0);
            gate.resolve();await work;await encoder.flush();
            assert.equal(events.filter(e=>e.type==='packet').length,51);assert.equal(events.at(-1).presentationSamples,48000);
            assert.equal(f.encoders[0].flushes,1);assert.equal(errors.length,0);
        }finally{gate.resolve();encoder?.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));f.restore();}
    }
});

test('Opus final flush reserves its tail packet and waits for downstream writes before end',async()=>{
    for(const maxPendingInputs of [1,2,4]){
        const f=fixture('flush-burst'),gate=deferred(),entered=deferred(),events=[];let encoder;
        try{
            encoder=createWebCodecsAudioEncoder().create(config,context({maxPendingInputs,output:{async write(event){events.push(event);if(event.type==='packet'){entered.resolve();await gate.promise;}},fail(){}}}));
            await encoder.encodeAudio(block(maxPendingInputs*960));let finished=false;
            const work=encoder.flush();void work.then(()=>{finished=true;},()=>{});await entered.promise;
            assert.equal(finished,false);assert.equal(events.some(e=>e.type==='end'),false);
            gate.resolve();await work;assert.equal(f.encoders[0].flushes,1);
            assert.equal(events.filter(e=>e.type==='packet').length,maxPendingInputs+1);
            assert.equal(events.at(-1).presentationSamples,maxPendingInputs*960);assert.equal(events.at(-1).trailingDiscardSamples,648);
        }finally{gate.resolve();encoder?.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));f.restore();}
    }
});

test('Opus cancellation wakes input-credit waits with an empty native queue, preserving null reason',async()=>{
    for(const reason of [new Error('cancel credit wait'),null]){
        const f=fixture('flush-burst'),abort=new AbortController(),events=[],errors=[];let encoder;
        try{
            encoder=createWebCodecsAudioEncoder().create(config,context({signal:abort.signal,maxPendingInputs:1,output:{async write(event){events.push(event);},fail(error){errors.push(error);}}}));
            const work=encoder.encodeAudio(block(2880));void work.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));
            assert.equal(f.encoders[0].encodeQueueSize,0);assert.equal(f.inputs.length,1);
            abort.abort(reason);await assert.rejects(work,error=>error===reason);
            f.encoders[0].init.output({},{});assert.equal(events.length,0);assert.equal(errors.length,0);
        }finally{encoder?.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));f.restore();}
    }
});

test('Opus sink failure wakes blocked input credits with the original cause and closes resources',async()=>{
    const f=fixture('burst'),gate=deferred(),entered=deferred(),reason=new Error('positioned sink failed'),events=[],errors=[];let encoder;
    try{
        encoder=createWebCodecsAudioEncoder().create(config,context({maxPendingInputs:2,output:{async write(event){events.push(event);if(event.type==='packet'){entered.resolve();await gate.promise;throw reason;}},fail(error){errors.push(error);encoder.dispose();}}}));
        const work=encoder.encodeAudio(block(960*20));void work.catch(()=>{});await entered.promise;assert.ok(f.inputs.length<=2);
        gate.resolve();await assert.rejects(work,error=>error===reason);await new Promise(resolve=>setImmediate(resolve));
        assert.deepEqual(errors,[reason]);assert.equal(events.some(e=>e.type==='end'),false);
        f.encoders[0].init.error(new Error('late error'));assert.equal(errors.length,1);
    }finally{gate.resolve();encoder?.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));f.restore();}
});

test('Opus cancellation interrupts flush waiting for packet acknowledgement without a late end event',async()=>{
    const f=fixture('flush-burst'),gate=deferred(),entered=deferred(),abort=new AbortController(),reason=new Error('cancel flush output'),events=[],errors=[];let encoder;
    try{
        encoder=createWebCodecsAudioEncoder().create(config,context({maxPendingInputs:2,signal:abort.signal,output:{async write(event){events.push(event);if(event.type==='packet'){entered.resolve();await gate.promise;}},fail(error){errors.push(error);}}}));
        await encoder.encodeAudio(block(1920));const work=encoder.flush();void work.catch(()=>{});await entered.promise;
        abort.abort(reason);await assert.rejects(work,error=>error===reason);assert.equal(f.encoders[0].closed,1);
        gate.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(events.some(e=>e.type==='end'),false);assert.deepEqual(errors,[]);
    }finally{gate.resolve();encoder?.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));f.restore();}
});

test('Opus bounds maximum supported priming separately from input credits at final flush',async()=>{
    const f=fixture('long-priming'),events=[];let encoder;
    try{
        encoder=createWebCodecsAudioEncoder().create(config,context({maxPendingInputs:1,output:{async write(event){events.push(event);await new Promise(resolve=>setImmediate(resolve));},fail(error){throw error;}}}));
        await encoder.encodeAudio(block(1));await encoder.flush();
        assert.equal(f.inputs.length,1);assert.equal(f.encoders[0].flushes,1);assert.equal(events.filter(e=>e.type==='packet').length,7);
        assert.deepEqual(events.at(-1),{type:'end',track:'audio',presentationSamples:1,leadingDiscardSamples:5760,trailingDiscardSamples:959});
    }finally{encoder?.dispose();assert.equal(f.encoders[0].closed,1);assert.ok(f.inputs.every(i=>i.closed===1));f.restore();}
});
