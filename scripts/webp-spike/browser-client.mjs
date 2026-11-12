import { specs, makeJob, stressJob } from './fixtures.mjs';

export async function run() {
    const workers = { opened: 0, terminated: 0, handlersCleared: 0, transferredInputs: 0 }, cases = [], cancellations = [];
    function workerJob(job, cancel) {
        return new Promise((resolve, reject) => {
            const worker = new Worker('/spike/worker.mjs', { type: 'module' }); workers.opened++;
            let outputs = 0, boundary = false, ready = false, settled = false;
            const close = () => {
                clearTimeout(timer); worker.onmessage = worker.onerror = null; workers.handlersCleared++;
                worker.terminate(); workers.terminated++;
            };
            const finish = value => { if (settled) return; settled = true; close(); resolve(value); };
            const fail = error => { if (settled) return; settled = true; close(); reject(error); };
            const timer = setTimeout(() => fail(new Error('Worker timed out')), 30000);
            worker.onerror = event => fail(new Error(event.message));
            worker.onmessage = ({ data }) => {
                if (data.type === 'error') return fail(new Error(data.message));
                if (data.type === 'ready') {
                    ready = true;
                    worker.postMessage({ type: 'encode', job }, job.frames.map(f => f.data.buffer));
                    if (job.frames.every(f => f.data.byteLength === 0)) workers.transferredInputs++;
                } else if (data.type === 'encode-boundary') {
                    boundary = true;
                    if (cancel === 'encode-boundary') finish({ cancel, ready, boundary, outputs });
                } else if (data.type === 'done') { outputs++; finish({ bytes: [...data.bytes], ready, boundary, outputs }); }
            };
            worker.postMessage({ type: 'init' });
            if (cancel === 'before-ready') finish({ cancel, ready, boundary, outputs });
        });
    }
    for (const spec of specs) {
        const result = await workerJob(makeJob(spec));
        cases.push({ name: spec.name, ...result });
    }
    // This tests termination at the native-call boundary; no inside-codec probe is available.
    for (const cancel of ['before-ready', 'encode-boundary', 'encode-boundary']) {
        cancellations.push(await workerJob(stressJob(), cancel));
        const retry = await workerJob(makeJob(specs[0]));
        cases.push({ name: 'retry-' + cancellations.length, sourceName: specs[0].name, ...retry });
    }
    const decode = async url => {
        const response = await fetch(url); if (!response.ok) throw new Error('Decode file download failed');
        const data = await response.arrayBuffer();
        const decoder = new ImageDecoder({ data, type: 'image/webp', preferAnimation: true });
        try {
            await decoder.tracks.ready;
            const track = decoder.tracks.selectedTrack, frames = [];
            for (let i = 0; i < track.frameCount; i++) {
                const { image } = await decoder.decode({ frameIndex: i });
                try {
                    const rgba = new Uint8Array(image.allocationSize({ format: 'RGBA' }));
                    await image.copyTo(rgba, { format: 'RGBA' });
                    frames.push({ width: image.displayWidth, height: image.displayHeight, timestamp: image.timestamp, duration: image.duration, rgba: [...rgba] });
                } finally { image.close(); }
            }
            return { frameCount: track.frameCount, repetitionCount: String(track.repetitionCount), frames };
        } finally { decoder.close(); }
    };
    const decoded = [];
    for (const spec of specs) decoded.push({ name: spec.name, ...await decode('/files/' + spec.name + '.webp') });
    // Valid files with deliberately incorrect timing/pixels verify that our comparisons can fail.
    const controls = [];
    for (const name of ['wrong-duration', 'wrong-pixels']) controls.push({ name, ...await decode('/files/' + name + '.webp') });
    return { workers, cases, cancellations, decoded, controls };
}
