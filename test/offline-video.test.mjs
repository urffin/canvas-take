import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOfflineVideoExporter } from '../dist/video.js';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setTimeout(resolve, 0));
function canvas(width = 1, height = 1) {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    return { width, height, data, reads: 0, getContext() { this.reads++; return { getImageData: () => ({ data }) }; } };
}
function adapters(hooks = {}) {
    const stats = { resources: [], events: [], frames: [], blocks: [], contexts: {}, maxWrites: 0, writes: 0 };
    const config = { codec: 'test-video', bitstreamFormat: 'test', width: 1, height: 1, bitrate: 1000 };
    const audioConfig = { codec: 'test-audio', bitstreamFormat: 'test', sampleRate: 1000, numberOfChannels: 1, bitrate: 1000 };
    const resource = name => { const r = { name, disposed: 0, dispose() { this.disposed++; hooks.dispose?.(name); } }; stats.resources.push(r); return r; };
    const output = (track, ctx, event) => ctx.output.write(hooks.event?.(track, event) ?? event);
    const muxer = {
        format: { mimeType: 'video/x-test', extension: 'test' },
        checkSupport: async () => ({ supported: true }),
        create(_config, context) {
            stats.contexts.muxer = context;
            const r = Object.assign(resource('muxer'), {
                async write(event) {
                    stats.maxWrites = Math.max(stats.maxWrites, ++stats.writes);
                    try { await hooks.write?.(event); stats.events.push(event); } finally { stats.writes--; }
                },
                async finalize(timeline) {
                    stats.timeline = timeline;
                    if (hooks.finalize) return hooks.finalize(timeline);
                    return new Blob([JSON.stringify({ timeline, events: stats.events })], { type: muxer.format.mimeType });
                }
            });
            return hooks.createMuxer ? hooks.createMuxer(r) : r;
        }
    };
    const video = {
        checkSupport: hooks.support ?? (async () => ({ supported: true })),
        create(c, ctx) {
            stats.contexts.video = ctx;
            let configured = false; const pending = [];
            const emitConfig = async () => {
                if (configured) return; configured = true;
                await output('video', ctx, { type: 'config', track: 'video', config: { codec: c.codec, bitstreamFormat: c.bitstreamFormat, width: c.width, height: c.height,
                    color: { primaries: 'bt709', transfer: 'srgb', matrix: 'rgb', fullRange: true } } });
            };
            const emit = async frame => { await emitConfig(); await output('video', ctx, { type: 'packet', packet: {
                track: 'video', timestampUs: frame.timestampUs, decodeTimestampUs: frame.timestampUs, durationUs: frame.durationUs,
                type: frame.timestampUs === 0 ? 'key' : 'delta', data: new Uint8Array([frame.data[0]]) } }); };
            const r = Object.assign(resource('video'), {
                async encodeFrame(frame) {
                    stats.frames.push({ ...frame, data: frame.data.slice() });
                    if (hooks.frame) return hooks.frame(frame, ctx, emit);
                    if (hooks.delayedVideo) pending.push({ ...frame, data: frame.data.slice() }); else await emit(frame);
                },
                async flush() {
                    await hooks.videoFlush?.(ctx);
                    if (hooks.burst) { await emitConfig(); await hooks.burst(pending, ctx, emit); }
                    else for (const frame of pending) await emit(frame);
                    if (!hooks.omitVideoEnd) await output('video', ctx, { type: 'end', track: 'video' });
                }
            });
            return hooks.createVideo ? hooks.createVideo(r, ctx) : r;
        }
    };
    const audio = {
        checkSupport: async () => ({ supported: true }),
        create(c, ctx) {
            stats.contexts.audio = ctx; let configured = false, samples = 0;
            const ts = sample => Math.round(sample * 1e6 / c.sampleRate);
            const packet = (start, end) => output('audio', ctx, { type: 'packet', packet: { track: 'audio', timestampUs: ts(start), decodeTimestampUs: ts(start), durationUs: ts(end) - ts(start), type: 'key', data: new Uint8Array([1]) } });
            const r = Object.assign(resource('audio'), {
                async encodeAudio(block) {
                    stats.blocks.push({ ...block, channels: block.channels.map(c => c.slice()) });
                    const used = await hooks.audio?.(block, ctx) ?? block;
                    if (!configured) {
                        configured = true;
                        await output('audio', ctx, { type: 'config', track: 'audio', config: { codec: c.codec, bitstreamFormat: c.bitstreamFormat, sampleRate: c.sampleRate, numberOfChannels: c.numberOfChannels } });
                        if (hooks.leading) await packet(-hooks.leading, 0);
                    }
                    await packet(used.sampleOffset, used.sampleOffset + used.channels[0].length); samples += used.channels[0].length;
                },
                async flush() {
                    await hooks.audioFlush?.(ctx);
                    if (hooks.trailing) await packet(samples, samples + hooks.trailing);
                    await output('audio', ctx, { type: 'end', track: 'audio', presentationSamples: samples, leadingDiscardSamples: hooks.leading ?? 0, trailingDiscardSamples: hooks.trailing ?? 0 });
                }
            });
            return hooks.createAudio ? hooks.createAudio(r, ctx) : r;
        }
    };
    const options = (extra = {}) => ({ video: { encoder: video, config }, muxer, ...extra });
    const withAudio = (length, policy = 'trim-or-pad', rate = 1000) => ({ encoder: audio, config: { ...audioConfig, sampleRate: rate }, source: { sampleRate: rate, channels: [new Float32Array(length).fill(0.25)] }, endPolicy: policy });
    return { stats, video, audio, muxer, config, options, withAudio };
}
const allDisposed = stats => assert.ok(stats.resources.every(r => r.disposed === 1), JSON.stringify(stats.resources.map(r => [r.name, r.disposed])));

