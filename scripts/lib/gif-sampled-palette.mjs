import assert from 'node:assert/strict';
import {setImmediate as yieldTurn} from 'node:timers/promises';
import {Worker} from 'node:worker_threads';

export const sampling = {maxFrames:4, gridSide:64, rowsPerTurn:16};

async function quantize(rgba, maxColors, signal, observe, accents) {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./gif-palette-quantize-worker.mjs', import.meta.url), {
        workerData:{rgba, maxColors, accents}, transferList:[rgba.buffer]
    });
    let onAbort;
    try {
        return await new Promise((resolve, reject) => {
            onAbort = () => reject(signal.reason);
            worker.once('error', reject);
            worker.once('exit', code => reject(new Error(`Palette Worker exited before returning a result (${code})`)));
            worker.on('message', message => {
                if (message.phase === 'complete') resolve(message);
                else {
                    try { observe?.({phase:'quantizing', senderBytes:rgba.byteLength}); }
                    catch (error) { reject(error); }
                }
            });
            signal?.addEventListener('abort', onAbort, {once:true});
            if (signal?.aborted) onAbort();
        });
    } finally {
        signal?.removeEventListener('abort', onAbort);
        await worker.terminate();
        observe?.({phase:'worker-closed', threadId:worker.threadId});
    }
}

export async function prepareSampledPalette(clip, maxColors, {signal, observe, accents} = {}) {
    const start = performance.now();
    signal?.throwIfAborted();
    const {width, height, count, readFrame} = clip;
    const frameCount = Math.min(count, sampling.maxFrames);
    const indices = Array.from({length:frameCount}, (_, index) =>
        frameCount === 1 ? 0 : Math.round(index * (count - 1) / (frameCount - 1)));
    const cols = Math.min(width, sampling.gridSide), rows = Math.min(height, sampling.gridSide);
    const rgba = new Uint8ClampedArray(frameCount * cols * rows * 4);
    const sampleBytes = rgba.byteLength;
    let dest = 0;
    for (const index of indices) {
        signal?.throwIfAborted();
        const {data} = readFrame(index);
        assert.equal(data.byteLength, width * height * 4);
        for (let y = 0; y < rows; y++) {
            const sourceY = Math.floor((y + 0.5) * height / rows);
            for (let x = 0; x < cols; x++) {
                const sourceX = Math.floor((x + 0.5) * width / cols);
                const src = (sourceY * width + sourceX) * 4;
                rgba[dest++] = data[src];
                rgba[dest++] = data[src + 1];
                rgba[dest++] = data[src + 2];
                rgba[dest++] = data[src + 3];
            }
            if ((y + 1) % sampling.rowsPerTurn === 0 || y === rows - 1) {
                observe?.({phase:'sampling', frameIndex:index, sampledPixels:dest / 4});
                await yieldTurn();
                signal?.throwIfAborted();
            }
        }
    }
    const sampleMs = performance.now() - start;
    const {palette, quantizeMs, unreservedPixels} = await quantize(rgba, maxColors, signal, observe, accents);
    signal?.throwIfAborted();
    return {palette, indices, sampleBytes, sampleMs, quantizeMs, unreservedPixels, prepMs:performance.now() - start};
}
