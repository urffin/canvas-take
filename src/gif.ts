import { createFramePreparation } from './gif-preparation.js';

/** An immutable frame description; the encoder may use the owned pixel copy until addFrame settles. */
export interface GifFrame {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    /** Milliseconds, rounded to GIF's 10 ms units by the exporter. */
    readonly durationMs: number;
}
export interface GifEncoderOptions {
    /** -1: play once; 0: forever; 1..65535: extra repetitions. */
    readonly repeat: number;
}
/** Implementations may encode synchronously or use a Worker. Never retain frames after completion. */
export interface GifFrameEncoder {
    addFrame(frame: GifFrame): void | Promise<void>;
    /** Return a complete GIF file. */
    finish(): Uint8Array | Promise<Uint8Array>;
    /** Must release buffers/terminate owned Workers, including during pending operations. */
    dispose(): void;
}
/** Must return a fresh, exclusively owned encoder for each export. */
export type GifEncoderFactory = (options: GifEncoderOptions) => GifFrameEncoder;
export interface GifExportOptions {
    readonly encoder: GifEncoderFactory;
    readonly repeat?: number;
    readonly signal?: AbortSignal;
    /** Transparent pixels are composited onto this RGB color. Default: white. */
    readonly background?: readonly [number, number, number];
    /** Optional display hint; does not limit the number of frames. */
    readonly totalFrames?: number;
    /** Inclusive width * height limit per frame. Positive safe integer; omitted means no extra limit. */
    readonly maxFramePixels?: number;
    /** Inclusive encoded-frame count limit. Positive safe integer; independent of totalFrames. */
    readonly maxFrames?: number;
    /** Inclusive sum of GIF-rounded frame durations, in ms. Positive safe integer; excludes repeat loops. */
    readonly maxDurationMs?: number;
    /** Observer exceptions are ignored. Called after frames and on terminal/finalizing states. */
    readonly onProgress?: (progress: GifExportProgress) => void;
}
export interface GifExportProgress {
    readonly phase: 'encoding' | 'finalizing' | 'finished' | 'failed' | 'aborted' | 'disposed';
    readonly framesEncoded: number;
    readonly durationMs: number;
    readonly totalFrames?: number;
}
export type GifExportState = 'ready' | 'encoding' | 'finished' | 'failed' | 'aborted' | 'disposed';
export interface GifExporter {
    readonly state: GifExportState;
    /** Snapshot a 2D canvas immediately. Await completion before adding another frame or finishing. */
    addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, durationMs: number): Promise<void>;
    finish(): Promise<Blob>;
    dispose(): void;
}