test('video composition finishes synchronously on one owned copy before its first task', async () => {
    const { code } = await transform(await readFile(new URL('../dist/video.js', import.meta.url), 'utf8'), { format: 'cjs' });
    const module = { exports: {} }, copies = [], tasks = new Map(); let nextTask = 0;
    function Pixels(input) { const copy = new Uint8ClampedArray(input); copies.push(copy); return copy; }
    runInNewContext(code, { module, exports: module.exports, Uint8ClampedArray: Pixels, Uint8Array, Float32Array, ArrayBuffer, Blob, DOMException, AbortController,
        setTimeout(callback) { const id = ++nextTask; tasks.set(id, callback); return id; }, clearTimeout(id) { tasks.delete(id); } });
    const a = adapters(), source = canvas(7, 5), reads = [], background = [7, 101, 239];
    Object.assign(a.config, { width: 7, height: 5 });
    for (let p = 0; p < 35; p++) source.data.set([p * 7 % 256, 255 - p * 5, p * 13 % 256, [0, 1, 127, 128, 254, 255][p % 6]], p * 4);
    const original = source.data.slice(), expected = original.map((value, i) => i % 4 === 3 ? 255
        : Math.floor((value * original[i - i % 4 + 3] + background[i % 4] * (255 - original[i - i % 4 + 3]) + 127) / 255));
    source.getContext = kind => { assert.equal(kind, '2d'); return { getImageData(...args) { reads.push(args); return { data: source.data }; } }; };
    const exporter = await module.exports.createOfflineVideoExporter(a.options({ background }));
    try {
        const pending = exporter.addFrame(source, { timestampUs: 0, durationUs: 123457 }); void pending.catch(() => {});
        assert.equal(copies.length, 1);
        assert.deepEqual(copies[0], expected, 'composition must finish before addFrame returns its promise');
        assert.notEqual(copies[0].buffer, source.data.buffer);
        assert.deepEqual(source.data, original);
        assert.deepEqual(JSON.parse(JSON.stringify(reads)), [[0, 0, 7, 5, { colorSpace: 'srgb' }]]);
        assert.equal(a.stats.frames.length, 0); assert.equal(tasks.size, 1);
        source.data.fill(0); source.width = 1; background.fill(255);
        const [id, resume] = tasks.entries().next().value; tasks.delete(id); resume(); await pending;
        assert.deepEqual(a.stats.frames[0].data, expected);
        assert.equal(a.stats.frames[0].timestampUs, 0); assert.equal(a.stats.frames[0].durationUs, 123457);
        assert.equal(a.stats.frames[0].keyFrame, true); assert.equal(copies.length, 1);
        const result = await exporter.finish(); assert.equal(result.durationUs, 123457); assert.equal(result.videoFrames, 1);
    } finally { exporter.dispose(); tasks.clear(); }
    allDisposed(a.stats);
});

