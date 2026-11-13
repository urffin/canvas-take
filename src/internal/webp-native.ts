import type { WebpFrameEncoder, WebpFrame, WebpExportLimits } from './webp-types.js';
import { checkCodec, checkLimits, checkPlays, type WebpCodecOptions } from './webp-config.js';
export interface WebpNativeModule {
    HEAPU8: Uint8Array<ArrayBuffer>;
    _ct_binding_abi(): number; _ct_profile(): number; _ct_version(): number;
    _ct_open(width: number, height: number, plays: number, lossless: number, quality: number, method: number, maxOutput: number): number;
    _ct_malloc(bytes: number): number; _ct_free(pointer: number): void; _ct_close(session: number): void;
    _ct_add(session: number, pointer: number, length: number, duration: number): number;
    _ct_finish(session: number): number; _ct_data(session: number): number; _ct_size(session: number): number; _ct_error(): number;
}
export type WebpNativeFactory = (options: { wasmBinary: Uint8Array }) => Promise<WebpNativeModule>;
export function checkBinding(module: WebpNativeModule): void {
    if (!module || module._ct_binding_abi?.() !== 1 || module._ct_profile?.() !== 1 || module._ct_version?.() !== 0x010600 ||
        !(module.HEAPU8 instanceof Uint8Array) || !(module.HEAPU8.buffer instanceof ArrayBuffer)) throw new Error('Incompatible WebP native ABI/profile');
    for (const method of ['_ct_open', '_ct_malloc', '_ct_free', '_ct_close', '_ct_add', '_ct_finish', '_ct_data', '_ct_size', '_ct_error'] as const)
        if (typeof module[method] !== 'function') throw new Error('Incomplete WebP native binding');
}
/** Batch admission retains exclusive snapshots; only finish enters synchronous native compression. */
export function createWebpNativeEncoder(module: WebpNativeModule | undefined, plays: number, limitsValue: WebpExportLimits, codecValue: WebpCodecOptions): WebpFrameEncoder {
    checkBinding(module!); checkPlays(plays); const limits = checkLimits(limitsValue), codec = checkCodec(codecValue);
    const frames: WebpFrame[] = []; let width = 0, height = 0, duration = 0, inputBytes = 0, closed = false;
    function dispose(): void { closed = true; frames.length = 0; module = undefined; }
    function nativeError(m: WebpNativeModule): Error {
        const start = m._ct_error(); let end = start;
        while (end < m.HEAPU8.length && m.HEAPU8[end] && end - start < 4096) end++;
        return new Error(new TextDecoder().decode(m.HEAPU8.subarray(start, end)) || 'WebP native allocation failed');
    }
    return {
        addFrame(frame) {
            if (closed) throw new Error('WebP native encoder closed');
            try {
                const { width: w, height: h, durationMs: delay, data } = frame;
                if (![w, h].every(n => Number.isInteger(n) && n >= 1 && n <= 16383) ||
                    (frames.length && (w !== width || h !== height))) throw new RangeError('Invalid WebP frame dimensions');
                const bytes = w * h * 4;
                if (!Number.isInteger(delay) || delay < 1 || delay > 16777215) throw new RangeError('Invalid WebP frame duration');
                if (!(data instanceof Uint8ClampedArray) || !(data.buffer instanceof ArrayBuffer) || data.byteOffset !== 0 || data.byteLength !== bytes || data.buffer.byteLength !== bytes) throw new TypeError('Invalid owned WebP frame');
                if (w * h > limits.maxFramePixels || frames.length >= limits.maxFrames || delay > limits.maxDurationMs - duration || bytes > limits.maxInputBytes - inputBytes) throw new RangeError('WebP Worker input budget exceeded');
                // Snapshot metadata too: even private direct callers cannot rewrite an admitted hold.
                frames.push(Object.freeze({ width: w, height: h, data, durationMs: delay }));
                width = w; height = h; duration += delay; inputBytes += bytes;
            } catch (error) { dispose(); throw error; }
        },
        finish() {
            if (closed) throw new Error('WebP native encoder closed');
            let session = 0, input = 0; const m = module!;
            try {
                if (!frames.length) throw new RangeError('WebP requires at least one frame');
                session = m._ct_open(width, height, plays, Number(codec.lossless), codec.quality, codec.method, limits.maxOutputBytes);
                if (!session) throw nativeError(m);
                input = m._ct_malloc(width * height * 4); if (!input) throw new Error('WebP input allocation failed');
                for (const frame of frames) {
                    m.HEAPU8.set(frame.data, input);
                    if (!m._ct_add(session, input, frame.data.byteLength, frame.durationMs)) throw nativeError(m);
                }
                if (!m._ct_finish(session)) throw nativeError(m);
                const pointer = m._ct_data(session), size = m._ct_size(session);
                if (!pointer || !size || size > limits.maxOutputBytes || pointer + size > m.HEAPU8.length) throw new RangeError('Invalid WebP native output or budget');
                return m.HEAPU8.slice(pointer, pointer + size);
            } finally { try { m._ct_free(input); } finally { try { m._ct_close(session); } finally { dispose(); } } }
        },
        dispose
    };
}
