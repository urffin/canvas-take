// Browser imports below resolve exclusively to the installed tarball's served assets.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseGIF, decompressFrames } from 'gifuct-js';
import { readWebm, decodeWebm } from '../../test/browser/helpers/offline-webm.mjs';
import { toneStarts } from '../../test/browser/helpers/offline-audio.mjs';

export async function verifyPackedFormats(page, output) {
    console.log('Packed providers: exporting VP8/Opus WebM');
    const webm = await page.evaluate(async () => {
        const { createOfflineVideoExporter } = await import('/package/video.js');
        const { createWebCodecsVideoEncoder } = await import('/package/video-webcodecs.js');
        const { createWebCodecsAudioEncoder } = await import('/package/video-opus.js');
        const { createWebmMuxer } = await import('/package/video-webm.js');
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'), rate = 48000, durationUs = 2450000;
        const markers = [0.25, 1, 1.75], pcm = new Float32Array(117600);
        for (let i = 0; i < pcm.length; i++) pcm[i] = 0.02 * Math.sin(i * 2 * Math.PI * 221 / rate)
            + (markers.some(t => i >= t * rate && i < (t + 0.04) * rate) ? 0.6 * Math.sin(i * 2 * Math.PI * 2003 / rate) : 0);
        const exporter = await createOfflineVideoExporter({
            video: { encoder: createWebCodecsVideoEncoder(), config: { codec: 'vp8', bitstreamFormat: 'vp8', width: 640, height: 360, bitrate: 1000000 } },
            audio: { encoder: createWebCodecsAudioEncoder(), config: { codec: 'opus', bitstreamFormat: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: 128000 },
                source: { sampleRate: rate, channels: [pcm] }, endPolicy: 'error' },
            muxer: createWebmMuxer(), maxFrames: 40, maxDurationUs: durationUs, maxOutputBytes: 16000000
        });
        try {
            for (let i = 0; i < 40; i++) {
                ctx.fillStyle = markers.some(t => i === t * 20) ? 'white' : '#102030'; ctx.fillRect(0, 0, 640, 360);
                await exporter.addFrame(canvas, { timestampUs: i * 50000, durationUs: i === 39 ? 500000 : 50000 });
            }
            const result = await exporter.finish(), video = document.createElement('video'), url = URL.createObjectURL(result.blob);
            video.muted = true;
            try {
                const ready = new Promise((yes, no) => { video.onloadedmetadata = yes; video.onerror = () => no(new Error('Packed WebM metadata failed')); });
                video.src = url; await ready;
                const metadata = { width: video.videoWidth, height: video.videoHeight, duration: video.duration };
                const ended = new Promise((yes, no) => { video.onended = yes; video.onerror = () => no(new Error('Packed WebM playback failed')); });
                video.playbackRate = 4; await video.play(); await ended;
                return { bytes: [...new Uint8Array(await result.blob.arrayBuffer())], metadata, frames: result.videoFrames,
                    samples: result.audioPresentationSamples, durationUs: result.durationUs, mime: result.mimeType, extension: result.extension };
            } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
        } finally { exporter.dispose(); }
    });
    const webmBytes = Buffer.from(webm.bytes), webmPath = join(output, 'vp8-opus.webm');
    await writeFile(webmPath, webmBytes);
    assert.equal(webm.frames, 40); assert.equal(webm.samples, 117600); assert.equal(webm.durationUs, 2450000);
    assert.equal(webm.mime, 'video/webm'); assert.equal(webm.extension, 'webm');
    assert.equal(webm.metadata.width, 640); assert.equal(webm.metadata.height, 360); assert.ok(Math.abs(webm.metadata.duration - 2.45) < .001);
    const layout = readWebm(webmBytes), decoded = await decodeWebm(webmPath, 1);
    assert.deepEqual(layout.tracks.map(t => t.codec).sort(), ['A_OPUS', 'V_VP8']);
    assert.equal(layout.scale, 1000); assert.equal(decoded.pts.length, 40);
    decoded.pts.forEach((t, i) => assert.equal(t, i * 50000));
    assert.equal(layout.blocks.findLast(b => b.track === layout.tracks.find(t => t.codec === 'V_VP8').number).duration, 500000);
    assert.equal(decoded.first, 0); assert.equal(decoded.containerSamples, 117600); assert.equal(decoded.planes[0].length, 117600);
    const flashes = decoded.pts.filter((t, i) => decoded.colors[i][0] > 200 && (i === 0 || decoded.colors[i - 1][0] < 200)).map(t => t / 1e6);
    const tones = toneStarts(decoded.planes[0], 48000);
    assert.equal(flashes.length, 3); assert.equal(tones.length, 3);
    const shifts = tones.map((t, i) => (t - flashes[i]) * 1000); assert.ok(shifts.every(t => Math.abs(t) < 3));
    const audio = layout.tracks.find(t => t.codec === 'A_OPUS');
    const webmMetrics = { bytes: webmBytes.length, metadata: webm.metadata, frames: webm.frames, samples: webm.samples,
        preSkip: audio.head.readUInt16LE(10), codecDelayNs: audio.delay, finalHoldUs: 500000, avShiftsMs: shifts };

    console.log('Packed providers: exporting GIF through sync and Worker adapters, with cancellation/retry');
    const gifs = await page.evaluate(async () => {
        const { createGifExporter } = await import('/package/gif.js');
        const { createGifencEncoder } = await import('/package/gifenc.js');
        const { createGifWorkerEncoder } = await import('/package/gif-worker.js');
        const NativeWorker = window.Worker; let constructed = 0, terminated = 0;
        window.Worker = class extends NativeWorker { constructor(...args) { super(...args); constructed++; } terminate() { terminated++; super.terminate(); } };
        const results = [], canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const ctx = canvas.getContext('2d'), alphas = [0, 1, 128, 254, 255], delays = [50, 70, 1000];
        try {
            for (const adapter of ['sync', 'worker']) {
                const factory = adapter === 'worker' ? createGifWorkerEncoder({ maxColors: 16 }) : createGifencEncoder({ maxColors: 16 });
                const controller = new AbortController(); let abortedDisposals = 0, abortedSubmissions = 0;
                const cancelled = createGifExporter({ signal: controller.signal, encoder(settings) { const real = factory(settings); return {
                    addFrame(frame) { abortedSubmissions++; return real.addFrame(frame); }, finish: () => real.finish(), dispose() { abortedDisposals++; real.dispose(); }
                }; } });
                const reason = new DOMException('Packed GIF cancelled', 'AbortError'), pending = cancelled.addFrame(canvas, 50);
                controller.abort(reason);
                try { await pending; throw new Error('Packed GIF ignored cancellation'); } catch (error) { if (error !== reason) throw error; }
                cancelled.dispose();
                const events = [], gif = createGifExporter({ encoder: factory, background: [20, 40, 60], repeat: 2, onProgress: p => events.push([p.phase, p.framesEncoded]) });
                try {
                    for (let frame = 0; frame < 3; frame++) {
                        const image = ctx.createImageData(320, 180);
                        for (let p = 0; p < 320 * 180; p++) { image.data[p * 4 + frame] = 255; image.data[p * 4 + 3] = alphas[p % 5]; }
                        ctx.putImageData(image, 0, 0); await gif.addFrame(canvas, delays[frame]);
                    }
                    const blob = await gif.finish();
                    results.push({ adapter, bytes: [...new Uint8Array(await blob.arrayBuffer())], events, abortedDisposals, abortedSubmissions });
                } finally { gif.dispose(); }
            }
            return { results, constructed, terminated };
        } finally { window.Worker = NativeWorker; }
    });
    assert.equal(gifs.constructed, 2); assert.equal(gifs.terminated, 2);
    const gifMetrics = [];
    for (const result of gifs.results) {
        assert.equal(result.abortedDisposals, 1); assert.equal(result.abortedSubmissions, 0);
        assert.deepEqual(result.events, [['encoding', 1], ['encoding', 2], ['encoding', 3], ['finalizing', 3], ['finished', 3]]);
        const bytes = Buffer.from(result.bytes), parsed = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        assert.deepEqual([parsed.lsd.width, parsed.lsd.height], [320, 180]);
        const frames = decompressFrames(parsed, true); assert.deepEqual(frames.map(f => f.delay), [50, 70, 1000]);
        const loop = parsed.frames.find(f => f.application)?.application; assert.equal(loop.blocks[1] + loop.blocks[2] * 256, 2);
        for (let f = 0; f < 3; f++) for (let p = 0; p < 320 * 180; p++) {
            const alpha = [0, 1, 128, 254, 255][p % 5] / 255;
            for (let c = 0; c < 3; c++) assert.ok(Math.abs(frames[f].patch[p * 4 + c] - Math.round((f === c ? 255 : 0) * alpha + [20, 40, 60][c] * (1 - alpha))) <= 8);
            assert.equal(frames[f].patch[p * 4 + 3], 255);
        }
        await writeFile(join(output, result.adapter + '.gif'), bytes);
        gifMetrics.push({ adapter: result.adapter, bytes: bytes.length, frames: 3, durationMs: 1120, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    assert.equal(gifMetrics[0].sha256, gifMetrics[1].sha256);
    const metrics = { webm: webmMetrics, gif: gifMetrics, gifWorkers: { constructed: gifs.constructed, terminated: gifs.terminated } };
    await writeFile(join(output, 'formats-metrics.json'), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify(metrics, null, 2));
    return metrics;
}