test('offline video preserves supplied frame intervals, final hold and immediate snapshot with delayed outputs', async () => {
    const a = adapters({ delayedVideo: true }), source = canvas(), progress = [];
    let exporter, repeatFinish;
    exporter = await createOfflineVideoExporter(a.options({ maxFrames: 3, totalFrames: 999, maxDurationUs: 2_066_667,
        onProgress(p) { progress.push(p); if (p.phase === 'finalizing') repeatFinish = exporter.finish(); } }));
    const timing = { timestampUs: 0, durationUs: 33333, keyFrame: false };
    const first = exporter.addFrame(source, timing); source.data.fill(0); timing.durationUs = 1; timing.keyFrame = true;
    await first; await exporter.addFrame(source, { timestampUs: 33333, durationUs: 33334 });
    await exporter.addFrame(source, { timestampUs: 66667, durationUs: 2_000_000 });
    const finishing = exporter.finish(); assert.equal(exporter.finish(), finishing);
    const result = await finishing; assert.equal(repeatFinish, finishing); assert.equal(await exporter.finish(), result);
    assert.equal(result.videoFrames, 3); assert.equal(result.durationUs, 2_066_667); assert.equal(result.mimeType, 'video/x-test');
    assert.deepEqual(a.stats.events.filter(e => e.type === 'packet').map(e => [e.packet.timestampUs, e.packet.durationUs]), [[0,33333],[33333,33334],[66667,2000000]]);
    assert.deepEqual([...a.stats.frames[0].data], [255,255,255,255]); assert.equal(a.stats.frames[0].keyFrame, true);
    assert.ok(Object.isFrozen(result)); assert.ok(progress.every(Object.isFrozen));
    assert.equal(progress.at(-1).framesAccepted, 3); assert.equal(progress.at(-1).outputBytes, result.blob.size);
    assert.equal(a.stats.maxWrites, 1); exporter.dispose(); exporter.dispose(); allDisposed(a.stats);
});

test('prepared PCM is snapshotted; sample boundaries, priming and padding use a sample clock', async () => {
    const a = adapters({ leading: 2, trailing: 3 }), input = a.withAudio(4410, 'error', 44100);
    const creating = createOfflineVideoExporter(a.options({ audio: input })); input.source.channels[0].fill(0);
    const exporter = await creating;
    for (const [timestampUs, durationUs] of [[0,33333],[33333,33334],[66667,33333]]) await exporter.addFrame(canvas(), { timestampUs, durationUs });
    const result = await exporter.finish();
    assert.equal(result.audioPresentationSamples, 4410); assert.equal(result.durationUs, 100000);
    assert.deepEqual(a.stats.blocks.map(b => [b.sampleOffset, b.timestampUs]), [[0,0],[1470,33333],[2940,66667]]);
    assert.ok(a.stats.blocks.every(b => b.channels[0].every(n => n === 0.25)));
    assert.equal(input.source.channels[0].buffer.byteLength, 4410 * 4); allDisposed(a.stats);
});

