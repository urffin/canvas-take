// Private external-output controller. No package entry point.
import {blendRange} from './rgba.js';
import type {
    Awaitable, Support, VideoEncodeConfig, AudioEncodeConfig, VideoDescription, AudioDescription,
    CodecEvent, Track, OfflineVideoEncoder, OfflineAudioEncoder, OfflineVideoProgress,
    MuxerConfig, FrameTiming, TimelineSummary
} from '../video.js';
import type {
    ExternalVideoOptions, ExternalVideoContainer, ExternalVideoExporter, ExternalVideoResult,
    ExternalVideoOutput, ExternalVideoOutputPhase, ExternalVideoTransaction, ExternalVideoMuxer,
    ExternalVideoCleanupIssue, ExternalVideoCloseReport, ExternalVideoDestinationRequest
} from './video-external-types.js';

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
function integer(value: number, name: string, minimum = 0): number {
    if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
    return value;
}
function text(value: string, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} must be a nonempty string`);
    return value;
}
function rounded(value: number, multiplier: number, divisor: number): number {
    const n = (BigInt(value) * BigInt(multiplier) * 2n + BigInt(divisor)) / (BigInt(divisor) * 2n);
    return integer(Number(n), 'sample/timestamp arithmetic');
}
function snapshot<Value, C extends ExternalVideoContainer>(options: ExternalVideoOptions<Value,C>) {
    const limits = {
        maxFramePixels: options.maxFramePixels, maxFrames: options.maxFrames, maxDurationUs: options.maxDurationUs,
        maxAudioInputBytes: options.maxAudioInputBytes, maxOutputBytes: options.maxOutputBytes,
        maxPendingInputs: options.maxPendingInputs === undefined ? 4 : options.maxPendingInputs,
        maxPendingBytes: options.maxPendingBytes === undefined ? 16 * 1024 * 1024 : options.maxPendingBytes
    };
    for (const [name, value] of Object.entries(limits)) if (value !== undefined) integer(value, name, 1);
    if (options.totalFrames !== undefined) integer(options.totalFrames, 'totalFrames', 1);
    const v = options.video.config;
    const videoConfig: VideoEncodeConfig = Object.freeze({ codec: text(v.codec, 'video.codec'), bitstreamFormat: text(v.bitstreamFormat, 'video.bitstreamFormat'),
        width: integer(v.width, 'width', 1), height: integer(v.height, 'height', 1), bitrate: integer(v.bitrate, 'video.bitrate', 1),
        ...(v.frameRateHint === undefined ? {} : { frameRateHint: Object.freeze({ numerator: integer(v.frameRateHint.numerator, 'frameRateHint.numerator', 1), denominator: integer(v.frameRateHint.denominator, 'frameRateHint.denominator', 1) }) }) });
    integer(v.width * v.height * 4, 'frame byte size', 1);
    const background = [...(options.background ?? [255, 255, 255])];
    if (background.length !== 3 || background.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new RangeError('background must contain three RGB bytes');
    const format = Object.freeze({ mimeType: text(options.muxer.format.mimeType, 'mimeType').trim().toLowerCase(), extension: text(options.muxer.format.extension, 'extension') });
    if (!format.mimeType.startsWith('video/')) throw new TypeError('muxer MIME must be video/*');
    let audioConfig: AudioEncodeConfig | undefined, planes: Float32Array[] = [], sourceLength = 0;
    const a = options.audio;
    if (a) {
        if (a.endPolicy !== 'error' && a.endPolicy !== 'trim-or-pad') throw new TypeError('audio.endPolicy must be error or trim-or-pad');
        audioConfig = Object.freeze({ codec: text(a.config.codec, 'audio.codec'), bitstreamFormat: text(a.config.bitstreamFormat, 'audio.bitstreamFormat'),
            sampleRate: integer(a.config.sampleRate, 'sampleRate', 1), numberOfChannels: integer(a.config.numberOfChannels, 'numberOfChannels', 1), bitrate: integer(a.config.bitrate, 'audio.bitrate', 1) });
        if (a.source.sampleRate !== audioConfig.sampleRate || a.source.channels.length !== audioConfig.numberOfChannels) throw new RangeError('PCM configuration mismatch');
        sourceLength = integer(a.source.channels[0]?.length, 'PCM sample count', 1);
        const bytes = integer(sourceLength * audioConfig.numberOfChannels * 4, 'PCM byte size', 1);
        if (limits.maxAudioInputBytes !== undefined && bytes > limits.maxAudioInputBytes) throw new RangeError('maxAudioInputBytes exceeded');
        for (const plane of a.source.channels) {
            if (!(plane instanceof Float32Array) || !(plane.buffer instanceof ArrayBuffer) || plane.length !== sourceLength) throw new TypeError('PCM channels must be equal-length nonshared Float32Arrays');
            if (plane.some(sample => !Number.isFinite(sample) || sample < -1 || sample > 1)) throw new RangeError('PCM samples must be finite in [-1, 1]');
        }
        if (audioConfig.numberOfChannels * 4 > limits.maxPendingBytes) throw new RangeError('maxPendingBytes cannot hold one audio sample');
        planes = a.source.channels.map(plane => new Float32Array(plane));
    }
    return { limits: Object.freeze(limits), videoConfig, audioConfig, planes, sourceLength, background,
        videoFactory: options.video.encoder, audioFactory: a?.encoder, audioPolicy: a?.endPolicy,
        muxerFactory: options.muxer, format, signal: options.signal, onProgress: options.onProgress, totalFrames: options.totalFrames };
}



const claimed = new WeakSet<object>();
const object = (value: unknown): value is Record<string, unknown> => value !== null && (typeof value === 'object' || typeof value === 'function');
const methods = (value: unknown, names: readonly string[]) => object(value) && names.every(name => typeof value[name] === 'function');

export function createExternalVideoExporter<Value, C extends ExternalVideoContainer>(options: ExternalVideoOptions<Value,C>): ExternalVideoExporter<Value,C> {
    if (!object(options)) throw new TypeError('External video options required');
    if (options.signal?.aborted) throw options.signal.reason;
    if (!methods(options.muxer,['checkSupport','create']) || options.muxer.outputKind !== 'external') throw new TypeError('External muxer factory required');
    const format = options.muxer.format;
    if (!format || !((format.mimeType==='video/mp4' && format.extension==='mp4') || (format.mimeType==='video/webm' && format.extension==='webm'))) throw new TypeError('External MP4/WebM format required');
    if (!methods(options.destination,['checkSupport','create']) || options.destination.kind!=='positioned-transactional') throw new TypeError('Positioned transactional destination required');
    if (!methods(options.video?.encoder,['checkSupport','create']) || (options.audio && !methods(options.audio.encoder,['checkSupport','create']))) throw new TypeError('Encoder factories required');
    const ifExists=options.ifExists===undefined?'error':options.ifExists;
    if (ifExists!=='error' && ifExists!=='replace') throw new TypeError('ifExists must be error or replace');
    const cfg=snapshot(options), destination=options.destination;
    const ready=deferred<void>(), closed=deferred<ExternalVideoCloseReport<Value,C>>(), cancelled=deferred<never>();
    const controller=new AbortController(), workAbort=new AbortController();
    let state: ExternalVideoExporter<Value,C>['state']='initializing', outputPhase:ExternalVideoOutputPhase='waiting';
    let hasFailure=false, failure:unknown, admitted=false, disposeRequested=false, settling=false, sealed=false, acceptingWrites=true;
    let publication:'committed'|'not-committed'|'indeterminate'='not-committed', recovery:unknown, hasRecovery=false;
    let transaction:ExternalVideoTransaction<Value>|undefined, muxer:ExternalVideoMuxer<C>|undefined;
    let video:OfflineVideoEncoder|undefined, audio:OfflineAudioEncoder|undefined;
    let receipt:ExternalVideoOutput<Value,C>|undefined, finishDone:ReturnType<typeof deferred<ExternalVideoResult<Value,C>>>|undefined;
    const tasks=new Set<Promise<unknown>>(), io=new Set<Promise<unknown>>();
    type Resource={instance:{dispose():Awaitable<void>};operation:'muxer.dispose'|'encoder.dispose';disposed:boolean};
    const owned:Resource[]=[], issues:ExternalVideoCleanupIssue[]=[];
    let frames=0,submittedFrames=0,duration=0,samples=0,videoPackets=0,audioPackets=0,encodedBytes=0;
    let videoSeen=0,videoOutputEnd=0,audioOutputStart:number|undefined,audioOutputEnd:number|undefined;
    let queuedBytes=0,draining=false,inFlight:Pending|undefined,size=0,busy=false;
    const expectedVideo=new Map<number,number>();
    type Pending={event:CodecEvent;bytes:number;cost:number;done:ReturnType<typeof deferred<void>>};
    const queue:Pending[]=[], idle=new Set<ReturnType<typeof deferred<void>>>();
    const tracks={video:{config:undefined as VideoDescription|AudioDescription|undefined,ended:false,flushing:false},audio:{config:undefined as VideoDescription|AudioDescription|undefined,ended:false,flushing:false}};
    const terminal=()=>hasFailure||state==='finished'||state==='disposed';
    const guard=()=>{if(hasFailure)throw failure;if(state==='finished'||state==='disposed')throw new Error('External exporter is '+state);};
    function observe<T>(promise:Promise<T>):Promise<T>{tasks.add(promise);void promise.then(()=>tasks.delete(promise),()=>tasks.delete(promise));return promise;}
    function call<T>(work:()=>Awaitable<T>):Promise<T>{return observe(Promise.resolve().then(work));}
    async function wait<T>(promise:Awaitable<T>):Promise<T>{const value=await Promise.race([Promise.resolve(promise),cancelled.promise]);guard();return value;}
    function issue(operation:ExternalVideoCleanupIssue['operation'],reason:unknown):void{if(outputPhase!=='settled')issues.push(Object.freeze({operation,reason}));}
    function report(phase:OfflineVideoProgress['phase'],outputBytes?:number):void{
        try{cfg.onProgress?.(Object.freeze({phase,framesAccepted:frames,durationUs:duration,audioSamplesAccepted:samples,videoPacketsWritten:videoPackets,audioPacketsWritten:audioPackets,encodedBytes,
            ...(cfg.totalFrames===undefined?{}:{totalFrames:cfg.totalFrames}),...(outputBytes===undefined?{}:{outputBytes})}));}catch{}
    }
    function disposeResource(resource:Resource):void{
        if(resource.disposed)return;resource.disposed=true;
        void call(async()=>{try{await resource.instance.dispose();}catch(error){issue(resource.operation,error);}});
    }
    function releaseOwned():void{for(const resource of owned)disposeResource(resource);}
    function stop(next:'failed'|'aborted'|'disposed',reason:unknown):void{
        if(admitted||terminal())return;
        hasFailure=true;failure=reason;state=next;sealed=true;acceptingWrites=false;ready.reject(reason);cancelled.reject(reason);finishDone?.reject(reason);
        controller.abort(reason);workAbort.abort(reason);
        inFlight?.done.reject(reason);for(const item of queue.splice(0))item.done.reject(reason);
        for(const pending of idle)pending.reject(reason);idle.clear();queuedBytes=0;
        releaseOwned();report(next);settle();
    }
    function onAbort():void{if(!admitted)stop('aborted',cfg.signal!.reason);}
    function settle():void{
        if(settling)return;settling=true;outputPhase='settling';cfg.signal?.removeEventListener('abort',onAbort);releaseOwned();
        void (async()=>{
            // Disposal runs before waiting: it must unblock tracked native/writer operations.
            while(tasks.size)await Promise.allSettled([...tasks]);
            if(transaction){
                if(publication==='not-committed')try{await transaction.abort(failure);}catch(error){issue('destination.abort',error);}
                try{await transaction.release(Object.freeze({publication}));}catch(error){issue('destination.release',error);}
            }
            cfg.planes.length=0;expectedVideo.clear();tracks.video.config=tracks.audio.config=undefined;
            muxer=undefined;video=undefined;audio=undefined;transaction=undefined;owned.length=0;
            const cleanupIssues=Object.freeze([...issues]);outputPhase='settled';
            if(publication==='committed')closed.resolve(Object.freeze({publication,output:receipt!,cleanupIssues}));
            else if(publication==='indeterminate')closed.resolve(Object.freeze({publication,reason:failure,...(hasRecovery?{recovery}:{}),cleanupIssues}));
            else closed.resolve(Object.freeze({publication,reason:failure,cleanupIssues}));
        })().catch(error=>{issue('protocol',error);outputPhase='settled';const cleanupIssues=Object.freeze([...issues]);
            if(publication==='committed')closed.resolve(Object.freeze({publication,output:receipt!,cleanupIssues}));
            else closed.resolve(Object.freeze({publication,reason:hasFailure?failure:error,...(hasRecovery?{recovery}:{}),cleanupIssues}));
        });
    }
    const protocol=(message:string)=>new Error('External video protocol: '+message);
    const wrap=(component:string,error:unknown)=>new Error(component+' failed',{cause:error});
    async function invoke<T>(component:string,work:()=>Awaitable<T>):Promise<T>{
        try{return await wait(call(()=>{guard();return work();}));}catch(error){if(hasFailure)throw failure;throw wrap(component,error);}
    }
    async function acquire<T extends {dispose():Awaitable<void>}>(operation:Resource['operation'],names:readonly string[],create:()=>Awaitable<T>):Promise<T>{
        return wait(call(async()=>{
            guard();const instance=await create();
            if(!object(instance)||claimed.has(instance))throw protocol('factory must return a fresh owned instance');
            claimed.add(instance);
            if(typeof instance.dispose==='function'){
                const resource:Resource={instance,operation,disposed:false};owned.push(resource);if(terminal())disposeResource(resource);
            }
            if(!methods(instance,['dispose',...names]))throw protocol('acquired instance has missing methods');
            return instance;
        }));
    }
    async function support(name:string,check:()=>Awaitable<Support>):Promise<void>{
        const value=await wait(call(()=>{guard();return check();}));
        if(!value||typeof value.supported!=='boolean'||(!value.supported&&typeof value.reason!=='string'))throw protocol(name+' invalid support result');
        if(!value.supported)throw new DOMException(name+' unsupported: '+value.reason,'NotSupportedError');
    }
    function outputError(reason:unknown):void{if(admitted){issue('protocol',reason);return;}stop('failed',reason);}
    const output=Object.freeze({
        get size(){return size;},
        writeAt(position:number,input:Uint8Array):Promise<void>{
            try{
                guard();if(sealed||!acceptingWrites)throw protocol('output is sealed');if(busy)throw protocol('overlapping positioned writes');
                if(!Number.isSafeInteger(position)||position<0||!(input instanceof Uint8Array)||!(input.buffer instanceof ArrayBuffer))throw new TypeError('Invalid positioned write');
                const end=integer(position+input.byteLength,'write endpoint');
                if(input.byteLength>cfg.limits.maxPendingBytes)throw new RangeError('maxPendingBytes write limit exceeded');
                if(cfg.limits.maxOutputBytes!==undefined&&end>cfg.limits.maxOutputBytes)throw new RangeError('maxOutputBytes exceeded');
                // The base constructor validates even detached empty views and avoids species/slice overrides.
                let data:Uint8Array<ArrayBuffer>|undefined=new Uint8Array(input);
                if(!data.byteLength)return Promise.resolve();
                busy=true;
                const physical=call(async()=>{
                    try{
                        guard();await call(()=>{guard();return transaction!.ready?.(workAbort.signal);});guard();
                        await call(()=>{guard();return transaction!.writeAt(position,data!,workAbort.signal);});guard();size=Math.max(size,end);
                    }finally{data=undefined;busy=false;}
                });
                io.add(physical);void physical.then(()=>io.delete(physical),error=>{io.delete(physical);outputError(error);});
                const logical=wait(physical);void logical.catch(()=>{});return logical;
            }catch(error){outputError(error);const rejected=Promise.reject(error);void rejected.catch(()=>{});return rejected;}
        },
        fail:outputError
    });

    function sameConfig(a: VideoDescription | AudioDescription, b: VideoDescription | AudioDescription): boolean {
        const { description: ad, ...ar } = a, { description: bd, ...br } = b;
        return JSON.stringify(ar) === JSON.stringify(br) && (ad === undefined ? bd === undefined : bd !== undefined && ad.length === bd.length && ad.every((n, i) => n === bd[i]));
    }
    function cloneEvent(track: Track, event: CodecEvent): { event: CodecEvent; bytes: number } {
        const t = tracks[track];
        const actualTrack = event.type === 'packet' ? event.packet.track : event.track;
        if (track !== actualTrack || t.ended) throw protocol('wrong track or output after end');
        if (event.type === 'config') {
            const c = event.config, expected = track === 'video' ? cfg.videoConfig : cfg.audioConfig!;
            if (c.codec !== expected.codec || c.bitstreamFormat !== expected.bitstreamFormat) throw protocol('codec/framing mismatch');
            if (c.description !== undefined && (!(c.description instanceof Uint8Array) || !(c.description.buffer instanceof ArrayBuffer))) throw protocol('invalid decoder description bytes');
            let copy: CodecEvent;
            if (track === 'video') {
                const v = c as VideoDescription;
                if (v.width !== cfg.videoConfig.width || v.height !== cfg.videoConfig.height || !v.color ||
                    [v.color.primaries, v.color.transfer, v.color.matrix].some(value => typeof value !== 'string' || !value) || typeof v.color.fullRange !== 'boolean') throw protocol('video description mismatch');
                copy = { type: 'config', track: 'video', config: { codec: c.codec, bitstreamFormat: c.bitstreamFormat,
                    width: v.width, height: v.height, color: Object.freeze({ primaries: v.color.primaries, transfer: v.color.transfer, matrix: v.color.matrix, fullRange: v.color.fullRange }), ...(c.description === undefined ? {} : { description: new Uint8Array(c.description) }) } };
            } else {
                const a = c as AudioDescription;
                if (a.sampleRate !== cfg.audioConfig!.sampleRate || a.numberOfChannels !== cfg.audioConfig!.numberOfChannels) throw protocol('audio description mismatch');
                copy = { type: 'config', track: 'audio', config: { codec: c.codec, bitstreamFormat: c.bitstreamFormat,
                    sampleRate: a.sampleRate, numberOfChannels: a.numberOfChannels, ...(c.description === undefined ? {} : { description: new Uint8Array(c.description) }) } };
            }
            if (t.config && !sameConfig(t.config, copy.config)) throw protocol('midstream configuration change');
            t.config = copy.config;
            return { event: copy, bytes: copy.config.description?.byteLength ?? 0 };
        }
        if (!t.config) throw protocol('output before decoder config');
        if (event.type === 'packet') {
            const p = event.packet;
            if (!Number.isSafeInteger(p.timestampUs) || !Number.isSafeInteger(p.decodeTimestampUs) || p.decodeTimestampUs !== p.timestampUs) throw protocol('invalid/reordered timestamps');
            integer(p.durationUs, 'packet durationUs', 1); integer(p.timestampUs + p.durationUs, 'packet end', -Number.MAX_SAFE_INTEGER);
            if (!(p.data instanceof Uint8Array) || !(p.data.buffer instanceof ArrayBuffer) || !p.data.byteLength || !['key', 'delta'].includes(p.type)) throw protocol('invalid packet');
            if (track === 'video') {
                if (p.timestampUs !== videoOutputEnd || expectedVideo.get(p.timestampUs) !== p.durationUs || (!videoSeen && p.type !== 'key')) throw protocol('missing, duplicated, reordered or non-key first video frame');
                expectedVideo.delete(p.timestampUs); videoOutputEnd += p.durationUs; videoSeen++;
            } else {
                if (audioOutputEnd !== undefined && p.timestampUs !== audioOutputEnd) throw protocol('noncontiguous audio packets');
                audioOutputStart ??= p.timestampUs; audioOutputEnd = p.timestampUs + p.durationUs;
            }
            return { event: { type: 'packet', packet: Object.freeze({ ...p, data: new Uint8Array(p.data) }) }, bytes: p.data.byteLength };
        }
        if (event.type !== 'end' || !t.flushing) throw protocol('track ended outside flush');
        if (track === 'video') {
            if (expectedVideo.size || videoSeen !== submittedFrames) throw protocol('video frames missing at end');
        } else {
            if (event.track !== 'audio') throw protocol('invalid audio end');
            integer(event.presentationSamples, 'presentationSamples'); integer(event.leadingDiscardSamples, 'leadingDiscardSamples'); integer(event.trailingDiscardSamples, 'trailingDiscardSamples');
            if (event.presentationSamples !== samples) throw protocol('audio presentation count mismatch');
            const endSamples = integer(samples + event.trailingDiscardSamples, 'audio sample end');
            integer(endSamples + event.leadingDiscardSamples, 'audio total samples');
            const first = -rounded(event.leadingDiscardSamples, 1_000_000, cfg.audioConfig!.sampleRate);
            const last = rounded(endSamples, 1_000_000, cfg.audioConfig!.sampleRate);
            if (audioOutputStart === undefined || audioOutputEnd === undefined || Math.abs(audioOutputStart - first) > 1 || Math.abs(audioOutputEnd - last) > 1) throw protocol('audio packets do not match declared trimming');
        }
        t.ended = true;
        return { event: Object.freeze({ ...event }), bytes: 0 };
    }


    async function drain():Promise<void>{
        if(draining)return;draining=true;
        try{while(queue.length&&!terminal()){
            const item=inFlight=queue.shift()!;
            try{await invoke('muxer.write',()=>muxer!.write(item.event));}
            catch(error){if(!terminal())stop('failed',error);item.done.reject(failure);break;}
            queuedBytes-=item.cost;if(item.event.type==='packet'){if(item.event.packet.track==='video')videoPackets++;else audioPackets++;encodedBytes+=item.bytes;}
            item.done.resolve();inFlight=undefined;report(state==='initializing'?'initializing':state==='finalizing'?'finalizing':'encoding');
        }}finally{draining=false;inFlight=undefined;if(!queue.length){for(const pending of idle)pending.resolve();idle.clear();}}
    }
    function sink(track:Track){return Object.freeze({
        write(event:CodecEvent):Promise<void>{const done=deferred<void>();try{
            guard();const bytes=event.type==='packet'?event.packet.data.byteLength:event.type==='config'?event.config.description?.byteLength??0:0,cost=bytes+64;
            if(cost>cfg.limits.maxPendingBytes-queuedBytes)throw new RangeError('maxPendingBytes exceeded');
            const copy=cloneEvent(track,event);queuedBytes+=cost;queue.push({...copy,cost,done});void drain();
        }catch(error){if(!terminal())stop('failed',error);done.reject(hasFailure?failure:error);}return done.promise;},
        fail(reason:unknown){if(!terminal())stop('failed',wrap(track+' encoder',reason));}
    });}
    async function queueIdle():Promise<void>{if(!draining&&!queue.length)return;const pending=deferred<void>();idle.add(pending);await wait(pending.promise);}

    async function feedAudio(target: number): Promise<void> {
        if (!audio || !cfg.audioConfig) return;
        const channels = cfg.audioConfig.numberOfChannels, rate = cfg.audioConfig.sampleRate;
        const blockSize = Math.min(2048, Math.floor(cfg.limits.maxPendingBytes / (channels * 4)));
        let blocks = 0;
        while (samples < target) {
            guard();
            const size = Math.min(blockSize, target - samples), offset = samples;
            const channelsData = cfg.planes.map(plane => {
                const data = new Float32Array(size);
                if (offset < cfg.sourceLength) data.set(plane.subarray(offset, Math.min(offset + size, cfg.sourceLength)));
                return data;
            });
            await invoke('audio encoder.encodeAudio', () => audio!.encodeAudio(Object.freeze({ sampleRate: rate, sampleOffset: offset, timestampUs: rounded(offset, 1_000_000, rate), channels: channelsData })));
            samples += size;
            if (++blocks % 8 === 0) await wait(new Promise<void>(resolve => setTimeout(resolve, 0)));
        }
    }


    async function initialize():Promise<void>{
        try{
            guard();report('initializing');guard();
            const config:MuxerConfig=Object.freeze({video:cfg.videoConfig,...(cfg.audioConfig?{audio:cfg.audioConfig}:{})});
            const request=Object.freeze({format:cfg.format,ifExists,maxWriteBytes:cfg.limits.maxPendingBytes,...(cfg.limits.maxOutputBytes===undefined?{}:{maxOutputBytes:cfg.limits.maxOutputBytes})}) as ExternalVideoDestinationRequest;
            await support('video',()=>cfg.videoFactory.checkSupport(cfg.videoConfig));
            if(cfg.audioConfig)await support('audio',()=>cfg.audioFactory!.checkSupport(cfg.audioConfig!));
            await support('muxer',()=>cfg.muxerFactory.checkSupport(config));await support('destination',()=>destination.checkSupport(request));
            await wait(call(async()=>{
                guard();const instance=await destination.create(Object.freeze({...request,signal:workAbort.signal}));
                if(!object(instance)||claimed.has(instance))throw protocol('destination must return a fresh transaction');
                claimed.add(instance);transaction=instance;
                if(!methods(instance,['writeAt','truncate','commit','abort','release'])||(instance.ready!==undefined&&typeof instance.ready!=='function'))throw protocol('transaction missing methods');
            }));
            const context=Object.freeze({signal:controller.signal,maxPendingInputs:cfg.limits.maxPendingInputs,maxPendingBytes:cfg.limits.maxPendingBytes,...(cfg.limits.maxOutputBytes===undefined?{}:{maxOutputBytes:cfg.limits.maxOutputBytes})});
            muxer=await acquire('muxer.dispose',['write','finalize'],()=>cfg.muxerFactory.create(config,Object.freeze({...context,output}))) as ExternalVideoMuxer<C>;
            video=await acquire('encoder.dispose',['encodeFrame','flush'],()=>cfg.videoFactory.create(cfg.videoConfig,Object.freeze({...context,output:sink('video')})));
            if(cfg.audioConfig)audio=await acquire('encoder.dispose',['encodeAudio','flush'],()=>cfg.audioFactory!.create(cfg.audioConfig!,Object.freeze({...context,output:sink('audio')})));
            await queueIdle();guard();outputPhase='writing';state='ready';ready.resolve();
        }catch(error){if(!terminal())stop('failed',error);}
    }
    const exporter:ExternalVideoExporter<Value,C>=Object.freeze({
        get state(){return state;},get outputPhase(){return outputPhase;},ready:ready.promise,closed:closed.promise,
        addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, timing: FrameTiming): Promise<void> {
            if (state !== 'ready') return Promise.reject(hasFailure ? failure : new Error(`Cannot addFrame in ${state} state`));
            state = 'encoding';
            return observe((async () => {
                try {
                    const timestampUs = integer(timing.timestampUs, 'timestampUs'), frameDuration = integer(timing.durationUs, 'durationUs', 1);
                    const endUs = integer(timestampUs + frameDuration, 'frame end');
                    if (timestampUs !== duration) throw new RangeError('Frame timeline must start at zero and remain contiguous');
                    if (timing.keyFrame !== undefined && typeof timing.keyFrame !== 'boolean') throw new TypeError('keyFrame must be boolean');
                    const keyFrame = timing.keyFrame === true;
                    if (canvas.width !== cfg.videoConfig.width || canvas.height !== cfg.videoConfig.height) throw new RangeError('Canvas dimensions must match video configuration');
                    const pixels = cfg.videoConfig.width * cfg.videoConfig.height;
                    if (cfg.limits.maxFramePixels !== undefined && pixels > cfg.limits.maxFramePixels) throw new RangeError('maxFramePixels exceeded');
                    if (cfg.limits.maxFrames !== undefined && frames >= cfg.limits.maxFrames) throw new RangeError('maxFrames exceeded');
                    if (cfg.limits.maxDurationUs !== undefined && endUs > cfg.limits.maxDurationUs) throw new RangeError('maxDurationUs exceeded');
                    if (expectedVideo.size >= cfg.limits.maxPendingInputs) throw new RangeError('maxPendingInputs video look-ahead exceeded');
                    if (pixels * 4 > cfg.limits.maxPendingBytes) throw new RangeError('maxPendingBytes cannot hold the frame snapshot');
                    const audioTarget = cfg.audioConfig ? rounded(endUs, cfg.audioConfig.sampleRate, 1_000_000) : 0;
                    if (cfg.audioPolicy === 'error' && audioTarget > cfg.sourceLength) throw new RangeError('Prepared audio is shorter than the video timeline');
                    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
                    if (!ctx) throw new TypeError('Offline video requires a 2D canvas');
                    const data = new Uint8ClampedArray(ctx.getImageData(0, 0, canvas.width, canvas.height, { colorSpace: 'srgb' }).data);
                    if (data.length !== pixels * 4) throw new RangeError('Invalid frame pixel data');
                    blendRange(data, 0, pixels, cfg.background);
                    await wait(new Promise<void>(resolve => setTimeout(resolve, 0)));
                    expectedVideo.set(timestampUs, frameDuration); submittedFrames++;
                    await invoke('video encoder.encodeFrame', () => video!.encodeFrame(Object.freeze({ width: cfg.videoConfig.width, height: cfg.videoConfig.height, data,
                        timestampUs, durationUs: frameDuration, keyFrame: frames === 0 || keyFrame })));
                    await feedAudio(audioTarget); guard();
                    frames++; duration = endUs; report('encoding'); guard(); state = 'ready';
                } catch (error) { if (!terminal()) stop('failed', error); throw hasFailure ? failure : error; }
            })());
        },

        finish():Promise<ExternalVideoResult<Value,C>>{
            if(finishDone)return finishDone.promise;
            if(state!=='ready')return Promise.reject(hasFailure?failure:new Error('Cannot finish in '+state));
            state='finalizing';finishDone=deferred<ExternalVideoResult<Value,C>>();
            void call(async()=>{
                try{
                    if(!frames)throw new RangeError('Offline video requires at least one frame');
                    if(cfg.audioConfig&&(!samples||(cfg.audioPolicy==='error'&&samples!==cfg.sourceLength)))throw new RangeError('Audio presentation/source count mismatch');
                    report('finalizing');guard();tracks.video.flushing=true;if(audio)tracks.audio.flushing=true;
                    await wait(Promise.all([invoke('video encoder.flush',()=>video!.flush()),...(audio?[invoke('audio encoder.flush',()=>audio!.flush())]:[])]));
                    await queueIdle();guard();if(!tracks.video.ended||(cfg.audioConfig&&!tracks.audio.ended))throw protocol('flush missing track end');
                    const timeline=Object.freeze({durationUs:duration,videoFrames:frames,...(cfg.audioConfig?{audioPresentationSamples:samples}:{})});
                    const container=await invoke('muxer.finalize',()=>muxer!.finalize(timeline));acceptingWrites=false;
                    await wait(Promise.all([...io]));guard();sealed=true;
                    if(!container||container.kind!=='external-container'||container.mimeType!==cfg.format.mimeType||!Number.isSafeInteger(container.size)||container.size!==size||!size)throw protocol('invalid container size/MIME');
                    await wait(call(()=>{guard();return transaction!.truncate(size,workAbort.signal);}));guard();
                    // Admission and invocation are one synchronous turn. No cancellation race after this point.
                    admitted=true;publication='indeterminate';outputPhase='committing';report('finalizing');
                    const outcome:unknown=await observe(Promise.resolve(transaction!.commit()));
                    if(!object(outcome))throw protocol('malformed commit outcome');
                    const status=outcome.status;
                    if(status==='committed'&&Object.prototype.hasOwnProperty.call(outcome,'value')){
                        const value=outcome.value;
                        if(value===transaction||owned.some(resource=>resource.instance===value))throw protocol('commit returned a session-owned resource');
                        publication='committed';receipt=Object.freeze({kind:'external',mimeType:cfg.format.mimeType,size,value}) as ExternalVideoOutput<Value,C>;
                        // C's format pair was checked synchronously and snapshotted before initialization.
                        const result=Object.freeze({...timeline,...cfg.format,output:receipt,videoCodec:cfg.videoConfig.codec,...(cfg.audioConfig?{audioCodec:cfg.audioConfig.codec}:{})}) as unknown as ExternalVideoResult<Value,C>;
                        state='finished';finishDone!.resolve(result);report('finished',size);
                    }else if((status==='not-committed'||status==='indeterminate')&&Object.prototype.hasOwnProperty.call(outcome,'reason')){
                        // Read untrusted fields before changing the conservative classification.
                        const reason=outcome.reason,includeRecovery=status==='indeterminate'&&Object.prototype.hasOwnProperty.call(outcome,'recovery');
                        const recoveryValue=includeRecovery?outcome.recovery:undefined;
                        publication=status;hasFailure=true;failure=reason;
                        if(includeRecovery){hasRecovery=true;recovery=recoveryValue;}
                        state='failed';finishDone!.reject(failure);report('failed');
                    }else throw protocol('malformed commit outcome');
                }catch(error){
                    if(!admitted){if(!terminal())stop('failed',error);}
                    else{hasFailure=true;failure=error;state='failed';finishDone!.reject(error);report('failed');}
                }finally{
                    if(admitted){if(disposeRequested)state='disposed';settle();}
                }
            });return finishDone.promise;
        },
        dispose():void{
            if(admitted&&state==='finalizing'){disposeRequested=true;return;}
            if(!terminal())stop('disposed',new DOMException('External exporter disposed','AbortError'));
            else state='disposed';
        }
    });
    cfg.signal?.addEventListener('abort',onAbort,{once:true});if(cfg.signal?.aborted)onAbort();
    observe(Promise.resolve().then(initialize));return exporter;
}
