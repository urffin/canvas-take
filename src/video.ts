/** Adapter-neutral offline video contracts. Concrete codecs and containers are supplied by the caller. */
export type Awaitable<T> = T | Promise<T>;
export type Support = { readonly supported: true } | { readonly supported: false; readonly reason: string };
export type Track = 'video' | 'audio';

export interface VideoEncodeConfig {
    readonly codec: string;
    readonly bitstreamFormat: string;
    readonly width: number;
    readonly height: number;
    readonly bitrate: number;
    /** Encoder hint only. Timing always comes from submitted frame intervals. */
    readonly frameRateHint?: { readonly numerator: number; readonly denominator: number };
}
export interface AudioEncodeConfig {
    readonly codec: string;
    readonly bitstreamFormat: string;
    readonly sampleRate: number;
    readonly numberOfChannels: number;
    readonly bitrate: number;
}
export interface FrameTiming {
    readonly timestampUs: number;
    readonly durationUs: number;
    readonly keyFrame?: boolean;
}
export interface RawVideoFrame extends FrameTiming {
    readonly width: number;
    readonly height: number;
    /** Exclusively owned opaque sRGB RGBA8 snapshot. */
    readonly data: Uint8ClampedArray;
}
export interface PreparedAudio {
    readonly sampleRate: number;
    /** Equal-length planar float32 channels, copied before asynchronous initialization. */
    readonly channels: readonly Float32Array[];
}
export interface RawAudioBlock {
    readonly sampleRate: number;
    readonly sampleOffset: number;
    readonly timestampUs: number;
    /** Exclusively owned block buffers; never aliases the retained source. */
    readonly channels: readonly Float32Array[];
}
export interface DecoderDescription {
    readonly codec: string;
    readonly bitstreamFormat: string;
    readonly description?: Uint8Array;
}
export interface VideoDescription extends DecoderDescription {
    readonly width: number;
    readonly height: number;
    readonly color: {
        readonly primaries: string;
        readonly transfer: string;
        readonly matrix: string;
        readonly fullRange: boolean;
    };
}
export interface AudioDescription extends DecoderDescription {
    readonly sampleRate: number;
    readonly numberOfChannels: number;
}
export interface EncodedPacket {
    readonly track: Track;
    /** Signed codec timestamps; presentation after trimming starts at zero. */
    readonly timestampUs: number;
    readonly decodeTimestampUs: number;
    readonly durationUs: number;
    readonly type: 'key' | 'delta';
    readonly data: Uint8Array;
}
export type CodecEvent =
    | { readonly type: 'config'; readonly track: 'video'; readonly config: VideoDescription }
    | { readonly type: 'config'; readonly track: 'audio'; readonly config: AudioDescription }
    | { readonly type: 'packet'; readonly packet: EncodedPacket }
    | { readonly type: 'end'; readonly track: 'video' }
    | { readonly type: 'end'; readonly track: 'audio'; readonly presentationSamples: number;
        readonly leadingDiscardSamples: number; readonly trailingDiscardSamples: number };

