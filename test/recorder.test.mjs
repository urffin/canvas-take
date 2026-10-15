import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvasRecorder } from "../dist/index.js";

class FakeRecorder extends EventTarget {
    static supported = ["video/webm;codecs=vp8"];
    static instances = [];
    static throwStart = false;
    static isTypeSupported(type) { return this.supported.includes(type); }
    state = "inactive";
    constructor(stream, options) { super(); this.stream = stream; this.mimeType = options.mimeType; FakeRecorder.instances.push(this); }
    start() {
        if (FakeRecorder.throwStart) throw new Error("start failed");
        this.state = "recording";
        queueMicrotask(() => this.dispatchEvent(new Event("start")));
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
