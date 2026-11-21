import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function sampleCanvas(width, height, data, onRead = () => {}) {
    return {
        width, height, data,
        getContext: () => ({ getImageData(x, y, w, h) {
            assert.deepEqual([x, y, w, h], [0, 0, width, height]);
            onRead();
            return { data };
        } })
    };
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function collectDefaultGifCases({ createGifExporter, createGifencEncoder }) {
    const cases = [];
    for (const quality of ['high', 'fast']) {
        for (const dither of ['none', 'bayer-4x4']) {
            for (const maxColors of [2, 32, 256]) {
                for (const repeat of [-1, 3]) {
                    const options = { quality, dither, maxColors };
                    const hashes = [];
                    const orders = [];
                    for (const adapterOptions of [options, { ...options, palette: undefined }]) {
                        const order = [];
                        const exporting = createGifExporter({
                            encoder: createGifencEncoder(adapterOptions), repeat,
                            background: [23, 41, 79], totalFrames: 2,
                            onProgress: p => order.push([p.phase, p.framesEncoded, p.durationMs, p.totalFrames])
                        });
                        for (const [phase, delay] of [[0, 54], [1, 1550]]) {
                            const data = Uint8ClampedArray.from({ length: 19 * 11 * 4 }, (_, i) =>
                                i % 4 === 3 ? [0, 1, 127, 254, 255][Math.floor(i / 4) % 5] : (i * 43 + phase * 101) % 251);
                            const add = exporting.addFrame(sampleCanvas(19, 11, data, () => order.push('read')), delay);
                            order.push('submitted');
                            data.fill(0);
                            await add;
                            order.push('settled');
                        }
                        hashes.push(sha256(new Uint8Array(await (await exporting.finish()).arrayBuffer())));
                        orders.push(order);
                    }
                    assert.equal(hashes[0], hashes[1]);
                    assert.deepEqual(orders[0], orders[1]);
                    cases.push({ ...options, repeat, sha256: hashes[0], order: orders[0] });
                }
            }
        }
    }
    const order = cases[0].order;
    assert.ok(cases.every(c => JSON.stringify(c.order) === JSON.stringify(order)));
    return { order, cases: cases.map(({ order, ...c }) => c) };
}
