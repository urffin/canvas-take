import { specs, jobFor, stressJob } from './fixtures.mjs';
const check = (value, message) => { if (!value) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function run() {
    check(crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined', 'Native cancellation probe requires isolated test server');
    const workers = { opened: 0, terminated: 0, cleared: 0, transfers: 0 }, cases = [], cancellations = [];
    function open() {
        const worker = new Worker('/scripts/webp-libwebp/browser-worker.mjs', { type: 'module' }); workers.opened++;
        let pending, closed = false;
        const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Worker initialization timeout')), 30000);
            pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
        });
        worker.onmessage = ({ data }) => { const current = pending; pending = undefined; current?.resolve(data); };
        worker.onerror = event => { const current = pending; pending = undefined; current?.reject(new Error(event.message)); };
        return {
            ready,
            call(job, shared) {
                check(!closed && !pending, 'single in-flight Worker call');
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => { pending = undefined; reject(new Error('Worker encode timeout')); }, 30000);
                    pending = { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } };
                    worker.postMessage({ job, shared }, job.frames.map(frame => frame.data.buffer));
                    check(job.frames.every(frame => frame.data.byteLength === 0), 'input buffers transferred'); workers.transfers++;
                });
            },
            close(reason = new Error('Worker closed')) {
                if (closed) return;
                closed = true; pending?.reject(reason); pending = undefined;
                worker.onmessage = worker.onerror = null; workers.cleared++; worker.terminate(); workers.terminated++;
            }
        };
    }
    const record = (name, result) => {
        check(!result.error && result.bytes?.length > 0, 'Worker output: ' + name + ' ' + result.error?.message);
        check(result.stats.liveBytes === 0 && result.stats.liveAllocations === 0, 'native allocations released');
        cases.push({ name, bytes: [...result.bytes], calls: result.calls, stats: result.stats });
    };
    const early = open(), earlyReason = new Error('Before ready'), earlyResult = early.ready.catch(error => error);
    early.close(earlyReason); check(await earlyResult === earlyReason, 'before-ready cancellation reason');
    cancellations.push({ mode: 'before-ready', outputs: 0 });
    for (const spec of specs) {
        const client = open();
        try { await client.ready; record(spec.name, await client.call(jobFor(spec))); }
        finally { client.close(); }
    }
    for (const mode of ['cooperative', 'terminate', 'terminate']) {
        const client = open(), flags = new Int32Array(new SharedArrayBuffer(16));
        try {
            await client.ready;
            const response = client.call(stressJob(), flags.buffer);
            // Attach a rejection handler before hard termination settles the pending promise.
            const observed = response.then(value => ({ value }), error => ({ error }));
            const deadline = performance.now() + 20000;
            while (!Atomics.load(flags, 0)) { check(performance.now() < deadline, 'native progress hook not entered'); await sleep(1); }
            const phaseBefore = Atomics.load(flags, 0), started = performance.now();
            if (mode === 'cooperative') {
                Atomics.store(flags, 1, 1); Atomics.store(flags, 2, 1); Atomics.notify(flags, 2);
                const { value } = await observed;
                check(value.error?.message === 'Native encoding aborted' && !value.bytes, 'cooperative native abort');
                check(value.stats.liveBytes === 0 && value.stats.liveAllocations === 0, 'cooperative cleanup');
                cancellations.push({ mode, phaseBefore, phaseAfter: Atomics.load(flags, 0), hookCalls: Atomics.load(flags, 3),
                    settlementMs: performance.now() - started, stats: value.stats });
                record('cooperative-same-worker-retry', await client.call(jobFor(specs[0])));
            } else {
                const reason = new Error('Hard cancel'); client.close(reason);
                check((await observed).error === reason, 'hard cancellation original reason');
                check(Atomics.load(flags, 0) === 1, 'hard cancellation inside native progress callback');
                cancellations.push({ mode, phaseBefore, phaseAfter: Atomics.load(flags, 0), hookCalls: Atomics.load(flags, 3),
                    settlementMs: performance.now() - started, outputs: 0 });
            }
        } finally { client.close(); }
        const retry = open(); try { await retry.ready; record('fresh-retry-' + cancellations.length, await retry.call(jobFor(specs[0]))); } finally { retry.close(); }
    }
    const repeated = open(), memory = [];
    try {
        await repeated.ready;
        for (let i = 0; i < 12; i++) {
            const result = await repeated.call(jobFor(specs.find(spec => spec.name === 'alpha-ramp')));
            check(!result.error && result.stats.liveBytes === 0 && result.stats.liveAllocations === 0, 'repeated cleanup');
            memory.push(result.stats);
        }
    } finally { repeated.close(); }
    const decoded = [], controls = [];
    for (const name of [...specs.map(spec => spec.name), 'wrong-delay', 'wrong-plays', 'wrong-pixels', 'wrong-blend']) {
        const data = await (await fetch('/files/' + name + '.webp')).arrayBuffer();
        const decoder = new ImageDecoder({ data, type: 'image/webp', preferAnimation: true });
        try {
            await decoder.tracks.ready; const track = decoder.tracks.selectedTrack, frames = [];
            for (let i = 0; i < track.frameCount; i++) {
                const { image } = await decoder.decode({ frameIndex: i });
                try {
                    const rgba = new Uint8Array(image.allocationSize({ format: 'RGBA' }));
                    await image.copyTo(rgba, { format: 'RGBA' });
                    frames.push({ timestamp: image.timestamp, duration: image.duration, width: image.displayWidth, height: image.displayHeight, rgba: [...rgba] });
                } finally { image.close(); }
            }
            const result = { name, count: track.frameCount, repetitions: String(track.repetitionCount), frames };
            (name.startsWith('wrong-') ? controls : decoded).push(result);
        } finally { decoder.close(); }
    }
    check(workers.opened === workers.terminated && workers.opened === workers.cleared, 'Worker handles released');
    return { cases, cancellations, memory, decoded, controls, workers };
}
