import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {decompressFrames, parseGIF} from 'gifuct-js';

export function measureGifQuality(bytes, frames, {cutFrame, previewFrames = [Math.floor(frames.length / 2)]} = {}) {
    const gif = parseGIF(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const decoded = decompressFrames(gif, true);
    const {width, height} = frames[0];
    assert.equal(gif.lsd.width, width);
    assert.equal(gif.lsd.height, height);
    assert.equal(decoded.length, frames.length);
    assert.equal(width % 8 + height % 8, 0, '8×8 quality metric requires whole blocks');

    const blocksAcross = width / 8, blocksDown = height / 8;
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
                let same = true;
                for (let channel = 0; channel < 3; channel++) {
                    const error = patch[offset + channel] - original[offset + channel];
                    squared += error * error;
                    blocks[block + channel] += error;
                    if (error !== 0) same = false;
                    if (isStatic) frameStaticError += Math.abs(patch[offset + channel] - previousPatch[offset + channel]);
                }
                if (same) exact++;
                if (isStatic) frameStaticPixels++;
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
    return {
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
}
