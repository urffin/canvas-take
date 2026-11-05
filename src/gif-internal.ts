import type { GifFrame, GifFrameEncoder } from './gif.js';

// Private convention shared by independently bundled entries. Not a plugin API.
export const rawPreparation = Symbol.for('@grundyjs/canvas-take/gif/raw-preparation/v1');
export interface InternalGifEncoder extends GifFrameEncoder {
    [rawPreparation]?: (frame: GifFrame, background: readonly number[]) => Promise<'declined' | 'encoded'>;
}

export function validateRawFrame(frame: GifFrame, background: readonly number[]): void {
    if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) ||
        frame.width < 1 || frame.width > 65535 || frame.height < 1 || frame.height > 65535 ||
        !(frame.data instanceof Uint8ClampedArray) || !(frame.data.buffer instanceof ArrayBuffer) ||
        frame.data.byteOffset !== 0 || frame.data.byteLength !== frame.data.buffer.byteLength ||
        frame.data.length !== frame.width * frame.height * 4 ||
        !Number.isInteger(frame.durationMs) || frame.durationMs < 10 || frame.durationMs > 655350 || frame.durationMs % 10 !== 0) {
        throw new Error('Invalid GIF raw frame');
    }
    if (!Array.isArray(background) || background.length !== 3 || background.some(v => !Number.isInteger(v) || v < 0 || v > 255)) {
        throw new Error('Invalid GIF raw background');
    }
}
