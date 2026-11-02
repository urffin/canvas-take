import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWebCodecsAudioEncoder} from '../dist/video-opus.js';

const config={codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:1,bitrate:128000};
const time=n=>Math.round(n*1e6/48000);
const context=(extra={})=>({signal:new AbortController().signal,maxPendingInputs:2,maxPendingBytes:16384,output:{async write(){},fail(){}},...extra});
const block=(n,offset=0)=>({sampleRate:48000,sampleOffset:offset,channels:[Float32Array.from({length:n},(_,i)=>Math.sin(i))]});
function fixture(mode='zero'){
    const previous=[globalThis.AudioEncoder,globalThis.AudioData],encoders=[],inputs=[];
    class Data{constructor(init){this.init=init;this.closed=0;inputs.push(this);}close(){this.closed++;}}
    class Encoder extends EventTarget{
        state='unconfigured';encodeQueueSize=0;closed=0;flushes=0;count=0;accepted=0;
        static async isConfigSupported(config){return{supported:true,config};}
        constructor(init){super();this.init=init;encoders.push(this);}
        configure(c){this.config=c;this.state='configured';if(mode==='configure')throw new Error('configure failure');}
        packet(){
            const i=this.count++,head=new Uint8Array([79,112,117,115,72,101,97,100,1,1,56,1,128,187,0,0,0,0,0]);
            if(mode==='head')head[0]=0;
            const data=new Uint8Array([mode==='toc'?0:152,23]);
            this.init.output({timestamp:mode==='clock'&&i?999:mode==='shifted'&&i?time(i*960-312):i*20000,duration:20000,type:'key',byteLength:mode==='oversize'?20000:data.length,copyTo(out){out.set(data);}},i?{}:{decoderConfig:{...config,description:head}});
        }
        encode(input){this.accepted+=input.init.numberOfFrames;if(mode==='stall'){this.encodeQueueSize++;return;}this.packet();}
        async flush(){this.flushes++;if(mode==='flush-stall')return new Promise(()=>{});while(this.count<Math.ceil((this.accepted+312)/960))this.packet();}
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
