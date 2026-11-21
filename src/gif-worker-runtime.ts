import { createGifencEncoder } from './gifenc.js';
import type { GifFrame, GifFrameEncoder } from './gif.js';
import type { GifencOptions } from './gifenc.js';
import { blendRange } from './internal/rgba.js';
import { validateRawFrame } from './gif-internal.js';
import { activeGifDither } from './internal/gif-dither.js';
import { sampledPaletteAction, sampledPaletteCodecRequest, sampledPaletteInstall, sampledPaletteMode,
    unsupportedSampledPalette } from './internal/gif-palette-protocol.js';

const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent) => void;
    postMessage(message: unknown, transfer?: Transferable[]): void;
};
let encoder: GifFrameEncoder | undefined;
let palette: { install: (data: unknown) => void; ready: boolean } | undefined;
let failed = false;

scope.onmessage = event => {
    const { id, action, value } = event.data;
    let errorCode: typeof unsupportedSampledPalette | undefined;
    try {
        if (failed) throw new Error('GIF Worker session failed');
        if (action === 'init') {
            if (encoder) throw new Error('GIF Worker already initialized');
            const options = value as GifencOptions & { repeat: number; paletteMode?: unknown; accentColors?: unknown };
            const sampled = options.paletteMode === sampledPaletteMode;
            if (options.paletteMode !== undefined && !sampled) {
                errorCode = unsupportedSampledPalette;
                throw new Error('GIF Worker does not support the requested palette mode');
            }
            const codecOptions = sampled ? { ...options, [sampledPaletteCodecRequest]: options.accentColors } : options;
            encoder = createGifencEncoder(codecOptions)({ repeat: options.repeat });
            if (sampled) {
                const install = Object.getOwnPropertyDescriptor(encoder, sampledPaletteInstall)?.value;
                if (typeof install !== 'function') {
                    errorCode = unsupportedSampledPalette;
                    throw new Error('GIF Worker codec does not support sampled palettes');
                }
                palette = { install, ready: false };
            }
            if (options.dither === 'bayer-4x4' &&
                Object.getOwnPropertyDescriptor(encoder, activeGifDither)?.value !== options.dither) {
                throw new Error('GIF Worker codec does not support bayer-4x4 dithering');
            }
            scope.postMessage({ id, rawPreparationVersion: 1,
                ...(options.dither === 'bayer-4x4' ? { activeDither: options.dither } : {}),
                ...(sampled ? { activePalette: sampledPaletteMode } : {}) });
            return;
        }
        if (!encoder) throw new Error('GIF Worker is not initialized');
        if (action === sampledPaletteAction) {
            if (!palette || palette.ready) throw new Error('GIF Worker did not expect a palette sample');
            palette.install(value?.data);
            palette.ready = true;
            scope.postMessage({ id, paletteReady: 1 });
            return;
        }
        if (palette && !palette.ready) throw new Error('GIF Worker palette sample is not ready');
        if (action === 'frame') encoder.addFrame(value as GifFrame);
        else if (action === 'raw-frame-v1') {
            validateRawFrame(value, value?.background);
            blendRange(value.data, 0, value.width * value.height, value.background);
            encoder.addFrame(value as GifFrame);
            scope.postMessage({ id, rawFrameEncoded: 1 });
            return;
        } else if (action === 'finish') {
            const bytes = encoder.finish() as Uint8Array;
            encoder.dispose(); encoder = undefined; palette = undefined;
            scope.postMessage({ id, bytes }, [bytes.buffer as ArrayBuffer]);
            return;
        } else throw new Error('Unknown GIF Worker request');
        scope.postMessage({ id });
    } catch (error) {
        failed ||= palette !== undefined || action === sampledPaletteAction ||
            (action === 'init' && value?.paletteMode !== undefined);
        encoder?.dispose(); encoder = undefined; palette = undefined;
        scope.postMessage({ id, error: error instanceof Error ? error.message : String(error),
            ...(errorCode ? { errorCode } : {}) });
    }
};
