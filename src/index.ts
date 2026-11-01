export interface RecordingResult {
    readonly blob: Blob;
    readonly mimeType: string;
    readonly extension: "webm" | "mp4";
    readonly durationMs: number;
    readonly stopReason: "manual" | "duration-limit";
}
export interface RecorderOptions {
    readonly fps: number;
    readonly videoBitsPerSecond?: number;
    readonly mimeType?: string;
    /** Live caller-owned audio tracks; recorder owns and stops only clones. */
    readonly audioTracks?: readonly MediaStreamTrack[];
    /** Positive safe integer in ms; active recording time only, excluding pauses. */
    readonly maxDurationMs?: number;
}
export type RecorderState = "idle" | "recording" | "paused" | "stopping" | "stopped" | "disposed";
export interface CanvasRecorder {
    readonly state: RecorderState;
    /** Settles on manual/automatic completion or failure; does not initiate stopping. */
    readonly finished: Promise<RecordingResult>;
    start(): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    stop(): Promise<RecordingResult>;
    dispose(): void;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    // Errors may occur before the caller asks for the final result.
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
function extension(mime: string): "webm" | "mp4" {
    const base = mime.split(";", 1)[0].trim().toLowerCase();
    if (base === "video/webm") return "webm";
    if (base === "video/mp4") return "mp4";
    throw new TypeError(`Unsupported video container: ${mime}`);
}

/** One recorder instance produces one video, optionally with supplied audio; drawing is managed by the caller. */
export function createCanvasRecorder(canvas: HTMLCanvasElement, options: RecorderOptions): CanvasRecorder {
    if (!Number.isFinite(options.fps) || options.fps <= 0) throw new RangeError("fps must be positive and finite");
    const { maxDurationMs } = options;
    if (maxDurationMs !== undefined && (!Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1)) {
        throw new RangeError("maxDurationMs must be a positive safe integer");
    }
    if (options.videoBitsPerSecond !== undefined &&
        (!Number.isFinite(options.videoBitsPerSecond) || options.videoBitsPerSecond <= 0)) {
        throw new RangeError("videoBitsPerSecond must be positive and finite");
    }
    if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
        throw new Error("Canvas video recording is not supported in this environment");
    }
    const audioTracks = [...(options.audioTracks ?? [])];
    for (const track of audioTracks) {
        if (track.kind !== "audio" || track.readyState !== "live") throw new TypeError("audioTracks must contain live audio tracks");
    }
    const requested = options.mimeType;
    if (requested !== undefined) extension(requested);
    const candidates = audioTracks.length
        ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"]
        : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
    const mime = requested ?? candidates
        .find(candidate => MediaRecorder.isTypeSupported(candidate));
    if (!mime || !MediaRecorder.isTypeSupported(mime)) throw new Error(`Unsupported recording format: ${mime ?? "none"}`);

    let state: RecorderState = "idle";
    let recorder: MediaRecorder | undefined;
    let stream: MediaStream | undefined;
    let observer: MutationObserver | undefined;
    let width = 0, height = 0, activeMs = 0, activeSince: number | undefined;
    let limitTimer: ReturnType<typeof setTimeout> | undefined;
    let stopReason: RecordingResult['stopReason'] = "manual";
    let transition: { action: "pause" | "resume"; result: ReturnType<typeof deferred<void>> } | undefined;
    let chunks: Blob[] = [];
    let startResult: ReturnType<typeof deferred<void>> | undefined;
    const result = deferred<RecordingResult>();
    let stopPromise: Promise<RecordingResult> | undefined;
    let failure: unknown;

