import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decompressFrames, parseGIF} from 'gifuct-js';

export function measureGifQuality(bytes, frames, {
    cutFrame, previewFrames = [Math.floor(frames.length / 2)], accents = []
} = {}) {
    const gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const decoded = decompressFrames(gif, true);
    const {width, height} = frames[0];
    assert.equal(gif.lsd.width, width);
    assert.equal(gif.lsd.height, height);
    assert.equal(decoded.length, frames.length);
    assert.equal(width % 8 + height % 8, 0, '8×8 quality metric requires whole blocks');

    const blocksAcross = width / 8, blocksDown = height / 8;
    const accentStats = new Map(accents.map(color => [
        (color[0] << 16) | (color[1] << 8) | color[2],
        {color, pixels:0, exact:0, squared:0, staticPairs:0, staticDelta:0}
    ]));
    let squared = 0, blockSquared = 0, exact = 0;
    let staticError = 0, staticPixels = 0, cutError = 0, cutStaticPixels = 0;
    for (const [i, frame] of decoded.entries()) {
        const original = frames[i].data;
        const previousOriginal = frames[i - 1]?.data;
        const previousPatch = decoded[i - 1]?.patch;
        const {patch, dims} = frame;
        assert.deepEqual([dims.left, dims.top, dims.width, dims.height], [0, 0, width, height]);
        assert.equal(frame.delay, frames[i].durationMs);
        assert.equal(patch.length, original.length);
        const blocks = new Int32Array(blocksAcross * blocksDown * 3);
        let frameStaticError = 0, frameStaticPixels = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const offset = (y * width + x) * 4;
                const block = (Math.floor(y / 8) * blocksAcross + Math.floor(x / 8)) * 3;
                assert.equal(patch[offset + 3], 255);
                const isStatic = previousOriginal && original[offset] === previousOriginal[offset] &&
                    original[offset + 1] === previousOriginal[offset + 1] && original[offset + 2] === previousOriginal[offset + 2];
                let pixelSquared = 0, pixelStaticDelta = 0;
                for (let channel = 0; channel < 3; channel++) {
                    const error = patch[offset + channel] - original[offset + channel];
                    pixelSquared += error * error;
                    blocks[block + channel] += error;
                    if (isStatic) pixelStaticDelta += Math.abs(patch[offset + channel] - previousPatch[offset + channel]);
                }
                squared += pixelSquared;
                if (pixelSquared === 0) exact++;
                if (isStatic) {
                    frameStaticError += pixelStaticDelta;
                    frameStaticPixels++;
                }
                if (accentStats.size > 0) {
                    const key = (original[offset] << 16) | (original[offset + 1] << 8) | original[offset + 2];
                    const accent = accentStats.get(key);
                    if (accent) {
                        accent.pixels++;
                        accent.squared += pixelSquared;
                        if (pixelSquared === 0) accent.exact++;
                        if (isStatic) {
                            accent.staticPairs++;
                            accent.staticDelta += pixelStaticDelta;
                        }
                    }
                }
            }
        }
        staticError += frameStaticError;
        staticPixels += frameStaticPixels;
        if (i === cutFrame) {
            cutError = frameStaticError;
            cutStaticPixels = frameStaticPixels;
        }
        for (const block of blocks) blockSquared += (block / 64) ** 2;
    }

    const pixels = width * height * frames.length;
    const result = {
        metrics: {
            rgbRmse: Math.sqrt(squared / (pixels * 3)),
            block8Rmse: Math.sqrt(blockSquared / (pixels * 3 / 64)),
            exactPixelPercent: 100 * exact / pixels,
            staticPixelDelta: staticPixels ? staticError / (staticPixels * 3) : null
        },
        temporal: {
            staticPixels,
            cutStaticPixels,
            cutStaticPixelDelta: cutStaticPixels ? cutError / (cutStaticPixels * 3) : null
        },
        paletteSha256: createHash('sha256').update(JSON.stringify(decoded.map(frame => frame.colorTable))).digest('hex'),
        previews: previewFrames.map(index => decoded[index].patch)
    };
    if (accentStats.size > 0) {
        const values = [...accentStats.values()];
        const summarize = ({pixels, exact, squared, staticPairs, staticDelta}) => ({
            pixels, exact, exactPixelPercent:pixels ? 100 * exact / pixels : null,
            rgbRmse:pixels ? Math.sqrt(squared / (pixels * 3)) : null,
            staticPairs, staticPixelDelta:staticPairs ? staticDelta / (staticPairs * 3) : null
        });
        const totals = {pixels:0, exact:0, squared:0, staticPairs:0, staticDelta:0};
        for (const stats of values) {
            for (const key of Object.keys(totals)) totals[key] += stats[key];
        }
        result.accentMetrics = {
            ...summarize(totals),
            otherRgbRmse:totals.pixels < pixels ? Math.sqrt((squared - totals.squared) / ((pixels - totals.pixels) * 3)) : null,
            colors:values.map(stat => ({color:stat.color, ...summarize(stat)}))
        };
    }
    return result;
}
