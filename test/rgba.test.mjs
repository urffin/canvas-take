import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blendRange } from '../dist/internal/rgba.js';

// Independent integer oracle: byte-weighted source/background with nearest-integer rounding.
function reference(source, background) {
    return source.map((value, i) => i % 4 === 3 ? 255
        : Math.floor((value * source[i - i % 4 + 3] + background[i % 4] * (255 - source[i - i % 4 + 3]) + 127) / 255));
}

test('RGBA composition matches integer weights for every source byte and alpha value', () => {
    const source = new Uint8ClampedArray(256 * 256 * 4);
    for (let alpha = 0; alpha < 256; alpha++) for (let value = 0; value < 256; value++) {
        source.set([value, (value * 37 + alpha) % 256, 255 - value, alpha], (alpha * 256 + value) * 4);
    }
    for (const background of [[0, 0, 0], [255, 255, 255], [7, 101, 239], [254, 128, 1]]) {
        const data = source.slice(), buffer = data.buffer, expected = reference(source, background);
        blendRange(data, 0, data.length / 4, background);
        assert.equal(data.buffer, buffer);
        assert.deepEqual(data, expected);
    }
});

test('adjacent RGBA ranges match a full odd-size frame and leave outside pixels unchanged', () => {
    const source = Uint8ClampedArray.from({ length: 259 * 131 * 4 }, (_, i) => (i * 73 + 17) % 256);
    const background = [20, 40, 60], full = reference(source, background), partial = source.slice();
    const start = 11, end = 16389;
    blendRange(partial, start, end, background);
    assert.deepEqual(partial.subarray(0, start * 4), source.subarray(0, start * 4));
    assert.deepEqual(partial.subarray(start * 4, end * 4), full.subarray(start * 4, end * 4));
    assert.deepEqual(partial.subarray(end * 4), source.subarray(end * 4));
    const beforeEmpty = partial.slice();
    blendRange(partial, 0, 0, background);
    blendRange(partial, end, end, background);
    assert.deepEqual(partial, beforeEmpty);
    blendRange(partial, 0, start, background);
    blendRange(partial, end, source.length / 4, background);
    assert.deepEqual(partial, full);
});

test('opaque RGBA pixels bypass RGB access and writes', () => {
    const pixel = new Proxy(new Uint8ClampedArray([17, 128, 254, 255]), {
        get(target, key) { assert.ok(!['0', '1', '2'].includes(key), 'opaque RGB should not be read'); return Reflect.get(target, key, target); },
        set() { assert.fail('opaque RGB/alpha should not be written'); }
    });
    blendRange(pixel, 0, 1, [0, 0, 0]);
});