    function cleanup(): void {
        clearTimeout(limitTimer); limitTimer = undefined;
        observer?.disconnect();
        recorder?.removeEventListener("start", onStart);
        recorder?.removeEventListener("dataavailable", onData);
        recorder?.removeEventListener("stop", onStop);
        recorder?.removeEventListener("error", onError);
        recorder?.removeEventListener("pause", onPause);
        recorder?.removeEventListener("resume", onResume);
        for (const track of stream?.getTracks() ?? []) {
            track.removeEventListener("ended", onEnded);
        }
        try { if (recorder && recorder.state !== "inactive") recorder.stop(); } catch {}
        for (const track of stream?.getTracks() ?? []) track.stop();
        chunks = [];
    }
    function fail(error: unknown): void {
        if (state === "disposed" || state === "stopped") return;
        failure = error;
        state = "stopped";
        startResult?.reject(error);
        transition?.result.reject(error); transition = undefined;
        result.reject(error);
        cleanup();
    }
    function unchanged(): boolean { return canvas.width === width && canvas.height === height; }
    function accountActive(): void {
        if (activeSince !== undefined) activeMs += Math.max(0, performance.now() - activeSince);
        activeSince = undefined;
        clearTimeout(limitTimer); limitTimer = undefined;
    }
    function armLimit(): void {
        if (maxDurationMs === undefined || state !== "recording") return;
        const remaining = maxDurationMs - activeMs - Math.max(0, performance.now() - activeSince!);
        if (remaining <= 0) { void beginStop("duration-limit"); return; }
        limitTimer = setTimeout(armLimit, Math.min(2147483647, Math.ceil(remaining)));
    }
    function onStart(): void {
        activeSince = performance.now();
        state = "recording";
        startResult!.resolve();
        armLimit();
    }
    function onPause(): void {
        if (state !== "recording" || transition?.action !== "pause") return;
        accountActive();
        if (maxDurationMs !== undefined && activeMs >= maxDurationMs) { void beginStop("duration-limit"); return; }
        state = "paused";
        transition.result.resolve(); transition = undefined;
    }
    function onResume(): void {
        if (state !== "paused" || transition?.action !== "resume") return;
        activeSince = performance.now(); state = "recording";
        transition.result.resolve(); transition = undefined;
        armLimit();
    }
    function onData(event: BlobEvent): void { if (event.data.size) chunks.push(event.data); }
    function onError(event: Event): void {
        fail((event as Event & { error?: Error }).error ?? new Error("Video recording failed"));
    }
    function onEnded(): void { fail(new Error("Recording track ended unexpectedly")); }
    function onStop(): void {
        if (!unchanged()) { fail(new Error("Canvas bitmap size changed during recording")); return; }
        if (state !== "stopping") { fail(new Error("Recording stopped unexpectedly")); return; }
        try {
            const actualMime = recorder!.mimeType || chunks.find(chunk => chunk.type)?.type || mime!;
            const ext = extension(actualMime);
            const blob = new Blob(chunks, { type: actualMime });
            if (!blob.size) throw new Error("Recording produced an empty video");
            state = "stopped";
            result.resolve(Object.freeze({ blob, mimeType: actualMime, extension: ext,
                durationMs: activeMs, stopReason }));
            cleanup();
        } catch (error) { fail(error); }
    }
    function beginStop(reason: RecordingResult['stopReason'] = "manual"): Promise<RecordingResult> {
        if (state === "disposed") return Promise.reject(new Error("Recorder is disposed"));
        if (failure) return result.promise;
        if (state === "stopped" || state === "stopping") return result.promise;
        if (!unchanged()) { fail(new Error("Canvas bitmap size changed during recording")); return result.promise; }
        state = "stopping";
        stopReason = reason;
        accountActive();
        transition?.result.reject(new Error("Recording stopped before pause/resume completed")); transition = undefined;
        try { recorder!.stop(); } catch (error) { fail(error); }
        return result.promise;
    }
    function change(action: "pause" | "resume"): Promise<void> {
        if (state !== "recording" && state !== "paused") return Promise.reject(new Error(`Cannot ${action} recorder in ${state} state`));
        if (transition) return transition.action === action ? transition.result.promise : Promise.reject(new Error("Pause/resume operation is pending"));
        if ((action === "pause" && state === "paused") || (action === "resume" && state === "recording")) return Promise.resolve();
        if (!unchanged()) { const error = new Error("Canvas bitmap size changed during recording"); fail(error); return Promise.reject(error); }
        const pending = deferred<void>(); transition = { action, result: pending };
        try { recorder![action](); } catch (error) { fail(error); }
        return pending.promise;
    }
    return Object.freeze({
        get state() { return state; },
        get finished() { return result.promise; },
        pause: () => change("pause"),
        resume: () => change("resume"),
        start(): Promise<void> {
            if (state !== "idle" || startResult) return Promise.reject(new Error("Recorder can only start once"));
            startResult = deferred<void>();
            try {
                width = canvas.width; height = canvas.height;
                if (!width || !height) throw new RangeError("Canvas must have a positive bitmap size");
                stream = canvas.captureStream(options.fps);
                if (!stream.getVideoTracks().length) throw new Error("Canvas stream has no video track");
                for (const track of audioTracks) {
                    if (track.readyState !== "live") throw new Error("Audio track ended before recording");
                    const clone = track.clone();
                    try { stream.addTrack(clone); } catch (error) { clone.stop(); throw error; }
                }
                recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: options.videoBitsPerSecond });
                recorder.addEventListener("start", onStart);
                recorder.addEventListener("dataavailable", onData);
                recorder.addEventListener("stop", onStop);
                recorder.addEventListener("error", onError);
                recorder.addEventListener("pause", onPause);
                recorder.addEventListener("resume", onResume);
                for (const track of stream.getTracks()) track.addEventListener("ended", onEnded);
                if (typeof MutationObserver !== "undefined") {
                    observer = new MutationObserver(() => {
                        if (!unchanged()) fail(new Error("Canvas bitmap size changed during recording"));
                    });
                    observer.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
                }
                recorder.start(1000);
            } catch (error) { fail(error); }
            return startResult.promise;
        },
        stop(): Promise<RecordingResult> {
            if (state === "disposed") return Promise.reject(new Error("Recorder is disposed"));
            if (!startResult) return Promise.reject(new Error("Recorder has not started"));
            stopPromise ??= startResult.promise.then(() => beginStop());
            return stopPromise;
        },
        dispose(): void {
            if (state === "disposed") return;
            const error = new Error("Recording was disposed");
            state = "disposed";
            startResult?.reject(error);
            transition?.result.reject(error); transition = undefined;
            result.reject(error);
            cleanup();
        }
    });
}
