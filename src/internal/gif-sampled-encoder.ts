import type { GifencOptions } from '../gifenc.js';
import type { GifEncoderFactory, GifFrame } from '../gif.js';
import { sampledPalettePreparation, type InternalGifEncoder } from '../gif-internal.js';
import { activeGifDither } from './gif-dither.js';
import { collectGifPaletteSample, normalizeGifPaletteSampling, yieldGifPaletteTask } from './gif-palette-sampling.js';
import { createSampledGifCodec } from './gif-sampled-codec.js';
import { resolveGifencSettings } from './gifenc-settings.js';

export function createSampledGifencEncoder(options: GifencOptions, sampling: unknown): GifEncoderFactory {
    const settings = resolveGifencSettings(options);
    const source = normalizeGifPaletteSampling(sampling, settings.maxColors);
    return ({ repeat }) => {
        const abort = new AbortController();
        const { signal } = abort;
        const { encoder: codec, install } = createSampledGifCodec(repeat, settings, source.accents);
        let width = 0, height = 0;
        let ready = false;
        let preparing = false;
        let adding = false;
        let closed = false;

        function dispose(): void {
            if (closed) return;
            closed = true;
            codec.dispose();
            abort.abort(new DOMException('GIF sampled encoder disposed', 'AbortError'));
        }
        function active(): void {
            signal.throwIfAborted();
            if (closed) throw new Error('GIF encoder is disposed');
        }
        async function prepare(w: number, h: number, background?: readonly number[]): Promise<void> {
            active();
            if (ready) return;
            if (preparing) throw new Error('GIF palette preparation is already in progress');
            preparing = true;
            try {
                const sample = source.accents.length === settings.maxColors ? new Uint8ClampedArray(0)
                    : await collectGifPaletteSample(source, w, h, signal, background);
                await yieldGifPaletteTask(signal);
                signal.throwIfAborted();
                install(sample);
                await yieldGifPaletteTask(signal);
                signal.throwIfAborted();
                width = w; height = h;
                ready = true;
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
                    const { data, width: w, height: h } = frame;
                    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 65535 || h > 65535 ||
                        data.length !== w * h * 4) throw new RangeError('Invalid GIF frame dimensions or pixel data');
                    if (!ready) await prepare(w, h);
                    active();
                    if (w !== width || h !== height) throw new Error('GIF frame dimensions must remain fixed');
                    codec.addFrame(frame);
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
                closed = true;
                return codec.finish();
            },
            dispose
        };
        Object.defineProperty(encoder, sampledPalettePreparation, { value: prepare });
        if (settings.dither === 'bayer-4x4') Object.defineProperty(encoder, activeGifDither, { value: settings.dither });
        return encoder;
    };
}