test('audio trim/pad is explicit; strict mismatch fails without submitting the rejected interval', async () => {
    for (const [length, target, expected] of [[3,5,[0.25,0.25,0.25,0,0]], [5,3,[0.25,0.25,0.25]]]) {
        const a = adapters(), exporter = await createOfflineVideoExporter(a.options({ audio: a.withAudio(length) }));
        await exporter.addFrame(canvas(), { timestampUs: 0, durationUs: target * 1000 }); await exporter.finish();
        assert.deepEqual(a.stats.blocks.flatMap(b => [...b.channels[0]]), expected); allDisposed(a.stats);
    }
    for (const [length, target] of [[1,2],[2,1]]) {
        const a = adapters(), source = canvas(), exporter = await createOfflineVideoExporter(a.options({ audio: a.withAudio(length, 'error') }));
        if (target > length) { await assert.rejects(exporter.addFrame(source, { timestampUs: 0, durationUs: target * 1000 }), /shorter/); assert.equal(source.reads, 0); }
        else { await exporter.addFrame(source, { timestampUs: 0, durationUs: target * 1000 }); await assert.rejects(exporter.finish(), /longer/); }
        assert.equal(exporter.state, 'failed'); allDisposed(a.stats);
    }
});

test('invalid timeline/limits fail before readback and keep successful progress counters', async () => {
    const cases = [
        [{}, {timestampUs:1,durationUs:10}, /contiguous/], [{}, {timestampUs:0,durationUs:0}, /durationUs/],
        [{}, {timestampUs:0,durationUs:Number.MAX_SAFE_INTEGER+1}, /durationUs/],
        [{maxDurationUs:9}, {timestampUs:0,durationUs:10}, /maxDurationUs/],
        [{maxFramePixels:1}, {timestampUs:0,durationUs:10}, /maxFramePixels/, true],
        [{maxPendingBytes:3}, {timestampUs:0,durationUs:10}, /maxPendingBytes/]
    ];
    for (const [limits,timing,error,wide] of cases) {
        const a = adapters(); if (wide) a.config.width = 2;
        const source = canvas(wide ? 2 : 1), exporter = await createOfflineVideoExporter(a.options(limits));
        await assert.rejects(exporter.addFrame(source, timing), error); assert.equal(source.reads, 0); allDisposed(a.stats);
    }
    for (const next of [{timestampUs:9,durationUs:1},{timestampUs:11,durationUs:1},{timestampUs:10,durationUs:1}]) {
        const a = adapters(), source = canvas(), events = [];
        const exporter = await createOfflineVideoExporter(a.options({ maxFrames: 1, onProgress: p => events.push(p) }));
        await exporter.addFrame(source, { timestampUs:0,durationUs:10 });
        await assert.rejects(exporter.addFrame(source, next)); assert.equal(source.reads, 1);
        assert.equal(events.at(-1).framesAccepted, 1); assert.equal(events.at(-1).durationUs, 10); allDisposed(a.stats);
    }
});

test('invalid options and unsupported combinations allocate no adapters', async () => {
    for (const key of ['maxFrames','maxFramePixels','maxDurationUs','maxAudioInputBytes','maxOutputBytes','maxPendingInputs','maxPendingBytes','totalFrames']) {
        for (const value of [0,-1,1.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,null,'4',false]) {
            const a = adapters(); await assert.rejects(createOfflineVideoExporter(a.options({ [key]:value })), RangeError); assert.equal(a.stats.resources.length, 0);
        }
    }
    const a = adapters({ support: async () => ({ supported:false, reason:'codec unavailable' }) });
    await assert.rejects(createOfflineVideoExporter(a.options()), { name:'NotSupportedError' }); assert.equal(a.stats.resources.length, 0);
    const b = adapters(); await assert.rejects(createOfflineVideoExporter(b.options({ audio:b.withAudio(5), maxAudioInputBytes:19 })), /maxAudioInputBytes/); assert.equal(b.stats.resources.length, 0);
    const bad = b.withAudio(5); bad.source.channels[0][0] = NaN;
    await assert.rejects(createOfflineVideoExporter(b.options({ audio:bad })), /PCM/);
    if(typeof SharedArrayBuffer !== 'undefined') {
        const shared=b.withAudio(5); shared.source.channels[0]=new Float32Array(new SharedArrayBuffer(20));
        await assert.rejects(createOfflineVideoExporter(b.options({audio:shared})),/nonshared/);
    }
});

