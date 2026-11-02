import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { inspectOfflineVideo, mp4Headers } from './helpers/offline-video.mjs';

const rate = 57_600;
const tick = us => Math.round(us * rate / 1e6);
const colors = [[235,30,30], [30,220,30], [30,30,235], [0,0,0], [255,255,255]];

async function exportVideo(page, durations, delayMs = 0) {
    await page.goto('/');
    return page.evaluate(async ({ durations, delayMs, colors }) => {
        const { createOfflineVideoExporter } = await import('/dist/video.js');
        const { createWebCodecsVideoEncoder } = await import('/dist/video-webcodecs.js');
        const { createMp4Muxer } = await import('/dist/video-mp4.js');
        const config = { codec: 'avc1.42E01F', bitstreamFormat: 'avc', width: 90, height: 160, bitrate: 500_000,
            frameRateHint: { numerator: 30_000, denominator: 1001 } };
        const encoder = createWebCodecsVideoEncoder();
        const support = await encoder.checkSupport(config);
        if (!support.supported) return { unsupported: support.reason };
        const canvas = document.createElement('canvas'); canvas.width = 90; canvas.height = 160;
        const ctx = canvas.getContext('2d'), progress = [];
        const exporter = await createOfflineVideoExporter({ video: { encoder, config }, muxer: createMp4Muxer(),
            maxPendingInputs: 1, maxPendingBytes: 1_000_000, maxOutputBytes: 4_000_000, onProgress: p => progress.push(p) });
        try {
            let time = 0;
            for (let i = 0; i < durations.length; i++) {
                ctx.fillStyle = `rgb(${colors[i % colors.length].join(',')})`; ctx.fillRect(0, 0, 90, 160);
                if (delayMs) await new Promise(r => setTimeout(r, delayMs));
                await exporter.addFrame(canvas, { timestampUs: time, durationUs: durations[i], keyFrame: i % 10 === 0 }); time += durations[i];
            }
            const result = await exporter.finish();
            const url = URL.createObjectURL(result.blob), video = document.createElement('video'); video.muted = true;
            try {
                video.src = url;
                await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('MP4 playback failed')); });
                const duration = video.duration;
                const ended = new Promise((resolve, reject) => { video.onended = resolve; video.onerror = () => reject(new Error('MP4 playback failed')); });
                video.playbackRate = 4; await video.play(); await ended;
                return { bytes: [...new Uint8Array(await result.blob.arrayBuffer())], durationUs: result.durationUs, frames: result.videoFrames,
                    mimeType: result.mimeType, extension: result.extension, codec: result.videoCodec, duration, progress: progress.at(-1) };
            } finally { video.pause(); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); }
        } finally { exporter.dispose(); }
    }, { durations, delayMs, colors });
}

async function verify(testInfo, result, durations, name) {
    // Chromium is the required integration target in CI. Other browsers explicitly report unsupported configurations.
    if (result.unsupported) {
        expect(testInfo.project.name, result.unsupported).not.toBe('chromium');
        test.skip(true, result.unsupported);
    }
    const bytes = Buffer.from(result.bytes), path = testInfo.outputPath(name + '.mp4'); await writeFile(path, bytes);
    await testInfo.attach(name, { path, contentType: 'video/mp4' });
    const inspected = await inspectOfflineVideo(path), headers = mp4Headers(bytes);
    const boundaries = [0]; for (const d of durations) boundaries.push(boundaries.at(-1) + d);
    expect(inspected.timebase).toEqual([1, rate]); expect(inspected.packets).toHaveLength(durations.length);
    expect(headers.topLevel).toContain('ftyp'); expect(headers.tracks).toEqual([{ type: 'vide', timescale: rate, duration: tick(boundaries.at(-1)) }]);
    expect(headers.movie).toEqual({ timescale: rate, duration: tick(boundaries.at(-1)) });
    for (let i = 0; i < durations.length; i++) {
        expect(inspected.packets[i].pts).toBe(tick(boundaries[i])); expect(inspected.packets[i].dts).toBe(tick(boundaries[i]));
        expect(inspected.packets[i].duration).toBe(tick(boundaries[i + 1]) - tick(boundaries[i]));
        expect(Math.abs(inspected.ptsUs[i] - tick(boundaries[i]) * 1e6 / rate)).toBeLessThan(6);
        for (let c = 0; c < 3; c++) expect(Math.abs(inspected.colors[i][c] - colors[i % colors.length][c])).toBeLessThan(30);
    }
    expect(result.durationUs).toBe(boundaries.at(-1)); expect(result.frames).toBe(durations.length);
    expect(result.mimeType).toBe('video/mp4'); expect(result.extension).toBe('mp4'); expect(result.codec).toBe('avc1.42E01F');
    expect(Math.abs(result.duration * 1e6 - boundaries.at(-1))).toBeLessThan(1e6 / rate + 1);
    expect(result.progress.phase).toBe('finished'); expect(result.progress.videoPacketsWritten).toBe(durations.length);
    expect(result.progress.audioPacketsWritten).toBe(0);
    await writeFile(testInfo.outputPath(name + '-inspection.json'), JSON.stringify({ headers, packets: inspected.packets, colors: inspected.colors, durationUs: result.durationUs }, null, 2));
    return inspected.packets;
}

