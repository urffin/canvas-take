import { blendRange } from './rgba.js';

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type SampleReader = (index: number, signal: AbortSignal) => Canvas | Promise<Canvas>;
export type GifPaletteRgb = [number, number, number];

interface PaletteSampling {
    readonly frameCount: number;
    readonly readFrame: SampleReader;
    readonly accents: GifPaletteRgb[];
}

export function gifRgbKey(r: number, g: number, b: number): number {
    return (r << 16) | (g << 8) | b;
}

function readRgbByte(value: unknown): number {
    if (typeof value !== 'number') throw new TypeError('GIF accent channels must be numbers');
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('GIF accent channels must be RGB bytes');
    return value;
}

export function normalizeGifPaletteSampling(value: unknown, maxColors: number): PaletteSampling {
    if (!value || typeof value !== 'object') throw new TypeError('GIF sampled palette requires a descriptor');
    const { mode, source, accentColors } = value as { mode?: unknown; source?: unknown; accentColors?: unknown };
    if (mode !== 'sampled') throw new TypeError('GIF palette mode must be sampled');
    if (!source || typeof source !== 'object') throw new TypeError('GIF sampled palette requires a frame source');
    const { frameCount, readFrame } = source as { frameCount?: unknown; readFrame?: unknown };
    if (typeof readFrame !== 'function') throw new TypeError('GIF palette source requires readFrame');
    if (typeof frameCount !== 'number') throw new TypeError('GIF palette frameCount must be a number');
    if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new RangeError('GIF palette frameCount must be a positive safe integer');
    if (accentColors !== undefined && !Array.isArray(accentColors)) throw new TypeError('GIF accentColors must be an array');

    const accents: GifPaletteRgb[] = [];
    const seen = new Set<number>();
    for (const color of accentColors ?? []) {
        if (!Array.isArray(color) || color.length !== 3) throw new TypeError('GIF accents must contain three RGB channels');
        const rgb: GifPaletteRgb = [readRgbByte(color[0]), readRgbByte(color[1]), readRgbByte(color[2])];
        const key = gifRgbKey(...rgb);
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > maxColors) throw new RangeError('GIF accent colors exceed maxColors');
        accents.push(rgb);
    }
    return { frameCount, readFrame: (readFrame as SampleReader).bind(source), accents };
}

export function gifPaletteSampleIndices(frameCount: number): number[] {
    const count = Math.min(4, frameCount);
    if (count === 1) return [0];
    const intervals = BigInt(count - 1);
    const last = BigInt(frameCount - 1);
    return Array.from({ length: count }, (_, index) =>
        Number((2n * BigInt(index) * last + intervals) / (2n * intervals)));
}

export function yieldGifPaletteTask(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', cancel);
            resolve();
        }, 0);
        function cancel() {
            clearTimeout(timer);
            reject(signal.reason);
        }
        signal.addEventListener('abort', cancel, { once: true });
    });
}

type ReadHandlers = { resolve?: (canvas: Canvas) => void; reject?: (reason: unknown) => void };

function observeRead(result: Promise<Canvas>, handlers: ReadHandlers): void {
    void Promise.resolve(result).then(canvas => handlers.resolve?.(canvas), reason => handlers.reject?.(reason));
}

function waitForRead(result: Promise<Canvas>, signal: AbortSignal): Promise<Canvas> {
    return new Promise((resolve, reject) => {
        const handlers: ReadHandlers = {};
        function clear() {
            signal.removeEventListener('abort', cancel);
            handlers.resolve = handlers.reject = undefined;
        }
        function cancel() {
            clear();
            reject(signal.reason);
        }
        handlers.resolve = canvas => { clear(); resolve(canvas); };
        handlers.reject = reason => { clear(); reject(reason); };
        // A late reader retains only this handoff record, which is emptied on cancellation.
        observeRead(result, handlers);
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
    });
}

function isPendingRead(result: Canvas | Promise<Canvas>): result is Promise<Canvas> {
    return typeof (result as Partial<Promise<Canvas>> | null)?.then === 'function';
}

async function readPixels(readFrame: SampleReader, index: number, width: number, height: number,
    signal: AbortSignal): Promise<Uint8ClampedArray> {
    signal.throwIfAborted();
    const result = readFrame(index, signal);
    const canvas = isPendingRead(result) ? await waitForRead(result, signal) : result;
    signal.throwIfAborted();
    if (!canvas || canvas.width !== width || canvas.height !== height) throw new RangeError('GIF sample dimensions must match the first frame');
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!context) throw new Error('GIF palette sampling requires a 2D canvas');
    const { data } = context.getImageData(0, 0, width, height);
    if (data.length !== width * height * 4) throw new Error('Invalid GIF sample pixel data');
    return data;
}

export async function collectGifPaletteSample(source: PaletteSampling, width: number, height: number,
    signal: AbortSignal, background?: readonly number[]): Promise<Uint8ClampedArray> {
    const indices = gifPaletteSampleIndices(source.frameCount);
    const cols = Math.min(width, 64), rows = Math.min(height, 64);
    const sample = new Uint8ClampedArray(indices.length * cols * rows * 4);
    let cursor = 0;
    for (const index of indices) {
        const data = await readPixels(source.readFrame, index, width, height, signal);
        signal.throwIfAborted();
        for (let y = 0; y < rows; y++) {
            const row = Math.floor((y + 0.5) * height / rows) * width;
            for (let x = 0; x < cols; x++) {
                const offset = (row + Math.floor((x + 0.5) * width / cols)) * 4;
                sample[cursor++] = data[offset];
                sample[cursor++] = data[offset + 1];
                sample[cursor++] = data[offset + 2];
                sample[cursor++] = data[offset + 3];
            }
            if ((y + 1) % 16 === 0 && y + 1 < rows) {
                await yieldGifPaletteTask(signal);
                signal.throwIfAborted();
            }
        }
        // Yield between readbacks so small canvases also have a cancellation boundary.
        // Leave the readback's scope before retaining the next source frame.
        await yieldGifPaletteTask(signal);
    }
    signal.throwIfAborted();
    if (background) {
        blendRange(sample, 0, sample.length / 4, background);
    } else {
        for (let alpha = 3; alpha < sample.length; alpha += 4) {
            if (sample[alpha] !== 255) throw new Error('GIF palette samples must be opaque without an export background');
        }
    }
    return sample;
}
