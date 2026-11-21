import type { GifencOptions } from '../gifenc.js';
import { resolveGifDither } from './gif-dither.js';

export function resolveGifencSettings(options: GifencOptions) {
    const maxColors = options.maxColors ?? 256;
    const quality = options.quality ?? 'high';
    if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256) throw new RangeError('maxColors must be 2..256');
    if (quality !== 'high' && quality !== 'fast') throw new TypeError('quality must be high or fast');
    const format = quality === 'high' ? 'rgb565' : 'rgb444';
    return { maxColors, format, dither: resolveGifDither(options.dither) } as const;
}
