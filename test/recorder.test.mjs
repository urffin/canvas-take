import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvasRecorder } from "../dist/index.js";

class FakeRecorder extends EventTarget {
    static supported = ["video/webm;codecs=vp8"];
    static instances = [];
    static throwStart = false;
    static isTypeSupported(type) { return this.supported.includes(type); }
    state = "inactive";
    constructor(stream, options) { super(); this.mimeType = options.mimeType; FakeRecorder.instances.push(this); }
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
    const track = new EventTarget(); track.stopped = false; track.stop = () => { track.stopped = true; };
    const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
    return { track, canvas: { width: 640, height: 360, captureStream: () => stream } };
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
