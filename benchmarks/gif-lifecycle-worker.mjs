// Only cancellation probes use this bootstrap. Memory runs use the shipped Worker URL.
// Mark the start of the real runtime's selected frame; do not replace or delay the codec.
const variant=new URL(self.location.href).searchParams.get('variant');
// A module Worker can receive init while a dynamic import is pending.
const early=[];self.onmessage=event=>early.push(event);
await import(variant==='before'?'/before/dist/gif-worker-runtime.js':'/dist/gif-worker-runtime.js');
const handle = self.onmessage;
const selected = Number(new URL(self.location.href).searchParams.get('frame'));
let frame = 0;
self.onmessage = event => {
    const mark = ['frame','raw-frame-v1'].includes(event.data.action) && frame++ === selected;
    if (mark) self.postMessage({ benchmarkStage: 'encode-start', at: performance.timeOrigin + performance.now() });
    handle(event);
    if (mark) self.postMessage({ benchmarkStage: 'encode-end', at: performance.timeOrigin + performance.now() });
};
for(const event of early)self.onmessage(event);early.length=0;
