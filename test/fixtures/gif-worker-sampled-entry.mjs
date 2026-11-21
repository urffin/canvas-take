import '../../dist/gif-worker-runtime.js';

const blocked = new URL(import.meta.url).searchParams.get('block');
const handle = globalThis.onmessage;
globalThis.onmessage = event => {
    if (event.data.action === blocked) {
        globalThis.postMessage({ entered: blocked });
        // Hold the real Worker at a request boundary until termination.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
    }
    handle(event);
};
