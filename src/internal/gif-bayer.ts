const bayer4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
].map(rank => (rank + 0.5) / 16);

// Use the same RGB buckets as gifenc's RGB565 and RGB444 paths.
const rgb565 = (r: number, g: number, b: number) => ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
const rgb444 = (r: number, g: number, b: number) => ((r >> 4) << 8) | (g & 0xf0) | (b >> 4);
const rgb888 = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;

function nearestPair(r: number, g: number, b: number, palette: number[][]) {
    let first = 0, second = 0;
    let firstDistance = Infinity, secondDistance = Infinity;
    for (let i = 0; i < palette.length; i++) {
        const [pr, pg, pb] = palette[i];
        const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        // Like gifenc, prefer the last entry on a tie.
        if (distance <= firstDistance) {
            second = first;
            secondDistance = firstDistance;
            first = i;
            firstDistance = distance;
        } else if (distance <= secondDistance) {
            second = i;
            secondDistance = distance;
        }
    }

    const [pr, pg, pb] = palette[first];
    const [sr, sg, sb] = palette[second];
    const dr = sr - pr, dg = sg - pg, db = sb - pb;
    return { first, second, pr, pg, pb, dr, dg, db, lengthSquared: dr * dr + dg * dg + db * db };
}

export function applyBayerPalette(data: Uint8ClampedArray, palette: number[][],
    format: 'rgb565' | 'rgb444', width: number, height: number): Uint8Array {
    const indices = new Uint8Array(width * height);
    if (palette.length === 1) return indices;

    const exact = new Map<number, number>();
    for (const [index, [r, g, b]] of palette.entries()) exact.set(rgb888(r, g, b), index);
    const bucketKey = format === 'rgb565' ? rgb565 : rgb444;
    let pairs: (ReturnType<typeof nearestPair> | undefined)[] | undefined;
    let pixel = 0;
    for (let y = 0; y < height; y++) {
        const row = (y & 3) * 4;
        for (let x = 0; x < width; x++, pixel++) {
            const offset = pixel * 4;
            const r = data[offset], g = data[offset + 1], b = data[offset + 2];
            const exactIndex = exact.get(rgb888(r, g, b));
            if (exactIndex !== undefined) {
                indices[pixel] = exactIndex;
                continue;
            }

            // Only non-exact pixels nominate bucket representatives. Flat frames with
            // exact colors never allocate the pair cache.
            pairs ??= new Array(format === 'rgb565' ? 65536 : 4096);
            const key = bucketKey(r, g, b);
            const pair = pairs[key] ??= nearestPair(r, g, b, palette);
            const projection = (r - pair.pr) * pair.dr + (g - pair.pg) * pair.dg + (b - pair.pb) * pair.db;
            indices[pixel] = projection > bayer4[row + (x & 3)] * pair.lengthSquared ? pair.second : pair.first;
        }
    }
    return indices;
}
