import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker as NodeWorker } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { createGifExporter } from '../dist/gif.js';
import { createGifWorkerEncoder } from '../dist/gif-worker.js';
import { createGifencEncoder } from '../dist/gifenc.js';
import { createGifWorkerEncoder as legacyAdapter } from './fixtures/gif-worker-legacy-adapter.mjs';

const rawKey = Symbol.for('@grundyjs/canvas-take/gif/raw-preparation/v1');
test('raw initialization, handoff, failure and finish release snapshots with retained exporters', () => {
    assert.match(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(new URL('./fixtures/gif-raw-gc.mjs', import.meta.url))],
        { encoding: 'utf8', timeout: 20000 }), /Raw snapshots collectible/);
});
const pixelSource = () => {
    const data = new Uint8ClampedArray(60 * 4);
    for (let p = 0; p < 60; p++) data.set([p * 3 % 256, 210 - p, 40 + p, [0, 1, 128, 254, 255][p % 5]], p * 4);
    return { width: 10, height: 6, data, getContext: () => ({ getImageData: () => ({ data }) }) };
};
class RealWorker extends EventTarget {
    static instances = [];
    terminated = 0; actions = []; transfers = 0;
    constructor(url) {
        super(); this.node = new NodeWorker(new URL('./fixtures/browser-worker.mjs', import.meta.url), { workerData: String(url) });
        this.node.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
        this.node.on('error', error => { const event = new Event('error'); event.message = error.message; this.dispatchEvent(event); });
        RealWorker.instances.push(this);
    }
    postMessage(message, transfer) {
        this.actions.push(message.action); this.node.postMessage(message, transfer);
        if (transfer.length) { this.transfers++; assert.equal(message.value.data.byteLength, 0); }
    }
    terminate() { this.terminated++; this.exited = this.node.terminate(); }
}
async function exportFrames(factory, background) {
    const source = pixelSource(), original = source.data.slice(), gif = createGifExporter({ encoder: factory, background, repeat: 3 });
    try {
        const work = gif.addFrame(source, 54); source.data.fill(0); await work;
        source.data.set(original); await gif.addFrame(source, 2000);
        assert.deepEqual(source.data, original); assert.equal(source.data.buffer.byteLength, 240);
        const bytes = new Uint8Array(await (await gif.finish()).arrayBuffer());
        const parsed = parseGIF(bytes.buffer), frames = decompressFrames(parsed, true);
        assert.deepEqual(frames.map(f => f.delay), [50, 2000]); assert.equal(frames[0].patch.length, 240);
        assert.equal(parsed.frames.find(f => f.application).application.blocks[1], 3);
        return bytes;
    } finally { gif.dispose(); }
}

test('raw Worker, legacy runtime/adapter and public-method wrappers produce byte-identical GIFs', async () => {
    const previous = globalThis.Worker; globalThis.Worker = RealWorker;
    try {
        for (const quality of ['high', 'fast']) for (const maxColors of [16, 256]) for (const background of [[255, 255, 255], [20, 40, 60]]) {
            const options = { quality, maxColors }, expected = await exportFrames(createGifencEncoder(options), background);
            for (const mode of ['raw', 'proxy', 'legacy-runtime', 'legacy-adapter', 'wrapper']) {
                let factory = mode === 'legacy-adapter'
                    ? legacyAdapter({ ...options, workerUrl: new URL('../dist/gif-worker-runtime.js', import.meta.url) })
                    : createGifWorkerEncoder({ ...options, ...(mode === 'legacy-runtime' ? { workerUrl: new URL('./fixtures/gif-worker-legacy-runtime.mjs', import.meta.url) } : {}) });
                if (mode === 'wrapper') { const real = factory; factory = settings => { const encoder = real(settings); return {
                    addFrame: frame => encoder.addFrame(frame), finish: () => encoder.finish(), dispose: () => encoder.dispose()
                }; }; }
                if (mode === 'proxy') { const real = factory; factory = settings => new Proxy(real(settings), {
                    get(target,key) { const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value; }
                }); }
                assert.deepEqual(await exportFrames(factory, background), expected, mode);
                const worker = RealWorker.instances.at(-1); await worker.exited;
                assert.equal(worker.terminated, 1); assert.equal(worker.node.threadId, -1);
                assert.deepEqual(worker.actions, ['init', ...(['raw','proxy'].includes(mode) ? ['raw-frame-v1', 'raw-frame-v1'] : ['frame', 'frame']), 'finish']);
                assert.equal(worker.transfers, 2);
            }
        }
    } finally { globalThis.Worker = previous; }
});

