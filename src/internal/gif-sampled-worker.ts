import type { GifEncoderFactory } from '../gif.js';
import { createGifWorkerEncoder, type GifWorkerOptions } from '../gif-worker.js';
import { sampledPaletteWorkerSource } from './gif-palette-protocol.js';

export function createSampledGifWorkerEncoder(options: GifWorkerOptions, sampling: unknown): GifEncoderFactory {
    const internal = { ...options, [sampledPaletteWorkerSource]: sampling };
    return createGifWorkerEncoder(internal);
}
