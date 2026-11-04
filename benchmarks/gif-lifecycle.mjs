import {createGifExporter} from '/dist/gif.js';
import {createGifencEncoder} from '/dist/gifenc.js';
import {createGifWorkerEncoder} from '/dist/gif-worker.js';
import {draw} from './gif-scene.mjs';

// Observers retain scalar counters only. Live Worker references are dropped on terminate.
const nativeTimeout = window.setTimeout.bind(window), nativeClear = window.clearTimeout.bind(window);
const NativeWorker = window.Worker, timers = new Set(), workers = new Set();
let current, output, calibration;
window.setTimeout = (callback, delay, ...args) => {
    // The core's existing zero-delay yield follows the owned snapshot. Observe its
    // resolver only in this probe, so cancellation is scheduled just before compositing.
    const record=current;
    if(record?.options.mode==='blend'&&delay===0&&record.phase==='preparation'&&record.stats.submitted===record.options.cancelFrame&&!record.blendYieldArmed){
        record.blendYieldArmed=true;const resolve=callback;
        callback=(...values)=>{record.phase='compositing';arm(record,performance.now());resolve(...values);};
    }
    let id;
    id = nativeTimeout(() => { timers.delete(id); callback(...args); }, delay);
    timers.add(id); return id;
};
window.clearTimeout = id => { timers.delete(id); nativeClear(id); };
class ObservedWorker extends NativeWorker {
    constructor(...args) {
        super(...args); workers.add(this);
        const stats = current.stats;
        stats.workersCreated++;
        this.benchmarkMessage = event => {
            if (event.data.benchmarkStage === 'encode-start') arm(current, event.data.at - performance.timeOrigin);
            if (event.data.benchmarkStage === 'encode-end') current.targetWorkerEndAt = event.data.at - performance.timeOrigin;
        };
        NativeWorker.prototype.addEventListener.call(this, 'message', this.benchmarkMessage);
        this.benchmarkStats = stats;
    }
    addEventListener(type, listener, options) {
        if (['message','error','messageerror'].includes(type)) this.benchmarkStats.listeners++;
        return super.addEventListener(type, listener, options);
    }
    removeEventListener(type, listener, options) {
        if (['message','error','messageerror'].includes(type)) this.benchmarkStats.listeners--;
        return super.removeEventListener(type, listener, options);
    }
    postMessage(message, transfer) {
        super.postMessage(message, transfer);
        if (message.action === 'frame') {
            this.benchmarkStats.transfers++;
            if (message.value.data.byteLength === 0) this.benchmarkStats.detached++;
        }
    }
    terminate() {
        this.benchmarkStats.terminateCalls++;
        NativeWorker.prototype.removeEventListener.call(this, 'message', this.benchmarkMessage);
        workers.delete(this); super.terminate();
    }
}
window.Worker = ObservedWorker;

