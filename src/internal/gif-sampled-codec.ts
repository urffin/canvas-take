import { GIFEncoder, applyPalette } from 'gifenc';
import type { GifFrame } from '../gif.js';
import { applyBayerPalette } from './gif-bayer.js';
import { activeGifDither } from './gif-dither.js';
import { maxGifPaletteSampleBytes, type GifPaletteRgb } from './gif-palette-sampling.js';
import { sampledPaletteInstall } from './gif-palette-protocol.js';
import { buildSampledGifPalette, createGifAccentCorrection } from './gif-sampled-palette.js';
import type { resolveGifencSettings } from './gifenc-settings.js';

export function createSampledGifCodec(repeat: number, { maxColors, format, dither }: ReturnType<typeof resolveGifencSettings>,
    accents: GifPaletteRgb[]) {
    const mapPalette = dither === 'bayer-4x4' ? applyBayerPalette : applyPalette;
    let width = 0, height = 0;
    let palette: number[][] | undefined;
    let correct: ReturnType<typeof createGifAccentCorrection> | undefined;
    let writer: ReturnType<typeof GIFEncoder> | undefined;
    let closed = false;

    function dispose(): void {
        closed = true;
        writer = undefined;
        palette = undefined;
        correct = undefined;
    }
    function active(): void {
        if (closed) throw new Error('GIF encoder is disposed');
    }
    function install(data: unknown): void {
        active();
        if (palette) throw new Error('GIF palette sample was already installed');
        if (!(data instanceof Uint8ClampedArray) || !(data.buffer instanceof ArrayBuffer) ||
            data.byteOffset !== 0 || data.byteLength !== data.buffer.byteLength ||
            data.byteLength % 4 !== 0 || data.byteLength > maxGifPaletteSampleBytes ||
            (data.byteLength === 0 && accents.length !== maxColors)) {
            throw new Error('Invalid GIF palette sample');
        }
        for (let offset = 3; offset < data.length; offset += 4) {
            if (data[offset] !== 255) throw new Error('GIF palette sample must be opaque');
        }
        palette = buildSampledGifPalette(data, maxColors, accents, format);
        if (dither === 'none' && accents.length) correct = createGifAccentCorrection(accents, palette.length - accents.length);
    }

    const encoder = {
        addFrame({ data, width: w, height: h, durationMs }: GifFrame): void {
            active();
            if (!palette) throw new Error('GIF palette sample is not ready');
            if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 65535 || h > 65535 ||
                data.length !== w * h * 4) throw new RangeError('Invalid GIF frame dimensions or pixel data');
            if (writer && (w !== width || h !== height)) throw new Error('GIF frame dimensions must remain fixed');
            // gifenc reads the whole backing buffer. Built-in exporters supply a full-span copy.
            const pixels = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
            const index = mapPalette(pixels, palette, format, w, h);
            correct?.(pixels, index);
            const first = !writer;
            writer ??= GIFEncoder();
            writer.writeFrame(index, w, h, { ...(first ? { palette } : {}), delay: durationMs, repeat, dispose: 1 });
            width = w; height = h;
        },
        finish(): Uint8Array {
            active();
            try {
                if (!writer) throw new Error('GIF export requires at least one frame');
                writer.finish();
                return writer.bytes();
            } finally {
                dispose();
            }
        },
        dispose
    };
    Object.defineProperty(encoder, sampledPaletteInstall, { value: install });
    if (dither === 'bayer-4x4') Object.defineProperty(encoder, activeGifDither, { value: dither });
    return { encoder, install };
}