test('real offline AVC/MP4 preserves variable intervals, colors, portrait size and final hold', async ({ page }, testInfo) => {
    const durations = [33_333, 33_334, 123_457, 10_000, 700_001];
    await verify(testInfo, await exportVideo(page, durations), durations, 'variable-final-hold');
});

test('fractional timeline is identical with delayed rendering and has no accumulated drift', async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const boundary = i => Math.round(i * 1e6 * 1001 / 30_000);
    const durations = Array.from({ length: 60 }, (_, i) => boundary(i + 1) - boundary(i)); durations.push(500_001);
    const fast = await verify(testInfo, await exportVideo(page, durations), durations, 'fractional-fast');
    const slow = await verify(testInfo, await exportVideo(page, durations, 4), durations, 'fractional-delayed');
    expect(slow.map(({ pts, dts, duration }) => ({ pts, dts, duration }))).toEqual(fast.map(({ pts, dts, duration }) => ({ pts, dts, duration })));
});

test('real codec cancellation and MP4 size failure close resources; a fresh export works', async ({ page }, testInfo) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const { createOfflineVideoExporter } = await import('/dist/video.js');
        const { createWebCodecsVideoEncoder } = await import('/dist/video-webcodecs.js');
        const { createMp4Muxer } = await import('/dist/video-mp4.js');
        const config = { codec: 'avc1.42E01F', bitstreamFormat: 'avc', width: 90, height: 160, bitrate: 500000 };
        const encoder = createWebCodecsVideoEncoder(), support = await encoder.checkSupport(config);
        if (!support.supported) return { unsupported: support.reason };
        const Native = VideoEncoder, resources = [];
        globalThis.VideoEncoder = class extends Native { constructor(init) { super(init); resources.push(this); } };
        const canvas = document.createElement('canvas'); canvas.width = 90; canvas.height = 160;
        canvas.getContext('2d').fillRect(0,0,90,160);
        const outcomes = [];
        try {
            for (const mode of ['abort', 'limit', 'retry']) {
                const controller = new AbortController(); let exporter;
                try {
                    exporter = await createOfflineVideoExporter({ video: { encoder, config }, muxer: createMp4Muxer(), signal: controller.signal,
                        ...(mode === 'limit' ? { maxOutputBytes: 500 } : {}),
                        onProgress(p) { if (mode === 'abort' && p.videoPacketsWritten) controller.abort(new Error('requested stop')); } });
                    await exporter.addFrame(canvas, { timestampUs: 0, durationUs: 100000 });
                    await exporter.finish(); outcomes.push(mode + ':ok');
                } catch (e) { outcomes.push(mode + ':' + [e.message, e.cause?.message, e.cause?.cause?.message].filter(Boolean).join('/')); }
                finally { exporter?.dispose(); }
            }
            return { outcomes, states: resources.map(r => r.state), unsupportedAudio: await createMp4Muxer().checkSupport({ video: config, audio: { codec:'mp4a.40.2',bitstreamFormat:'aac',sampleRate:48000,numberOfChannels:1,bitrate:128000 } }) };
        } finally { globalThis.VideoEncoder = Native; }
    });
    if (result.unsupported) { expect(testInfo.project.name, result.unsupported).not.toBe('chromium'); test.skip(true, result.unsupported); }
    expect(result.outcomes[0]).toContain('requested stop'); expect(result.outcomes[1]).toContain('maxOutputBytes'); expect(result.outcomes[2]).toBe('retry:ok');
    expect(result.states).toEqual(['closed','closed','closed']); expect(result.unsupportedAudio.supported).toBe(false);
});

test('offline example exports a playable five-second file and clears stale output on a failed retry', async ({ page }, testInfo) => {
    await page.goto('/examples/offline-video.html');
    const support = await page.evaluate(async () => {
        const { createWebCodecsVideoEncoder } = await import('/dist/video-webcodecs.js');
        return createWebCodecsVideoEncoder().checkSupport({ codec:'avc1.42E01F',bitstreamFormat:'avc',width:360,height:640,bitrate:2000000 });
    });
    if (!support.supported) { expect(testInfo.project.name, support.reason).not.toBe('chromium'); test.skip(true, support.reason); }
    await page.getByRole('button', { name:'Export MP4',exact:true }).click();
    await expect(page.locator('#download')).toBeVisible({ timeout:30000 });
    await expect(page.locator('#status')).toContainText('120 frames, 5 s');
    const metadata = await page.locator('video').evaluate(async video => {
        if (!video.readyState) await new Promise((resolve,reject) => { video.onloadedmetadata=resolve;video.onerror=reject; });
        return { duration:video.duration,width:video.videoWidth,height:video.videoHeight };
    });
    expect(metadata).toEqual({ duration:5,width:360,height:640 });
    await page.locator('#codec').fill('avc1.64001F');
    await page.getByRole('button', { name:'Export MP4',exact:true }).click();
    await expect(page.locator('#status')).toContainText('Baseline'); await expect(page.locator('#download')).toBeHidden();
    expect(await page.locator('video').getAttribute('src')).toBeNull();
    await expect(page.getByRole('button', { name:'Export MP4',exact:true })).toBeEnabled();
});
