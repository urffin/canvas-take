import type { ApngExportOptions, ApngExportState, ApngExportProgress, ApngExporter, ApngFrameEncoder } from './apng-types.js';
import { validateApngEnvelope } from './apng-envelope.js';

// Internal implementation behind the codec-free public /apng entry.
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {}); return { promise, resolve, reject };
}
export function createApngController(options: ApngExportOptions): ApngExporter {
    const signal = options.signal;
    const abortReason = () => signal?.reason ?? new DOMException('APNG export aborted', 'AbortError');
    if (signal?.aborted) throw abortReason();
    const { encoder: factory, onProgress, totalFrames, maxFramePixels, maxFrames, maxDurationMs, maxOutputBytes } = options;
    const maxInputBytes = options.maxInputBytes === undefined ? 64 * 1024 * 1024 : options.maxInputBytes;
    const plays = options.plays === undefined ? 0 : options.plays;
    if (typeof factory !== 'function') throw new TypeError('An APNG encoder factory is required');
    if (!Number.isInteger(plays) || plays < 0 || plays > 0xffffffff) throw new RangeError('APNG plays must be 0..4294967295');
    for (const [name, value] of Object.entries({ totalFrames, maxFramePixels, maxFrames, maxDurationMs, maxInputBytes, maxOutputBytes })) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (onProgress !== undefined && typeof onProgress !== 'function') throw new TypeError('APNG onProgress must be a function');
    const controller = new AbortController(), cancellation = deferred<never>();
    let state: ApngExportState = 'ready', failure: { reason: unknown } | undefined;
    let encoder: ApngFrameEncoder | undefined, released = false;
    let width = 0, height = 0, frames = 0, duration = 0, inputBytes = 0;
    let task: { id: ReturnType<typeof setTimeout>; reject: (error: unknown) => void } | undefined;
    let completion: ReturnType<typeof deferred<Blob>> | undefined;
    const durations: number[] = [];
    const terminal = () => ['finished', 'failed', 'aborted', 'disposed'].includes(state);
    const reason = () => failure ? failure.reason : new Error(`APNG exporter is ${state}`);
    const guard = () => { if (terminal()) throw reason(); };
    function report(phase: ApngExportProgress['phase'], outputBytes?: number): void {
        try { onProgress?.(Object.freeze({ phase, framesAccepted: frames, durationMs: duration, inputBytesAccepted: inputBytes,
            ...(totalFrames === undefined ? {} : { totalFrames }), ...(outputBytes === undefined ? {} : { outputBytes }) })); } catch {}
    }
    function release(): void {
        const owned = encoder; encoder = undefined;
        if (owned && !released) { released = true; try { owned.dispose(); } catch {} }
    }
    function cleanup(): void {
        try { signal?.removeEventListener('abort', onAbort); } catch {}
        if (task) { const pending = task; task = undefined; clearTimeout(pending.id); pending.reject(reason()); }
        durations.length = 0; release();
    }
    function end(next: 'failed' | 'aborted' | 'disposed', error: unknown): void {
        if (terminal()) return;
        state = next; failure = { reason: error }; cancellation.reject(error); controller.abort(error); cleanup(); report(next);
    }
    function onAbort(): void { end('aborted', abortReason()); }
    async function wait<T>(value: T | Promise<T>): Promise<T> {
        const result = await Promise.race([Promise.resolve(value), cancellation.promise]); guard(); return result;
    }
    async function invoke<T>(component: string, work: () => T | Promise<T>): Promise<T> {
        try { guard(); return await wait(work()); }
        catch (error) { if (terminal()) throw reason(); throw new Error(`APNG encoder.${component} failed`, { cause: error }); }
    }
    function yieldTask(): Promise<void> {
        guard();
        return new Promise((resolve, reject) => {
            const pending = { id: undefined as unknown as ReturnType<typeof setTimeout>, reject };
            task = pending;
            pending.id = setTimeout(() => { if (task !== pending) return; task = undefined; resolve(); }, 0);
        });
    }
    try {
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort(); guard();
        try { encoder = factory(Object.freeze({ plays }), Object.freeze({ signal: controller.signal, maxInputBytes,
            ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) })); }
        catch (error) { if (terminal()) throw reason(); throw new Error('APNG encoder.create failed', { cause: error }); }
        guard();
        if (!encoder || typeof encoder.addFrame !== 'function' || typeof encoder.finish !== 'function' || typeof encoder.dispose !== 'function') throw new TypeError('APNG factory must return a fresh disposable encoder');
    } catch (error) {
        // Async factories violate the synchronous contract. Observe their eventual settlement and
        // release a late disposable result without waiting or leaving an unhandled rejection.
        try {
            const invalid = encoder as unknown as PromiseLike<ApngFrameEncoder> | undefined;
            if (invalid && typeof invalid.then === 'function' && typeof encoder?.dispose !== 'function') {
                encoder = undefined;
                void Promise.resolve(invalid).then(instance => { try { instance?.dispose?.(); } catch {} }, () => {});
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
                    if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 65535) throw new RangeError('APNG durationMs must be an integer in 1..65535');
                    if (!canvas) throw new TypeError('APNG export requires a canvas');
                    const w = canvas.width, h = canvas.height, pixels = w * h, bytes = pixels * 4;
                    if (![w, h].every(n => Number.isInteger(n) && n > 0 && n <= 0x7fffffff) || !Number.isSafeInteger(bytes)) throw new RangeError('Invalid APNG canvas dimensions');
                    if (frames && (w !== width || h !== height)) throw new RangeError('APNG frame dimensions must remain fixed');
                    if (maxFramePixels !== undefined && pixels > maxFramePixels) throw new RangeError('APNG maxFramePixels exceeded');
                    if (maxFrames !== undefined && frames >= maxFrames) throw new RangeError('APNG maxFrames exceeded');
                    if (!Number.isSafeInteger(duration + durationMs) || (maxDurationMs !== undefined && durationMs > maxDurationMs - duration)) throw new RangeError('APNG maxDurationMs exceeded');
                    if (bytes > maxInputBytes - inputBytes) throw new RangeError('APNG maxInputBytes exceeded');
                    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
                    if (!context) throw new TypeError('APNG export requires a 2D canvas');
                    const pixelsData = context.getImageData(0, 0, w, h, { colorSpace: 'srgb' }).data;
                    guard(); data = new Uint8ClampedArray(pixelsData);
                    guard(); if (data.length !== bytes) throw new RangeError('Invalid APNG pixel data');
                    await wait(yieldTask());
                    await invoke('addFrame', () => encoder!.addFrame(Object.freeze({ width: w, height: h, data: data!, durationMs })));
                    guard();
                    width = w; height = h; frames++; duration += durationMs; inputBytes += bytes; durations.push(durationMs);
                    report('collecting'); guard(); state = 'ready';
                } catch (error) { if (!terminal()) end('failed', error); throw reason(); }
                finally { data = undefined; canvas = undefined; } // Error stacks can retain invocation/input closures.
            })();
        },
        finish(): Promise<Blob> {
            if (state === 'finalizing' || state === 'finished') return completion!.promise;
            if (state !== 'ready') return Promise.reject(reason());
            state = 'finalizing'; completion = deferred<Blob>();
            void (async () => {
                try {
                    if (!frames) throw new RangeError('APNG export requires at least one frame');
                    report('finalizing'); guard();
                    const returned = await invoke('finish', () => encoder!.finish());
                    guard();
                    if (!(returned instanceof Uint8Array) || !(returned.buffer instanceof ArrayBuffer) || !returned.length) throw new TypeError('APNG encoder must return nonshared Uint8Array bytes');
                    if (maxOutputBytes !== undefined && returned.byteLength > maxOutputBytes) throw new RangeError('APNG maxOutputBytes exceeded');
                    const bytes = new Uint8Array(returned);
                    await wait(validateApngEnvelope(bytes, { width, height, plays, durations }, () => wait(yieldTask()), guard));
                    guard();
                    const blob = new Blob([bytes], { type: 'image/apng' });
                    state = 'finished'; cleanup(); report('finished', blob.size); return blob;
                } catch (error) { if (!terminal()) end('failed', error); throw reason(); }
            })().then(completion.resolve, completion.reject);
            return completion.promise;
        },
        dispose(): void {
            if (state === 'disposed') return;
            const error = new DOMException('APNG exporter disposed', 'AbortError');
            if (!terminal()) end('disposed', error);
            else { state = 'disposed'; failure ??= { reason: error }; controller.abort(failure.reason); cleanup(); }
        }
    });
}
