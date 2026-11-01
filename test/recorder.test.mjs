import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvasRecorder } from "../dist/index.js";

class FakeRecorder extends EventTarget {
    static supported = ["video/webm;codecs=vp8"];
    static instances = [];
    static throwStart = false;
    static throwChange = false;
    static holdChanges = false;
    static isTypeSupported(type) { return this.supported.includes(type); }
    state = "inactive";
    constructor(stream, options) { super(); this.stream = stream; this.mimeType = options.mimeType; FakeRecorder.instances.push(this); }
    start() {
        if (FakeRecorder.throwStart) throw new Error("start failed");
        this.state = "recording";
        queueMicrotask(() => this.dispatchEvent(new Event("start")));
    }
    pause() {
        if (FakeRecorder.throwChange) throw new Error('pause failed');
        this.state = 'paused';
        if (!FakeRecorder.holdChanges) queueMicrotask(() => this.dispatchEvent(new Event('pause')));
    }
    resume() {
        if (FakeRecorder.throwChange) throw new Error('resume failed');
        this.state = 'recording';
        if (!FakeRecorder.holdChanges) queueMicrotask(() => this.dispatchEvent(new Event('resume')));
    }
    stop() {
        this.state = "inactive";
        queueMicrotask(() => {
            const event = new Event("dataavailable"); event.data = new Blob(["last chunk"], { type: this.mimeType });
            this.dispatchEvent(event); this.dispatchEvent(new Event("stop"));
        });
    }
}
globalThis.MediaRecorder = FakeRecorder;
function fixture() {
    const track = fakeTrack("video");
    const tracks = [track];
    const stream = { getTracks: () => [...tracks], getVideoTracks: () => tracks.filter(t => t.kind === "video"), addTrack: t => tracks.push(t) };
    return { track, stream, canvas: { width: 640, height: 360, captureStream: () => stream } };
}
function fakeTrack(kind = "audio") {
    const track = new EventTarget();
    Object.assign(track, { kind, readyState: "live", stopped: false, clones: [] });
    track.stop = () => { track.stopped = true; track.readyState = "ended"; };
    track.clone = () => { const clone = fakeTrack(kind); track.clones.push(clone); return clone; };
    track.end = () => { track.readyState = "ended"; track.dispatchEvent(new Event("ended")); };
    return track;
}
test("format selection, final chunk, repeated stop and cleanup", async () => {
    const { canvas, track } = fixture();
    const recorder = createCanvasRecorder(canvas, { fps: 30 });
    assert.equal(recorder.state, "idle");
    await recorder.start(); assert.equal(recorder.state, "recording");
    const first = recorder.stop(); assert.equal(first, recorder.stop());
    const result = await first;
    assert.equal(await result.blob.text(), "last chunk");
    assert.equal(result.mimeType, "video/webm;codecs=vp8");
    assert.equal(result.extension, "webm"); assert.ok(result.durationMs >= 0);
    assert.equal(recorder.state, "stopped"); assert.ok(track.stopped);
    assert.equal(await recorder.stop(), result);
    await assert.rejects(recorder.start()); recorder.dispose(); recorder.dispose();
    assert.equal(recorder.state, "disposed");
});
test("stop while start event is pending", async () => {
    const { canvas } = fixture(); const recorder = createCanvasRecorder(canvas, { fps: 30 });
    const start = recorder.start(); const stop = recorder.stop();
    await assert.rejects(recorder.pause(), /idle/);
    await start; assert.ok((await stop).blob.size);
});
test("dispose rejects unfinished operations and stops tracks", async () => {
    const { canvas, track } = fixture(); const recorder = createCanvasRecorder(canvas, { fps: 30 });
    const start = recorder.start(); const stop = recorder.stop(); recorder.dispose();
    await assert.rejects(start, /disposed/); await assert.rejects(stop, /disposed/); assert.ok(track.stopped);
});
test("recording and start errors reject and clean up", async () => {
    const { canvas, track } = fixture(); const recorder = createCanvasRecorder(canvas, { fps: 30 });
    await recorder.start(); FakeRecorder.instances.at(-1).dispatchEvent(new Event("error"));
    await assert.rejects(recorder.stop(), /failed/); assert.ok(track.stopped);
    FakeRecorder.throwStart = true;
    const second = fixture(); const failed = createCanvasRecorder(second.canvas, { fps: 30 });
    await assert.rejects(failed.start(), /start failed/); assert.ok(second.track.stopped);
    FakeRecorder.throwStart = false;
});
test("resize and unexpected track termination fail recording", async () => {
    for (const reason of ["resize", "ended"]) {
        const { canvas, track } = fixture(); const recorder = createCanvasRecorder(canvas, { fps: 30 });
        await recorder.start();
        if (reason === "resize") canvas.width++;
        else track.dispatchEvent(new Event("ended"));
        await assert.rejects(recorder.stop()); assert.ok(track.stopped);
    }
});
test("validation and unsupported MIME before capture", async () => {
    const { canvas } = fixture();
    for (const fps of [0, -1, Infinity, NaN]) assert.throws(() => createCanvasRecorder(canvas, { fps }), RangeError);
    assert.throws(() => createCanvasRecorder(canvas, { fps: 30, mimeType: "video/mp4" }), /Unsupported/);
    assert.throws(() => createCanvasRecorder(canvas, { fps: 30, mimeType: "audio/webm" }), /container/);
    await assert.rejects(createCanvasRecorder(canvas, { fps: 30 }).stop(), /not started/);
});

