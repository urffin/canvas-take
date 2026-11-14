// Post-measurement cross-check: independently inspect the last presentation interval.
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import ffmpeg from 'ffmpeg-static';
import {mp4Headers} from '../../test/browser/helpers/offline-video.mjs';
import {readWebm} from '../../test/browser/helpers/offline-webm.mjs';
const execute=promisify(execFile),directory='benchmark-results/video-output-study';
const data=JSON.parse(await readFile(directory+'/results.json','utf8'));
const partial=process.argv.includes('--partial');
if(partial){assert.ok(['running','passed'].includes(data.status));assert.ok(data.rows.length>0);}
else{assert.equal(data.status,'passed');assert.equal(data.rows.length,28);}
const rows=[];
for(const row of data.rows){
    const expectedStart=Math.round((row.frames-1)*1e6/row.fps),expectedDuration=row.durationUs-expectedStart;
    const bytes=await readFile(row.file);let lastTimestampUs,lastDurationUs;
    if(row.kind==='mp4'){
        const headers=mp4Headers(bytes),video=headers.tracks.find(t=>t.type==='vide');
        assert.equal(Math.round(video.duration*1e6/video.timescale),row.durationUs);
        const {stdout}=await execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-copyts','-i',row.file,'-map','0:v:0','-c:v','copy','-f','framecrc','pipe:1'],{encoding:'utf8',maxBuffer:4*1024*1024,timeout:120000});
        const timebase=stdout.match(/#tb 0:\s*(\d+)\/(\d+)/);assert.ok(timebase);
        const packets=stdout.split('\n').filter(line=>/^0,/.test(line));assert.equal(packets.length,row.frames);
        const packet=packets.at(-1).split(',').map(s=>Number(s.trim())),unitUs=Number(timebase[1])*1e6/Number(timebase[2]);
        lastTimestampUs=packet[2]*unitUs;lastDurationUs=packet[3]*unitUs;
        assert.ok(Math.abs(lastTimestampUs-expectedStart)<=unitUs+1);
        assert.ok(Math.abs(lastDurationUs-expectedDuration)<=unitUs+1);
    }else{
        const layout=readWebm(bytes),video=layout.tracks.find(t=>t.codec==='V_VP8'),blocks=layout.blocks.filter(b=>b.track===video.number);
        assert.equal(blocks.length,row.frames);const last=blocks.at(-1);
        lastTimestampUs=Math.round(last.time*layout.scale/1000);lastDurationUs=Math.round(last.duration*layout.scale/1000);
        assert.equal(lastTimestampUs,expectedStart);assert.equal(lastDurationUs,expectedDuration);
    }
    rows.push({id:row.id,frames:row.frames,lastTimestampUs,lastDurationUs,durationUs:row.durationUs});
}
await writeFile(directory+(partial?'/timeline-proof-partial.json':'/timeline-proof.json'),JSON.stringify({status:partial?'partial':'passed',rows},null,2)+'\n');
console.log('Independent final sample/block duration passed: '+rows.length+' files');