export interface CodecOutputSink {
    /** Ordered per track. Promise settles after muxer consumption; bytes are borrowed until then. */
    write(event: CodecEvent): Promise<void>;
    /** Report a delayed callback/worker failure even when no encode call is pending. */
    fail(error: unknown): void;
}
export interface SessionContext {
    readonly signal: AbortSignal;
    /** Adapter input bound; also caps video intervals awaiting packets in the controller. */
    readonly maxPendingInputs: number;
    /** Work-byte budget; the controller reserves 64 additional bytes per queued event. */
    readonly maxPendingBytes: number;
}
export interface EncoderContext extends SessionContext {
    readonly output: CodecOutputSink;
}
export interface MuxerContext extends SessionContext {
    readonly maxOutputBytes?: number;
}
export interface OfflineVideoEncoder {
    encodeFrame(frame: RawVideoFrame): Promise<void>;
    /** Emits end after all delayed packets and waits for all output writes. */
    flush(): Promise<void>;
    dispose(): void;
}
export interface OfflineAudioEncoder {
    encodeAudio(block: RawAudioBlock): Promise<void>;
    flush(): Promise<void>;
    dispose(): void;
}
export interface VideoEncoderFactory {
    checkSupport(config: VideoEncodeConfig): Promise<Support>;
    create(config: VideoEncodeConfig, context: EncoderContext): Awaitable<OfflineVideoEncoder>;
}
export interface AudioEncoderFactory {
    checkSupport(config: AudioEncodeConfig): Promise<Support>;
    create(config: AudioEncodeConfig, context: EncoderContext): Awaitable<OfflineAudioEncoder>;
}
export interface MuxerConfig {
    readonly video: VideoEncodeConfig;
    readonly audio?: AudioEncodeConfig;
}
export interface TimelineSummary {
    readonly durationUs: number;
    readonly videoFrames: number;
    readonly audioPresentationSamples?: number;
}
export interface OfflineVideoMuxer {
    /** Serial across tracks; must not wait for a future track/packet to resolve this write. */
    write(event: CodecEvent): Promise<void>;
    /** Returns one complete, playable container after both track-end events. */
    finalize(timeline: TimelineSummary): Promise<Blob>;
    dispose(): void;
}
export interface MuxerFactory {
    readonly format: { readonly mimeType: string; readonly extension: string };
    checkSupport(config: MuxerConfig): Promise<Support>;
    create(config: MuxerConfig, context: MuxerContext): Awaitable<OfflineVideoMuxer>;
}
export interface OfflineVideoProgress {
    readonly phase: 'initializing' | 'encoding' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
    readonly framesAccepted: number;
    readonly durationUs: number;
    readonly audioSamplesAccepted: number;
    readonly videoPacketsWritten: number;
    readonly audioPacketsWritten: number;
    readonly encodedBytes: number;
    readonly totalFrames?: number;
    /** Known only after container finalization in the first implementation. */
    readonly outputBytes?: number;
}
export interface OfflineVideoOptions {
    readonly video: { readonly encoder: VideoEncoderFactory; readonly config: VideoEncodeConfig };
    readonly audio?: { readonly encoder: AudioEncoderFactory; readonly config: AudioEncodeConfig;
        readonly source: PreparedAudio; readonly endPolicy: 'error' | 'trim-or-pad' };
    readonly muxer: MuxerFactory;
    readonly signal?: AbortSignal;
    readonly background?: readonly [number, number, number];
    readonly totalFrames?: number;
    readonly onProgress?: (progress: OfflineVideoProgress) => void;
    readonly maxFramePixels?: number;
    readonly maxFrames?: number;
    readonly maxDurationUs?: number;
    readonly maxAudioInputBytes?: number;
    readonly maxOutputBytes?: number;
    readonly maxPendingInputs?: number;
    readonly maxPendingBytes?: number;
}
export interface OfflineVideoResult extends TimelineSummary {
    readonly blob: Blob;
    readonly mimeType: string;
    readonly extension: string;
    readonly videoCodec: string;
    readonly audioCodec?: string;
}
export type OfflineVideoState = 'ready' | 'encoding' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
export interface OfflineVideoExporter {
    readonly state: OfflineVideoState;
    /** Snapshot immediately, before the first yield; await before the next operation. */
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, timing: FrameTiming): Promise<void>;
    finish(): Promise<OfflineVideoResult>;
    dispose(): void;
}

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
function snapshot(options: OfflineVideoOptions) {
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
        planes = a.source.channels.map(plane => plane.slice());
    }
    return { limits: Object.freeze(limits), videoConfig, audioConfig, planes, sourceLength, background,
        videoFactory: options.video.encoder, audioFactory: a?.encoder, audioPolicy: a?.endPolicy,
        muxerFactory: options.muxer, format, signal: options.signal, onProgress: options.onProgress, totalFrames: options.totalFrames };
}