test('capability is private and optional; unknown versions decline without detaching raw pixels', async () => {
    const previous = globalThis.Worker;
    class FakeWorker extends EventTarget {
        static instance; actions = []; terminated = 0;
        constructor() { super(); FakeWorker.instance = this; }
        postMessage(message, transfer) {
            this.actions.push(message.action);
            const reply = { id: message.id };
            if (message.action === 'init') reply.rawPreparationVersion = 99;
            if (message.action === 'frame') {
                assert([...message.value.data].every((v, i) => i % 4 !== 3 || v === 255));
                structuredClone(message, { transfer });
            }
            if (message.action === 'finish') reply.bytes = new Uint8Array([71, 73, 70, 56, 57, 97]);
            queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: reply })));
        }
        terminate() { this.terminated++; }
    }
    globalThis.Worker = FakeWorker;
    try {
        const encoder = createGifWorkerEncoder()({ repeat: 0 });
        assert.deepEqual(Object.keys(encoder), ['addFrame', 'finish', 'dispose']);
        assert.equal(Object.getOwnPropertyDescriptor(encoder, rawKey).enumerable, false);
        const data = pixelSource().data;
        assert.equal(await encoder[rawKey]({ width: 10, height: 6, data, durationMs: 50 }, [20, 40, 60]), 'declined');
        assert.equal(data.byteLength, 240); assert.equal(data[7], 1); encoder.dispose();
        const gif = createGifExporter({ encoder: createGifWorkerEncoder() });
        await gif.addFrame(pixelSource(), 50); await gif.finish();
        assert.deepEqual(FakeWorker.instance.actions, ['init', 'frame', 'finish']); assert.equal(FakeWorker.instance.terminated, 1);
    } finally { globalThis.Worker = previous; }
});

test('public addFrame hooks on decorated/Proxy worker encoders are preserved',async()=>{
    const previous=globalThis.Worker;globalThis.Worker=RealWorker;
    try{for(const mode of ['decorated','proxy']){
        let called=0;
        const factory=options=>{
            const encoder=createGifWorkerEncoder()(options),original=encoder.addFrame;
            const hook=frame=>{called++;assert([...frame.data].every((v,i)=>i%4!==3||v===255));return original.call(encoder,frame);};
            if(mode==='decorated'){encoder.addFrame=hook;return encoder;}
            return new Proxy(encoder,{get(target,key){return key==='addFrame'?hook:Reflect.get(target,key,target);}});
        };
        await exportFrames(factory,[20,40,60]);assert.equal(called,2);
        const worker=RealWorker.instances.at(-1);await worker.exited;
        assert.deepEqual(worker.actions,['init','frame','frame','finish']);assert.equal(worker.terminated,1);
    }}finally{globalThis.Worker=previous;}
});

test('strict third-party Proxies and inaccessible private properties use the opaque contract',async()=>{
    for(const mode of ['unknown-get','descriptor','private-getter']){
        let submitted=0,disposed=0;
        const target={addFrame(frame){submitted++;assert([...frame.data].every((v,i)=>i%4!==3||v===255));},finish:()=>new Uint8Array([71,73,70,56,57,97]),dispose(){disposed++;}};
        if(mode==='private-getter')Object.defineProperty(target,rawKey,{get(){throw Error('private property inaccessible');}});
        const encoder=new Proxy(target,{
            get(t,key){if(typeof key==='symbol'&&mode==='unknown-get')throw Error('unknown symbol');return Reflect.get(t,key,t);},
            getOwnPropertyDescriptor(t,key){if(typeof key==='symbol'&&mode==='descriptor')throw Error('unknown descriptor');return Reflect.getOwnPropertyDescriptor(t,key);}
        });
        const gif=createGifExporter({encoder:()=>encoder});
        await gif.addFrame(pixelSource(),50);await gif.finish();gif.dispose();
        assert.equal(submitted,1);assert.equal(disposed,1);
    }
});

