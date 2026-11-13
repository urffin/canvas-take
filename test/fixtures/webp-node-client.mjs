import { Worker as Thread } from 'node:worker_threads';
export function nodeWorkers(workerData = {}) {
    const workers = [];
    class Worker {
        listeners = new Map(); messages = []; terminated = 0; stats = [];
        constructor(url, options) {
            this.url = url.href; this.options = options;
            this.thread = new Thread(new URL('./webp-node-runtime.mjs', import.meta.url), { workerData });
            this.exited = new Promise(resolve => this.thread.once('exit', code => { this.exitCode = code; resolve(code); }));
            this.thread.on('message', data => { if (data.stats) this.stats.push({ action: data.action, ...data.stats }); this.listeners.get('message')?.({ data }); });
            this.thread.on('error', error => this.listeners.get('error')?.({ message: error.message, preventDefault() {} }));
            workers.push(this);
        }
        addEventListener(type, fn) { this.listeners.set(type, fn); }
        removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
        postMessage(message, transfer) {
            const record = { action: message.action, id: message.id }; this.messages.push(record);
            this.thread.postMessage(message, transfer);
            if (message.action === 'frame') record.detached = message.value.data.byteLength === 0;
        }
        terminate() { this.terminated++; void this.thread.terminate(); }
    }
    return { Worker, workers, async drain() { await Promise.all(workers.map(w => w.exited)); } };
}
