import type { WebpExportOptions, WebpExportLimits, WebpExportState, WebpExportProgress, WebpExporter, WebpFrameEncoder, WebpFrame } from './webp-types.js';
import { validateWebpEnvelope } from './webp-envelope.js';

// Private, codec-free implementation. Keep domain policies local, as specified in the design.
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {}); return { promise, resolve, reject };
}
export function createWebpController(options: WebpExportOptions): WebpExporter {
    const signal = options.signal;
    const abortReason = () => signal?.reason ?? new DOMException('WebP export aborted', 'AbortError');
    if (signal?.aborted) throw abortReason();
    const { encoder: factory, totalFrames } = options;
    let observer = options.onProgress;
    const plays = options.plays === undefined ? 0 : options.plays;
    const limits: Readonly<WebpExportLimits> = Object.freeze({
        maxFramePixels: options.maxFramePixels === undefined ? 4194304 : options.maxFramePixels,
        maxFrames: options.maxFrames === undefined ? 1000 : options.maxFrames,
        maxDurationMs: options.maxDurationMs === undefined ? 2147483647 : options.maxDurationMs,
        maxInputBytes: options.maxInputBytes === undefined ? 67108864 : options.maxInputBytes,
        maxOutputBytes: options.maxOutputBytes === undefined ? 33554432 : options.maxOutputBytes
    });
    if (typeof factory !== 'function') throw new TypeError('A WebP encoder factory is required');
    if (!Number.isInteger(plays) || plays < 0 || plays > 65535) throw new RangeError('WebP plays must be 0..65535');
    for (const [name, value] of Object.entries(limits)) if (!Number.isInteger(value) || value < 1 || value > 2147483647) throw new RangeError(`${name} must be an integer in 1..2147483647`);
    if (totalFrames !== undefined && (!Number.isSafeInteger(totalFrames) || totalFrames < 1)) throw new RangeError('WebP totalFrames must be a positive safe integer');
    if (observer !== undefined && typeof observer !== 'function') throw new TypeError('WebP onProgress must be a function');
    const controller = new AbortController(), cancellation = deferred<never>();
    let state: WebpExportState = 'ready', failure: { reason: unknown } | undefined;
    let encoder: WebpFrameEncoder | undefined, released = false;
    let width = 0, height = 0, frames = 0, duration = 0, inputBytes = 0;
    let task: { id: ReturnType<typeof setTimeout> | undefined; reject: (error: unknown) => void } | undefined;
    let completion: ReturnType<typeof deferred<Blob>> | undefined;
    const terminal = () => ['finished', 'failed', 'aborted', 'disposed'].includes(state);
    const reason = () => failure ? failure.reason : new Error(`WebP exporter is ${state}`);
    const guard = () => { if (terminal()) throw reason(); };
    function report(phase: WebpExportProgress['phase'], outputBytes?: number): void {
        const notify = observer;
        if (['finished', 'failed', 'aborted', 'disposed'].includes(phase)) observer = undefined;
        try { notify?.(Object.freeze({ phase, framesAccepted: frames, durationMs: duration, inputBytesAccepted: inputBytes,
            ...(totalFrames === undefined ? {} : { totalFrames }), ...(outputBytes === undefined ? {} : { outputBytes }) })); } catch {}
    }
    function disposeValue(value: unknown): void {
        try {
            const result = (value as { dispose?: () => unknown } | undefined)?.dispose?.();
            if (result && typeof (result as PromiseLike<unknown>).then === 'function') void Promise.resolve(result).catch(() => {});
        } catch {}
    }
    function release(): void {
        const owned = encoder; encoder = undefined;
        if (owned && !released) { released = true; disposeValue(owned); }
    }
    function cleanup(): void {
        try { signal?.removeEventListener('abort', onAbort); } catch {}
        if (task) { const pending = task; task = undefined; if (pending.id !== undefined) clearTimeout(pending.id); pending.reject(reason()); }
        release();
    }
    function end(next: 'failed' | 'aborted' | 'disposed', error: unknown): void {
        if (terminal()) return;
        state = next; failure = { reason: error }; cancellation.reject(error); controller.abort(error); cleanup(); report(next);
    }
    function onAbort(): void { end('aborted', abortReason()); }
    async function wait<T>(value: T | Promise<T>): Promise<T> {
        const result = await Promise.race([Promise.resolve(value), cancellation.promise]); guard(); return result;
    }
    async function invoke(component: 'addFrame' | 'finish', frame?: WebpFrame): Promise<unknown> {
        try {
            guard(); const owned = encoder!, method = owned[component]; guard();
            return await wait(component === 'addFrame' ? (method as WebpFrameEncoder['addFrame']).call(owned, frame!) : (method as WebpFrameEncoder['finish']).call(owned));
        } catch (error) { if (terminal()) throw reason(); throw new Error(`WebP encoder.${component} failed`, { cause: error }); }
        finally { frame = undefined; }
    }
    function yieldTask(): Promise<void> {
        guard();
        return new Promise((resolve, reject) => {
            const pending = { id: undefined as ReturnType<typeof setTimeout> | undefined, reject }; task = pending;
            pending.id = setTimeout(() => { if (task !== pending) return; task = undefined; resolve(); }, 0);
            if (task !== pending) clearTimeout(pending.id);
        });
    }
    try {
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort(); guard();
        try { encoder = factory(Object.freeze({ plays }), Object.freeze({ signal: controller.signal, limits })); }
        catch (error) { if (terminal()) throw reason(); throw new Error('WebP encoder.create failed', { cause: error }); }
        guard();
        if (encoder && typeof (encoder as unknown as PromiseLike<unknown>).then === 'function') throw new TypeError('WebP factory must return an encoder synchronously');
        for (const method of ['addFrame', 'finish', 'dispose'] as const) {
            if (!encoder || typeof encoder[method] !== 'function') throw new TypeError('WebP factory must return a fresh disposable encoder');
            guard();
        }
    } catch (error) {
        try {
            const late = encoder as unknown as PromiseLike<unknown> | undefined;
            if (late && typeof late.then === 'function') {
                encoder = undefined; disposeValue(late);
                void Promise.resolve(late).then(disposeValue, () => {});
            }
        } catch {}
        if (!terminal()) end('failed', error); else release(); throw failure ? failure.reason : error;
    }
    return Object.freeze({
        get state() { return state; },
        addFrame(canvas: HTMLCanvasElement | OffscreenCanvas | undefined, durationMs: number): Promise<void> {
            if (state !== 'ready') return Promise.reject(reason());
            state = 'adding';
            return (async () => {
                let data: Uint8ClampedArray | undefined;
                try {
                    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 16777215) throw new RangeError('WebP durationMs must be an integer in 1..16777215');
                    if (!canvas) throw new TypeError('WebP export requires a canvas');
                    const w = canvas.width; guard(); const h = canvas.height; guard();
                    const pixels = w * h, bytes = pixels * 4;
                    if (![w, h].every(n => Number.isInteger(n) && n > 0 && n <= 16383) || !Number.isSafeInteger(bytes)) throw new RangeError('Invalid WebP canvas dimensions');
                    if (frames && (w !== width || h !== height)) throw new RangeError('WebP frame dimensions must remain fixed');
                    if (pixels > limits.maxFramePixels) throw new RangeError('WebP maxFramePixels exceeded');
                    if (frames >= limits.maxFrames) throw new RangeError('WebP maxFrames exceeded');
                    if (durationMs > limits.maxDurationMs - duration) throw new RangeError('WebP maxDurationMs exceeded');
                    if (bytes > limits.maxInputBytes - inputBytes) throw new RangeError('WebP maxInputBytes exceeded');
                    // State 'adding' reserves this one frame's budgets until acknowledgement/terminal cleanup.
                    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null; guard();
                    if (!context) throw new TypeError('WebP export requires a 2D canvas');
                    const image = context.getImageData(0, 0, w, h, { colorSpace: 'srgb' }); guard();
                    const raw = image.data; guard();
                    if (!(raw instanceof Uint8ClampedArray) || !(raw.buffer instanceof ArrayBuffer) || raw.byteLength !== bytes) throw new TypeError('WebP readback must provide nonshared RGBA8 pixels');
                    data = new Uint8ClampedArray(raw); guard();
                    if (data.length !== bytes) throw new RangeError('Invalid WebP pixel copy');
                    await wait(yieldTask());
                    await invoke('addFrame', Object.freeze({ width: w, height: h, data, durationMs }));
                    guard(); width = w; height = h; frames++; duration += durationMs; inputBytes += bytes;
                    report('collecting'); guard(); state = 'ready';
                } catch (error) { if (!terminal()) end('failed', error); throw reason(); }
                finally { data = undefined; canvas = undefined; }
            })();
        },
        finish(): Promise<Blob> {
            if (state === 'finalizing' || state === 'finished') return completion!.promise;
            if (state !== 'ready') return Promise.reject(reason());
            state = 'finalizing'; completion = deferred<Blob>();
            void (async () => {
                try {
                    if (!frames) throw new RangeError('WebP export requires at least one frame');
                    report('finalizing'); guard();
                    const returned = await invoke('finish'); guard();
                    if (!(returned instanceof Uint8Array) || !(returned.buffer instanceof ArrayBuffer) || !returned.length) throw new TypeError('WebP encoder must return nonshared Uint8Array bytes');
                    if (returned.byteLength > limits.maxOutputBytes) throw new RangeError('WebP maxOutputBytes exceeded');
                    const bytes = new Uint8Array(returned);
                    await wait(validateWebpEnvelope(bytes, { width, height, plays, durationMs: duration }, () => wait(yieldTask()), guard));
                    guard(); const blob = new Blob([bytes], { type: 'image/webp' });
                    state = 'finished'; cleanup(); report('finished', blob.size); return blob;
                } catch (error) { if (!terminal()) end('failed', error); throw reason(); }
            })().then(completion.resolve, completion.reject);
            return completion.promise;
        },
        dispose(): void {
            if (state === 'disposed') return;
            const error = new DOMException('WebP exporter disposed', 'AbortError');
            if (!terminal()) end('disposed', error);
            else { state = 'disposed'; failure ??= { reason: error }; controller.abort(failure.reason); cleanup(); }
        }
    });
}
