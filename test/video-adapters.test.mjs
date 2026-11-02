import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createWebCodecsVideoEncoder } from '../dist/video-webcodecs.js';
import { createMp4Muxer } from '../dist/video-mp4.js';

const config = { codec: 'avc1.42E01F', bitstreamFormat: 'avc', width: 2, height: 2, bitrate: 1000 };
const raw = { data: new Uint8ClampedArray(16).fill(255), width: 2, height: 2, timestampUs: 0, durationUs: 100001, keyFrame: true };
const settle = () => new Promise(resolve => setImmediate(resolve));

function nativeFixture(mode = 'valid') {
    const oldEncoder = globalThis.VideoEncoder, oldFrame = globalThis.VideoFrame;
    const frames = [], encoders = [];
    class Frame {
        constructor(data, init) { this.init = init; this.closed = 0; frames.push(this); }
        close() { this.closed++; }
    }
    class Encoder {
        state = 'unconfigured'; closed = 0;
        static async isConfigSupported(config) { return { supported: true, config }; }
        constructor(init) { this.init = init; encoders.push(this); }
        configure(config) { this.config = config; this.state = 'configured'; if (mode === 'configure-failure') throw new Error('configure failed'); }
        encode(frame) { this.frame = frame; }
        async flush() {
            if (!this.frame) return;
            const frame = this.frame; this.frame = undefined;
            if (mode === 'missing') return;
            if (mode === 'native-error') { this.init.error(new Error('native error')); return; }
            const d = { codec: this.config.codec, codedWidth: 2, codedHeight: 2,
                description: new Uint8Array([1, mode === 'high-profile' ? 100 : 66, 192, 31, 255, 225, 0]),
                colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false } };
            if (mode === 'missing-color') delete d.colorSpace;
            const vp8 = new Uint8Array([16,0,0,157,1,42,mode === 'vp8-dimensions' ? 4 : 2,0,2,0]);
            if (mode === 'vp8-hidden') vp8[0] = 0;
            if (mode === 'vp8-version') vp8[0] |= 2;
            if (mode === 'vp8-key') vp8[0] |= 1;
            if (this.config.codec === 'vp8') delete d.description;
            this.init.output({ timestamp: mode === 'timestamp' ? 1 : frame.init.timestamp, duration: 1,
                type: mode === 'non-key' ? 'delta' : 'key', byteLength: this.config.codec === 'vp8' ? vp8.length : mode === 'oversize' ? 10000 : 2,
                copyTo(data) { if (d.codec === 'vp8') data.set(vp8); else data.fill(7); } }, mode === 'missing-description' ? {} : { decoderConfig: d });
        }
        close() { this.closed++; this.state = 'closed'; }
    }
    globalThis.VideoEncoder = Encoder; globalThis.VideoFrame = Frame;
    return { frames, encoders, restore() { globalThis.VideoEncoder = oldEncoder; globalThis.VideoFrame = oldFrame; } };
}
function context(overrides = {}) {
    return { signal: new AbortController().signal, maxPendingInputs: 1, maxPendingBytes: 1024,
        output: { async write() {}, fail() {} }, ...overrides };
}

test('optional adapters import without browser globals; support rejects unavailable or mismatched profiles', async () => {
    assert.equal((await createWebCodecsVideoEncoder().checkSupport(config)).supported, false);
    const native = nativeFixture();
    try {
        assert.equal((await createWebCodecsVideoEncoder().checkSupport(config)).supported, true);
        for (const invalid of [{ codec: 'avc1.64001F' }, { bitstreamFormat: 'annexb' }, { width: 3 }, { height: 0 }]) {
            assert.equal((await createWebCodecsVideoEncoder().checkSupport({ ...config, ...invalid })).supported, false);
        }
        const muxer = createMp4Muxer(); assert.equal((await muxer.checkSupport({ video: config })).supported, true);
        assert.equal((await muxer.checkSupport({ video: config, audio: {} })).supported, false);
        assert.equal((await muxer.checkSupport({ video: { ...config, codec: 'vp8' } })).supported, false);
        assert.equal(native.encoders.length, 0);
    } finally { native.restore(); }
});

test('VP8 preserves submitted timing without avcC and rejects invisible/version/key/dimension mismatches', async () => {
    const vp8 = { ...config, codec: 'vp8', bitstreamFormat: 'vp8' };
    for (const mode of ['valid','vp8-hidden','vp8-version','vp8-key','vp8-dimensions']) {
        const native = nativeFixture(mode), events = [];
        try {
            const encoder = createWebCodecsVideoEncoder().create(vp8, context({ output: { async write(e) { events.push(e); }, fail() {} } }));
            if (mode === 'valid') {
                await encoder.encodeFrame(raw); await encoder.flush();
                assert.equal(events[0].config.description, undefined);
                assert.equal(events[1].packet.durationUs, raw.durationUs);
                assert.equal(native.encoders[0].config.avc, undefined);
            } else await assert.rejects(encoder.encodeFrame(raw), /VP8/);
            encoder.dispose(); encoder.dispose();
            assert.equal(native.encoders[0].closed, 1); assert.equal(native.frames[0].closed, 1);
        } finally { native.restore(); }
    }
});

