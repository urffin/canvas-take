import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAacAudioEncoder} from '../dist/video-aac.js';
const config={codec:'mp4a.40.2',bitstreamFormat:'aac',sampleRate:48000,numberOfChannels:1,bitrate:128000};
const context=(controller=new AbortController(),write=async()=>{})=>({signal:controller.signal,maxPendingInputs:1,maxPendingBytes:16384,output:{write,fail(){}}});
const block=(sampleOffset,size)=>({sampleOffset,sampleRate:48000,timestampUs:Math.round(sampleOffset*1e6/48000),channels:[new Float32Array(size)]});
const turn=()=>new Promise(r=>setImmediate(r));
function fixture(mode='valid'){
    const original=globalThis.Worker,workers=[];
    class Mock extends EventTarget{
        terminated=0;next=-1024;frames=0;
        constructor(){super();workers.push(this);}
        terminate(){this.terminated++;}
        postMessage({id,type,data}){
            if(mode===type+'-blocked')return;
            queueMicrotask(()=>{
                if(mode==='worker-error'){this.dispatchEvent(new Event('error'));return;}
                let result;
                if(type==='init')result={frameSize:1024,description:new Uint8Array([17,136])};
                else{
                    const packets=[];if(type==='frame')this.frames++;
                    const count=type==='flush'?2:this.frames>1?1:0;
                    for(let i=0;i<count;i++){packets.push({sampleOffset:this.next,samples:1024,data:new Uint8Array([1,2])});this.next+=1024;}
                    result={packets};
                }
                if(mode==='bad-init'&&type==='init')result.frameSize=960;
                if(mode==='bad-packet'&&result.packets?.length)result.packets[0].samples=960;
                if(mode==='no-delay'&&result.packets?.length)result.packets[0].sampleOffset=0;
                this.dispatchEvent(new MessageEvent('message',{data:{id:mode==='wrong-id'?99:id,result}}));
            });
        }
    }globalThis.Worker=Mock;
    return{workers,restore(){globalThis.Worker=original;}};
}
test('AAC support is explicit; invalid profile/options/budget and pre-abort create no worker',async()=>{
    assert.equal((await createAacAudioEncoder().checkSupport(config)).supported,false);
    const f=fixture();try{
        assert.equal((await createAacAudioEncoder().checkSupport(config)).supported,true);
        for(const patch of [{codec:'mp4a.40.5'},{bitstreamFormat:'adts'},{sampleRate:32000},{numberOfChannels:6},{bitrate:0}])assert.equal((await createAacAudioEncoder().checkSupport({...config,...patch})).supported,false);
        for(const timeoutMs of [0,null,Infinity,2147483648])assert.throws(()=>createAacAudioEncoder({timeoutMs}));
        await assert.rejects(createAacAudioEncoder().create(config,{...context(),maxPendingBytes:4000}),/maxPendingBytes/);
        const c=new AbortController();c.abort(new Error('before'));await assert.rejects(createAacAudioEncoder().create(config,context(c)),/before/);
        assert.equal(f.workers.length,0);
    }finally{f.restore();}
});
test('AAC accumulates codec frames, rounds absolute sample positions and reports exact delay/padding',async()=>{
    const f=fixture(),events=[];try{
        const encoder=await createAacAudioEncoder().create(config,context(undefined,async e=>events.push(e)));
        await encoder.encodeAudio(block(0,1000));await encoder.encodeAudio(block(1000,25));await encoder.flush();encoder.dispose();encoder.dispose();
        assert.deepEqual(events.map(e=>e.type),['config','packet','packet','packet','end']);
        assert.deepEqual(events.at(-1),{type:'end',track:'audio',presentationSamples:1025,leadingDiscardSamples:1024,trailingDiscardSamples:1023});
        const packets=events.filter(e=>e.type==='packet').map(e=>e.packet);
        assert.deepEqual(packets.map(p=>p.timestampUs),[-21333,0,21333]);assert.equal(packets.at(-1).timestampUs+packets.at(-1).durationUs,42667);
        assert.equal(f.workers[0].terminated,1);
    }finally{f.restore();}
});
test('AAC startup/worker/malformed/timeout failures terminate once',async()=>{
    for(const mode of ['worker-error','bad-init','wrong-id','init-blocked','bad-packet','no-delay']){
        const f=fixture(mode);let encoder;try{
            await assert.rejects((async()=>{encoder=await createAacAudioEncoder({timeoutMs:20}).create(config,context());await encoder.encodeAudio(block(0,2048));})(),undefined,mode);
        }finally{encoder?.dispose();assert.equal(f.workers[0].terminated,1,mode);f.restore();}
    }
});
test('AAC cancellation interrupts startup, encode, flush and blocked output; late work stays closed',async()=>{
    for(const mode of ['init-blocked','frame-blocked','flush-blocked','output-blocked']){
        const f=fixture(mode),controller=new AbortController();let encoder,release;
        const gate=new Promise(r=>{release=r;});
        try{
            const creating=createAacAudioEncoder().create(config,context(controller,e=>mode==='output-blocked'&&e.type==='packet'?gate:Promise.resolve()));
            let operation=creating;
            if(mode!=='init-blocked'){
                encoder=await creating;
                if(mode==='flush-blocked'){await encoder.encodeAudio(block(0,1024));operation=encoder.flush();}
                else operation=encoder.encodeAudio(block(0,2048));
            }
            await turn();controller.abort(new Error('cancel '+mode));await assert.rejects(operation,/cancel/);
            release();await turn();assert.equal(f.workers[0].terminated,1);
        }finally{encoder?.dispose();f.restore();}
    }
});
