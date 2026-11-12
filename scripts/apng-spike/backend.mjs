import UPNG, { setCompressionProbe } from 'spike:upng';

// Batch backend feasibility only. Not the proposed controller or a package entry.
export function encodeApng({ width, height, frames, plays = 0, maxInputBytes = 64 * 1024 * 1024, maxOutputBytes }, probe) {
    if (![width, height].every(n => Number.isInteger(n) && n > 0 && n <= 0x7fffffff) || !Number.isSafeInteger(width * height * 4)) throw new RangeError('Invalid dimensions');
    if (!Number.isInteger(plays) || plays < 0 || plays > 0xffffffff) throw new RangeError('Invalid plays');
    if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1))) throw new RangeError('Invalid byte budget');
    if (!Array.isArray(frames) || !frames.length) throw new RangeError('No frames');
    const bytes = width * height * 4, total = bytes * frames.length;
    if (!Number.isSafeInteger(total) || total > maxInputBytes) throw new RangeError('maxInputBytes exceeded');
    for (const frame of frames) {
        if (!(frame.data instanceof Uint8Array || frame.data instanceof Uint8ClampedArray) || !(frame.data.buffer instanceof ArrayBuffer) || frame.data.byteLength !== bytes || frame.data.byteOffset !== 0 || frame.data.buffer.byteLength !== bytes) throw new TypeError('Expected owned full-frame RGBA8 buffer');
        if (!Number.isInteger(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 65535) throw new RangeError('Invalid frame delay');
    }
    setCompressionProbe(probe);
    try {
        const data = new Uint8Array(UPNG.encodeLL(frames.map(f => f.data.buffer), width, height, 3, 1, 8, frames.map(f => f.durationMs), { loop: plays, sRGB: 0 }));
        if (maxOutputBytes !== undefined && data.byteLength > maxOutputBytes) throw new RangeError('maxOutputBytes exceeded');
        return data;
    } finally { setCompressionProbe(undefined); }
}
