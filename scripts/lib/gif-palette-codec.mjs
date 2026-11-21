import assert from 'node:assert/strict';
import gifenc from 'gifenc';
import {parseGIF} from 'gifuct-js';

// Keep both benchmark paths on the same codec, writer settings and index mapper.
export function createBenchmarkEncoder(maxColors, palette, mapIndices = applyPalette) {
    return ({repeat}) => {
        let encoder = gifenc.GIFEncoder(), firstFrame = true;
        return {
            addFrame({data, width, height, durationMs}) {
                const colors = palette ?? gifenc.quantize(data, maxColors, {format:'rgb565'});
                encoder.writeFrame(mapIndices(data, colors), width, height, {
                    palette:palette && !firstFrame ? undefined : colors, delay:durationMs, repeat, dispose:1
                });
                firstFrame = false;
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

function applyPalette(data, palette) {
    return gifenc.applyPalette(data, palette, 'rgb565');
}

export function createExactAccentMapper(palette, accents) {
    const indices = new Map(accents.map(color => {
        const index = palette.findIndex(entry => entry.every((channel, i) => channel === color[i]));
        assert.ok(index >= 0, 'An exact accent must have an entry in the GIF palette');
        return [(color[0] << 16) | (color[1] << 8) | color[2], index];
    }));
    return (data, colors) => {
        const mapped = applyPalette(data, colors);
        for (let pixel = 0, offset = 0; pixel < mapped.length; pixel++, offset += 4) {
            const exact = indices.get((data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]);
            if (exact !== undefined) mapped[pixel] = exact;
        }
        return mapped;
    };
}

export function inspectTables(bytes, frames, maxColors, shared) {
    const gif = parseGIF(bytes.buffer);
    const images = gif.frames.filter(frame => frame.image).map(frame => frame.image);
    assert.equal(images.length, frames);
    assert.ok(gif.lsd.gct.exists);
    assert.equal(gif.frames.find(frame => frame.application).application.blocks[1], 0);
    const localTables = images.filter(image => image.descriptor.lct.exists).map(image => image.lct);
    assert.equal(localTables.length, shared ? 0 : frames - 1);
    assert.ok([gif.gct, ...localTables].every(table => table.length <= maxColors));
    if (shared) {
        const colors = gif.gct.map(color => Array.from(color));
        assert.deepEqual(colors.slice(0, shared.length), shared);
        assert.ok(colors.slice(shared.length).every(color => color.every(channel => channel === 0)));
        assert.equal(colors.length, 2 ** Math.max(1, Math.ceil(Math.log2(shared.length))));
    }
    return {globalEntries:gif.gct.length, localTables:localTables.length,
        colorTableBytes:3 * (gif.gct.length + localTables.reduce((sum, table) => sum + table.length, 0))};
}
