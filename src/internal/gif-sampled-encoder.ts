import { GIFEncoder, applyPalette } from 'gifenc';
import type { GifencOptions } from '../gifenc.js';
import type { GifEncoderFactory, GifFrame } from '../gif.js';
import { sampledPalettePreparation, type InternalGifEncoder } from '../gif-internal.js';
import { applyBayerPalette } from './gif-bayer.js';
import { activeGifDither } from './gif-dither.js';
import { collectGifPaletteSample, normalizeGifPaletteSampling, yieldGifPaletteTask } from './gif-palette-sampling.js';
import { buildSampledGifPalette, createGifAccentCorrection } from './gif-sampled-palette.js';
import { resolveGifencSettings } from './gifenc-settings.js';

export function createSampledGifencEncoder(options: GifencOptions, sampling: unknown): GifEncoderFactory {
    const { maxColors, format, dither } = resolveGifencSettings(options);
    const source = normalizeGifPaletteSampling(sampling, maxColors);
    const { accents } = source;
    const mapPalette = dither === 'bayer-4x4' ? applyBayerPalette : applyPalette;
    return ({ repeat }) => {
        const abort = new AbortController();
        const { signal } = abort;
        let width = 0, height = 0;
        let palette: number[][] | undefined;
        let correct: ReturnType<typeof createGifAccentCorrection> | undefined;
        let writer: ReturnType<typeof GIFEncoder> | undefined;
        let preparing = false;
        let adding = false;
        let closed = false;

        function release(): void {
            closed = true;
            writer = palette = correct = undefined;
        }
        function dispose(): void {
            if (closed) return;
            release();
            abort.abort(new DOMException('GIF sampled encoder disposed', 'AbortError'));
        }
        function active(): void {
            signal.throwIfAborted();
            if (closed) throw new Error('GIF encoder is disposed');
        }
        async function prepare(w: number, h: number, background?: readonly number[]): Promise<void> {
            active();
            if (palette) return;
            if (preparing) throw new Error('GIF palette preparation is already in progress');
            preparing = true;
            try {
                const sample = accents.length === maxColors ? new Uint8ClampedArray(0)
                    : await collectGifPaletteSample(source, w, h, signal, background);
                await yieldGifPaletteTask(signal);
                active();
                const colors = buildSampledGifPalette(sample, maxColors, accents, format);
                await yieldGifPaletteTask(signal);
                active();
                width = w; height = h;
                palette = colors;
                if (dither === 'none' && accents.length) correct = createGifAccentCorrection(accents, colors.length - accents.length);
            } catch (error) {
                dispose();
                throw error;
            } finally {
                preparing = false;
            }
        }
        const encoder: InternalGifEncoder = {
            async addFrame(frame: GifFrame) {
                active();
                if (adding) throw new Error('GIF frame encoding is already in progress');
                adding = true;
                try {
                    const { data, width: w, height: h, durationMs } = frame;
                    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 65535 || h > 65535 ||
                        data.length !== w * h * 4) throw new RangeError('Invalid GIF frame dimensions or pixel data');
                    if (!palette) await prepare(w, h);
                    active();
                    if (w !== width || h !== height) throw new Error('GIF frame dimensions must remain fixed');
                    // gifenc reads the whole backing buffer. The exporter already supplies a full-span copy.
                    const pixels = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
                    const index = mapPalette(pixels, palette!, format, w, h);
                    correct?.(pixels, index);
                    const first = !writer;
                    writer ??= GIFEncoder();
                    writer.writeFrame(index, w, h, { ...(first ? { palette } : {}), delay: durationMs, repeat, dispose: 1 });
                } catch (error) {
                    dispose();
                    throw error;
                } finally {
                    adding = false;
                }
            },
            finish() {
                active();
                if (preparing || adding) throw new Error('GIF frame encoding is already in progress');
                try {
                    if (!writer) throw new Error('GIF export requires at least one frame');
                    writer.finish();
                    return writer.bytes();
                } finally {
                    release();
                }
            },
            dispose
        };
        Object.defineProperty(encoder, sampledPalettePreparation, { value: prepare });
        if (dither === 'bayer-4x4') Object.defineProperty(encoder, activeGifDither, { value: dither });
        return encoder;
    };
}
