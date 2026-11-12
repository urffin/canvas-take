import { encodeApng } from './backend.mjs';
// Prototype protocol only; intentionally separate from every shipped Worker.
self.postMessage({ boot: true });
self.onmessage = ({ data: { id, job, phase } }) => {
    try {
        const status = phase && new Int32Array(phase);
        const result = encodeApng(job, status ? event => {
            Atomics.store(status, 0, event === 'enter' ? 1 : 2);
            if (event === 'enter') self.postMessage({ id, compression: true });
        } : undefined);
        if (status) Atomics.store(status, 0, 3);
        self.postMessage({ id, bytes: result }, [result.buffer]);
    } catch (error) { self.postMessage({ id, error: { name: error.name, message: error.message } }); }
};
self.postMessage({ ready: true });
