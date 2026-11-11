import { Output, StreamTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedAudioPacketSource, EncodedPacket } from 'mediabunny';
import type { MuxerFactory, MuxerConfig, VideoDescription, AudioDescription, EncodedPacket as Packet } from './video.js';
import { createPagedByteStore } from './internal/paged-bytes.js';

// Mediabunny 1.65 uses this movie/track timebase when no frameRate snapping is requested.
const TIMESCALE = 57_600;
const ticks = (us: number) => Number((BigInt(us) * BigInt(TIMESCALE) + 500_000n) / 1_000_000n);
function unsupported(config: MuxerConfig): string | undefined {
    if (config.audio && (config.audio.codec !== 'mp4a.40.2' || config.audio.bitstreamFormat !== 'aac' || ![44100,48000].includes(config.audio.sampleRate) || ![1,2].includes(config.audio.numberOfChannels))) return 'MP4 audio requires AAC-LC, raw aac framing, 44.1/48 kHz mono/stereo';
    if (!/^avc1\.42[0-9a-f]{4}$/i.test(config.video.codec) || config.video.bitstreamFormat !== 'avc') return 'MP4 adapter requires H.264 Baseline with avc framing';
    return undefined;
}

/** Optional, bundled Mediabunny MP4 writer. No encoding or implicit format selection. */
export function createMp4Muxer(): MuxerFactory {
    return {
        format: Object.freeze({ mimeType: 'video/mp4', extension: 'mp4' }),
        async checkSupport(config) { const reason = unsupported(config); return reason ? { supported: false, reason } : { supported: true }; },
        async create(config, context) {
            const reason = unsupported(config); if (reason) throw new DOMException(reason, 'NotSupportedError');
            let output: Output | undefined, source: EncodedVideoPacketSource | undefined, audio: EncodedAudioPacketSource | undefined;
            let disposed = false, ended = false, description: VideoDescription | undefined, frames = 0, endUs = 0, mediaBytes = 0;
            let audioDescription: AudioDescription | undefined, audioEnded = false, audioSamples: number | undefined;
            let audioFirst: number | undefined, audioNext: number | undefined, audioLast: Packet | undefined;
            const sample = (timeUs:number) => Math.sign(timeUs)*Number((BigInt(Math.abs(timeUs))*BigInt(config.audio!.sampleRate)+500_000n)/1_000_000n);
            let outputError: Error | undefined;
            const bytes = createPagedByteStore();
            const guard = () => {
                if (outputError) throw outputError;
                if (disposed || context.signal.aborted) throw context.signal.reason ?? new DOMException('MP4 muxer disposed', 'AbortError');
            };
            function dispose(): void {
                if (disposed) return; disposed = true; context.signal.removeEventListener('abort', dispose);
                const previous = output; output = undefined; source = undefined; audio = undefined; audioLast = undefined;
                bytes.clear(); description = undefined; audioDescription = undefined;
                if (previous && previous.state !== 'finalized' && previous.state !== 'canceled') void previous.cancel().catch(() => {});
            }
            try {
                guard();
                const target = new StreamTarget(new WritableStream({ write({ data, position }) {
                    // Preserve the first adapter error while allowing the vendor to close the
                    // owned sink. Late queued writes after failure/abort retain no more pages.
                    if (disposed || context.signal.aborted || outputError) return;
                    const end = position + data.byteLength;
                    if (context.maxOutputBytes !== undefined && end > context.maxOutputBytes) { outputError = new RangeError('MP4 maxOutputBytes exceeded'); return; }
                    bytes.write(position, data);
                } }), { chunked: false });
                // Event listeners are observers: Mediabunny swallows their exceptions. Record an error and
                // reject operations/stream writes explicitly instead of relying on a throwing listener.
                target.on('write', ({ end }) => {
                    if (context.maxOutputBytes !== undefined && end > context.maxOutputBytes) outputError ??= new RangeError('MP4 maxOutputBytes exceeded');
                });
                source = new EncodedVideoPacketSource('avc');
                // Write media incrementally. Avoid fastStart in-memory accumulation and frameRate snapping.
                output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
                output.addVideoTrack(source);
                if (config.audio) { audio = new EncodedAudioPacketSource('aac'); output.addAudioTrack(audio); }
                await output.start(); guard();
                context.signal.addEventListener('abort', dispose, { once: true }); guard();
            } catch (error) { dispose(); throw error; }
            function reserve(bytes:number): void {
                if (context.maxOutputBytes !== undefined && bytes > context.maxOutputBytes - mediaBytes) throw new RangeError('MP4 maxOutputBytes exceeded');
                mediaBytes += bytes;
            }
            async function writeAudio(packet:Packet, endSample:number): Promise<void> {
                const c = audioDescription!, rate = config.audio!.sampleRate, startSample = sample(packet.timestampUs);
                await audio!.add(new EncodedPacket(packet.data,packet.type,startSample/rate,(endSample-startSample)/rate), { decoderConfig:{
                    codec:c.codec,sampleRate:rate,numberOfChannels:c.numberOfChannels,description:c.description as Uint8Array<ArrayBuffer>
                } }); guard();
            }
            return {
                async write(event) {
                    guard();
                    const track = event.type === 'packet' ? event.packet.track : event.track;
                    if (track === 'audio') {
                        if (!audio || audioEnded) throw new Error('MP4 audio unavailable or ended');
                        if (event.type === 'config' && event.track === 'audio') {
                            const c = event.config, d = c.description, rate = config.audio!.sampleRate;
                            if (!d || d.length < 2 || (d[0]>>3)!==2 || (((d[0]&7)<<1)|(d[1]>>7))!==(rate===48000?3:4) || ((d[1]>>3)&15)!==config.audio!.numberOfChannels) throw new Error('MP4 AAC AudioSpecificConfig mismatch');
                            audioDescription = {...c,description:d.slice()}; return;
                        }
                        if (!audioDescription) throw new Error('MP4 audio requires decoder configuration');
                        if (event.type === 'packet') {
                            const p = event.packet, first = sample(p.timestampUs), last = sample(p.timestampUs+p.durationUs);
                            if (first !== (audioNext ?? first) || last-first !== 1024 || p.timestampUs!==p.decodeTimestampUs || p.data.byteLength+64>context.maxPendingBytes) throw new Error('MP4 invalid AAC packet interval/budget');
                            reserve(p.data.byteLength);
                            if (audioLast) await writeAudio(audioLast,first);
                            audioLast = {...p,data:p.data.slice()}; audioFirst ??= first; audioNext = last; return;
                        }
                        if (event.type !== 'end' || event.track !== 'audio' || !audioLast || audioFirst !== -event.leadingDiscardSamples || audioNext !== event.presentationSamples+event.trailingDiscardSamples) throw new Error('MP4 AAC trimming mismatch');
                        if (sample(audioLast.timestampUs)>=event.presentationSamples) throw new Error('MP4 AAC tail exceeds final packet');
                        // Retain the coded frame for decoder overlap, but shorten its MP4 sample duration.
                        // Negative first PTS causes an edit list that discards encoder priming at the front.
                        await writeAudio(audioLast,event.presentationSamples); audioLast = undefined;
                        audioSamples = event.presentationSamples; audioEnded = true; audio.close(); return;
                    }
                    if (ended) throw new Error('MP4 video track already ended');
                    if (event.type === 'config' && event.track === 'video') {
                        if (!event.config.description?.byteLength) throw new Error('MP4 requires an AVCDecoderConfigurationRecord');
                        description = { ...event.config, description: event.config.description.slice(), color: { ...event.config.color } }; return;
                    }
                    if (event.type === 'end' && event.track === 'video') { ended = true; source!.close(); return; }
                    if (event.type !== 'packet' || event.packet.track !== 'video' || !description) throw new Error('MP4 requires configured video packets');
                    const p = event.packet, nextEnd = p.timestampUs + p.durationUs;
                    if (p.timestampUs !== endUs || p.decodeTimestampUs !== p.timestampUs) throw new Error('MP4 requires contiguous, non-reordered video');
                    const first = ticks(p.timestampUs), last = ticks(nextEnd), delta = last - first;
                    if (delta <= 0 || delta > 0xffff_ffff) throw new RangeError('MP4 frame interval cannot be represented in the 57600 Hz timebase');
                    reserve(p.data.byteLength);
                    await source!.add(new EncodedPacket(p.data, p.type, first / TIMESCALE, delta / TIMESCALE), { decoderConfig: {
                        codec: description.codec, codedWidth: description.width, codedHeight: description.height, description: description.description as Uint8Array<ArrayBuffer>,
                        colorSpace: description.color as VideoColorSpaceInit
                    } });
                    guard(); frames++; endUs = nextEnd;
                },
                async finalize(timeline) {
                    guard();
                    if (!ended || frames !== timeline.videoFrames || endUs !== timeline.durationUs || (config.audio ? !audioEnded || audioSamples !== timeline.audioPresentationSamples : timeline.audioPresentationSamples !== undefined)) throw new Error('MP4 final timeline does not match written tracks');
                    await output!.finalize(); guard();
                    if (!bytes.size) throw new Error('MP4 output buffer missing');
                    const blob = new Blob(bytes.parts(), { type: 'video/mp4' }); bytes.clear();
                    return blob;
                },
                dispose
            };
        }
    };
}
