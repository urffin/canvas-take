import type { VideoEncodeConfig, VideoEncoderFactory, VideoDescription, CodecEvent } from './video.js';

/** First profile: H.264 Baseline, AVC framing, quality mode, one drained native input at a time. */
export function createWebCodecsVideoEncoder(): VideoEncoderFactory {
    function nativeConfig(config: VideoEncodeConfig): VideoEncoderConfig {
        if (!/^avc1\.42[0-9a-f]{4}$/i.test(config.codec) || config.bitstreamFormat !== 'avc') {
            throw new DOMException('WebCodecs adapter requires H.264 Baseline (avc1.42xxxx) with avc framing', 'NotSupportedError');
        }
        if (![config.width, config.height, config.bitrate].every(n => Number.isSafeInteger(n) && n > 0) || config.width % 2 || config.height % 2) {
            throw new RangeError('H.264 requires positive even dimensions and a positive integer bitrate');
        }
        return { codec: config.codec, width: config.width, height: config.height, bitrate: config.bitrate,
            latencyMode: 'quality', avc: { format: 'avc' },
            ...(config.frameRateHint ? { framerate: config.frameRateHint.numerator / config.frameRateHint.denominator } : {}) };
    }
    return {
        async checkSupport(config) {
            try {
                const native = nativeConfig(config);
                if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return { supported: false, reason: 'WebCodecs VideoEncoder/VideoFrame unavailable (requires a secure context)' };
                const support = await VideoEncoder.isConfigSupported(native);
                return support.supported ? { supported: true } : { supported: false, reason: `WebCodecs does not support ${config.codec} at ${config.width}x${config.height}` };
            } catch (error) { return { supported: false, reason: error instanceof Error ? error.message : String(error) }; }
        },
        create(config, context) {
            const native = nativeConfig(config);
            let encoder: VideoEncoder | undefined, disposed = false, ended = false, error: unknown;
            let pending: { timestampUs: number; durationUs: number; keyFrame: boolean } | undefined;
            let tail = Promise.resolve(), bytes = 0, events = 0, description: VideoDescription | undefined;
            let rejectFailure!: (reason: unknown) => void;
            const failed = new Promise<never>((_, reject) => { rejectFailure = reject; }); void failed.catch(() => {});
            const guard = () => {
                if (error !== undefined) throw error;
                if (disposed || context.signal.aborted) throw context.signal.reason ?? new DOMException('Video encoder disposed', 'AbortError');
            };
            function fail(reason: unknown): void {
                if (disposed || error !== undefined) return;
                error = reason instanceof Error ? reason : new Error('WebCodecs encoder failed', { cause: reason });
                rejectFailure(error); context.output.fail(error);
            }
            const wait = async <T>(work: Promise<T>): Promise<T> => { const value = await Promise.race([work, failed]); guard(); return value; };
            function enqueue(event: CodecEvent, cost: number): void {
                if (cost > context.maxPendingBytes - bytes || events >= context.maxPendingInputs + 1) throw new RangeError('WebCodecs maxPendingBytes/maxPendingInputs exceeded');
                bytes += cost; events++;
                tail = tail.then(() => { guard(); return context.output.write(event); }).then(() => { bytes -= cost; events--; });
                void tail.catch(fail);
            }
            function abort(): void { dispose(); }
            function dispose(): void {
                if (disposed) return;
                disposed = true; context.signal.removeEventListener('abort', abort);
                rejectFailure(context.signal.reason ?? new DOMException('Video encoder disposed', 'AbortError'));
                if (encoder && encoder.state !== 'closed') encoder.close();
                encoder = undefined; pending = undefined; description = undefined;
            }
            try {
                guard();
                encoder = new VideoEncoder({ error: fail, output(chunk, metadata) {
                    if (disposed || error !== undefined) return;
                    try {
                        guard();
                        if (!pending || chunk.timestamp !== pending.timestampUs || (pending.keyFrame && chunk.type !== 'key')) throw new Error('WebCodecs dropped, reordered or changed a requested key frame');
                        // Baseline forbids B pictures. Also verify the actual avcC profile, not only callback order.
                        if (metadata?.decoderConfig) {
                            const c = metadata.decoderConfig, color = c.colorSpace;
                            const d = c.description;
                            const avcc = d ? (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d)).slice() : undefined;
                            if (!avcc || avcc.length < 7 || avcc[0] !== 1 || avcc[1] !== 66 || c.codec !== config.codec || c.codedWidth !== config.width || c.codedHeight !== config.height) throw new Error('WebCodecs returned incompatible AVC Baseline decoder configuration');
                            if (color?.primaries !== 'bt709' || !['bt709', 'iec61966-2-1'].includes(color.transfer ?? '') || color.matrix !== 'bt709' || typeof color.fullRange !== 'boolean') throw new Error('WebCodecs returned unsupported or missing SDR color metadata');
                            description = { codec: config.codec, bitstreamFormat: 'avc', width: config.width, height: config.height, description: avcc,
                                color: { primaries: color.primaries, transfer: color.transfer!, matrix: color.matrix, fullRange: color.fullRange } };
                            enqueue({ type: 'config', track: 'video', config: description }, avcc.byteLength + 64);
                        }
                        if (!description) throw new Error('WebCodecs did not provide an AVC decoder description');
                        if (chunk.byteLength + 64 > context.maxPendingBytes - bytes) throw new RangeError('WebCodecs maxPendingBytes exceeded');
                        const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
                        // Duration comes from the submitted interval, including a long final hold.
                        enqueue({ type: 'packet', packet: { track: 'video', timestampUs: pending.timestampUs, decodeTimestampUs: pending.timestampUs,
                            durationUs: pending.durationUs, type: chunk.type, data } }, data.byteLength + 64);
                        pending = undefined;
                    } catch (reason) { fail(reason); }
                } });
                encoder.configure(native);
                context.signal.addEventListener('abort', abort, { once: true }); guard();
            } catch (reason) { dispose(); throw reason; }
            return {
                async encodeFrame(frame) {
                    guard(); if (ended || pending) throw new Error('Video encoder is ended or busy');
                    pending = { timestampUs: frame.timestampUs, durationUs: frame.durationUs, keyFrame: frame.keyFrame === true };
                    let input: VideoFrame | undefined;
                    try {
                        input = new VideoFrame(frame.data, { format: 'RGBA', codedWidth: config.width, codedHeight: config.height,
                            timestamp: frame.timestampUs, duration: frame.durationUs,
                            colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true } });
                        encoder!.encode(input, { keyFrame: frame.keyFrame });
                    } finally { input?.close(); }
                    await wait(encoder!.flush());
                    if (pending) throw new Error('WebCodecs did not output the submitted frame');
                    await wait(tail);
                },
                async flush() {
                    guard(); if (ended) throw new Error('Video encoder already ended'); ended = true;
                    await wait(encoder!.flush()); await wait(tail);
                    await wait(context.output.write({ type: 'end', track: 'video' }));
                },
                dispose
            };
        }
    };
}
