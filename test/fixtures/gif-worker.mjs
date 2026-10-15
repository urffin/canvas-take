import { parentPort } from 'node:worker_threads';
import { createGifencEncoder } from '../../dist/gifenc.js';
let encoder;
parentPort.on('message', ({ id, action, value }) => {
    try {
        if (action === 'init') encoder = createGifencEncoder()(value);
        if (action === 'frame') encoder.addFrame(value);
        const bytes = action === 'finish' ? encoder.finish() : undefined;
        parentPort.postMessage({ id, bytes }, bytes ? [bytes.buffer] : []);
    } catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
