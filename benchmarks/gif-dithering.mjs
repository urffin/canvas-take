const bayer4 = [
    0, 8, 2, 10,
    12, 4, 14, 6,
    3, 11, 1, 9,
    15, 7, 13, 5
];

// Match the key used by gifenc 1.0.3 in its rgb565 mapping mode.
const rgb565 = (r, g, b) => ((r << 8) & 0xf800) | ((g << 2) & 0x03e0) | (b >> 3);
const clamp = value => Math.max(0, Math.min(255, value));

function nearestColors(r, g, b, palette) {
    let first = 0, second = 0;
    let firstDistance = Infinity, secondDistance = Infinity;
    for (let i = 0; i < palette.length; i++) {
        const [pr, pg, pb] = palette[i];
        const distance = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
        if (distance <= firstDistance) {
            secondDistance = firstDistance;
            second = first;
            firstDistance = distance;
            first = i;
        } else if (distance <= secondDistance) {
            secondDistance = distance;
            second = i;
        }
    }
    return [first, second];
}

export function orderedBayer(data, palette, width, height) {
    const indices = new Uint8Array(width * height);
    const pairs = new Array(65536);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const pixel = y * width + x;
            const offset = pixel * 4;
            const r = data[offset], g = data[offset + 1], b = data[offset + 2];
            const key = rgb565(r, g, b);
            let pair = pairs[key];
            if (!pair) {
                const [first, second] = nearestColors(r, g, b, palette);
                const [pr, pg, pb] = palette[first];
                const dr = palette[second][0] - pr, dg = palette[second][1] - pg, db = palette[second][2] - pb;
                pair = pairs[key] = {first, second, pr, pg, pb, dr, dg, db, lengthSquared: dr * dr + dg * dg + db * db};
            }
            const projection = (r - pair.pr) * pair.dr + (g - pair.pg) * pair.dg + (b - pair.pb) * pair.db;
            const threshold = (bayer4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
            indices[pixel] = projection > threshold * pair.lengthSquared ? pair.second : pair.first;
        }
    }
    return indices;
}

export function floydSteinberg(data, palette, width, height) {
    const indices = new Uint8Array(width * height);
    const nearest = new Int16Array(65536).fill(-1);
    let row = new Float32Array((width + 2) * 3);
    let nextRow = new Float32Array(row.length);
    const adjusted = new Float64Array(3);

    for (let y = 0; y < height; y++) {
        const direction = y % 2 === 0 ? 1 : -1;
        let x = direction === 1 ? 0 : width - 1;
        for (let column = 0; column < width; column++, x += direction) {
            const pixel = y * width + x;
            const offset = pixel * 4;
            const slot = (x + 1) * 3;
            for (let c = 0; c < 3; c++) adjusted[c] = clamp(data[offset + c] + row[slot + c]);
            const [r, g, b] = adjusted;
            const key = rgb565(r, g, b);
            let index = nearest[key];
            if (index === -1) index = nearest[key] = nearestColors(r, g, b, palette)[0];
            indices[pixel] = index;
            const chosen = palette[index];
            for (let c = 0; c < 3; c++) {
                const current = slot + c;
                const error = (adjusted[c] - chosen[c]) / 16;
                row[current + direction * 3] += 7 * error;
                nextRow[current - direction * 3] += 3 * error;
                nextRow[current] += 5 * error;
                nextRow[current + direction * 3] += error;
            }
        }
        const previousRow = row;
        row = nextRow;
        nextRow = previousRow;
        nextRow.fill(0);
    }
    return indices;
}

const tileColors = [
    0xe63946, 0xfd9353, 0xf6c244, 0xd4e54c, 0x94c853, 0x42c687, 0x31cdbc, 0x26bed9,
    0x4098eb, 0x566def, 0x845ae6, 0xa455d5, 0xc859b9, 0xe9619c, 0xf48691, 0xcc7865,
    0xa85536, 0x916a45, 0x747747, 0x48744d, 0x3c7977, 0x436a9b, 0x665994, 0x875979
];

function flatColor(x, y, width, height) {
    const tileWidth = Math.floor(width / 8), tileHeight = Math.floor(height / 5);
    const column = Math.floor(x / tileWidth), row = Math.floor(y / tileHeight);
    if (row < 3 && column < 8 && x % tileWidth >= 3 && y % tileHeight >= 3) {
        return tileColors[row * 8 + column];
    }
    return y >= height * 0.78 ? 0x233d57 : 0x102030;
}

function gradientColor(x, y, width, height) {
    const u = x / (width - 1), v = y / (height - 1);
    if (v < 0.42) {
        const grey = Math.round(8 + 236 * u);
        return (grey << 16) | (grey << 8) | grey;
    }
    const r = Math.round(20 + 210 * u);
    const g = Math.round(25 + 185 * (0.65 * u + 0.35 * v));
    const b = Math.round(24 + 211 * (0.73 * (1 - u) + 0.27 * v));
    return (r << 16) | (g << 8) | b;
}

function writeColor(data, offset, color) {
    data[offset] = color >> 16;
    data[offset + 1] = (color >> 8) & 255;
    data[offset + 2] = color & 255;
    data[offset + 3] = 255;
}

export function makeFrames(scene, width, height, count) {
    const background = new Uint8Array(width * height * 4);
    const colors = new Set([0xfffaf3]);
    const paint = scene === 'flat' ? flatColor : gradientColor;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const color = paint(x, y, width, height);
            writeColor(background, (y * width + x) * 4, color);
            colors.add(color);
        }
    }
    const markerWidth = Math.floor(width * 0.06);
    const frames = Array.from({length: count}, (_, i) => {
        const data = background.slice();
        const startX = Math.round(i * (width - markerWidth) / (count - 1));
        for (let y = Math.floor(height * 0.84); y < Math.floor(height * 0.91); y++) {
            for (let x = startX; x < startX + markerWidth; x++) writeColor(data, (y * width + x) * 4, 0xfffaf3);
        }
        return {data, width, height, durationMs: i === count - 1 ? 560 : 80};
    });
    return {frames, colorCount: colors.size};
}
