import { createGifencEncoder } from './gifenc.js';
import type { GifFrame, GifFrameEncoder } from './gif.js';
import type { GifencOptions } from './gifenc.js';
import { blendRange } from './internal/rgba.js';
import { validateRawFrame } from './gif-internal.js';
import { activeGifDither } from './internal/gif-dither.js';

const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent) => void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};
let encoder: GifFrameEncoder | undefined;
scope.onmessage = event => {
    const { id, action, value } = event.data;
    try {
        if (action === 'init') {
            if (encoder) throw new Error('GIF Worker already initialized');
            const options = value as GifencOptions & { repeat: number };
            encoder = createGifencEncoder(options)({ repeat: options.repeat });
            if (options.dither === 'bayer-4x4') {
                // The runtime and codec can come from independent deployments.
                if (Object.getOwnPropertyDescriptor(encoder, activeGifDither)?.value !== options.dither) {
                    throw new Error('GIF Worker codec does not support bayer-4x4 dithering');
                }
                scope.postMessage({ id, rawPreparationVersion: 1, activeDither: options.dither });
            } else {
                scope.postMessage({ id, rawPreparationVersion: 1 });
            }
            return;
        } else if (!encoder) throw new Error('GIF Worker is not initialized');
        else if (action === 'frame') encoder.addFrame(value as GifFrame);
        else if (action === 'raw-frame-v1') {
            validateRawFrame(value, value?.background);
            blendRange(value.data, 0, value.width * value.height, value.background);
            encoder.addFrame(value as GifFrame);
            scope.postMessage({ id, rawFrameEncoded: 1 });
            return;
        }
        else if (action === 'finish') {
            const bytes = encoder.finish() as Uint8Array;
            encoder.dispose(); encoder = undefined;
            scope.postMessage({ id, bytes }, [bytes.buffer as ArrayBuffer]);
            return;
        } else throw new Error('Unknown GIF Worker request');
        scope.postMessage({ id });
    } catch (error) {
        encoder?.dispose(); encoder = undefined;
        scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
};
