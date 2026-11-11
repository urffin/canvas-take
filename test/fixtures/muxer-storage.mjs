import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { patchWebmMuxer } from '../../scripts/webm-muxer-patch.mjs';

const compiled = new Map(), pageSize = 65536;
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Observe the existing sink in an isolated bundle; never add production test hooks or another stream queue.
export async function storageHarness(kind, { real = false, maxOutputBytes, maxPendingBytes = 1000000, header = [1, 2, 3, 4], finalWrites } = {}) {
    const key = kind + '/' + real;
    if (!compiled.has(key)) compiled.set(key, (async () => (await build({
        entryPoints: [fileURLToPath(new URL(`../../src/video-${kind}.ts`, import.meta.url))],
        bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2022',
        external: real ? [] : ['mediabunny'],
        plugins: real ? [{ name: 'real-pinned-webm', setup(b) {
            b.onLoad({ filter: /[\\/]matroska[\\/]matroska-muxer\.js$/ }, async ({ path }) => ({
                contents: patchWebmMuxer((await readFile(path, 'utf8')).replaceAll('\r\n', '\n').replace(/^\/\/# sourceMappingURL=.*$/gm, '')),
                loader: 'js', resolveDir: dirname(path)
            }));
        } }] : []
    })).outputFiles[0].text)());
    const writes = [], pages = [], streams = [], outputs = [], signal = new AbortController();
    let sink, target;
    const Bytes = new Proxy(Uint8Array, { construct(ctor, args) {
        const value = Reflect.construct(ctor, args, ctor);
        if (args.length === 1 && args[0] === pageSize) pages.push({ array: new WeakRef(value), buffer: new WeakRef(value.buffer) });
        return value;
    } });
    const Streams = new Proxy(WritableStream, { construct(ctor, [underlying, ...rest]) {
        if (underlying?.write) {
            sink = underlying;
            const receiver = underlying, write = underlying.write;
            underlying = { ...underlying, write(chunk) {
                writes.push({ position: chunk.position, data: Uint8Array.from(chunk.data) });
                return Reflect.apply(write, receiver, [chunk]);
            } };
        }
        const stream = Reflect.construct(ctor, [underlying, ...rest], ctor); streams.push(stream); return stream;
    } });
    class Target {
        listeners = new Map();
        constructor(stream) { this.writer = stream.getWriter(); target = this; }
        on(type, callback) { this.listeners.set(type, callback); }
        emit(end) { this.listeners.get('write')?.({ end }); }
        write(position, data) { this.emit(position + data.length); return this.writer.write({ position, data }); }
    }
    class Output {
        state = 'pending'; next = header.length; cancellations = 0; closed = false;
        constructor(options) { this.target = options.target; outputs.push(this); }
        addVideoTrack(source) { source.output = this; }
        addAudioTrack(source) { source.output = this; }
        async start() { this.state = 'started'; await this.target.write(0, new Uint8Array(header)); }
        async add(data) { const at = this.next; this.next += data.length; await this.target.write(at, data); }
        async finalize() {
            for (const item of finalWrites ?? [{ position: this.next, data: new Uint8Array([9, 8, 7, 6]) }]) await this.target.write(item.position, item.data);
            await this.target.writer.close(); this.closed = true; this.state = 'finalized';
        }
        async cancel() { this.cancellations++; this.state = 'canceled'; await this.target.writer.close(); this.closed = true; }
    }
    class Source { async add(packet) { await this.output.add(packet.data); } close() {} }
    class Packet { constructor(data, type, timestamp, duration) { Object.assign(this, { data, type, timestamp, duration }); } }
    class Format {}
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [Date.UTC(2025, 0, 1)])); }
        static now() { return Date.UTC(2025, 0, 1); }
    }
    const math = Object.create(Math); math.random = () => 0.25;
    const module = { exports: {} };
    runInNewContext(await compiled.get(key), { module, exports: module.exports,
        require(name) { assert.equal(name, 'mediabunny'); return { Output, StreamTarget: Target, Mp4OutputFormat: Format, WebMOutputFormat: Format,
            EncodedVideoPacketSource: Source, EncodedAudioPacketSource: Source, EncodedPacket: Packet }; },
        Uint8Array: Bytes, ArrayBuffer, DataView, Blob, WritableStream: Streams, ReadableStream, TransformStream,
        TextEncoder, TextDecoder, DOMException, AbortController, EventTarget, Event, URL, performance,
        setTimeout, clearTimeout, queueMicrotask, Date: FixedDate, Math: math, console
    });
    const factory = module.exports[kind === 'mp4' ? 'createMp4Muxer' : 'createWebmMuxer']();
    return { factory, signal, pages, writes, streams, outputs,
        get sink() { return sink; }, get target() { return target; },
        context: { signal: signal.signal, maxPendingInputs: 2, maxPendingBytes, ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) } };
}