/** Offline, sequential GIF export. No timers are used to determine frame durations. */
export function createGifExporter(options: GifExportOptions): GifExporter {
    const { signal, encoder: factory } = options;
    const { totalFrames, onProgress } = options;
    const { maxFramePixels, maxFrames, maxDurationMs } = options;
    for (const [name, value] of Object.entries({ maxFramePixels, maxFrames, maxDurationMs })) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError(`${name} must be a positive safe integer`);
    }
    if (totalFrames !== undefined && (!Number.isSafeInteger(totalFrames) || totalFrames < 1)) throw new RangeError('totalFrames must be a positive safe integer');
    const repeat = options.repeat ?? 0;
    const background = [...(options.background ?? [255, 255, 255])];
    if (typeof factory !== 'function') throw new TypeError('An encoder factory is required');
    if (!Number.isInteger(repeat) || repeat < -1 || repeat > 65535) throw new RangeError('repeat must be -1..65535');
    if (background.length !== 3 || background.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
        throw new RangeError('background must contain three RGB bytes');
    }
    const abortError = () => signal?.reason ?? new DOMException('GIF export aborted', 'AbortError');
    if (signal?.aborted) throw abortError();
    let encoder: GifFrameEncoder | undefined = factory(Object.freeze({ repeat }));
    const preparation = createFramePreparation();
    let state: GifExportState = 'ready';
    let width = 0, height = 0, frames = 0;
    let duration = 0;
    function report(phase: GifExportProgress['phase']): void {
        try { onProgress?.(Object.freeze({ phase, framesEncoded: frames, durationMs: duration,
            ...(totalFrames === undefined ? {} : { totalFrames }) })); } catch {}
    }
    let rejectCancelled!: (error: unknown) => void;
    let cancellation: { reason: unknown } | undefined;
    const cancelled = new Promise<never>((_, reject) => { rejectCancelled = reject; });
    void cancelled.catch(() => {});
    function cleanup(): void {
        signal?.removeEventListener('abort', onAbort);
        preparation.dispose();
        const owned = encoder;
        encoder = undefined;
        // Preserve the original failure/cancellation even if an adapter's cleanup throws.
        try { owned?.dispose(); } catch {}
    }
    function onAbort(): void {
        if (state !== 'ready' && state !== 'encoding') return;
        state = 'aborted';
        cancellation ??= { reason: abortError() };
        rejectCancelled(cancellation.reason);
        cleanup();
        report('aborted');
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    function ready(): void {
        if (state !== 'ready') throw new Error(`GIF exporter is ${state}`);
    }
    function active(): void {
        if (state !== 'encoding') throw new Error(`GIF exporter is ${state}`);
    }
    async function operation<T>(work: () => Promise<T>): Promise<T> {
        ready();
        state = 'encoding';
        try { return await Promise.race([work(), cancelled]); }
        catch (error) {
            if (cancellation) throw cancellation.reason;
            if (state === 'encoding') { state = 'failed'; cleanup(); report('failed'); }
            throw error;
        }
    }
    return Object.freeze({
        get state() { return state; },
        addFrame(canvas: HTMLCanvasElement | OffscreenCanvas, durationMs: number): Promise<void> {
            return operation(async () => {
                if (!Number.isFinite(durationMs) || durationMs < 10 || durationMs > 655350) {
                    throw new RangeError('durationMs must be between 10 and 655350');
                }
                const w = canvas.width, h = canvas.height;
                if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 65535 || h > 65535) {
                    throw new RangeError('Canvas dimensions must be integers in 1..65535');
                }
                if (frames && (w !== width || h !== height)) throw new Error('GIF frame dimensions must remain fixed');
                const frameDuration = Math.round(durationMs / 10) * 10;
                if (maxFramePixels !== undefined && w * h > maxFramePixels) throw new RangeError('GIF frame exceeds maxFramePixels');
                if (maxFrames !== undefined && frames >= maxFrames) throw new RangeError('GIF export exceeds maxFrames');
                if (maxDurationMs !== undefined && frameDuration > maxDurationMs - duration) throw new RangeError('GIF export exceeds maxDurationMs');
                const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
                if (!context) throw new Error('GIF export requires a 2D canvas');
                preparation.capture(context.getImageData(0, 0, w, h).data, w * h * 4);
                await preparation.prepare(background, active);
                active();
                await encoder!.addFrame({ width: w, height: h, data: preparation.take(), durationMs: frameDuration });
                active();
                width = w; height = h; frames++;
                duration += frameDuration;
                report('encoding');
                active();
                state = 'ready';
            });
        },
        finish(): Promise<Blob> {
            return operation(async () => {
                if (!frames) throw new Error('GIF export requires at least one frame');
                report('finalizing');
                active();
                const bytes = await encoder!.finish();
                active();
                if (!(bytes instanceof Uint8Array) || bytes.length < 6 ||
                    !['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))) {
                    throw new Error('Encoder did not return GIF bytes');
                }
                const blob = new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
                state = 'finished';
                cleanup();
                report('finished');
                return blob;
            });
        },
        dispose(): void {
            if (state === 'disposed') return;
            const unfinished = state === 'ready' || state === 'encoding';
            state = 'disposed';
            if (unfinished) {
                cancellation ??= { reason: new DOMException('GIF exporter disposed', 'AbortError') };
                rejectCancelled(cancellation.reason);
            }
            cleanup();
            if (unfinished) report('disposed');
        }
    });
}
