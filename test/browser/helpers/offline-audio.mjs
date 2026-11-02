import ffmpeg from 'ffmpeg-static';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const execute=promisify(execFile);
/** Independent MP4 table reader; no values from the exporter or encoder callbacks. */
export function readAudioLayout(bytes){
    let movieScale;const tracks=[];
    function walk(start,end,track){for(let p=start;p+8<=end;){
        const length=bytes.readUInt32BE(p),type=bytes.toString('ascii',p+4,p+8),header=length===1?16:8;
        const size=length===1?Number(bytes.readBigUInt64BE(p+8)):length||end-p,d=p+header;assert.ok(size>=header&&p+size<=end);
        if(type==='trak'){const t={};tracks.push(t);walk(d,p+size,t);}
        else if(['moov','mdia','minf','stbl','edts'].includes(type))walk(d,p+size,track);
        else if(type==='hdlr')track.type=bytes.toString('ascii',d+8,d+12);
        else if(type==='mvhd'||type==='mdhd'){
            const v=bytes[d],o=d+(v?20:12),scale=bytes.readUInt32BE(o),duration=v?Number(bytes.readBigUInt64BE(o+4)):bytes.readUInt32BE(o+4);
            if(type==='mvhd')movieScale=scale;else Object.assign(track,{scale,duration});
        }else if(type==='elst'){
            const v=bytes[d];assert.equal(bytes.readUInt32BE(d+4),1);
            track.editDuration=v?Number(bytes.readBigUInt64BE(d+8)):bytes.readUInt32BE(d+8);
            track.editStart=v?Number(bytes.readBigInt64BE(d+16)):bytes.readInt32BE(d+12);
        }else if(type==='stts'){
            let total=0,count=0,lastDuration;for(let i=0;i<bytes.readUInt32BE(d+4);i++){
                const n=bytes.readUInt32BE(d+8+i*8),duration=bytes.readUInt32BE(d+12+i*8);count+=n;total+=n*duration;lastDuration=duration;
            }Object.assign(track,{tableSamples:total,packets:count,lastPacketDuration:lastDuration});
        }p+=size;
    }}walk(0,bytes.length);const audio=tracks.find(t=>t.type==='soun');assert.ok(audio);assert.equal(audio.duration,audio.tableSamples);
    assert.ok(Number.isSafeInteger(audio.editStart)&&audio.editStart>=0);
    return{...audio,movieScale,presentationSamples:audio.duration-audio.editStart,leading:audio.editStart,trailing:audio.packets*1024-audio.duration};
}
export async function decodeOfflineAudio(path,channels,layout){
    const run=(ignore,args)=>execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-err_detect','explode',...(ignore?['-ignore_editlist','1']:[]),'-copyts','-i',path,...args],{encoding:'buffer',maxBuffer:32*1024*1024,timeout:30000});
    const output=['-map','0:a:0','-af','ashowinfo','-c:a','pcm_f32le','-f','f32le','pipe:1'];
    const [normal,untrimmed,presentation,video]=await Promise.all([
        run(false,output),run(true,output),
        // FFmpeg 6 exposes the full last AAC frame. Apply the endpoint read from MP4, never a test-supplied count.
        run(false,['-map','0:a:0','-af',`atrim=end_sample=${layout.presentationSamples}`,'-c:a','pcm_f32le','-f','f32le','pipe:1']),
        run(false,['-map','0:v:0','-vf','scale=1:1,format=gray,showinfo','-vsync','0','-f','rawvideo','pipe:1'])
    ]);
    const planes=b=>Array.from({length:channels},(_,c)=>Float32Array.from({length:b.length/(4*channels)},(_,i)=>b.readFloatLE((i*channels+c)*4)));
    const a=normal.stderr.toString(),v=video.stderr.toString();assert.match(a,/Audio:\s*aac/);assert.match(v,/Video:\s*h264/);
    const videoFrames=v.split('\n').filter(l=>l.includes('Parsed_showinfo')&&l.includes('pts_time:')).map(l=>Number(l.match(/pts_time:([\d.e+-]+)/)[1]));
    const audioFirst=Number(a.split('\n').find(l=>l.includes('Parsed_ashowinfo')&&l.includes('pts:')).match(/pts:(-?\d+)/)[1]);
    return{normal:planes(normal.stdout),untrimmed:planes(untrimmed.stdout),presentation:planes(presentation.stdout),audioFirst,videoFrames,videoGray:[...video.stdout]};
}
export function bestLag(reference,decoded,start=256,length=4096){
    const end=Math.min(reference.length,start+length);let best={lag:0,correlation:-Infinity};
    for(let lag=-1536;lag<=1536;lag++){
        if(start+lag<0||end+lag>decoded.length)continue;let a=0,b=0,dot=0;
        for(let i=start;i<end;i++){a+=reference[i]**2;b+=decoded[i+lag]**2;dot+=reference[i]*decoded[i+lag];}
        const correlation=dot/Math.sqrt(a*b);if(correlation>best.correlation)best={lag,correlation};
    }return best;
}
export function toneStarts(plane,rate){
    const starts=[],step=Math.round(rate/1000);let previous=false;
    for(let i=0;i+step<=plane.length;i+=step){let energy=0;for(let j=0;j<step;j++)energy+=plane[i+j]**2;
        const active=Math.sqrt(energy/step)>0.2;if(active&&!previous)starts.push(i/rate);previous=active;
    }return starts;
}
