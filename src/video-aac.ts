import type { AudioEncodeConfig, AudioEncoderFactory, EncoderContext } from './video.js';

export interface AacEncoderOptions {
    readonly workerUrl?: string | URL;
    /** Per-command startup/encode/flush timeout. Default 30000 ms. */
    readonly timeoutMs?: number;
}
type Packet = { sampleOffset: number; samples: number; data: Uint8Array };
type Response = { frameSize?: number; description?: Uint8Array; packets?: Packet[] };
function invalid(config: AudioEncodeConfig): string | undefined {
    if (config.codec !== 'mp4a.40.2' || config.bitstreamFormat !== 'aac') return 'AAC adapter requires mp4a.40.2 with raw aac framing';
    if (![44100,48000].includes(config.sampleRate) || ![1,2].includes(config.numberOfChannels)) return 'AAC adapter supports 44.1/48 kHz mono/stereo';
    if (!Number.isSafeInteger(config.bitrate) || config.bitrate < 8000 || config.bitrate > 512000) return 'AAC bitrate must be an integer in 8000..512000';
    return undefined;
}
const us = (samples: number, rate: number) => Math.sign(samples) * Number((BigInt(Math.abs(samples)) * 1_000_000n + BigInt(rate / 2)) / BigInt(rate));

/** Dedicated Worker running the pinned libavcodec AAC-LC WASM backend; no native AAC assumption. */
export function createAacAudioEncoder(options: AacEncoderOptions = {}): AudioEncoderFactory {
    const workerUrl = options.workerUrl, timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new RangeError('AAC timeoutMs must be 1..2147483647');
    return {
        async checkSupport(config) {
            const reason = invalid(config) ?? (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined' ? 'AAC requires Worker and WebAssembly' : undefined);
            return reason ? { supported:false,reason } : { supported:true };
        },
        async create(config, context: EncoderContext) {
            const reason = invalid(config); if (reason) throw new DOMException(reason, 'NotSupportedError');
            if (context.signal.aborted) throw context.signal.reason;
            const channels = config.numberOfChannels, rate = config.sampleRate;
            if (1024 * channels * 4 > context.maxPendingBytes) throw new RangeError('AAC maxPendingBytes cannot hold one codec frame');
            let worker: Worker | undefined = workerUrl === undefined ? new Worker(new URL('./video-aac-worker.js', import.meta.url), { type:'module' }) : new Worker(workerUrl, { type:'module' });
            let id = 0, failure: unknown, disposed = false, ended = false, accepted = 0, filled = 0, encoded = 0;
            let first: number | undefined, last: number | undefined, pcm: Float32Array | undefined = new Float32Array(1024 * channels);
            let pending: { id:number; resolve:(value:Response)=>void; reject:(error:unknown)=>void; timer:ReturnType<typeof setTimeout> } | undefined;
            let cancel!: (reason:unknown)=>void;
            const cancelled=new Promise<never>((_,reject)=>{cancel=reject;}); void cancelled.catch(()=>{});
            const guard = () => { if (disposed) throw failure ?? new DOMException('AAC encoder disposed', 'AbortError'); };
            const wait=async<T>(work:Promise<T>):Promise<T>=>{const value=await Promise.race([work,cancelled]);guard();return value;};
            function dispose(): void {
                if (disposed) return; disposed = true; failure ??= context.signal.reason ?? new DOMException('AAC encoder disposed', 'AbortError');
                context.signal.removeEventListener('abort', dispose);
                worker?.removeEventListener('message', onMessage); worker?.removeEventListener('error', onError); worker?.removeEventListener('messageerror', onMessageError);
                worker?.terminate(); worker = undefined; pcm = undefined;
                cancel(failure);
                if (pending) { clearTimeout(pending.timer); pending.reject(failure); pending = undefined; }
            }
            function fail(error: unknown): void { if (disposed) return; failure = error; dispose(); context.output.fail(error); }
            function onError(event: ErrorEvent): void { fail(new Error(event.message || 'AAC worker failed')); }
            function onMessageError(): void { fail(new Error('AAC worker message could not be decoded')); }
            function onMessage(event: MessageEvent): void {
                if (disposed || !pending) return;
                const message = event.data;
                if (!message || message.id !== pending.id || (!message.result && typeof message.error !== 'string')) { fail(new Error('Invalid AAC worker response')); return; }
                if (message.error) { fail(new Error(message.error)); return; }
                const request = pending; pending = undefined; clearTimeout(request.timer); request.resolve(message.result);
            }
            function send(type: string, data?: unknown, transfer: Transferable[] = []): Promise<Response> {
                guard(); if (pending) throw new Error('AAC worker command overlap');
                return new Promise((resolve,reject) => {
                    const requestId = id++;
                    pending = { id:requestId,resolve,reject,timer:setTimeout(() => fail(new Error(`AAC worker ${type} timed out`)),timeoutMs) };
                    try { worker!.postMessage({ id:requestId,type,data },transfer); } catch (error) { fail(error); }
                });
            }
            async function packets(result: Response): Promise<void> {
                if (!Array.isArray(result.packets) || result.packets.length > 4) throw new Error('Invalid AAC packet response');
                for (const p of result.packets) {
                    guard();
                    if (!Number.isSafeInteger(p.sampleOffset) || p.samples !== 1024 || !(p.data instanceof Uint8Array) || !p.data.byteLength || p.data.byteLength + 64 > context.maxPendingBytes) throw new Error('Invalid AAC packet');
                    if (first === undefined) { if (p.sampleOffset >= 0 || p.sampleOffset < -8192) throw new Error('AAC backend did not expose valid encoder delay'); first = p.sampleOffset; }
                    if (last !== undefined && last !== p.sampleOffset) throw new Error('Noncontiguous AAC sample positions');
                    const next = p.sampleOffset + p.samples;
                    await wait(context.output.write({ type:'packet',packet:{track:'audio',timestampUs:us(p.sampleOffset,rate),decodeTimestampUs:us(p.sampleOffset,rate),
                        durationUs:us(next,rate)-us(p.sampleOffset,rate),type:'key',data:p.data} }));
                    guard(); last = next;
                }
            }
            async function encodeFrame(): Promise<void> {
                const data = pcm!; pcm = new Float32Array(1024 * channels); filled = 0;
                await packets(await send('frame',{pcm:data,sampleOffset:encoded},[data.buffer])); encoded += 1024;
            }
            worker.addEventListener('message',onMessage); worker.addEventListener('error',onError); worker.addEventListener('messageerror',onMessageError);
            context.signal.addEventListener('abort',dispose,{once:true});
            try {
                if (context.signal.aborted) dispose();
                const init = await send('init',{channels,sampleRate:rate,bitrate:config.bitrate,maxBytes:context.maxPendingBytes});
                if (init.frameSize !== 1024 || !(init.description instanceof Uint8Array) || init.description.length < 2 || init.description.byteLength + 64 > context.maxPendingBytes) throw new Error('Invalid AAC initialization response');
                await wait(context.output.write({type:'config',track:'audio',config:{codec:config.codec,bitstreamFormat:'aac',sampleRate:rate,numberOfChannels:channels,description:init.description}})); guard();
            } catch (error) { dispose(); throw error; }
            return {
                async encodeAudio(block) {
                    guard(); if (ended || block.sampleOffset !== accepted || block.sampleRate !== rate || block.channels.length !== channels || block.channels.some(c=>c.length!==block.channels[0].length)) throw new Error('Invalid AAC input timeline/configuration');
                    for (let offset = 0; offset < block.channels[0].length;) {
                        const count = Math.min(1024-filled,block.channels[0].length-offset);
                        for (let i=0;i<count;i++) for (let c=0;c<channels;c++) pcm![(filled+i)*channels+c]=block.channels[c][offset+i];
                        filled+=count; offset+=count; accepted+=count;
                        if (filled===1024) await encodeFrame();
                    }
                },
                async flush() {
                    guard(); if (ended) throw new Error('AAC track already ended'); ended = true;
                    if (filled) await encodeFrame();
                    await packets(await send('flush'));
                    if (first===undefined || last===undefined || last<accepted) throw new Error('AAC backend returned incomplete audio');
                    await wait(context.output.write({type:'end',track:'audio',presentationSamples:accepted,leadingDiscardSamples:-first,trailingDiscardSamples:last-accepted})); guard();
                },
                dispose
            };
        }
    };
}
