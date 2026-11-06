// Pure in-place composition of an owned RGBA8 pixel range. Scheduling belongs to the caller.
export function blendRange(data: Uint8ClampedArray, start: number, end: number, background: readonly number[]): void {
    for (let i = start * 4; i < end * 4; i += 4) {
        if (data[i + 3] === 255) continue;
        const alpha = data[i + 3] / 255;
        for (let c = 0; c < 3; c++) data[i + c] = Math.round(data[i + c] * alpha + background[c] * (1 - alpha));
        data[i + 3] = 255;
    }
}
