import type { WebpExportLimits } from './webp-types.js';
export const webpProfile = 'libwebp-batch-animation-v1';
export interface WebpCodecOptions { readonly lossless: boolean; readonly quality: number; readonly method: number }
export function checkCodec(value: WebpCodecOptions): WebpCodecOptions {
    if (!value || typeof value.lossless !== 'boolean' || !Number.isFinite(value.quality) || value.quality < 0 || value.quality > 100 ||
        !Number.isInteger(value.method) || value.method < 0 || value.method > 6) throw new RangeError('Invalid WebP codec options');
    return Object.freeze({ lossless: value.lossless, quality: value.quality, method: value.method });
}
export function checkLimits(value: WebpExportLimits): Readonly<WebpExportLimits> {
    const result = {} as Record<keyof WebpExportLimits, number>;
    for (const key of ['maxFramePixels', 'maxFrames', 'maxDurationMs', 'maxInputBytes', 'maxOutputBytes'] as const) {
        const n = value?.[key];
        if (!Number.isInteger(n) || n < 1 || n > 2147483647) throw new RangeError('Invalid WebP ' + key);
        result[key] = n;
    }
    return Object.freeze(result);
}
export function checkPlays(plays: number): void {
    if (!Number.isInteger(plays) || plays < 0 || plays > 65535) throw new RangeError('Invalid WebP plays');
}