test('a slow muxer applies backpressure, serializes writes and rejects overlapping public operations without cancelling', async () => {
    const gate = deferred(), entered = deferred();
    const a = adapters({ async write() { entered.resolve(); await gate.promise; } });
    const exporter = await createOfflineVideoExporter(a.options());
    const pending = exporter.addFrame(canvas(), {timestampUs:0,durationUs:1000}); await entered.promise;
    await assert.rejects(exporter.addFrame(canvas(), {timestampUs:1000,durationUs:1000}), /encoding/);
    await assert.rejects(exporter.finish(), /encoding/); assert.equal(exporter.state, 'encoding');
    gate.resolve(); await pending; await exporter.finish(); assert.equal(a.stats.maxWrites, 1); allDisposed(a.stats);
});

test('bounded look-ahead and output bytes fail instead of growing or deadlocking', async () => {
    const a = adapters({ delayedVideo:true }), source = canvas();
    const exporter = await createOfflineVideoExporter(a.options({maxPendingInputs:2}));
    await exporter.addFrame(source, {timestampUs:0,durationUs:10}); await exporter.addFrame(source, {timestampUs:10,durationUs:10});
    await assert.rejects(exporter.addFrame(source, {timestampUs:20,durationUs:10}), /maxPendingInputs/); assert.equal(source.reads, 2); allDisposed(a.stats);
    const gate = deferred();
    const b = adapters({ delayedVideo:true, async write(event) { if (event.type === 'packet') await gate.promise; },
        async burst(frames,ctx) {
            const writes = frames.map(f => ctx.output.write({type:'packet',packet:{track:'video',timestampUs:f.timestampUs,decodeTimestampUs:f.timestampUs,durationUs:f.durationUs,type:f.timestampUs===0?'key':'delta',data:new Uint8Array([1])}}));
            await Promise.all(writes);
        } });
    const full = await createOfflineVideoExporter(b.options({maxPendingBytes:140}));
    for(let i=0;i<3;i++) await full.addFrame(canvas(), {timestampUs:i*10,durationUs:10});
    await assert.rejects(full.finish(), /maxPendingBytes/); gate.resolve(); await turn(); allDisposed(b.stats);
});

test('protocol rejects bad config, timestamp order, keys, missing end and audio trimming', async () => {
    for (const mode of ['codec','delta','dts','duration','track','missing-end','audio-count','audio-trim']) {
        const a = adapters({ omitVideoEnd:mode==='missing-end', event(track,event) {
            if(mode==='codec' && event.type==='config') return {...event,config:{...event.config,codec:'other'}};
            if(event.type==='packet' && track==='video') {
                if(mode==='delta') return {...event,packet:{...event.packet,type:'delta'}};
                if(mode==='dts') return {...event,packet:{...event.packet,decodeTimestampUs:-1}};
                if(mode==='duration') return {...event,packet:{...event.packet,durationUs:11}};
                if(mode==='track') return {...event,packet:{...event.packet,track:'audio'}};
            }
            if(event.type==='end' && track==='audio') {
                if(mode==='audio-count') return {...event,presentationSamples:99};
                if(mode==='audio-trim') return {...event,leadingDiscardSamples:2};
            }
            return event;
        } });
        const exporter = await createOfflineVideoExporter(a.options(mode.startsWith('audio') ? {audio:a.withAudio(1)} : {}));
        const frame = exporter.addFrame(canvas(), {timestampUs:0,durationUs:1000});
        if(['missing-end','audio-count','audio-trim'].includes(mode)) { await frame; await assert.rejects(exporter.finish(), /protocol/); }
        else await assert.rejects(frame, /protocol/);
        allDisposed(a.stats);
    }
});

