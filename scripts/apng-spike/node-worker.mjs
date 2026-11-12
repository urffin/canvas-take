import { parentPort, workerData } from 'node:worker_threads';
parentPort.postMessage({ boot: true });
const { encodeApng } = await import(workerData.backend);
parentPort.on('message', ({ id, job, phase }) => {
    try {
        const status = phase && new Int32Array(phase);
        const result = encodeApng(job, status ? event => {
            Atomics.store(status, 0, event === 'enter' ? 1 : 2);
            if (event === 'enter') parentPort.postMessage({ id, compression: true });
        } : undefined);
        if (status) Atomics.store(status, 0, 3);
        parentPort.postMessage({ id, bytes: result }, [result.buffer]);
    } catch (error) { parentPort.postMessage({ id, error: { name: error.name, message: error.message } }); }
});
parentPort.postMessage({ ready: true });