function arm(record, phaseStartAt) {
    if (record.armedAt !== undefined) return;
    record.armedAt = performance.now(); record.phaseStartAt = phaseStartAt;
    record.dueAt = phaseStartAt + record.options.cancelDelayMs;
    record.framesAtArm = record.stats.accepted;
    record.abortTimer = setTimeout(() => {
        record.abortAt = performance.now(); record.framesAtAbort = record.stats.accepted;
        record.phaseAtAbort = record.phase;
        record.controller.abort(new DOMException('Benchmark cancellation', 'AbortError'));
    }, Math.ceil(Math.max(0, record.dueAt - performance.now())));
}
const idle = () => new Promise(resolve => nativeTimeout(resolve, 0));
window.lifecycle = {
    async run(options) {
        if (output || current) throw new Error('Release previous case before starting another');
        const stats = {created:0,disposed:0,submitted:0,accepted:0,finished:0,workersCreated:0,terminateCalls:0,listeners:0,transfers:0,detached:0,abortListeners:0};
        const controller = new AbortController();
        const abortListeners = new Set();
        const add = controller.signal.addEventListener.bind(controller.signal), remove = controller.signal.removeEventListener.bind(controller.signal);
        controller.signal.addEventListener = (type, fn, opts) => { if (type === 'abort') abortListeners.add(fn); stats.abortListeners=abortListeners.size; return add(type,fn,opts); };
        controller.signal.removeEventListener = (type, fn, opts) => { if (type === 'abort') abortListeners.delete(fn); stats.abortListeners=abortListeners.size; return remove(type,fn,opts); };
        const record = current = {options,stats,controller,phase:'initializing'};
        const canvas = document.createElement('canvas'); canvas.width = options.width; canvas.height = options.height;
        record.canvas = canvas; document.body.append(canvas);
        const ctx = canvas.getContext('2d'), read = ctx.getImageData.bind(ctx);
        ctx.getImageData = (...args) => {
            if (args[2] === options.width && args[3] === options.height) {
                record.phase = 'preparation';
                if (options.mode === 'prepare' && stats.submitted === options.cancelFrame) arm(record, performance.now());
            }
            return read(...args);
        };
        const workerOptions = {maxColors:options.maxColors,quality:options.quality};
        if (options.mode === 'encode') workerOptions.workerUrl = new URL(`/benchmarks/gif-lifecycle-worker.mjs?frame=${options.cancelFrame}`,location.href);
        const factory = options.adapter === 'worker' ? createGifWorkerEncoder(workerOptions) : createGifencEncoder(workerOptions);
        let gif;
        const started = performance.now();
        try {
            gif = createGifExporter({signal:controller.signal, repeat:0, encoder(settings) {
                stats.created++; const real = factory(settings);
                return {
                    addFrame(frame) {
                        const index = stats.submitted++; record.phase = 'encoding';
                        if (options.mode === 'encode' && options.adapter === 'sync' && index === options.cancelFrame) arm(record,performance.now());
                        const result = real.addFrame(frame);
                        if (options.adapter === 'sync' && index === options.cancelFrame) record.targetEncoderEndAt = performance.now();
                        return result;
                    },
                    finish() { stats.finished++; return real.finish(); },
                    dispose() { stats.disposed++; real.dispose(); }
                };
            },onProgress(progress) { stats.accepted = progress.framesEncoded; record.phase = progress.phase === 'encoding' ? 'between-frames' : progress.phase; }});
            const count = options.mode === 'success' ? options.frames : options.cancelFrame + 10000;
            for (let i = 0; i < count; i++) {
                draw(ctx,i,canvas.width,canvas.height,options.scene);
                record.sourceCorner = [...read(0,0,1,1).data];
                await gif.addFrame(canvas,1000/options.fps);
                if (controller.signal.aborted) throw controller.signal.reason;
            }
            if (options.mode !== 'success') throw new Error('Cancellation was never delivered');
            output = await gif.finish(); record.outcome = 'finished'; record.bytes = output.size;
        } catch(error) {
            if (options.mode === 'success' || error.name !== 'AbortError') throw error;
            record.outcome = 'aborted'; record.error = error.name;
        } finally {
            record.settledAt = performance.now(); record.state = gif?.state;
            gif?.dispose(); await idle();
        }
        const cornerUnchanged = record.sourceCorner.every((v,i)=>v===read(0,0,1,1).data[i]);
        const result = {outcome:record.outcome,state:record.state,elapsedMs:record.settledAt-started,bytes:record.bytes??0,stats:{...stats},
            timers:timers.size,liveWorkers:workers.size,cornerUnchanged};
        if (options.mode !== 'success') result.cancellation = {
            phaseStartAt:record.phaseStartAt,armedAt:record.armedAt,dueAt:record.dueAt,abortAt:record.abortAt,settledAt:record.settledAt,
            deliveryLagMs:record.abortAt-record.dueAt,settleAfterAbortMs:record.settledAt-record.abortAt,
            deadlineToSettleMs:record.settledAt-record.dueAt,phaseAtAbort:record.phaseAtAbort,
            framesAtArm:record.framesAtArm,framesAtAbort:record.framesAtAbort,
            targetEncoderEndAt:record.targetEncoderEndAt,targetWorkerEndAt:record.targetWorkerEndAt
        };
        return result;
    },
    async bytes() {
        if (!output) throw new Error('No completed GIF');
        // Transfer outside profiling; avoid expanding each byte into an eight-byte JS number.
        return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error);reader.onload=()=>resolve(reader.result.split(',')[1]);reader.readAsDataURL(output);});
    },
    async release() {
        if (current?.abortTimer !== undefined) clearTimeout(current.abortTimer);
        if (current?.canvas) { current.canvas.width = current.canvas.height = 0; current.canvas.remove(); }
        output = undefined; current = undefined; await idle();
        return {timers:timers.size,workers:workers.size};
    },
    calibration(hold) { calibration = hold ? new Uint8Array(32*1024*1024).fill(77) : undefined; return calibration?.byteLength??0; }
};