test("audio clones are recorded with Opus and originals survive stop", async () => {
    const supported = FakeRecorder.supported;
    FakeRecorder.supported = ["video/webm;codecs=vp8,opus"];
    try {
        const { canvas, track } = fixture();
        const audio = fakeTrack(); const inputs = [audio];
        const recorder = createCanvasRecorder(canvas, { fps: 30, audioTracks: inputs });
        inputs.length = 0; // The recorder snapshots the supplied list.
        await recorder.start();
        assert.deepEqual(FakeRecorder.instances.at(-1).stream.getTracks(), [track, audio.clones[0]]);
        const result = await recorder.stop();
        assert.equal(result.mimeType, "video/webm;codecs=vp8,opus");
        assert.ok(audio.clones[0].stopped); assert.ok(track.stopped);
        recorder.dispose(); assert.equal(audio.readyState, "live");
    } finally { FakeRecorder.supported = supported; }
});

test("audio survives disposal, encoder failure and clone termination", async () => {
    for (const reason of ["dispose", "error", "ended", "start"]) {
        const { canvas, track } = fixture(); const audio = fakeTrack();
        const recorder = createCanvasRecorder(canvas, { fps: 30, mimeType: "video/webm;codecs=vp8", audioTracks: [audio] });
        try {
            FakeRecorder.throwStart = reason === "start";
            const start = recorder.start();
            if (reason === "start") await assert.rejects(start, /start failed/);
            else {
                await start;
                if (reason === "dispose") recorder.dispose();
                if (reason === "error") FakeRecorder.instances.at(-1).dispatchEvent(new Event("error"));
                if (reason === "ended") audio.clones[0].end();
            }
            await assert.rejects(recorder.stop());
            assert.ok(track.stopped); assert.ok(audio.clones[0].stopped);
            assert.equal(audio.readyState, "live");
        } finally { FakeRecorder.throwStart = false; recorder.dispose(); }
    }
});

test("reject invalid audio and audio ended between creation and start", async () => {
    const { canvas, track } = fixture();
    const ended = fakeTrack(); ended.stop();
    for (const audio of [fakeTrack("video"), ended]) {
        assert.throws(() => createCanvasRecorder(canvas, { fps: 30, audioTracks: [audio] }), /live audio/);
    }
    const audio = fakeTrack();
    const recorder = createCanvasRecorder(canvas, { fps: 30, mimeType: "video/webm;codecs=vp8", audioTracks: [audio] });
    audio.stop();
    await assert.rejects(recorder.start(), /ended before/);
    assert.equal(audio.clones.length, 0); assert.ok(track.stopped);
});

test("partial clone and addTrack failures release every owned track", async () => {
    for (const reason of ["clone", "addTrack", "ended"]) {
        const { canvas, track, stream } = fixture();
        const first = fakeTrack(); const second = fakeTrack();
        const recorder = createCanvasRecorder(canvas, { fps: 30, mimeType: "video/webm;codecs=vp8", audioTracks: [first, second] });
        if (reason === "clone") second.clone = () => { throw new Error("clone failed"); };
        if (reason === "ended") second.stop();
        if (reason === "addTrack") {
            const add = stream.addTrack;
            stream.addTrack = t => { if (t === second.clones[0]) throw new Error("add failed"); add(t); };
        }
        await assert.rejects(recorder.start());
        assert.ok(track.stopped);
        assert.ok(first.clones[0].stopped);
        for (const clone of second.clones) assert.ok(clone.stopped);
        assert.equal(first.readyState, "live");
        if (reason !== "ended") assert.equal(second.readyState, "live");
    }
});

test('pause/resume exclude paused time from duration and the automatic limit', async t => {
    let now = 0; t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const advance = ms => { now += ms; t.mock.timers.tick(ms); };
    const { canvas, track } = fixture(); const audio = fakeTrack();
    const recorder = createCanvasRecorder(canvas, { fps: 30, mimeType: 'video/webm;codecs=vp8', maxDurationMs: 100, audioTracks: [audio] });
    try {
        await recorder.start(); advance(40);
        const pausing = recorder.pause(); assert.equal(pausing, recorder.pause()); await pausing;
        assert.equal(recorder.state, 'paused'); await recorder.pause();
        advance(1000); assert.equal(recorder.state, 'paused');
        assert.equal(audio.readyState, 'live'); assert.equal(audio.clones[0].readyState, 'live');
        const resuming = recorder.resume(); assert.equal(resuming, recorder.resume()); await resuming;
        await recorder.resume(); advance(30); await recorder.pause(); advance(500); await recorder.resume();
        advance(29); assert.equal(recorder.state, 'recording'); advance(1);
        const result = await recorder.finished;
        assert.equal(result.stopReason, 'duration-limit'); assert.equal(result.durationMs, 100);
        assert.equal(await recorder.stop(), result); assert.equal(recorder.state, 'stopped');
        assert.ok(track.stopped); assert.ok(audio.clones[0].stopped); assert.equal(audio.readyState, 'live');
        await assert.rejects(recorder.pause(), /stopped/); await assert.rejects(recorder.resume(), /stopped/);
        advance(10000);
    } finally { recorder.dispose(); }
});

