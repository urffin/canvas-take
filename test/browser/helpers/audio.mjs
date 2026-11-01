// Fail with an actionable error instead of timing out in a stopped audio clock.
// This does not fake audio or weaken the recording assertions.
export async function startAudioClock(audio) {
    let timeout, cancelled = false;
    try {
        await Promise.race([
            (async () => {
                await audio.resume();
                const startedAt = audio.currentTime;
                while (!cancelled && audio.currentTime <= startedAt) await new Promise(resolve => setTimeout(resolve, 10));
            })(),
            new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`AudioContext clock did not start (state=${audio.state}); check the runner's audio output`)), 5000); })
        ]);
    } finally { cancelled = true; clearTimeout(timeout); }
}
