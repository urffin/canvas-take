import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import ffmpeg from 'ffmpeg-static';
import {createWebmMuxer} from '../dist/video-webm.js';
import {readWebm} from './browser/helpers/offline-webm.mjs';
import {patchWebmMuxer} from '../scripts/webm-muxer-patch.mjs';
const video={codec:'vp8',bitstreamFormat:'vp8',width:2,height:2,bitrate:10000};
const audio={codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:1,bitrate:128000};
const context=(extra={})=>({signal:new AbortController().signal,maxPendingInputs:2,maxPendingBytes:100000,...extra});
const config={type:'config',track:'video',config:{...video,color:{primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false}}};
const packet=(start=0,duration=100001)=>({type:'packet',packet:{track:'video',timestampUs:start,decodeTimestampUs:start,durationUs:duration,type:'key',data:new Uint8Array([16,0,0,157,1,42,2,0,2,0])}});
const head=new Uint8Array([79,112,117,115,72,101,97,100,1,1,56,1,128,187,0,0,0,0,0]);
const audioConfig={type:'config',track:'audio',config:{...audio,description:head}};
test('WebM validates format, output headers, staging limit and final summary',async()=>{
    const f=createWebmMuxer();
    assert.equal((await f.checkSupport({video})).supported,true);
    assert.equal((await f.checkSupport({video,audio})).supported,true);
    for(const c of[{video:{...video,codec:'avc1.42E01F'}},{video,audio:{...audio,sampleRate:44100}}]){assert.equal((await f.checkSupport(c)).supported,false);await assert.rejects(f.create(c,context()),/WebM/);}
    await assert.rejects(f.create({video},context({maxOutputBytes:1})),/maxOutputBytes/);
    const muxer=await f.create({video},context());try{
        await muxer.write(config);await muxer.write(packet());await muxer.write({type:'end',track:'video'});
        await assert.rejects(muxer.finalize({videoFrames:2,durationUs:100001}),/final timeline/);
        const blob=await muxer.finalize({videoFrames:1,durationUs:100001});const layout=readWebm(Buffer.from(await blob.arrayBuffer()));assert.equal(layout.duration,100001);assert.equal(layout.scale,1000);assert.equal(layout.blocks[0].duration,100001);
    }finally{muxer.dispose();muxer.dispose();}
    const limited=await f.create({video},context({maxPendingBytes:73}));try{await limited.write(config);await assert.rejects(limited.write(packet()),/maxPendingBytes staging/);}finally{limited.dispose();}
});
test('WebM Opus requires pre-skip and consistent end accounting, writes signed final discard',async()=>{
    const m=await createWebmMuxer().create({video,audio},context());try{
        await m.write(config);await m.write(audioConfig);await m.write(packet(0,1000));
        await m.write({type:'packet',packet:{track:'audio',timestampUs:-6500,decodeTimestampUs:-6500,durationUs:20000,type:'key',data:new Uint8Array([152,0])}});
        await assert.rejects(m.write({type:'end',track:'audio',presentationSamples:48,leadingDiscardSamples:0,trailingDiscardSamples:600}),/discard accounting/);
        await m.write({type:'end',track:'audio',presentationSamples:48,leadingDiscardSamples:312,trailingDiscardSamples:600});await m.write({type:'end',track:'video'});
        const blob=await m.finalize({videoFrames:1,durationUs:1000,audioPresentationSamples:48}),layout=readWebm(Buffer.from(await blob.arrayBuffer()));
        assert.equal(layout.duration,1000);assert.equal(layout.tracks[1].delay,6500000);assert.equal(layout.blocks.find(b=>b.track===2).discard,12500000);
    }finally{m.dispose();}
    const bad=await createWebmMuxer().create({video,audio},context());try{await assert.rejects(bad.write({...audioConfig,config:{...audio,description:new Uint8Array(19)}}),/OpusHead/);}finally{bad.dispose();}
});
test('WebM build transformation is pinned, preserves upstream and includes integration changes',async()=>{
    const source=(await readFile('node_modules/mediabunny/dist/modules/src/matroska/matroska-muxer.js','utf8')).replaceAll('\r\n','\n');
    const patched=patchWebmMuxer(source);assert.match(patched,/canvastakeDiscardPaddingNs/);assert.match(patched,/maxPendingBytes staging/);assert.match(patched,/EBMLId.TimestampScale, data: 1000/);
    assert.doesNotMatch(source,/canvastakeDiscardPaddingNs/);assert.throws(()=>patchWebmMuxer(patched),/anchor changed/);
});

test('independent FFmpeg encoder reproduces single-packet Opus leading-discard interaction',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'canvastake-opus-control-')),file=join(directory,'one-sample.webm'),run=promisify(execFile);
    try{
        await run(ffmpeg,['-hide_banner','-nostdin','-y','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-af','atrim=end_sample=1','-c:a','libopus',file],{timeout:30000});
        const layout=readWebm(await readFile(file)),track=layout.tracks.find(t=>t.codec==='A_OPUS'),blocks=layout.blocks.filter(b=>b.track===track.number),skip=track.head.readUInt16LE(10);
        assert.equal(blocks.length,1);assert.ok(skip>0);assert.equal(Math.round(blocks[0].discard*48000/1e9),960-skip-1);
        const raw=await run(ffmpeg,['-hide_banner','-nostdin','-copyts','-i',file,'-af','ashowinfo','-c:a','pcm_f32le','-f','f32le','pipe:1'],{encoding:'buffer',timeout:30000});
        assert.equal(raw.stdout.length/4,1+skip,'Pinned FFmpeg exposes initial skip when final discard shares the packet');
        assert.match(raw.stderr.toString(),/pts:-\d+/);
        assert.equal(Number(raw.stderr.toString().match(/nb_samples:(\d+)/)[1]),1+skip);
    }finally{await unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});await rmdir(directory);}
});
