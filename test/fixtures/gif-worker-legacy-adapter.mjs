// Frozen 0.6.0 wire compatibility fixture (09299d7); no private raw protocol.
/** One dedicated module Worker per exporter. No codec runs on the calling thread. */
export function createGifWorkerEncoder(options = {}) {
    const maxColors = options.maxColors ?? 256, quality = options.quality ?? 'high';
    const timeoutMs = options.timeoutMs ?? 30000;
    const workerUrl = options.workerUrl;
    if (!Number.isInteger(maxColors) || maxColors < 2 || maxColors > 256)
        throw new RangeError('maxColors must be 2..256');
    if (quality !== 'high' && quality !== 'fast')
        throw new TypeError('quality must be high or fast');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
        throw new RangeError('timeoutMs must be in (0, 2147483647]');
    return ({ repeat }) => {
        if (typeof Worker === 'undefined')
            throw new Error('GIF Worker encoding is not supported in this environment');
        let worker = workerUrl === undefined
            ? new Worker(new URL('./gif-worker-runtime.js', import.meta.url), { type: 'module' })
            : new Worker(workerUrl, { type: 'module' });
        let nextId = 0;
        let failure;
        const pending = new Map();
        function close(error) {
            failure ??= error;
            const owned = worker;
            worker = undefined;
            if (owned) {
                owned.removeEventListener('message', onMessage);
                owned.removeEventListener('error', onError);
                owned.removeEventListener('messageerror', onMessageError);
                owned.terminate();
            }
            for (const request of pending.values()) {
                clearTimeout(request.timer);
                request.reject(failure);
            }
            pending.clear();
        }
        function onMessage(event) {
            const message = event.data;
            const request = pending.get(message?.id);
            if (!request)
                return;
            if (typeof message.error === 'string') {
                close(new Error(message.error));
                return;
            }
            pending.delete(message.id);
            clearTimeout(request.timer);
            request.resolve(message.bytes);
        }
        function onError(event) { close(new Error(event.message || 'GIF Worker failed to load or execute')); }
        function onMessageError() { close(new Error('GIF Worker message could not be decoded')); }
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        worker.addEventListener('messageerror', onMessageError);
        function send(action, value, transfer = []) {
            if (!worker)
                return Promise.reject(failure ?? new Error('GIF Worker is disposed'));
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                const timer = setTimeout(() => close(new Error(`GIF Worker ${action} timed out`)), timeoutMs);
                pending.set(id, { resolve, reject, timer });
                try {
                    worker.postMessage({ id, action, value }, transfer);
                }
                catch (error) {
                    close(error instanceof Error ? error : new Error(String(error)));
                }
            });
        }
        const initialized = send('init', { repeat, maxColors, quality });
        void initialized.catch(() => { });
        return {
            async addFrame(frame) {
                await initialized;
                await send('frame', frame, [frame.data.buffer]);
            },
            async finish() {
                await initialized;
                const bytes = await send('finish');
                if (!(bytes instanceof Uint8Array)) {
                    const error = new Error('GIF Worker returned invalid bytes');
                    close(error);
                    throw error;
                }
                close(new Error('GIF Worker finished'));
                return bytes;
            },
            dispose() { close(new DOMException('GIF Worker disposed', 'AbortError')); }
        };
    };
}