test('abort at support/create/input/write/flush/finalize settles promptly and disposes late instances once', async () => {
    for(const phase of ['support','muxer-create','video-create','audio-create','frame','audio','write','video-flush','audio-flush','finalize']) {
        const gate=deferred(), entered=deferred(), controller=new AbortController(), reason=new Error('cancel '+phase), progress=[];
        const block = async () => { entered.resolve(); await gate.promise; };
        const hooks = {};
        if(phase==='support') hooks.support=async()=>{await block();return {supported:true};};
        if(phase.endsWith('-create')) hooks[{'muxer-create':'createMuxer','video-create':'createVideo','audio-create':'createAudio'}[phase]]=async instance=>{await block();return instance;};
        if(phase==='frame') hooks.frame=block;
        if(phase==='audio') hooks.audio=block;
        if(phase==='write') hooks.write=async event=>{if(event.type==='packet')await block();};
        if(phase==='video-flush') hooks.videoFlush=block;
        if(phase==='audio-flush') hooks.audioFlush=block;
        if(phase==='finalize') hooks.finalize=async()=>{await block();return new Blob(['late'],{type:'video/x-test'});};
        const a=adapters(hooks); let exporter;
        const creating=createOfflineVideoExporter(a.options({audio:a.withAudio(1),signal:controller.signal,onProgress:p=>progress.push(p)}));
        let pending;
        if(phase==='support'||phase.endsWith('-create')) pending=creating;
        else {
            exporter=await creating;
            const frame=exporter.addFrame(canvas(),{timestampUs:0,durationUs:1000});
            if(['frame','audio','write'].includes(phase)) pending=frame;
            else {await frame;pending=exporter.finish();}
        }
        await entered.promise; controller.abort(reason); await assert.rejects(pending, error=>error===reason);
        const count=progress.length; gate.resolve(); await turn(); await turn();
        assert.equal(progress.length,count); assert.equal(progress.at(-1).phase,'aborted');
        exporter?.dispose(); allDisposed(a.stats);
    }
});

test('dispose, delayed callback failure, output-size failure and observer cleanup preserve primary outcomes', async () => {
    const gate=deferred(), entered=deferred(), a=adapters({frame:async()=>{entered.resolve();await gate.promise;},dispose(){throw Error('cleanup');}});
    const exporter=await createOfflineVideoExporter(a.options()); const pending=exporter.addFrame(canvas(),{timestampUs:0,durationUs:10}); await entered.promise;
    exporter.dispose(); await assert.rejects(pending,{name:'AbortError'}); gate.resolve(); exporter.dispose(); allDisposed(a.stats);
    const b=adapters(), late=await createOfflineVideoExporter(b.options());
    b.stats.contexts.video.output.fail(Error('worker died'));
    await assert.rejects(late.addFrame(canvas(),{timestampUs:0,durationUs:10}),/video encoder/); allDisposed(b.stats);
    const c=adapters(), limited=await createOfflineVideoExporter(c.options({maxOutputBytes:1}));
    await limited.addFrame(canvas(),{timestampUs:0,durationUs:10}); await assert.rejects(limited.finish(),/maxOutputBytes/); allDisposed(c.stats);
    let successful;
    const d=adapters(); successful=await createOfflineVideoExporter(d.options({onProgress(p){if(p.phase==='finished')successful.dispose();else throw Error('UI');}}));
    await successful.addFrame(canvas(),{timestampUs:0,durationUs:10}); assert.ok((await successful.finish()).blob.size); allDisposed(d.stats);
});

