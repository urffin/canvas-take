import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import {provisionNodeVideoDestination} from '../dist/internal/video-file-node.mjs';
import {createExternalVideoExporter} from '../dist/internal/video-external.js';
import {createExternalMp4Muxer} from '../dist/internal/video-external-mp4.js';
import {createExternalWebmMuxer} from '../dist/internal/video-external-webm.js';
import {mp4Headers} from './browser/helpers/offline-video.mjs';
import {readWebm} from './browser/helpers/offline-webm.mjs';

const execute=promisify(execFile),durations=[300000,500000,700000],canvas={width:2,height:2,getContext(){return {getImageData(){return {data:new Uint8ClampedArray(16).fill(255)};}};}};
async function encoder(kind){
 const {stdout}=await execute(ffmpeg,['-hide_banner','-nostdin','-f','lavfi','-i','color=c=white:s=2x2:r=1','-frames:v','1','-pix_fmt','yuv420p','-c:v',kind==='mp4'?'libx264':'libvpx',...(kind==='mp4'?['-profile:v','baseline','-f','h264']:['-f','ivf']),'pipe:1'],{encoding:'buffer',timeout:30000});
 let codec='vp8',data=stdout.subarray(44,44+stdout.readUInt32LE(32)),description;
 if(kind==='mp4'){
  const starts=[];for(let i=0;i<stdout.length-3;i++)if(stdout[i]===0&&stdout[i+1]===0&&(stdout[i+2]===1||(stdout[i+2]===0&&stdout[i+3]===1))){const n=stdout[i+2]===1?3:4;starts.push([i,n]);i+=n-1;}
  const nals=starts.map(([p,n],i)=>stdout.subarray(p+n,starts[i+1]?.[0]??stdout.length)),sps=nals.find(n=>(n[0]&31)===7),pps=nals.find(n=>(n[0]&31)===8);codec='avc1.'+sps.subarray(1,4).toString('hex');description=Buffer.concat([Buffer.from([1,...sps.subarray(1,4),255,225,sps.length>>8,sps.length&255]),sps,Buffer.from([1,pps.length>>8,pps.length&255]),pps]);
  data=Buffer.concat(nals.filter(n=>![7,8].includes(n[0]&31)).flatMap(n=>{const length=Buffer.alloc(4);length.writeUInt32BE(n.length);return [length,n];}));
 }
 const config={codec,bitstreamFormat:kind==='mp4'?'avc':'vp8',width:2,height:2,bitrate:10000};
 return {config,encoder:{checkSupport:async()=>({supported:true}),create(c,context){let configured=false;return {async encodeFrame(frame){if(!configured){configured=true;await context.output.write({type:'config',track:'video',config:{...config,...(description?{description}:{}),color:{primaries:'bt709',transfer:'bt709',matrix:'smpte170m',fullRange:false}}});}await context.output.write({type:'packet',packet:{track:'video',type:'key',data,timestampUs:frame.timestampUs,decodeTimestampUs:frame.timestampUs,durationUs:frame.durationUs}});},async flush(){await context.output.write({type:'end',track:'video'});},dispose(){}};}}};
}
async function decode(path,kind){
 const {stdout,stderr}=await execute(ffmpeg,['-hide_banner','-nostdin','-xerror','-err_detect','explode','-copyts','-i',path,'-map','0:v:0','-vf','scale=1:1,format=rgb24,showinfo','-vsync','0','-f','rawvideo','pipe:1'],{encoding:'buffer',timeout:30000});assert.equal(stdout.length,9);assert.ok([...stdout].every(n=>n>=235));
 const pts=stderr.toString().split('\n').filter(l=>l.includes('Parsed_showinfo')&&l.includes('pts_time:')).map(l=>Math.round(Number(l.match(/pts_time:([\d.e+-]+)/)[1])*1e6));assert.deepEqual(pts,[0,300000,800000]);const file=await readFile(path);
 if(kind==='mp4'){const h=mp4Headers(file),video=h.tracks.find(t=>t.type==='vide');assert.equal(video.duration/video.timescale,1.5);}else{const h=readWebm(file);assert.equal(h.duration,1500000);assert.deepEqual(h.blocks.map(b=>b.duration),durations);}
}
for(const kind of ['mp4','webm'])for(const lost of [false,true])test('D20: new receiver '+kind+' decodes '+(lost?'recovered commit and fresh retry':'committed result after target overwrite'),async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'canvastake-receiver-media-')));let lose=lost;
 try{
  const receiver=await provisionNodeVideoDestination(root,{trust:'controlled-local-directory',shortWrite:17,fault(point){if(lose&&point==='before-ack')throw Error('lost ack');}});
  for(let round=0;round<(lost?2:1);round++){
   const b=receiver.bind('movie.'+kind),e=createExternalVideoExporter({video:await encoder(kind),muxer:kind==='mp4'?createExternalMp4Muxer():createExternalWebmMuxer(),destination:b.destination,ifExists:round?'replace':'error'});await e.ready;let timestampUs=0;for(const durationUs of durations){await e.addFrame(canvas,{timestampUs,durationUs});timestampUs+=durationUs;}
   let value;if(lose){await assert.rejects(e.finish());assert.equal((await e.closed).publication,'indeterminate');const recovered=await b.recovery.inspect(b.key);assert.equal(recovered.publication.status,'committed');value=recovered.publication.receipt.value;const cleanup=await b.recovery.cleanup(b.key,{expectedRevision:recovered.revision});assert.notEqual(cleanup.status,'blocked');}
   else{value=(await e.finish()).output.value;assert.equal((await e.closed).publication,'committed');}
   await decode(value.path,kind);assert.deepEqual(new Uint8Array(await readFile(join(root,'movie.'+kind))),await value.read());await writeFile(join(root,'movie.'+kind),'another writer in place');await decode(value.path,kind);assert.equal((await b.recovery.inspect(b.key)).publication.status,'committed');e.dispose();assert.equal(receiver.stats.liveHandles,0);assert.equal(receiver.stats.borrowedBytes,0);lose=false;
  }
 }finally{const target=await realpath(root);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-receiver-media-'));await rm(target,{recursive:true,force:true});}
});
