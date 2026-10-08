export interface RecordingResult {
    readonly blob: Blob;
    readonly mimeType: string;
    readonly extension: "webm" | "mp4";
    readonly durationMs: number;
}
export interface RecorderOptions {
    readonly fps: number;
    readonly videoBitsPerSecond?: number;
    readonly mimeType?: string;
}
export type RecorderState = "idle" | "recording" | "stopping" | "stopped" | "disposed";
export interface CanvasRecorder {
    readonly state: RecorderState;
    start(): Promise<void>;
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

/** One recorder instance produces one silent video; drawing is managed by the caller. */
export function createCanvasRecorder(canvas: HTMLCanvasElement, options: RecorderOptions): CanvasRecorder {
    if (!Number.isFinite(options.fps) || options.fps <= 0) throw new RangeError("fps must be positive and finite");
    if (options.videoBitsPerSecond !== undefined &&
        (!Number.isFinite(options.videoBitsPerSecond) || options.videoBitsPerSecond <= 0)) {
        throw new RangeError("videoBitsPerSecond must be positive and finite");
    }
    if (typeof MediaRecorder === "undefined" || typeof canvas.captureStream !== "function") {
        throw new Error("Canvas video recording is not supported in this environment");
    }
    const requested = options.mimeType;
    if (requested !== undefined) extension(requested);
    const mime = requested ?? ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"]
        .find(candidate => MediaRecorder.isTypeSupported(candidate));
    if (!mime || !MediaRecorder.isTypeSupported(mime)) throw new Error(`Unsupported recording format: ${mime ?? "none"}`);

    let state: RecorderState = "idle";
    let recorder: MediaRecorder | undefined;
    let stream: MediaStream | undefined;
    let observer: MutationObserver | undefined;
    let width = 0, height = 0, startedAt = 0, stoppedAt: number | undefined;
    let chunks: Blob[] = [];
    let startResult: ReturnType<typeof deferred<void>> | undefined;
    const result = deferred<RecordingResult>();
    let stopPromise: Promise<RecordingResult> | undefined;
    let failure: unknown;

    function cleanup(): void {
        observer?.disconnect();
        recorder?.removeEventListener("start", onStart);
        recorder?.removeEventListener("dataavailable", onData);
        recorder?.removeEventListener("stop", onStop);
        recorder?.removeEventListener("error", onError);
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
        result.reject(error);
        cleanup();
    }
    function unchanged(): boolean { return canvas.width === width && canvas.height === height; }
    function onStart(): void {
        startedAt = performance.now();
        state = "recording";
        startResult!.resolve();
    }
    function onData(event: BlobEvent): void { if (event.data.size) chunks.push(event.data); }
    function onError(event: Event): void {
        fail((event as Event & { error?: Error }).error ?? new Error("Video recording failed"));
    }
    function onEnded(): void { fail(new Error("Canvas capture track ended unexpectedly")); }
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
                durationMs: Math.max(0, (stoppedAt ?? performance.now()) - startedAt) }));
            cleanup();
        } catch (error) { fail(error); }
    }
    function beginStop(): Promise<RecordingResult> {
        if (state === "disposed") return Promise.reject(new Error("Recorder is disposed"));
        if (failure) return result.promise;
        if (state === "stopped" || state === "stopping") return result.promise;
        if (!unchanged()) { fail(new Error("Canvas bitmap size changed during recording")); return result.promise; }
        state = "stopping";
        stoppedAt = performance.now();
        try { recorder!.stop(); } catch (error) { fail(error); }
        return result.promise;
    }
    return Object.freeze({
        get state() { return state; },
        start(): Promise<void> {
            if (state !== "idle" || startResult) return Promise.reject(new Error("Recorder can only start once"));
            startResult = deferred<void>();
            try {
                width = canvas.width; height = canvas.height;
                if (!width || !height) throw new RangeError("Canvas must have a positive bitmap size");
                stream = canvas.captureStream(options.fps);
                if (!stream.getVideoTracks().length) throw new Error("Canvas stream has no video track");
                recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: options.videoBitsPerSecond });
                recorder.addEventListener("start", onStart);
                recorder.addEventListener("dataavailable", onData);
                recorder.addEventListener("stop", onStop);
                recorder.addEventListener("error", onError);
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
            stopPromise ??= startResult.promise.then(beginStop);
            return stopPromise;
        },
        dispose(): void {
            if (state === "disposed") return;
            const error = new Error("Recording was disposed");
            state = "disposed";
            startResult?.reject(error);
            result.reject(error);
            cleanup();
        }
    });
}
