import { test, expect } from '@playwright/test';

test('video example pauses past the budget and resumes to a downloadable result', async ({ page }) => {
    await page.goto('/examples/video.html');
    await page.getByLabel('Maximum active duration').fill('1000');
    await page.getByRole('button', { name: 'Record', exact: true }).click();
    const pause = page.getByRole('button', { name: 'Pause', exact: true });
    await expect(pause).toBeEnabled(); await pause.click();
    await expect(page.getByRole('status')).toHaveText('paused');
    await page.waitForTimeout(1200); // Deliberately exceed the budget while paused.
    await expect(page.getByRole('status')).toHaveText('paused');
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Download video' })).toBeVisible({ timeout: 15000 });
    const result = JSON.parse(await page.getByRole('status').textContent());
    expect(result.stopReason).toBe('duration-limit'); expect(result.bytes).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Record', exact: true })).toBeEnabled();
});

for (const mimeType of ['video/webm;codecs=vp8,opus', 'video/mp4;codecs=avc1,mp4a.40.2']) {
    for (const mode of ['limit', 'stop-paused']) test(`${mimeType}: ${mode} preserves audio and excludes pauses`, async ({ page }, testInfo) => {
        await page.goto('/');
        const supported = await page.evaluate(mime => MediaRecorder.isTypeSupported(mime), mimeType);
        test.skip(!supported, 'Requested encoder is not available in this browser');
        const result = await page.evaluate(async ({ mimeType, mode }) => {
            const { createCanvasRecorder } = await import('/dist/index.js');
            const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 90;
            const ctx = canvas.getContext('2d');
            const audio = new AudioContext(); await audio.resume();
            const destination = audio.createMediaStreamDestination(), oscillator = audio.createOscillator();
            oscillator.connect(destination); oscillator.start();
            const source = destination.stream.getAudioTracks()[0];
            const captured = [], clones = [], clone = source.clone.bind(source), capture = canvas.captureStream.bind(canvas);
            source.clone = () => { const track = clone(); clones.push(track); return track; };
            canvas.captureStream = fps => { const stream = capture(fps); captured.push(stream); return stream; };
            let timer, recorder, url;
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            try {
                let frame = 0;
                const draw = () => { ctx.fillStyle = frame++ % 2 ? '#ff0000' : '#00ff00'; ctx.fillRect(0, 0, 160, 90); };
                draw(); timer = setInterval(draw, 30);
                recorder = createCanvasRecorder(canvas, { fps: 30, mimeType, audioTracks: [source], maxDurationMs: 1500 });
                const wallStart = performance.now();
                await recorder.start(); await sleep(300); await recorder.pause();
                const pausedState = recorder.state;
                await sleep(1700); // Longer than the entire active-time budget.
                const stillPaused = recorder.state;
                if (mode === 'limit') {
                    await recorder.resume(); await sleep(250); await recorder.pause(); await sleep(200); await recorder.resume();
                }
                const result = mode === 'limit' ? await recorder.finished : await recorder.stop();
                const wallMs = performance.now() - wallStart;
                const ownedEnded = captured.every(stream => stream.getTracks().every(t => t.readyState === 'ended'));
                const originalState = source.readyState;
                url = URL.createObjectURL(result.blob);
                const video = document.createElement('video'); video.src = url;
                await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(Error('Recorded video cannot be decoded')); });
                // Playback also exercises audio decoding. Connect it to an analyser, not speakers.
                const analyser = audio.createAnalyser(); analyser.fftSize = 2048;
                audio.createMediaElementSource(video).connect(analyser);
                const ended = new Promise((resolve, reject) => { video.onended = resolve; video.onerror = () => reject(Error('Recorded video playback failed')); });
                await video.play();
                let audioPeak = 0;
                for (let i = 0; i < 10; i++) {
                    await sleep(20); const samples = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(samples);
                    audioPeak = Math.max(audioPeak, ...samples.map(Math.abs));
                }
                await ended;
                return { mime: result.mimeType, reason: result.stopReason, durationMs: result.durationMs, wallMs,
                    pausedState, stillPaused, originalState, ownedEnded, clonesEnded: clones.every(t => t.readyState === 'ended'),
                    width: video.videoWidth, height: video.videoHeight, audioPeak,
                    fileDuration: Number.isFinite(video.duration) ? video.duration : null,
                    playedDurationMs: video.currentTime * 1000,
                    bytes: Array.from(new Uint8Array(await result.blob.arrayBuffer())) };
            } finally {
                clearInterval(timer); recorder?.dispose(); oscillator.stop(); destination.stream.getTracks().forEach(t => t.stop());
                if (url) URL.revokeObjectURL(url); await audio.close();
            }
        }, { mimeType, mode });
        expect(result.pausedState).toBe('paused'); expect(result.stillPaused).toBe('paused');
        expect(result.reason).toBe(mode === 'limit' ? 'duration-limit' : 'manual');
        expect(result.durationMs).toBeGreaterThan(mode === 'limit' ? 1400 : 200);
        expect(result.durationMs).toBeLessThan(mode === 'limit' ? 2400 : 1300);
        expect(result.wallMs - result.durationMs).toBeGreaterThan(1600);
        expect([result.width, result.height]).toEqual([160, 90]);
        expect(result.originalState).toBe('live'); expect(result.ownedEnded).toBe(true); expect(result.clonesEnded).toBe(true);
        expect(result.audioPeak).toBeGreaterThan(0.01);
        expect(result.playedDurationMs).toBeGreaterThan(mode === 'limit' ? 1000 : 100);
        expect(result.playedDurationMs).toBeLessThan(mode === 'limit' ? 2400 : 1300);
        await testInfo.attach('recording', { body: Buffer.from(result.bytes), contentType: result.mime });
        await testInfo.attach('metrics', { body: JSON.stringify({ ...result, bytes: result.bytes.length }, null, 2), contentType: 'application/json' });
    });
}