test('manual stop during a pause excludes the pause and clears the limit timer', async t => {
    let now = 0; t.mock.method(performance, 'now', () => now); t.mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas } = fixture(); const recorder = createCanvasRecorder(canvas, { fps: 30, maxDurationMs: 500 });
    await recorder.start(); now = 100; t.mock.timers.tick(100); await recorder.pause();
    now = 900; t.mock.timers.tick(800);
    const result = await recorder.stop(); assert.equal(result.durationMs, 100); assert.equal(result.stopReason, 'manual');
    assert.equal(await recorder.finished, result); recorder.dispose(); t.mock.timers.tick(10000);
});

test('invalid limits and pause/resume states allocate no capture', async () => {
    const { canvas } = fixture(); let captured = 0; canvas.captureStream = () => { captured++; throw Error('unexpected capture'); };
    for (const maxDurationMs of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => createCanvasRecorder(canvas, { fps: 30, maxDurationMs }), /maxDurationMs/);
    }
    const recorder = createCanvasRecorder(canvas, { fps: 30 });
    await assert.rejects(recorder.pause(), /idle/); await assert.rejects(recorder.resume(), /idle/);
    assert.equal(captured, 0); recorder.dispose(); await assert.rejects(recorder.finished, /disposed/);
    await assert.rejects(recorder.pause(), /disposed/);
});

test('pending pause/resume reject on stop, disposal and encoder errors; owned audio is cleaned', async () => {
    FakeRecorder.holdChanges = true;
    try {
        for (const action of ['pause', 'resume']) for (const reason of ['stop', 'dispose', 'error', 'throw']) {
            const { canvas, track } = fixture(); const audio = fakeTrack();
            const recorder = createCanvasRecorder(canvas, { fps: 30, mimeType: 'video/webm;codecs=vp8', audioTracks: [audio], maxDurationMs: 10000 });
            try {
                await recorder.start();
                if (action === 'resume') { const p = recorder.pause(); FakeRecorder.instances.at(-1).dispatchEvent(new Event('pause')); await p; }
                FakeRecorder.throwChange = reason === 'throw';
                const pending = recorder[action]();
                if (reason !== 'throw') await assert.rejects(recorder[action === 'pause' ? 'resume' : 'pause'](), /pending/);
                if (reason === 'stop') await recorder.stop();
                if (reason === 'dispose') recorder.dispose();
                if (reason === 'error') FakeRecorder.instances.at(-1).dispatchEvent(new Event('error'));
                await assert.rejects(pending);
                if (reason !== 'stop') await assert.rejects(recorder.finished);
                assert.ok(track.stopped); assert.ok(audio.clones[0].stopped); assert.equal(audio.readyState, 'live');
            } finally { FakeRecorder.throwChange = false; recorder.dispose(); }
        }
    } finally { FakeRecorder.holdChanges = false; }
});

test('limit racing a pending pause terminates it and still returns final data', async t => {
    let now = 0; t.mock.method(performance, 'now', () => now); t.mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas } = fixture(); const recorder = createCanvasRecorder(canvas, { fps: 30, maxDurationMs: 20 });
    FakeRecorder.holdChanges = true;
    try {
        await recorder.start(); const pending = recorder.pause(); now = 20; t.mock.timers.tick(20);
        await assert.rejects(pending, /stopped/);
        const result = await recorder.finished; assert.equal(result.stopReason, 'duration-limit'); assert.ok(result.blob.size);
    } finally { recorder.dispose(); FakeRecorder.holdChanges = false; }
});

test('large duration budgets are scheduled in safe timer segments and snapshotted', async t => {
    let now = 0; t.mock.method(performance, 'now', () => now); t.mock.timers.enable({ apis: ['setTimeout'] });
    const { canvas } = fixture(), options = { fps: 30, maxDurationMs: 2147483648 };
    const recorder = createCanvasRecorder(canvas, options); options.maxDurationMs = 1;
    try {
        await recorder.start(); now = 2147483647; t.mock.timers.tick(2147483647);
        assert.equal(recorder.state, 'recording'); now++; t.mock.timers.tick(1);
        assert.equal((await recorder.finished).durationMs, 2147483648);
        assert.equal((await recorder.stop()).stopReason, 'duration-limit');
    } finally { recorder.dispose(); }
});