test('native frame is always closed; submitted duration and actual color/avcC reach the sink', async () => {
    const native = nativeFixture(), events = [];
    try {
        const encoder = createWebCodecsVideoEncoder().create(config, context({ output: { async write(event) { events.push(event); }, fail(e) { throw e; } } }));
        await encoder.encodeFrame(raw); await encoder.flush(); encoder.dispose(); encoder.dispose();
        assert.deepEqual(events.map(e => e.type), ['config','packet','end']);
        assert.equal(events[1].packet.durationUs, raw.durationUs, 'Native duration is deliberately wrong; input interval is authoritative');
        assert.equal(events[0].config.color.fullRange, false); assert.equal(events[0].config.description[1], 66);
        assert.deepEqual([...events[1].packet.data], [7,7]);
        assert.equal(native.encoders[0].config.latencyMode, 'quality'); assert.equal(native.encoders[0].closed, 1);
        assert.equal(native.frames[0].closed, 1);
    } finally { native.restore(); }
});

test('native protocol errors and bounded callback output fail with no leaked native resources', async () => {
    for (const mode of ['high-profile','missing-color','missing-description','timestamp','non-key','oversize','missing','native-error']) {
        const native = nativeFixture(mode), errors = [];
        try {
            const encoder = createWebCodecsVideoEncoder().create(config, context({ output: { async write() {}, fail(e) { errors.push(e); } } }));
            await assert.rejects(encoder.encodeFrame(raw), undefined, mode); encoder.dispose();
            if (mode !== 'missing') assert.equal(errors.length, 1, mode);
            assert.equal(native.encoders[0].closed, 1, mode); assert.equal(native.frames[0].closed, 1, mode);
        } finally { native.restore(); }
    }
    const native = nativeFixture('configure-failure');
    try {
        assert.throws(() => createWebCodecsVideoEncoder().create(config, context()), /configure failed/);
        assert.equal(native.encoders[0].closed, 1);
    } finally { native.restore(); }
});

test('abort/dispose interrupts a blocked native output and suppresses late callbacks', async () => {
    const native = nativeFixture(), controller = new AbortController(), errors = [], writes = [];
    let release; const blocked = new Promise(resolve => { release = resolve; });
    try {
        const encoder = createWebCodecsVideoEncoder().create(config, context({ signal: controller.signal,
            output: { write(event) { writes.push(event); return blocked; }, fail(e) { errors.push(e); } } }));
        const encoding = encoder.encodeFrame(raw); await settle();
        controller.abort(new Error('stop now')); await assert.rejects(encoding, /stop now/);
        release(); await settle();
        native.encoders[0].init.output({}, {}); native.encoders[0].init.error(new Error('late'));
        assert.equal(writes.length, 1); assert.equal(errors.length, 0); assert.equal(native.encoders[0].closed, 1);
        assert.equal(native.frames[0].closed, 1); encoder.dispose();
    } finally { native.restore(); }
});

test('MP4 rejects unrepresentable intervals and invalid final timelines; output budget covers headers', async () => {
    const factory = createMp4Muxer();
    await assert.rejects(factory.create({ video: config }, context({ maxOutputBytes: 1 })), /maxOutputBytes/);
    await assert.rejects(factory.create({ video: config, audio: {} }, context()), /MP4 audio requires/);
    const muxer = await factory.create({ video: config }, context());
    try {
        await muxer.write({ type: 'config', track: 'video', config: { ...config, description: new Uint8Array([1]),
            color: { primaries:'bt709',transfer:'bt709',matrix:'bt709',fullRange:false } } });
        await assert.rejects(muxer.write({ type: 'packet', packet: { track:'video',timestampUs:0,decodeTimestampUs:0,durationUs:1,type:'key',data:new Uint8Array([1]) } }), /cannot be represented/);
        await assert.rejects(muxer.finalize({ durationUs:1000,videoFrames:1 }), /final timeline/);
    } finally { muxer.dispose(); muxer.dispose(); }
});

test('separate entries keep the controller and WebCodecs provider free of bundled muxer code', async () => {
    for (const entry of ['video', 'video-webcodecs', 'video-aac', 'video-opus']) {
        const result = await build({ entryPoints: [`dist/${entry}.js`], bundle: true, format:'esm',platform:'browser',write:false,metafile:true });
        assert.deepEqual(Object.keys(result.metafile.inputs), [`dist/${entry}.js`]);
    }
    const result = await build({ entryPoints:['dist/video-mp4.js'],bundle:true,format:'esm',platform:'browser',write:false,metafile:true });
    assert.deepEqual(result.metafile.outputs[Object.keys(result.metafile.outputs)[0]].imports, []);
});
