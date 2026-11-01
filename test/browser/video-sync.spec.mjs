import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { decodeMarkers, delayAudio } from './helpers/media-sync.mjs';

for (const mimeType of ['video/webm;codecs=vp8,opus', 'video/mp4;codecs=avc1,mp4a.40.2']) {
    for (const variant of ['library', 'native']) test(`${variant} ${mimeType}: decoded markers across two pauses`, async ({ page }, testInfo) => {
        await page.goto('/');
        test.skip(!await page.evaluate(mime => MediaRecorder.isTypeSupported(mime), mimeType), 'Requested encoder unavailable');
        await page.locator('canvas').click();
        const result = await page.evaluate(async ({ mimeType, variant }) => {
            const { createCanvasRecorder } = await import('/dist/index.js');
            const { startAudioClock } = await import('/test-audio.js');
            const audio = new AudioContext();
            try { await startAudioClock(audio); } catch (error) { await audio.close(); throw error; }
            const destination = audio.createMediaStreamDestination(), oscillator = audio.createOscillator(), gain = audio.createGain();
            gain.gain.value = 0; oscillator.frequency.value = 1000; oscillator.connect(gain).connect(destination); oscillator.start();
            const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
            const context = canvas.getContext('2d'), pulses = [], drawLagMs = [], expectedMarkersMs = [];
            let frame, recorder;
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            try {
                const draw = () => {
                    const now = audio.currentTime;
                    const marker = pulses.findIndex(start => now >= start && now < start + 0.18);
                    if (marker >= 0 && drawLagMs[marker] === undefined) drawLagMs[marker] = (now - pulses[marker]) * 1000;
                    context.fillStyle = marker >= 0 ? '#fff' : '#000';
                    context.fillRect(0, 0, 160, 90); frame = requestAnimationFrame(draw);
                };
                draw();
                if (variant === 'library') recorder = createCanvasRecorder(canvas, { fps: 30, mimeType, audioTracks: destination.stream.getAudioTracks() });
                else {
                    // Independent baseline: use native MediaRecorder directly, with the same producer.
                    const stream = canvas.captureStream(30);
                    stream.addTrack(destination.stream.getAudioTracks()[0].clone());
                    const native = new MediaRecorder(stream, { mimeType }), chunks = [];
                    native.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
                    let activeMs = 0, startedAt;
                    const invoke = (method, event) => new Promise((resolve, reject) => {
                        native.addEventListener(event, resolve, { once: true });
                        native.addEventListener('error', reject, { once: true });
                        if (method === 'start') native.start(1000); else native[method]();
                    });
                    recorder = {
                        async start() { await invoke('start', 'start'); startedAt = performance.now(); },
                        async pause() { await invoke('pause', 'pause'); activeMs += performance.now() - startedAt; },
                        async resume() { await invoke('resume', 'resume'); startedAt = performance.now(); },
                        async stop() {
                            activeMs += performance.now() - startedAt; await invoke('stop', 'stop');
                            return { blob: new Blob(chunks, { type: native.mimeType }), mimeType: native.mimeType, durationMs: activeMs };
                        },
                        dispose() { if (native.state !== 'inactive') native.stop(); stream.getTracks().forEach(track => track.stop()); }
                    };
                }
                await recorder.start();
                const wallStart = performance.now();
                let activeAudioSince = audio.currentTime, activeAudioMs = 0;
                for (let segment = 0; segment < 3; segment++) {
                    const base = audio.currentTime + 0.25;
                    for (const start of [base, base + 0.55]) {
                        expectedMarkersMs.push(activeAudioMs + (start - activeAudioSince) * 1000);
                        pulses.push(start); gain.gain.setValueAtTime(0.3, start); gain.gain.setValueAtTime(0, start + 0.18);
                    }
                    while (audio.currentTime < base + 1.05) await sleep(10);
                    if (segment < 2) {
                        await recorder.pause(); activeAudioMs += (audio.currentTime - activeAudioSince) * 1000;
                        await sleep(600); await recorder.resume(); activeAudioSince = audio.currentTime;
                    }
                }
                const recording = await recorder.stop(), wallMs = performance.now() - wallStart;
                cancelAnimationFrame(frame);
                const bytes = await recording.blob.arrayBuffer();
                return { variant, mimeType: recording.mimeType, activeMs: recording.durationMs, wallMs, drawLagMs, expectedMarkersMs,
                    bytes: Array.from(new Uint8Array(bytes)) };
            } finally {
                cancelAnimationFrame(frame); recorder?.dispose(); oscillator.stop();
                destination.stream.getTracks().forEach(track => track.stop()); await audio.close();
            }
        }, { mimeType, variant });
        const { bytes, ...recorded } = result;
        const recordingPath = testInfo.outputPath(mimeType.startsWith('video/mp4') ? 'sync.mp4' : 'sync.webm');
        await writeFile(recordingPath, Buffer.from(bytes));
        await testInfo.attach('recording', { path: recordingPath, contentType: result.mimeType });
        const decoded = await decodeMarkers(recordingPath);
        const audioRelativeMs = decoded.audioMarkersMs.map(time => time - decoded.audioMarkersMs[0]);
        const videoRelativeMs = decoded.videoMarkersMs.map(time => time - decoded.videoMarkersMs[0]);
        const expectedRelativeMs = result.expectedMarkersMs.map(time => time - result.expectedMarkersMs[0]);
        const metrics = { ...recorded, ...decoded, audioRelativeMs, videoRelativeMs, expectedRelativeMs,
            audioStartupLeadMs: decoded.audioMarkersMs[0] - result.expectedMarkersMs[0],
            videoStartupLeadMs: decoded.videoMarkersMs[0] - result.expectedMarkersMs[0] };
        const offsetsMs = decoded.videoMarkersMs.map((time, i) => time - decoded.audioMarkersMs[i]);
        const metricsPath = testInfo.outputPath('sync-metrics.json');
        const absoluteOffsetWithin120Ms = Math.max(...offsetsMs.map(Math.abs)) <= 120;
        await writeFile(metricsPath, JSON.stringify({ ...metrics, offsetsMs, absoluteOffsetWithin120Ms }, null, 2));
        await testInfo.attach('sync-metrics', { path: metricsPath, contentType: 'application/json' });
        expect(decoded.audioMarkersMs).toHaveLength(6); expect(decoded.videoMarkersMs).toHaveLength(6);
        expect(decoded.videoCodec).toBe(mimeType.startsWith('video/mp4') ? 'h264' : 'vp8');
        expect(decoded.audioCodec).toBe(mimeType.startsWith('video/mp4') ? 'aac' : 'opus');
        expect(result.drawLagMs).toHaveLength(6);
        // A pause must not add >80 ms of offset. Absolute capture/encoder startup offset
        // is retained as a diagnostic, alongside an independent native-recorder control.
        expect(Math.max(...offsetsMs) - Math.min(...offsetsMs)).toBeLessThanOrEqual(80);
        expect(result.wallMs - result.activeMs).toBeGreaterThan(1100);
        expect(Math.abs(decoded.audioEndMs - decoded.videoLastFrameMs)).toBeLessThan(250);
        // Streams can start at nonzero PTS or contain an initial video frame before
        // audio/MediaRecorder's start event. Compare active spans, not end PTS to a duration.
        expect(Math.max(...audioRelativeMs.map((value, i) => Math.abs(value - expectedRelativeMs[i])))).toBeLessThan(150);
        expect(Math.max(...videoRelativeMs.map((value, i) => Math.abs(value - expectedRelativeMs[i])))).toBeLessThan(150);
        const expectedTailMs = result.activeMs - result.expectedMarkersMs[0];
        expect(Math.abs(decoded.audioEndMs - decoded.audioMarkersMs[0] - expectedTailMs)).toBeLessThan(300);
        expect(Math.abs(decoded.videoLastFrameMs - decoded.videoMarkersMs[0] - expectedTailMs)).toBeLessThan(300);
        if (variant === 'library' && testInfo.project.name === 'chromium' && mimeType.startsWith('video/webm')) {
            // Negative control: remux a known bad copy with delayed audio. No re-encoding.
            const controlPath = testInfo.outputPath('delayed-audio.webm');
            await delayAudio(recordingPath, controlPath, 300);
            const control = await decodeMarkers(controlPath);
            expect(control.audioMarkersMs).toHaveLength(6); expect(control.videoMarkersMs).toHaveLength(6);
            const badOffsetsMs = control.videoMarkersMs.map((time, i) => time - control.audioMarkersMs[i]);
            expect(Math.max(...badOffsetsMs.map(Math.abs))).toBeGreaterThan(120);
            expect(Math.max(...badOffsetsMs.map((value, i) => Math.abs(value - offsetsMs[i] + 300)))).toBeLessThan(15);
            await testInfo.attach('negative-control', { body: JSON.stringify({ injectedAudioDelayMs: 300, badOffsetsMs }, null, 2), contentType: 'application/json' });
        }
    });
}
