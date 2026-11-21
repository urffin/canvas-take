// Fixed 5×7 glyphs keep the source pixels independent of platform fonts and antialiasing.
const glyphs = {
    S: [15, 16, 16, 14, 1, 1, 30], O: [14, 17, 17, 17, 17, 17, 14],
    R: [30, 17, 17, 30, 20, 18, 17], T: [31, 4, 4, 4, 4, 4, 4],
    0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14],
    2: [14, 17, 1, 2, 4, 8, 31], 3: [30, 1, 1, 14, 1, 1, 30],
    4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 16, 30, 1, 1, 30],
    6: [14, 16, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8],
    8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 1, 14]
};

function rectangle({data, width, height}, x, y, w, h, [r, g, b]) {
    // Draw the same 320×180 logical scene at the quick and full resolutions.
    const left = Math.round(x * width / 320), right = Math.round((x + w) * width / 320);
    const top = Math.round(y * height / 180), bottom = Math.round((y + h) * height / 180);
    for (let row = top; row < bottom; row++) {
        let offset = (row * width + left) * 4;
        for (let col = left; col < right; col++, offset += 4) {
            data[offset] = r;
            data[offset + 1] = g;
            data[offset + 2] = b;
            data[offset + 3] = 255;
        }
    }
}

function label(frame, text, x, y, color) {
    for (const [letter, glyph] of [...text].entries()) {
        for (const [row, bits] of glyphs[glyph].entries()) {
            for (let col = 0; col < 5; col++) {
                if (bits & (16 >> col)) rectangle(frame, x + letter * 12 + col * 2, y + row * 2, 2, 2, color);
            }
        }
    }
}

function drawChart(frame, index, warm) {
    rectangle(frame, 0, 0, 320, 180, warm ? [56, 27, 21] : [16, 25, 42]);
    rectangle(frame, 12, 34, 296, 106, warm ? [81, 41, 28] : [25, 38, 58]);
    for (let column = 0; column < 16; column++) {
        const x = 20 + 18 * column;
        const slot = (column + index) % 16;
        const bar = 17 + (slot * 23 % 65);
        const color = warm ? [166 + 5 * slot, 65 + 7 * slot, 30 + 3 * slot]
            : [42 + 7 * slot, 90 + 5 * slot, 170 + 4 * slot];
        rectangle(frame, x, 127 - bar, 12, bar, color);
        rectangle(frame, x, 127 - bar, 12, 4, [color[0] + 8, color[1] + 12, color[2] + 7]);
        rectangle(frame, x, 145, 12, 7, [79 + 9 * column, 192 - 7 * column, 75 + 5 * column]);
    }
    rectangle(frame, 20, 128, 282, 1, [117, 129, 144]);
    rectangle(frame, 12 + 18 * (index % 16), 156, 16, 3, [249, 218, 112]);
}

const triangle = phase => {
    const position = phase % 512;
    return position < 256 ? position : 511 - position;
};

function drawGradient({data, width, height}, index) {
    for (let y = 0; y < height; y++) {
        const v = Math.round(220 * y / (height - 1));
        // Keep a strip of the gradient stationary to test temporal color error.
        const phase = y < height * 0.72 ? index * 6 : 0;
        for (let x = 0; x < width; x++) {
            const u = Math.round(330 * x / (width - 1));
            const offset = (y * width + x) * 4;
            if (y < height * 0.40) {
                const gray = 12 + Math.round(229 * triangle(u + phase) / 255);
                data[offset] = gray;
                data[offset + 1] = gray;
                data[offset + 2] = gray;
            } else {
                data[offset] = 22 + Math.round(triangle(u + (v >> 1) + phase) * 0.83);
                data[offset + 1] = 28 + Math.round(triangle(v + (u >> 1) + 2 * phase) * 0.74);
                data[offset + 2] = 33 + Math.round(triangle(370 - u + v + phase) * 0.75);
            }
            data[offset + 3] = 255;
        }
    }
}

export const paletteScenes = ['flat-text', 'moving-gradient', 'scene-cut'];

export function makePaletteFrames(scene, width, height, count) {
    const cutFrame = scene === 'scene-cut' ? count / 2 : undefined;
    const frames = Array.from({length: count}, (_, index) => {
        const frame = {
            width, height, data: new Uint8ClampedArray(width * height * 4),
            durationMs: index === count - 1 ? 560 : 80
        };
        if (scene === 'flat-text' || index < cutFrame) drawChart(frame, index, scene === 'scene-cut');
        else drawGradient(frame, index - (cutFrame ?? 0));
        rectangle(frame, 0, 0, 320, 28, [20, 32, 48]);
        rectangle(frame, 0, 163, 320, 17, [20, 32, 48]);
        rectangle(frame, 12, 167, 296, 4, [173, 194, 215]);
        label(frame, 'SORT', 12, 7, [242, 245, 249]);
        label(frame, String(index).padStart(2, '0'), 277, 7, [98, 212, 185]);
        return frame;
    });
    return {frames, cutFrame};
}
