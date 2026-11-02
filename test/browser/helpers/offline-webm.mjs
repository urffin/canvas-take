import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ffmpeg from 'ffmpeg-static';
const execute=promisify(execFile);
function vint(bytes,p,id=false){
    let n=1,mask=128;while(n<=8&&!(bytes[p]&mask)){n++;mask>>=1;}assert.ok(n<=8&&p+n<=bytes.length);
    let value=BigInt(id?bytes[p]:bytes[p]&(mask-1));for(let i=1;i<n;i++)value=value*256n+BigInt(bytes[p+i]);
    if(!id&&value===(1n<<BigInt(n*7))-1n)return{value:-1,n};
    assert.ok(value<=BigInt(Number.MAX_SAFE_INTEGER));return{value:Number(value),n};
}
const uint=(b,p,end)=>{let n=0;for(;p<end;p++)n=n*256+b[p];return n;};
const signed=(b,p,end)=>{const n=uint(b,p,end);return b[p]&128?n-2**((end-p)*8):n;};
/** Independent EBML metadata/block parser; no Mediabunny reader or exporter values. */
export function readWebm(bytes){
    const out={tracks:[],blocks:[],scale:undefined,duration:undefined,docType:undefined};
    function block(d,end,cluster,group,simple){
        const track=vint(bytes,d),p=d+track.n;assert.ok(p+3<=end);assert.equal((bytes[p+2]>>1)&3,0,'No lacing expected');
        const item={track:track.value,time:cluster.time+bytes.readInt16BE(p),key:simple?!!(bytes[p+2]&128):undefined,data:bytes.subarray(p+3,end)};
        if(group)group.block=item;else out.blocks.push(item);
    }
    function walk(start,end,track,cluster,group){
        for(let p=start;p<end;){
            const id=vint(bytes,p,true),size=vint(bytes,p+id.n),d=p+id.n+size.n,stop=size.value<0?end:d+size.value;assert.ok(stop<=end&&stop>=d);
            if([0x1a45dfa3,0x18538067,0x1549a966,0x1654ae6b,0xe0,0xe1].includes(id.value))walk(d,stop,track,cluster,group);
            else if(id.value===0xae){const t={};out.tracks.push(t);walk(d,stop,t);}
            else if(id.value===0x1f43b675)walk(d,stop,undefined,{time:0});
            else if(id.value===0xa0){const g={};walk(d,stop,undefined,cluster,g);assert.ok(g.block);out.blocks.push({...g.block,duration:g.duration,discard:g.discard??0,discardOffset:g.discardOffset});}
            else if(id.value===0xa1||id.value===0xa3)block(d,stop,cluster,group,id.value===0xa3);
            else if(id.value===0xe7)cluster.time=uint(bytes,d,stop);
            else if(id.value===0x2ad7b1)out.scale=uint(bytes,d,stop);
            else if(id.value===0x4489)out.duration=stop-d===8?bytes.readDoubleBE(d):bytes.readFloatBE(d);
            else if(id.value===0x4282)out.docType=bytes.toString('utf8',d,stop);
            else if(id.value===0x9b)group.duration=uint(bytes,d,stop);
            else if(id.value===0x75a2){group.discard=signed(bytes,d,stop);group.discardOffset=[d,stop];}
            else if(track){
                if(id.value===0xd7)track.number=uint(bytes,d,stop);
                else if(id.value===0x86)track.codec=bytes.toString('utf8',d,stop);
                else if(id.value===0x63a2){track.head=bytes.subarray(d,stop);track.headOffset=d;}
                else if(id.value===0x56aa){track.delay=uint(bytes,d,stop);track.delayOffset=[d,stop];}
                else if(id.value===0x56bb)track.preRoll=uint(bytes,d,stop);
                else if(id.value===0xb0)track.width=uint(bytes,d,stop);
                else if(id.value===0xba)track.height=uint(bytes,d,stop);
                else if(id.value===0x9f)track.channels=uint(bytes,d,stop);
            }p=stop;
        }
    }walk(0,bytes.length);assert.equal(out.docType,'webm');return out;
}
export function removeOpusDiscards(bytes,layout){
    const altered=Buffer.from(bytes),audio=layout.tracks.find(t=>t.codec==='A_OPUS');
    altered[audio.headOffset+10]=altered[audio.headOffset+11]=0;
    if(audio.delayOffset)altered.fill(0,...audio.delayOffset);
    for(const b of layout.blocks)if(b.discardOffset)altered.fill(0,...b.discardOffset);
    return altered;
}
const run=(path,args)=>execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-err_detect','explode','-copyts','-i',path,...args],{encoding:'buffer',maxBuffer:32*1024*1024,timeout:30000});
function opusSamples(data){
    assert.ok(data.length);const config=data[0]>>>3,code=data[0]&3;
    const count=code===0?1:code===3?(data[1]&63):2;
    const frame=config<12?[480,960,1920,2880][config&3]:config<16?[480,960][config&1]:[120,240,480,960][config&3];
    assert.ok(count&&count*frame<=5760);return count*frame;
}
export async function decodeOpus(path,channels){
    const audio=await run(path,['-map','0:a:0','-af','ashowinfo','-c:a','pcm_f32le','-f','f32le','pipe:1']),log=audio.stderr.toString();assert.match(log,/Audio:\s*opus/);
    const rawFirst=Number(log.split('\n').find(l=>l.includes('Parsed_ashowinfo')&&l.includes('pts:')).match(/pts:(-?\d+)/)[1]);
    const planes=Array.from({length:channels},(_,c)=>Float32Array.from({length:audio.stdout.length/(4*channels)},(_,i)=>audio.stdout.readFloatLE((i*channels+c)*4)));
    const rawSamples=planes[0].length,layout=readWebm(await readFile(path)),track=layout.tracks.find(t=>t.codec==='A_OPUS'),blocks=layout.blocks.filter(b=>b.track===track.number);
    const skip=track.head.readUInt16LE(10),padding=Math.round(blocks.reduce((sum,b)=>sum+(b.discard??0),0)*48000/1e9);
    const containerSamples=blocks.reduce((sum,b)=>sum+opusSamples(b.data),0)-skip-padding;
    let normalizedLeading=0;
    // FFmpeg 6's DiscardPadding side data overrides initial skip on a single packet.
    // Reproduced with FFmpeg's own libopus/WebM output; never use a test-provided N to trim.
    if(rawFirst<0){
        assert.equal(blocks.length,1,'Unexpected negative decoded PTS');assert.ok(padding>0);assert.equal(rawFirst,-skip);
        assert.equal(rawSamples,containerSamples+skip);normalizedLeading=skip;
    }
    return{planes:planes.map(p=>p.subarray(normalizedLeading)),first:rawFirst+normalizedLeading,rawSamples,rawFirst,normalizedLeading,containerSamples};
}
export async function decodeWebm(path,channels){
    const video=await run(path,['-map','0:v:0','-vf','scale=1:1,format=rgb24,showinfo','-vsync','0','-f','rawvideo','pipe:1']);
    const videoLog=video.stderr.toString();assert.match(videoLog,/Video:\s*vp8/);
    const pts=videoLog.split('\n').filter(l=>l.includes('Parsed_showinfo')&&l.includes('pts_time:')).map(l=>Number(l.match(/pts_time:([\d.e+-]+)/)[1])*1e6);
    const colors=Array.from({length:video.stdout.length/3},(_,i)=>[...video.stdout.subarray(i*3,i*3+3)]);assert.equal(pts.length,colors.length);
    if(!channels){assert.doesNotMatch(videoLog,/Audio:/);return{pts,colors};}
    return{pts,colors,...await decodeOpus(path,channels)};
}
