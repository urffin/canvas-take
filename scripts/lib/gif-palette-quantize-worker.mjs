import {parentPort, workerData} from 'node:worker_threads';
import gifenc from 'gifenc';

const {rgba, maxColors, accents} = workerData;
parentPort.postMessage({phase:'quantizing'});
const start = performance.now();

function quantizeWithAccents() {
    const rgb = (r, g, b) => (r << 16) | (g << 8) | b;
    const reserved = new Set(accents.map(color => rgb(...color)));
    let dest = 0;
    // The sample buffer belongs to this Worker after transfer.
    for (let offset = 0; offset < rgba.length; offset += 4) {
        if (reserved.has(rgb(rgba[offset], rgba[offset + 1], rgba[offset + 2]))) continue;
        rgba.copyWithin(dest, offset, offset + 4);
        dest += 4;
    }
    const sample = dest === rgba.length ? rgba : rgba.slice(0, dest);
    const colors = sample.length ? gifenc.quantize(sample, maxColors - accents.length, {format:'rgb565'}) : [];
    const palette = [...colors.filter(color => !reserved.has(rgb(...color))), ...accents];
    return {palette, unreservedPixels:dest / 4};
}

const result = accents?.length ? quantizeWithAccents() : {palette:gifenc.quantize(rgba, maxColors, {format:'rgb565'})};
parentPort.postMessage({phase:'complete', ...result, quantizeMs:performance.now() - start});
