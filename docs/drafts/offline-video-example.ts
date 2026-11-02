// Compile-only usage example. Concrete codec/container providers are placeholders.
import { createOfflineVideoExporter } from '@grundyjs/canvas-take/video';
import type { VideoEncoderFactory, AudioEncoderFactory, MuxerFactory, PreparedAudio } from '@grundyjs/canvas-take/video';

declare const videoEncoder: VideoEncoderFactory;
declare const audioEncoder: AudioEncoderFactory;
declare const mp4Muxer: MuxerFactory;
declare const canvas: HTMLCanvasElement;
declare const narration: PreparedAudio;
declare function drawFrame(index: number): void;

export async function exportShort(signal: AbortSignal) {
    const exporter = await createOfflineVideoExporter({
        video: { encoder: videoEncoder, config: {
            codec: 'avc1.42E028', bitstreamFormat: 'avc', width: 1080, height: 1920,
            bitrate: 8_000_000, frameRateHint: { numerator: 30, denominator: 1 }
        } },
        audio: { encoder: audioEncoder, config: {
            codec: 'mp4a.40.2', bitstreamFormat: 'aac', sampleRate: narration.sampleRate,
            numberOfChannels: narration.channels.length, bitrate: 192_000
        }, source: narration, endPolicy: 'trim-or-pad' },
        muxer: mp4Muxer, signal, totalFrames: 300,
        maxFramePixels: 1080 * 1920, maxFrames: 300, maxDurationUs: 10_000_000,
        onProgress(progress) { console.log(progress.phase, progress.framesAccepted, progress.durationUs); }
    });
    try {
        // Absolute rounded boundaries prevent accumulated 1/30-second rounding error.
        const boundary = (index: number) => Math.round(index * 1_000_000 / 30);
        for (let i = 0; i < 300; i++) {
            drawFrame(i);
            await exporter.addFrame(canvas, { timestampUs: boundary(i), durationUs: boundary(i + 1) - boundary(i) });
        }
        return await exporter.finish();
    } finally { exporter.dispose(); }
}
