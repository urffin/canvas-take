/** DESIGN ONLY. Imports resolve to draft declarations; this file is typechecked, not executed. */
import {
    createWebpController, createWebpWorkerEncoder,
    type WebpEncoderFactory, type WebpExportProgress, type WebpFrameEncoder, type WebpFrame
} from './webp-export-api.js';

/** Any conforming encoder can be selected; no supplied codec import is needed by the controller. */
export async function customEncoderSketch(
    canvas: HTMLCanvasElement | OffscreenCanvas,
    encoder: WebpEncoderFactory,
    draw: (index: number) => void,
    signal: AbortSignal,
    onProgress: (progress: WebpExportProgress) => void
): Promise<Blob> {
    const exporter = createWebpController({ encoder, signal, onProgress, plays: 1,
        totalFrames: 3, maxFrames: 3, maxDurationMs: 2160,
        maxFramePixels: 640 * 360, maxInputBytes: 3 * 640 * 360 * 4,
        maxOutputBytes: 8 * 1024 * 1024 });
    try {
        for (const [index, delay] of [55, 105, 2000].entries()) {
            draw(index); // Draw/clear a complete image; it is captured before addFrame first yields.
            await exporter.addFrame(canvas, delay);
        }
        const first = exporter.finish();
        const same = exporter.finish(); // Design requires first === same, not just equal results.
        void same;
        return await first;
    } finally { exporter.dispose(); }
}

/** Separate URLs for a future static-copy deployment; these assets do not exist in 0.7.0. */
export function copiedWorkerSketch(): WebpEncoderFactory {
    return createWebpWorkerEncoder({ workerUrl: '/assets/webp-worker-runtime.js',
        wasmUrl: '/assets/webp-codec.wasm', timeoutMs: 60000,
        lossless: true, quality: 100, method: 4 });
}

/** A third-party encoder's structural shape; no fake compressed output is produced here. */
export function thirdPartyFactorySketch(
    acquire: (plays: number, signal: AbortSignal, rawLimit: number, outputLimit: number) => WebpFrameEncoder
): WebpEncoderFactory {
    return ({ plays }, context) => acquire(plays, context.signal, context.limits.maxInputBytes, context.limits.maxOutputBytes);
}

// Negative type checks; declarations cannot enforce integer/range/ownership runtime rules.
declare const encoder: WebpFrameEncoder;
declare const canvas: HTMLCanvasElement;
// @ts-expect-error Encoder acquisition is synchronous; a Promise is not an owned encoder.
const asynchronousFactory: WebpEncoderFactory = async () => encoder;
void asynchronousFactory;
// @ts-expect-error Codec selection/quality is configured in the factory, not the controller.
createWebpController({ encoder: () => encoder, quality: 90 });
// @ts-expect-error Public admission accepts a canvas snapshot source, not a raw transferable array.
createWebpController({ encoder: () => encoder }).addFrame(new Uint8ClampedArray(4), 55);
const invalidPixels: WebpFrame = { width: 1, height: 1, durationMs: 55,
    // @ts-expect-error The RGBA snapshot contract uses Uint8ClampedArray, not Uint8Array.
    data: new Uint8Array(4) };
void invalidPixels; void canvas;
