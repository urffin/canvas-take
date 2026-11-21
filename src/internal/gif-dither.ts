export const activeGifDither = Symbol.for('@grundyjs/canvas-take/gif/active-dither/v1');

export function resolveGifDither(dither: unknown): 'none' | 'bayer-4x4' {
    if (dither === undefined || dither === 'none') return 'none';
    if (dither === 'bayer-4x4') return dither;
    throw new TypeError('dither must be none or bayer-4x4');
}
