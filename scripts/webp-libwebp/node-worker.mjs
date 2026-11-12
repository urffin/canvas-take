import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { run } from './worker-core.mjs';
const { default: factory } = await import(workerData.codec);
const module = await factory({ wasmBinary: await readFile(workerData.wasm) });
parentPort.on('message', ({ job, shared }) => {
    const result = run(module, job, shared);
    parentPort.postMessage(result, result.bytes ? [result.bytes.buffer] : []);
});
parentPort.postMessage({ ready: true });
