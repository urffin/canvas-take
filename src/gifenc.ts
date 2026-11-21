import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { GifEncoderFactory, GifFrameEncoder } from './gif.js';
import { applyBayerPalette } from './internal/gif-bayer.js';
import { activeGifDither, resolveGifDither } from './internal/gif-dither.js';

export interface GifencOptions {
    /** Maximum colors per frame: 2..256. Default 256. */
    readonly maxColors?: number;
    /** high: RGB565 quantization; fast: RGB444. Default high. */
    readonly quality?: 'high' | 'fast';
    /** Optional ordered 4×4 Bayer dithering. Default none. */
    readonly dither?: 'none' | 'bayer-4x4';
}
/** Optional gifenc adapter. Import only when using this implementation. */
export function createGifencEncoder(options: GifencOptions = {}): GifEncoderFactory {
    const maxColors = options.maxColors ?? 256;
    const quality = options.quality ?? 'high';
    if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) throw new RangeError('maxColors must be 2..256');
    if (quality !== 'high' && quality !== 'fast') throw new TypeError('quality must be high or fast');
    const format = quality === 'high' ? 'rgb565' : 'rgb444';
    const dither = resolveGifDither(options.dither);
    const mapPalette = dither === 'bayer-4x4' ? applyBayerPalette : applyPalette;
    return ({ repeat }) => {
        let encoder: ReturnType<typeof GIFEncoder> | undefined = GIFEncoder();
        const frameEncoder: GifFrameEncoder = {
            addFrame({ data, width, height, durationMs }) {
                if (!encoder) throw new Error('GIF encoder is disposed');
                const palette = quantize(data, maxColors, { format });
                const index = mapPalette(data, palette, format, width, height);
                encoder.writeFrame(index, width, height, { palette, delay: durationMs, repeat, dispose: 1 });
            },
            finish() {
                if (!encoder) throw new Error('GIF encoder is disposed');
                encoder.finish();
                const bytes = encoder.bytes();
                encoder = undefined;
                return bytes;
            },
            dispose() { encoder = undefined; }
        };
        if (dither === 'bayer-4x4') Object.defineProperty(frameEncoder, activeGifDither, { value: dither });
        return frameEncoder;
    };
}
