// Undithered adapter from CanvasTake 0.9.0 (5a2c95e), using the same pinned gifenc dependency.
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;

export function createGifencEncoder(options = {}) {
    const maxColors = options.maxColors ?? 256;
    const quality = options.quality ?? 'high';
    const format = quality === 'high' ? 'rgb565' : 'rgb444';
    return ({ repeat }) => {
        let encoder = GIFEncoder();
        return {
            addFrame({ data, width, height, durationMs }) {
                const palette = quantize(data, maxColors, { format });
                encoder.writeFrame(applyPalette(data, palette, format), width, height,
                    { palette, delay: durationMs, repeat, dispose: 1 });
            },
            finish() {
                encoder.finish();
                const bytes = encoder.bytes();
                encoder = undefined;
                return bytes;
            },
            dispose() { encoder = undefined; }
        };
    };
}
