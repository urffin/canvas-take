import { Worker } from 'node:worker_threads';

// Drive a built browser module Worker from Node, with real structured-clone transfers.
export class NodeModuleWorker extends EventTarget {
    constructor(url) {
        super();
        this.node = new Worker(new URL('./browser-worker.mjs', import.meta.url), { workerData: String(url) });
        this.node.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })));
        this.node.on('error', error => {
            const event = new Event('error');
            event.message = error.message;
            this.dispatchEvent(event);
        });
    }

    postMessage(message, transfer) { this.node.postMessage(message, transfer); }
    terminate() { this.exited = this.node.terminate(); }
}