export function mediaInput(kind, withAudio = false, large = false) {
    const video = { codec: kind === 'mp4' ? 'avc1.42E01F' : 'vp8', bitstreamFormat: kind === 'mp4' ? 'avc' : 'vp8', width: 2, height: 2, bitrate: 10000 };
    const audio = { codec: kind === 'mp4' ? 'mp4a.40.2' : 'opus', bitstreamFormat: kind === 'mp4' ? 'aac' : 'opus', sampleRate: 48000, numberOfChannels: 1, bitrate: 128000 };
    const color = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
    const config = { video, ...(withAudio ? { audio } : {}) };
    const events = [{ type: 'config', track: 'video', config: { ...video, color,
        ...(kind === 'mp4' ? { description: new Uint8Array([1, 66, 192, 31, 255, 225, 0]) } : {}) } }];
    if (withAudio) events.push({ type: 'config', track: 'audio', config: { ...audio, description: kind === 'mp4'
        ? new Uint8Array([0x11, 0x88]) : new Uint8Array([79,112,117,115,72,101,97,100,1,1,56,1,128,187,0,0,0,0,0]) } });
    for (const [i, duration] of [10000, 30000].entries()) {
        const data = Uint8Array.from({ length: large ? (i ? 3301 : 70003) : 1 }, (_, p) => (p * 37 + i * 19) % 256);
        if (kind === 'webm' && large) data.set([16,0,0,157,1,42,2,0,2,0]);
        events.push({ type: 'packet', packet: { track: 'video', timestampUs: i ? 10000 : 0, decodeTimestampUs: i ? 10000 : 0, durationUs: duration, type: 'key', data } });
    }
    if (withAudio) {
        const frame = kind === 'mp4' ? 1024 : 960, leading = kind === 'mp4' ? 1024 : 312, count = 1920;
        const us = n => Math.sign(n) * Math.round(Math.abs(n) * 1e6 / 48000);
        let end = -leading;
        while (end < count) {
            const start = end; end += frame;
            events.push({ type: 'packet', packet: { track: 'audio', timestampUs: us(start), decodeTimestampUs: us(start), durationUs: us(end) - us(start), type: 'key', data: new Uint8Array([152, 0]) } });
        }
        events.push({ type: 'end', track: 'audio', presentationSamples: count, leadingDiscardSamples: leading, trailingDiscardSamples: end - count });
    }
    events.push({ type: 'end', track: 'video' });
    return { config, events, timeline: { durationUs: 40000, videoFrames: 2, ...(withAudio ? { audioPresentationSamples: 1920 } : {}) } };
}

export async function writeInput(harness, input) {
    const muxer = await harness.factory.create(input.config, harness.context);
    try { for (const event of input.events) await muxer.write(event); return { muxer, blob: await muxer.finalize(input.timeline) }; }
    catch (error) { muxer.dispose(); throw error; }
}

export function traceSummary(writes, bytes) {
    let end = 0, rewinds = 0;
    const trace = writes.map(write => { if (write.position < end) rewinds++; end = Math.max(end, write.position + write.data.length);
        return { position: write.position, bytes: write.data.length, sha256: digest(write.data) }; });
    return { bytes: bytes.length, sha256: digest(bytes), rewinds, trace };
}
