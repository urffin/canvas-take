import { parentPort, workerData } from 'node:worker_threads';
globalThis.postMessage = (message, transfer) => parentPort.postMessage(message, transfer);
await import(workerData);
parentPort.on('message', data => globalThis.onmessage({ data }));
