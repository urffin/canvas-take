import factory from '/codec/backend.mjs';
import { run } from './worker-core.mjs';
const response = await fetch('/codec/backend.wasm');
if (!response.ok) throw new Error('WASM download failed');
const module = await factory({ wasmBinary: new Uint8Array(await response.arrayBuffer()) });
self.onmessage = ({ data: { job, shared } }) => {
    const result = run(module, job, shared);
    self.postMessage(result, result.bytes ? [result.bytes.buffer] : []);
};
self.postMessage({ ready: true });
