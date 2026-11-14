import assert from 'node:assert/strict';
import { verify, inspect, comparePixels } from './webp-libwebp/oracle.mjs';
export function verifyPublicWebp(result, engine) {
    assert.equal(result.type,'image/webp'); assert.equal(result.same,true);
    const job={width:result.width,height:result.height,lossless:true,frames:result.frames.map(f=>({...f,data:Uint8Array.from(f.data)}))};
    const checked=verify(Uint8Array.from(result.bytes),{name:'public-'+engine,plays:result.plays},job), envelope=inspect(Uint8Array.from(result.bytes));
    assert.equal(result.decoded.count,envelope.frames.length); assert.equal(result.decoded.repetitions,result.plays===0?'Infinity':String(result.plays-1));
    let time=0,viewerTime=0;
    result.decoded.frames.forEach((f,index)=>{
        const hold=envelope.frames[index].durationMs,viewerHold=engine==='firefox'&&hold<=10?100:hold;
        assert.equal(f.timestamp,viewerTime*1000); assert.equal(f.duration,viewerHold*1000); assert.equal(f.width,job.width); assert.equal(f.height,job.height);
        let inputTime=0;
        for(const input of job.frames) {
            if(inputTime<time+hold&&inputTime+input.duration>time) {
                assert.equal(comparePixels(f.rgba,input.data,true).alphaErrors,0,'native alpha');
                for(let p=0;p<input.data.length;p+=4) if(input.data[p+3]===255) for(let c=0;c<3;c++) assert.equal(f.rgba[p+c],input.data[p+c],'opaque native RGB');
            }
            inputTime+=input.duration;
        }
        time+=hold; viewerTime+=viewerHold;
    });
    assert.deepEqual(result.events.map(p=>p.phase),[...result.frames.map(()=> 'collecting'),'finalizing','finished']);
    assert.equal(result.events.at(-1).framesAccepted,result.frames.length); assert.equal(result.events.at(-1).durationMs,result.delays.reduce((n,d)=>n+d,0));
    return {encodedFrames:checked.frames.length,intervalComparisons:checked.intervalComparisons,bytes:result.bytes.length,durationMs:time,plays:result.plays};
}
export async function waitForWorkerClosure(page,events) {
    const deadline=performance.now()+25000;
    while((page.workers().length||events.opened!==events.closed)&&performance.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(page.workers().length,0); assert.equal(events.opened,events.closed);
}
