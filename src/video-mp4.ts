import { Output, StreamTarget, Mp4OutputFormat, EncodedVideoPacketSource, EncodedPacket } from 'mediabunny';
import type { MuxerFactory, MuxerConfig, VideoDescription } from './video.js';

// Mediabunny 1.65 uses this movie/track timebase when no frameRate snapping is requested.
const TIMESCALE = 57_600;
const ticks = (us: number) => Number((BigInt(us) * BigInt(TIMESCALE) + 500_000n) / 1_000_000n);
function unsupported(config: MuxerConfig): string | undefined {
    if (config.audio) return 'This MP4 adapter currently supports video without audio only';
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
            let output: Output | undefined, source: EncodedVideoPacketSource | undefined;
            let disposed = false, ended = false, description: VideoDescription | undefined, frames = 0, endUs = 0, mediaBytes = 0;
            let size = 0, outputError: Error | undefined;
            const pageSize = 64 * 1024, pages = new Map<number, Uint8Array<ArrayBuffer>>();
            const guard = () => {
                if (outputError) throw outputError;
                if (disposed || context.signal.aborted) throw context.signal.reason ?? new DOMException('MP4 muxer disposed', 'AbortError');
            };
            function dispose(): void {
                if (disposed) return; disposed = true; context.signal.removeEventListener('abort', dispose);
                const previous = output; output = undefined; source = undefined;
                pages.clear(); description = undefined;
                if (previous && previous.state !== 'finalized' && previous.state !== 'canceled') void previous.cancel().catch(() => {});
            }
            try {
                guard();
                const target = new StreamTarget(new WritableStream({ write({ data, position }) {
                    guard();
                    const end = position + data.byteLength;
                    if (context.maxOutputBytes !== undefined && end > context.maxOutputBytes) throw new RangeError('MP4 maxOutputBytes exceeded');
                    for (let offset = 0; offset < data.byteLength;) {
                        const absolute = position + offset, index = Math.floor(absolute / pageSize), within = absolute % pageSize;
                        let page = pages.get(index);
                        if (!page) { page = new Uint8Array(pageSize); pages.set(index, page); }
                        const count = Math.min(pageSize - within, data.byteLength - offset);
                        page.set(data.subarray(offset, offset + count), within); offset += count;
                    }
                    size = Math.max(size, end);
                } }), { chunked: false });
                // Event listeners are observers: Mediabunny swallows their exceptions. Record an error and
                // reject operations/stream writes explicitly instead of relying on a throwing listener.
                target.on('write', ({ end }) => {
                    if (context.maxOutputBytes !== undefined && end > context.maxOutputBytes) outputError ??= new RangeError('MP4 maxOutputBytes exceeded');
                });
                source = new EncodedVideoPacketSource('avc');
                // Write media incrementally. Avoid fastStart in-memory accumulation and frameRate snapping.
                output = new Output({ format: new Mp4OutputFormat({ fastStart: false }), target });
                output.addVideoTrack(source); await output.start(); guard();
                context.signal.addEventListener('abort', dispose, { once: true }); guard();
            } catch (error) { dispose(); throw error; }
            return {
                async write(event) {
                    guard(); if (ended) throw new Error('MP4 video track already ended');
                    if (event.type === 'config' && event.track === 'video') {
                        if (!event.config.description?.byteLength) throw new Error('MP4 requires an AVCDecoderConfigurationRecord');
                        description = { ...event.config, description: event.config.description.slice(), color: { ...event.config.color } }; return;
                    }
                    if (event.type === 'end' && event.track === 'video') { ended = true; return; }
                    if (event.type !== 'packet' || event.packet.track !== 'video' || !description) throw new Error('MP4 requires configured video packets');
                    const p = event.packet, nextEnd = p.timestampUs + p.durationUs;
                    if (p.timestampUs !== endUs || p.decodeTimestampUs !== p.timestampUs) throw new Error('MP4 requires contiguous, non-reordered video');
                    const first = ticks(p.timestampUs), last = ticks(nextEnd), delta = last - first;
                    if (delta <= 0 || delta > 0xffff_ffff) throw new RangeError('MP4 frame interval cannot be represented in the 57600 Hz timebase');
                    if (context.maxOutputBytes !== undefined && p.data.byteLength > context.maxOutputBytes - mediaBytes) throw new RangeError('MP4 maxOutputBytes exceeded');
                    mediaBytes += p.data.byteLength;
                    await source!.add(new EncodedPacket(p.data, p.type, first / TIMESCALE, delta / TIMESCALE), { decoderConfig: {
                        codec: description.codec, codedWidth: description.width, codedHeight: description.height, description: description.description as Uint8Array<ArrayBuffer>,
                        colorSpace: description.color as VideoColorSpaceInit
                    } });
                    guard(); frames++; endUs = nextEnd;
                },
                async finalize(timeline) {
                    guard();
                    if (!ended || frames !== timeline.videoFrames || endUs !== timeline.durationUs || timeline.audioPresentationSamples !== undefined) throw new Error('MP4 final timeline does not match written video');
                    await output!.finalize(); guard();
                    if (!size) throw new Error('MP4 output buffer missing');
                    const parts: Uint8Array<ArrayBuffer>[] = [];
                    for (let offset = 0; offset < size; offset += pageSize) {
                        parts.push(pages.get(offset / pageSize)!.subarray(0, Math.min(pageSize, size - offset)));
                    }
                    const blob = new Blob(parts, { type: 'video/mp4' }); pages.clear();
                    return blob;
                },
                dispose
            };
        }
    };
}
