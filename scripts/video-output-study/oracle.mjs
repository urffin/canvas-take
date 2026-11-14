import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import {mp4Headers} from '../../test/browser/helpers/offline-video.mjs';
import {readWebm,decodeOpus} from '../../test/browser/helpers/offline-webm.mjs';
import {readAudioLayout,decodeOfflineAudio} from '../../test/browser/helpers/offline-audio.mjs';
const exec=promisify(execFile);
export async function verifyStudyFile(path,row){
    const run=args=>exec(ffmpeg,['-hide_banner','-nostdin','-xerror','-err_detect','explode','-copyts','-i',path,...args],{encoding:'buffer',maxBuffer:16*1024*1024,timeout:120000});
    const [copied,decoded]=await Promise.all([run(['-map','0:v:0','-c:v','copy','-f','framecrc','pipe:1']),run(['-map','0:v:0','-vf','scale=8:8,format=rgb24','-vsync','0','-f','framemd5','pipe:1'])]);
    const parse=buffer=>{const text=buffer.toString(),tb=text.match(/#tb 0:\s*(\d+)\/(\d+)/);assert.ok(tb);return {tb:[Number(tb[1]),Number(tb[2])],rows:text.split('\n').filter(l=>/^0,/.test(l)).map(l=>l.split(',').map(v=>v.trim()))};};
    const packets=parse(copied.stdout),frames=parse(decoded.stdout),fps=row.fps??24;
    assert.equal(packets.rows.length,row.frames);assert.equal(frames.rows.length,row.frames);
    const tolerance=packets.tb[0]/packets.tb[1]+0.00002;
    packets.rows.forEach((p,i)=>assert.ok(Math.abs(Number(p[2])*packets.tb[0]/packets.tb[1]-Math.round(i*1e6/fps)/1e6)<=tolerance,'Decoded PTS '+i));
    const bytes=await readFile(path);let containerDurationUs;
    if(row.kind==='mp4'){
        const headers=mp4Headers(bytes);containerDurationUs=Math.round(headers.movie.duration*1000000/headers.movie.timescale);
    }else{
        const layout=readWebm(bytes);containerDurationUs=Math.round(layout.duration*layout.scale/1000);
        const track=layout.tracks.find(t=>t.codec==='V_VP8'),blocks=layout.blocks.filter(b=>b.track===track.number);assert.equal(blocks.length,row.frames);
        blocks.forEach((b,i)=>assert.equal(Math.round(b.time*layout.scale/1000),Math.round(i*1e6/fps)));
    }
    assert.equal(containerDurationUs,row.durationUs);
    let samples;
    if(row.audio){
        const audio=row.kind==='mp4'?await decodeOfflineAudio(path,1,readAudioLayout(bytes)):await decodeOpus(path,1);
        samples=(audio.presentation??audio.planes)[0].length;assert.equal(samples,Math.round(row.durationUs*48000/1e6));
    }
    return {frames:frames.rows.length,durationUs:containerDurationUs,samples,firstDecodedHash:frames.rows[0].at(-1),lastDecodedHash:frames.rows.at(-1).at(-1),timebase:packets.tb};
}
