// Only cancellation probes use this bootstrap. Memory runs use the shipped Worker URL.
// Mark the start of the real runtime's selected frame; do not replace or delay the codec.
import '/dist/gif-worker-runtime.js';
const handle = self.onmessage;
const selected = Number(new URL(self.location.href).searchParams.get('frame'));
let frame = 0;
self.onmessage = event => {
    const mark = event.data.action === 'frame' && frame++ === selected;
    if (mark) self.postMessage({ benchmarkStage: 'encode-start', at: performance.timeOrigin + performance.now() });
    handle(event);
    if (mark) self.postMessage({ benchmarkStage: 'encode-end', at: performance.timeOrigin + performance.now() });
};
