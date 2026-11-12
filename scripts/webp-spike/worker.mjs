import { loadEncoder, encode } from './encoder.mjs';
let module;
self.onmessage = async ({ data }) => {
    try {
        if (data.type === 'init') {
            const response = await fetch('/codec.wasm');
            if (!response.ok) throw new Error('WASM download failed');
            module = await loadEncoder('/codec.mjs', new Uint8Array(await response.arrayBuffer()));
            self.postMessage({ type: 'ready', version: module.encoder_version() });
        } else if (data.type === 'encode') {
            // A boundary probe, NOT evidence that cancellation entered the native encoder.
            self.postMessage({ type: 'encode-boundary' });
            const bytes = encode(module, data.job);
            self.postMessage({ type: 'done', bytes }, [bytes.buffer]);
        }
    } catch (error) { self.postMessage({ type: 'error', message: String(error.stack ?? error) }); }
};
