import UPNG from 'canvastake:apng-codec';
import type { ApngEncoderFactory, ApngFrame, ApngFrameEncoder } from './apng-types.js';

/** Private pinned full-frame batch backend. Synchronous compression is not preemptible. */
export const createApngBatchEncoder: ApngEncoderFactory = ({ plays }, context) => {
    if (context.signal.aborted) throw context.signal.reason;
    if (!Number.isInteger(plays) || plays < 0 || plays > 0xffffffff) throw new RangeError('Invalid APNG plays');
    if (!Number.isSafeInteger(context.maxInputBytes) || context.maxInputBytes < 1) throw new RangeError('Invalid APNG input budget');
    for (const value of [context.maxInputBytes, context.maxOutputBytes]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError('Invalid APNG byte budget');
    }
    let frames: ApngFrame[] = [], width = 0, height = 0, inputBytes = 0, closed = false;
    const active = () => { if (context.signal.aborted) throw context.signal.reason; if (closed) throw new Error('APNG backend is closed'); };
    const encoder: ApngFrameEncoder = {
        addFrame(frame) {
            active();
            const w = frame.width, h = frame.height, bytes = w * h * 4;
            if (![w, h].every(n => Number.isInteger(n) && n > 0 && n <= 0x7fffffff) || !Number.isSafeInteger(bytes) || (frames.length && (w !== width || h !== height))) throw new RangeError('Invalid APNG frame dimensions');
            if (!Number.isInteger(frame.durationMs) || frame.durationMs < 1 || frame.durationMs > 65535) throw new RangeError('Invalid APNG frame delay');
            if (!(frame.data instanceof Uint8ClampedArray) || !(frame.data.buffer instanceof ArrayBuffer) || frame.data.byteOffset !== 0 || frame.data.byteLength !== bytes || frame.data.buffer.byteLength !== bytes) throw new TypeError('APNG requires an owned full-frame RGBA8 buffer');
            if (bytes > context.maxInputBytes - inputBytes) throw new RangeError('APNG maxInputBytes exceeded');
            width = w; height = h; inputBytes += bytes;
            // Take ownership of data; snapshot metadata so caller mutation cannot alter the timeline.
            frames.push({ width: w, height: h, data: frame.data, durationMs: frame.durationMs });
        },
        finish() {
            active(); if (!frames.length) throw new RangeError('APNG requires at least one frame');
            try {
                const bytes = new Uint8Array(UPNG.encodeLL(frames.map(f => f.data.buffer as ArrayBuffer), width, height,
                    3, 1, 8, frames.map(f => f.durationMs), { loop: plays, sRGB: 0 }));
                active();
                if (context.maxOutputBytes !== undefined && bytes.byteLength > context.maxOutputBytes) throw new RangeError('APNG maxOutputBytes exceeded');
                return bytes;
            } finally { encoder.dispose(); }
        },
        dispose() { if (closed) return; closed = true; frames.length = 0; context.signal.removeEventListener('abort', onAbort); }
    };
    function onAbort() { encoder.dispose(); }
    context.signal.addEventListener('abort', onAbort, { once: true });
    if (context.signal.aborted) { encoder.dispose(); throw context.signal.reason; }
    return encoder;
};