test('failed partial initialization cleans prior instances; empty finish and pre-abort leak nothing', async () => {
    const a=adapters({createAudio(instance){instance.dispose();throw Error('audio init');}});
    await assert.rejects(createOfflineVideoExporter(a.options({audio:a.withAudio(1)})),e=>e.message.includes('audio encoder.create') && e.cause.message==='audio init'); allDisposed(a.stats);
    const b=adapters(), empty=await createOfflineVideoExporter(b.options()); await assert.rejects(empty.finish(),/at least one/); allDisposed(b.stats);
    const controller=new AbortController(); controller.abort('already cancelled'); const c=adapters();
    await assert.rejects(createOfflineVideoExporter(c.options({signal:controller.signal})),e=>e==='already cancelled'); assert.equal(c.stats.resources.length,0);
});

test('offline entry is import-safe and has no codec/muxer runtime dependency', async () => {
    const bundled=await build({entryPoints:['dist/video.js'],bundle:true,write:false,metafile:true,format:'esm',platform:'browser'});
    assert.deepEqual(Object.keys(bundled.metafile.inputs),['dist/video.js']);
    assert.deepEqual(Object.values(bundled.metafile.outputs)[0].imports,[]);
});

test('adapter transfer and caller mutation cannot detach or alter source canvas/PCM', async () => {
    const a=adapters({
        frame(frame,_ctx,emit) { const moved=structuredClone(frame.data,{transfer:[frame.data.buffer]}); return emit({...frame,data:moved}); },
        audio(block) { return {...block,channels:block.channels.map(plane=>structuredClone(plane,{transfer:[plane.buffer]}))}; }
    });
    const source=canvas(), input=a.withAudio(3,'error');
    const exporter=await createOfflineVideoExporter(a.options({audio:input}));
    await exporter.addFrame(source,{timestampUs:0,durationUs:3000}); await exporter.finish();
    assert.equal(source.data.byteLength,4); assert.equal(input.source.channels[0].byteLength,12);
    assert.deepEqual([...input.source.channels[0]],[0.25,0.25,0.25]); allDisposed(a.stats);
});

test('packet storage is copied before async muxing; delayed callbacks after cancellation are suppressed', async () => {
    const gate=deferred(), entered=deferred(); let packet;
    const a=adapters({event(track,event){if(track==='video'&&event.type==='packet')packet=event.packet.data;return event;},
        async write(event){if(event.type==='packet'){entered.resolve();await gate.promise;}}});
    const exporter=await createOfflineVideoExporter(a.options());
    const adding=exporter.addFrame(canvas(),{timestampUs:0,durationUs:10}); await entered.promise;
    packet.fill(0); gate.resolve(); await adding; await exporter.finish();
    assert.equal(a.stats.events.find(e=>e.type==='packet').packet.data[0],255); allDisposed(a.stats);
    const b=adapters(), controller=new AbortController(), progress=[];
    const cancelled=await createOfflineVideoExporter(b.options({signal:controller.signal,onProgress:p=>progress.push(p)}));
    controller.abort('reason'); const n=progress.length;
    await assert.rejects(b.stats.contexts.video.output.write({type:'end',track:'video'}),e=>e==='reason');
    b.stats.contexts.video.output.fail(Error('late')); assert.equal(progress.length,n); cancelled.dispose(); allDisposed(b.stats);
});

test('fractional-rate boundaries and artificial encoder delays leave identical timing', async () => {
    const results=[];
    for(const delayed of [false,true]) {
        const a=adapters({frame:async(frame,_ctx,emit)=>{if(delayed)await turn();await emit(frame);}});
        const exporter=await createOfflineVideoExporter(a.options({maxFrames:12}));
        const boundary=i=>Math.round(i*1001000000/30000);
        for(let i=0;i<12;i++)await exporter.addFrame(canvas(),{timestampUs:boundary(i),durationUs:boundary(i+1)-boundary(i)});
        const result=await exporter.finish();
        results.push({duration:result.durationUs,packets:a.stats.events.filter(e=>e.type==='packet').map(e=>[e.packet.timestampUs,e.packet.durationUs])});
        allDisposed(a.stats);
    }
    assert.deepEqual(results[0],results[1]); assert.equal(results[0].duration,400400);
});

