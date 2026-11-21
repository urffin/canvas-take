import {parentPort, workerData} from 'node:worker_threads';
import gifenc from 'gifenc';

const {rgba, maxColors} = workerData;
parentPort.postMessage({phase:'quantizing'});
const start = performance.now();
const palette = gifenc.quantize(rgba, maxColors, {format:'rgb565'});
parentPort.postMessage({phase:'complete', palette, quantizeMs:performance.now() - start});