test('raw handoff cancellation/faults never retry detached buffers and clean listeners/timers', async () => {
    const previous = globalThis.Worker, nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
    const timers = new Set();
    globalThis.setTimeout = (fn, delay, ...args) => { const id = nativeSet(() => { timers.delete(id); fn(...args); }, delay); timers.add(id); return id; };
    globalThis.clearTimeout = id => { timers.delete(id); nativeClear(id); };
    try {
        for (const mode of ['init-abort', 'init-dispose', 'abort', 'dispose', 'malformed', 'error', 'timeout', 'post']) {
            const controller = new AbortController(), events = []; let gif, instance, detached = false;
            const reason = new Error('original abort');
            class FakeWorker extends EventTarget {
                listeners = new Set(); actions = []; terminated = 0;
                constructor() { super(); instance = this; }
                addEventListener(type, listener, opts) { this.listeners.add(listener); return super.addEventListener(type, listener, opts); }
                removeEventListener(type, listener, opts) { this.listeners.delete(listener); return super.removeEventListener(type, listener, opts); }
                postMessage(message, transfer) {
                    this.actions.push(message.action);
                    if (message.action === 'init') {
                        this.init = () => this.dispatchEvent(new MessageEvent('message', { data: { id: message.id, rawPreparationVersion: 1 } }));
                        if (!mode.startsWith('init-')) queueMicrotask(this.init);
                        return;
                    }
                    assert.equal(message.action, 'raw-frame-v1');
                    const rawId=message.id;
                    this.lateRaw=()=>this.dispatchEvent(new MessageEvent('message',{data:{id:rawId,rawFrameEncoded:1}}));
                    structuredClone(message, { transfer }); detached = message.value.data.byteLength === 0;
                    if (mode === 'abort') controller.abort(reason);
                    if (mode === 'dispose') gif.dispose();
                    if (mode === 'post') throw new Error('post failed after handoff');
                    if (mode === 'malformed' || mode === 'error') queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
                        data: { id: message.id, ...(mode === 'error' ? { error: 'worker failed' } : {}) }
                    })));
                }
                terminate() { this.terminated++; }
            }
            globalThis.Worker = FakeWorker;
            gif = createGifExporter({ encoder: createGifWorkerEncoder({ timeoutMs: 25 }), signal: controller.signal, onProgress: e => events.push([e.phase, e.framesEncoded]) });
            const work = gif.addFrame(pixelSource(), 50);
            if (mode.startsWith('init-')) {
                await new Promise(resolve => nativeSet(resolve, 3));
                if (mode === 'init-abort') controller.abort(reason); else gif.dispose();
                instance.init();
            }
            await assert.rejects(work, mode === 'abort' || mode === 'init-abort' ? e => e === reason : undefined);
            gif.dispose(); instance.init(); instance.lateRaw?.(); await new Promise(resolve => nativeSet(resolve, 0));
            assert.equal(instance.terminated, 1); assert.equal(instance.listeners.size, 0); assert.equal(timers.size, 0);
            assert.deepEqual(instance.actions, mode.startsWith('init-') ? ['init'] : ['init', 'raw-frame-v1']);
            assert.equal(detached, !mode.startsWith('init-')); assert.equal(events.length, 1); assert.equal(events[0][1], 0);
        }
    } finally { globalThis.Worker = previous; globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; }
});

test('raw sessions cancel or fail during finalization without leaking pending requests',async()=>{
    const previous=globalThis.Worker;
    try{for(const mode of ['abort','dispose','invalid','error','timeout','post']){
        const controller=new AbortController(),events=[];let gif,worker;
        class FakeWorker extends EventTarget{
            terminated=0;
            constructor(){super();worker=this;}
            postMessage(message,transfer){
                const reply={id:message.id};
                if(message.action==='init')reply.rawPreparationVersion=1;
                if(message.action==='raw-frame-v1'){structuredClone(message,{transfer});reply.rawFrameEncoded=1;}
                if(message.action==='finish'){
                    if(mode==='abort'){controller.abort();return;}
                    if(mode==='dispose'){gif.dispose();return;}
                    if(mode==='timeout')return;
                    if(mode==='post')throw Error('finish post failed');
                    if(mode==='error')reply.error='finish failed';else reply.bytes=null;
                }
                queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:reply})));
            }
            terminate(){this.terminated++;}
        }
        globalThis.Worker=FakeWorker;
        gif=createGifExporter({encoder:createGifWorkerEncoder({timeoutMs:25}),signal:controller.signal,onProgress:p=>events.push([p.phase,p.framesEncoded])});
        await gif.addFrame(pixelSource(),50);await assert.rejects(gif.finish());gif.dispose();
        assert.equal(worker.terminated,1);assert.deepEqual(events.slice(0,2),[['encoding',1],['finalizing',1]]);
        assert.deepEqual(events.at(-1),[mode==='abort'?'aborted':mode==='dispose'?'disposed':'failed',1]);
    }}finally{globalThis.Worker=previous;}
});

test('runtime validates raw envelopes and remains compatible with the ordinary opaque frame action', async () => {
    for (const invalid of ['width', 'length', 'duration', 'background', 'subarray', 'shared']) {
        const worker = new NodeWorker(new URL('./fixtures/browser-worker.mjs', import.meta.url), { workerData: String(new URL('../dist/gif-worker-runtime.js', import.meta.url)) });
        let next = 0; const send = (action, value) => new Promise((resolve, reject) => {
            worker.once('message', resolve); worker.once('error', reject); worker.postMessage({ id: ++next, action, value });
        });
        try {
            assert.equal((await send('init', { repeat: 0, maxColors: 16, quality: 'high' })).rawPreparationVersion, 1);
            const frame = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 128]), durationMs: 50, background: [20, 40, 60] };
            if (invalid === 'width') frame.width = 0;
            if (invalid === 'length') frame.data = new Uint8ClampedArray(3);
            if (invalid === 'duration') frame.durationMs = 51;
            if (invalid === 'background') frame.background = [0, 0, 256];
            if (invalid === 'subarray') frame.data = new Uint8ClampedArray(8).subarray(4);
            if (invalid === 'shared') frame.data = new Uint8ClampedArray(new SharedArrayBuffer(4));
            assert.match((await send('raw-frame-v1', frame)).error, /Invalid GIF raw/);
            assert.match((await send('frame', { ...frame, data: new Uint8ClampedArray(4) })).error, /not initialized/);
        } finally { await worker.terminate(); }
    }
});