test('signal listeners are removed on every terminal outcome and adapter failures retain component/cause', async () => {
    for(const mode of ['success','failure','dispose']) {
        const controller=new AbortController(), listeners=new Set();
        const add=controller.signal.addEventListener.bind(controller.signal),remove=controller.signal.removeEventListener.bind(controller.signal);
        controller.signal.addEventListener=(type,listener,opts)=>{listeners.add(listener);add(type,listener,opts);};
        controller.signal.removeEventListener=(type,listener,opts)=>{listeners.delete(listener);remove(type,listener,opts);};
        const original=Error('bad input'), a=adapters(mode==='failure'?{frame(){throw original;}}:{});
        const exporter=await createOfflineVideoExporter(a.options({signal:controller.signal})); assert.equal(listeners.size,1);
        if(mode==='failure')await assert.rejects(exporter.addFrame(canvas(),{timestampUs:0,durationUs:10}),e=>e.cause===original&&e.message.includes('video encoder.encodeFrame'));
        else if(mode==='dispose')exporter.dispose();
        else {await exporter.addFrame(canvas(),{timestampUs:0,durationUs:10});await exporter.finish();}
        assert.equal(listeners.size,0); exporter.dispose(); assert.equal(a.stats.contexts.video.signal.aborted,true); allDisposed(a.stats);
    }
});

test('configuration output during creation is drained; observer cancellation disposes a late factory result', async () => {
    const config={type:'config',track:'video',config:{codec:'test-video',bitstreamFormat:'test',width:1,height:1,color:{primaries:'bt709',transfer:'srgb',matrix:'rgb',fullRange:true}}};
    for(const abort of [false,true]) {
        const controller=new AbortController(); let a;
        a=adapters({async createVideo(instance,ctx){await ctx.output.write(config);return instance;}});
        const creating=createOfflineVideoExporter(a.options({signal:controller.signal,onProgress(p){
            if(abort && p.phase==='initializing' && a.stats.resources.length===2)controller.abort('initial observer');
        }}));
        if(abort) {await assert.rejects(creating,e=>e==='initial observer');await turn();}
        else {const exporter=await creating;await exporter.addFrame(canvas(),{timestampUs:0,durationUs:10});await exporter.finish();}
        allDisposed(a.stats);
    }
});

test('zero-byte config events cannot bypass the output budget', async () => {
    const gate=deferred();
    const a=adapters({async write(){await gate.promise;},createVideo(instance,ctx){
        const config={type:'config',track:'video',config:{codec:'test-video',bitstreamFormat:'test',width:1,height:1,color:{primaries:'bt709',transfer:'srgb',matrix:'rgb',fullRange:true}}};
        for(let i=0;i<10;i++)void ctx.output.write(config);return instance;
    }});
    await assert.rejects(createOfflineVideoExporter(a.options({maxPendingBytes:128})),/maxPendingBytes/);
    gate.resolve();await turn();await turn();allDisposed(a.stats);
});

test('malformed support and acquired instances fail early and release acquired resources', async () => {
    const a=adapters({support:async()=>({})});
    await assert.rejects(createOfflineVideoExporter(a.options()),/invalid support/);assert.equal(a.stats.resources.length,0);
    const b=adapters({createVideo(instance){delete instance.flush;return instance;}});
    await assert.rejects(createOfflineVideoExporter(b.options()),e=>e.message.includes('video encoder.create')&&e.cause.message.includes('missing methods'));allDisposed(b.stats);
});
