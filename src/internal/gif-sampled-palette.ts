import gifenc from 'gifenc';
import { gifRgbKey, type GifPaletteRgb } from './gif-palette-sampling.js';

export function buildSampledGifPalette(sample: Uint8ClampedArray, maxColors: number, accents: GifPaletteRgb[],
    format: 'rgb565' | 'rgb444'): number[][] {
    const budget = maxColors - accents.length;
    if (budget === 0) return accents;
    if (accents.length === 0) return gifenc.quantize(sample, budget, { format });

    const reserved = new Set(accents.map(color => gifRgbKey(...color)));
    let kept = 0;
    for (let offset = 0; offset < sample.length; offset += 4) {
        if (reserved.has(gifRgbKey(sample[offset], sample[offset + 1], sample[offset + 2]))) continue;
        sample.copyWithin(kept, offset, offset + 4);
        kept += 4;
    }
    if (kept === 0) return accents;
    // gifenc quantizes the whole backing buffer, including bytes outside a subarray.
    const compact = kept === sample.length ? sample : sample.slice(0, kept);
    const colors = gifenc.quantize(compact, budget, { format });
    return [...colors.filter(([r, g, b]) => !reserved.has(gifRgbKey(r, g, b))), ...accents];
}

export function createGifAccentCorrection(accents: GifPaletteRgb[], firstAccent: number) {
    const indices = new Map<number, number>();
    const blues = new Uint8Array(256);
    for (const [offset, [r, g, b]] of accents.entries()) {
        indices.set(gifRgbKey(r, g, b), firstAccent + offset);
        blues[b] = 1;
    }
    return (data: Uint8ClampedArray, mapped: Uint8Array): void => {
        for (let pixel = 0, offset = 0; pixel < mapped.length; pixel++, offset += 4) {
            const blue = data[offset + 2];
            if (!blues[blue]) continue;
            const exact = indices.get(gifRgbKey(data[offset], data[offset + 1], blue));
            if (exact !== undefined) mapped[pixel] = exact;
        }
    };
}