/** Offline timeline controller. Encoders and container implementation are always supplied. */
export async function createOfflineVideoExporter(options: OfflineVideoOptions): Promise<OfflineVideoExporter> {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Export aborted', 'AbortError');
    const cfg = snapshot(options); // Includes the PCM copy, before the first await.
    const controller = new AbortController(), cancelled = deferred<never>();
    let state: OfflineVideoState | 'initializing' = 'initializing', failure: unknown;
    let muxer: OfflineVideoMuxer | undefined, video: OfflineVideoEncoder | undefined, audio: OfflineAudioEncoder | undefined;
    const owned = new Set<{ dispose(): void }>(), disposed = new WeakSet<{ dispose(): void }>();
    let frames = 0, submittedFrames = 0, duration = 0, samples = 0, videoPackets = 0, audioPackets = 0, encodedBytes = 0;
    let videoSeen = 0, videoOutputEnd = 0, audioOutputStart: number | undefined, audioOutputEnd: number | undefined;
    let queuedBytes = 0, draining = false, inFlight: Pending | undefined;
    let finishPromise: Promise<OfflineVideoResult> | undefined;
    const expectedVideo = new Map<number, number>();
    type Pending = { event: CodecEvent; bytes: number; cost: number; done: ReturnType<typeof deferred<void>> };
    const queue: Pending[] = [], idle = new Set<ReturnType<typeof deferred<void>>>();
    const tracks = { video: { config: undefined as VideoDescription | AudioDescription | undefined, ended: false, flushing: false },
        audio: { config: undefined as VideoDescription | AudioDescription | undefined, ended: false, flushing: false } };
    const terminal = () => ['finished', 'failed', 'aborted', 'disposed'].includes(state);
    const guard = () => { if (terminal()) throw failure ?? new Error(`Offline video exporter is ${state}`); };
    const wait = async <T>(promise: Awaitable<T>): Promise<T> => { const value = await Promise.race([Promise.resolve(promise), cancelled.promise]); guard(); return value; };
    function report(phase: OfflineVideoProgress['phase'], outputBytes?: number): void {
        try { cfg.onProgress?.(Object.freeze({ phase, framesAccepted: frames, durationUs: duration, audioSamplesAccepted: samples,
            videoPacketsWritten: videoPackets, audioPacketsWritten: audioPackets, encodedBytes,
            ...(cfg.totalFrames === undefined ? {} : { totalFrames: cfg.totalFrames }), ...(outputBytes === undefined ? {} : { outputBytes }) })); } catch {}
    }
    function release(instance: { dispose(): void }): void {
        if (disposed.has(instance)) return;
        disposed.add(instance); try { instance.dispose(); } catch {}
    }
    function cleanup(): void {
        cfg.signal?.removeEventListener('abort', onAbort);
        for (const instance of owned) release(instance);
        owned.clear(); cfg.planes.length = 0; expectedVideo.clear();
        tracks.video.config = tracks.audio.config = undefined;
        muxer = undefined; video = undefined; audio = undefined;
    }
    function end(next: 'failed' | 'aborted' | 'disposed', error: unknown): void {
        if (terminal()) return;
        state = next; failure = error; cancelled.reject(error); controller.abort(error);
        inFlight?.done.reject(error);
        for (const item of queue.splice(0)) item.done.reject(error);
        for (const pending of idle) pending.reject(error);
        idle.clear(); queuedBytes = 0; cleanup(); report(next);
    }
    function onAbort(): void { end('aborted', cfg.signal?.reason ?? new DOMException('Export aborted', 'AbortError')); }
    const protocol = (message: string) => new Error(`Offline video protocol: ${message}`);
    function wrap(component: string, error: unknown): Error { return new Error(`${component} failed`, { cause: error }); }
    async function invoke<T>(component: string, work: () => Awaitable<T>): Promise<T> {
        try { guard(); return await wait(work()); }
        catch (error) { if (terminal()) throw failure ?? error; throw wrap(component, error); }
    }
    async function acquire<T extends { dispose(): void }>(component: string, methods: readonly string[], create: () => Awaitable<T>): Promise<T> {
        guard();
        return invoke(component, () => Promise.resolve().then(() => { guard(); return create(); }).then(instance => {
            if (terminal()) { release(instance); return instance; }
            if (!instance || typeof instance.dispose !== 'function' || owned.has(instance) || disposed.has(instance)) throw protocol('factory must return a fresh disposable instance');
            owned.add(instance);
            if (methods.some(name => typeof (instance as unknown as Record<string, unknown>)[name] !== 'function')) throw protocol(`${component} returned missing methods`);
            return instance;
        }));
    }
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
            let copy: CodecEvent;
            if (track === 'video') {
                const v = c as VideoDescription;
                if (v.width !== cfg.videoConfig.width || v.height !== cfg.videoConfig.height || !v.color ||
                    [v.color.primaries, v.color.transfer, v.color.matrix].some(value => typeof value !== 'string' || !value) || typeof v.color.fullRange !== 'boolean') throw protocol('video description mismatch');
                copy = { type: 'config', track: 'video', config: { codec: c.codec, bitstreamFormat: c.bitstreamFormat,
                    width: v.width, height: v.height, color: Object.freeze({ primaries: v.color.primaries, transfer: v.color.transfer, matrix: v.color.matrix, fullRange: v.color.fullRange }), ...(c.description === undefined ? {} : { description: c.description.slice() }) } };
            } else {
                const a = c as AudioDescription;
                if (a.sampleRate !== cfg.audioConfig!.sampleRate || a.numberOfChannels !== cfg.audioConfig!.numberOfChannels) throw protocol('audio description mismatch');
                copy = { type: 'config', track: 'audio', config: { codec: c.codec, bitstreamFormat: c.bitstreamFormat,
                    sampleRate: a.sampleRate, numberOfChannels: a.numberOfChannels, ...(c.description === undefined ? {} : { description: c.description.slice() }) } };
            }
            if (c.description !== undefined && (!(c.description instanceof Uint8Array) || !(c.description.buffer instanceof ArrayBuffer))) throw protocol('invalid decoder description bytes');
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
            return { event: { type: 'packet', packet: Object.freeze({ ...p, data: p.data.slice() }) }, bytes: p.data.byteLength };
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
    async function drain(): Promise<void> {
        if (draining) return; draining = true;
        try {
            while (queue.length && !terminal()) {
                const item = inFlight = queue.shift()!;
                try { await wait(muxer!.write(item.event)); }
                catch (error) { if (!terminal()) end('failed', wrap('muxer.write', error)); item.done.reject(failure); break; }
                queuedBytes -= item.cost;
                if (item.event.type === 'packet') {
                    if (item.event.packet.track === 'video') videoPackets++; else audioPackets++;
                    encodedBytes += item.bytes;
                }
                item.done.resolve(); inFlight = undefined;
                report(state === 'initializing' ? 'initializing' : state === 'finalizing' ? 'finalizing' : 'encoding');
            }
        } finally {
            draining = false; inFlight = undefined;
            if (!queue.length) { for (const pending of idle) pending.resolve(); idle.clear(); }
        }
    }
    function sink(track: Track): CodecOutputSink {
        return Object.freeze({
            write(event: CodecEvent): Promise<void> {
                const done = deferred<void>();
                try {
                    guard();
                    const bytes = event.type === 'packet' ? event.packet.data.byteLength : event.type === 'config' ? event.config.description?.byteLength ?? 0 : 0;
                    const cost = bytes + 64; // Reserve metadata space even for empty config/end events.
                    if (cost > cfg.limits.maxPendingBytes - queuedBytes) throw new RangeError('maxPendingBytes exceeded');
                    const item = cloneEvent(track, event);
                    queuedBytes += cost; queue.push({ ...item, cost, done }); void drain();
                } catch (error) { if (!terminal()) end('failed', error); done.reject(failure ?? error); }
                return done.promise;
            },
            fail(error: unknown) { if (!terminal()) end('failed', wrap(`${track} encoder`, error)); }
        });
    }
    async function queueIdle(): Promise<void> {
        if (!draining && !queue.length) return;
        const pending = deferred<void>(); idle.add(pending); await wait(pending.promise);
    }
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
    cfg.signal?.addEventListener('abort', onAbort, { once: true });
    if (cfg.signal?.aborted) onAbort();
    try {
        guard(); report('initializing'); guard();
        const muxerConfig: MuxerConfig = Object.freeze({ video: cfg.videoConfig, ...(cfg.audioConfig ? { audio: cfg.audioConfig } : {}) });
        for (const [name, check] of [
            ['video', () => cfg.videoFactory.checkSupport(cfg.videoConfig)],
            ...(cfg.audioConfig ? [['audio', () => cfg.audioFactory!.checkSupport(cfg.audioConfig!)]] : []),
            ['muxer', () => cfg.muxerFactory.checkSupport(muxerConfig)]
        ] as [string, () => Promise<Support>][]) {
            const support = await invoke(`${name}.checkSupport`, check);
            if (!support || typeof support.supported !== 'boolean' || (!support.supported && typeof support.reason !== 'string')) throw protocol(`${name} returned invalid support information`);
            if (!support.supported) throw new DOMException(`${name} unsupported: ${support.reason}`, 'NotSupportedError');
        }
        const context: SessionContext = Object.freeze({ signal: controller.signal, maxPendingInputs: cfg.limits.maxPendingInputs, maxPendingBytes: cfg.limits.maxPendingBytes });
        muxer = await acquire('muxer.create', ['write', 'finalize'], () => cfg.muxerFactory.create(muxerConfig, Object.freeze({ ...context, ...(cfg.limits.maxOutputBytes === undefined ? {} : { maxOutputBytes: cfg.limits.maxOutputBytes }) })));
        video = await acquire('video encoder.create', ['encodeFrame', 'flush'], () => cfg.videoFactory.create(cfg.videoConfig, Object.freeze({ ...context, output: sink('video') })));
        if (cfg.audioConfig) audio = await acquire('audio encoder.create', ['encodeAudio', 'flush'], () => cfg.audioFactory!.create(cfg.audioConfig!, Object.freeze({ ...context, output: sink('audio') })));
        await queueIdle(); guard(); state = 'ready';
    } catch (error) { if (!terminal()) end('failed', error); throw failure ?? error; }

    return Object.freeze({
        get state() { return state as OfflineVideoState; },
        addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, timing: FrameTiming): Promise<void> {
            if (state !== 'ready') return Promise.reject(failure ?? new Error(`Cannot addFrame in ${state} state`));
            state = 'encoding';
            return (async () => {
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
                    for (let i = 0; i < data.length; i += 4) {
                        if (data[i + 3] === 255) continue;
                        const alpha = data[i + 3] / 255;
                        for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * alpha + cfg.background[c] * (1 - alpha));
                        data[i + 3] = 255;
                    }
                    await wait(new Promise<void>(resolve => setTimeout(resolve, 0)));
                    expectedVideo.set(timestampUs, frameDuration); submittedFrames++;
                    await invoke('video encoder.encodeFrame', () => video!.encodeFrame(Object.freeze({ width: cfg.videoConfig.width, height: cfg.videoConfig.height, data,
                        timestampUs, durationUs: frameDuration, keyFrame: frames === 0 || keyFrame })));
                    await feedAudio(audioTarget); guard();
                    frames++; duration = endUs; report('encoding'); guard(); state = 'ready';
                } catch (error) { if (!terminal()) end('failed', error); throw failure ?? error; }
            })();
        },
        finish(): Promise<OfflineVideoResult> {
            if (state === 'finished' || state === 'finalizing') return finishPromise!;
            if (state !== 'ready') return Promise.reject(failure ?? new Error(`Cannot finish in ${state} state`));
            state = 'finalizing';
            const completion = deferred<OfflineVideoResult>(); finishPromise = completion.promise;
            void (async () => {
                try {
                    if (!frames) throw new RangeError('Offline video requires at least one frame');
                    if (cfg.audioConfig && !samples) throw new RangeError('Audio presentation requires at least one sample');
                    if (cfg.audioPolicy === 'error' && samples !== cfg.sourceLength) throw new RangeError('Prepared audio is longer than the video timeline');
                    report('finalizing'); guard();
                    tracks.video.flushing = true; if (audio) tracks.audio.flushing = true;
                    const encoders = [video!, ...(audio ? [audio] : [])];
                    await wait(Promise.all(encoders.map((encoder, i) => Promise.resolve().then(() => invoke(i === 0 ? 'video encoder.flush' : 'audio encoder.flush', () => encoder.flush())))));
                    await queueIdle(); guard();
                    if (!tracks.video.ended || (cfg.audioConfig && !tracks.audio.ended)) throw protocol('flush completed without track end');
                    const timeline = Object.freeze({ durationUs: duration, videoFrames: frames, ...(cfg.audioConfig ? { audioPresentationSamples: samples } : {}) });
                    const blob = await invoke('muxer.finalize', () => muxer!.finalize(timeline));
                    if (!(blob instanceof Blob) || !blob.size || blob.type !== cfg.format.mimeType) throw protocol('muxer returned an empty or mismatched container');
                    if (cfg.limits.maxOutputBytes !== undefined && blob.size > cfg.limits.maxOutputBytes) throw new RangeError('maxOutputBytes exceeded');
                    const result = Object.freeze({ ...timeline, blob, ...cfg.format, videoCodec: cfg.videoConfig.codec,
                        ...(cfg.audioConfig ? { audioCodec: cfg.audioConfig.codec } : {}) });
                    state = 'finished'; cleanup(); report('finished', blob.size); return result;
                } catch (error) { if (!terminal()) end('failed', error); throw failure ?? error; }
            })().then(completion.resolve, completion.reject);
            return finishPromise;
        },
        dispose(): void {
            if (state === 'disposed') return;
            if (!terminal()) end('disposed', new DOMException('Offline video disposed', 'AbortError'));
            else { state = 'disposed'; controller.abort(new DOMException('Offline video disposed', 'AbortError')); cleanup(); }
        }
    });
}
