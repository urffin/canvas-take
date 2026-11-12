/** DESIGN ONLY. This import resolves to draft declarations, not an implemented package entry. */
import { createApngExporter, type ApngEncoderFactory } from './apng-export-api.js';

export async function proposedApngExport(
    canvas: HTMLCanvasElement,
    encoder: ApngEncoderFactory,
    draw: (frame: number) => void,
    signal?: AbortSignal
): Promise<Blob> {
    const exporter = createApngExporter({ encoder, plays: 1, signal,
        totalFrames: 3, maxFrames: 3, maxDurationMs: 905,
        maxFramePixels: 640 * 360, maxInputBytes: 3 * 640 * 360 * 4,
        maxOutputBytes: 8 * 1024 * 1024 });
    try {
        for (const [index, delay] of [50, 55, 800].entries()) {
            draw(index); // Draw a complete frame, clearing pixels that should become transparent.
            await exporter.addFrame(canvas, delay);
        }
        return await exporter.finish();
    } finally { exporter.dispose(); }
}
