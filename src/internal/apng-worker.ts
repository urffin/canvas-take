import type { ApngEncoderFactory, ApngFrame } from './apng-types.js';

export interface ApngWorkerOptions {
    /** Override the module Worker URL when copying assets or using a bundler. */
    readonly workerUrl?: string | URL;
    /** Per-request including initialization and compression. Default 30000 ms. */
    readonly timeoutMs?: number;
}
/** Each factory invocation owns one dedicated module Worker; no calling-thread codec import. */
export function createApngWorkerEncoder(options: ApngWorkerOptions = {}): ApngEncoderFactory {
    const workerUrl = options.workerUrl === undefined ? undefined : String(options.workerUrl);
    const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new RangeError('APNG timeoutMs must be in (0, 2147483647]');
    return ({ plays }, context) => {
        if (context.signal.aborted) throw context.signal.reason;
        if (typeof Worker === 'undefined') throw new Error('APNG Worker encoding is not supported in this environment');
        let worker: Worker | undefined = workerUrl === undefined
            ? new Worker(new URL('./apng-worker-runtime.js', import.meta.url), { type: 'module' })
            : new Worker(workerUrl, { type: 'module' });
        let nextId = 0, failure: { reason: unknown } | undefined, busy = false, finishing = false;
        type Reply = { bytes?: unknown };
        const pending = new Map<number, { action: string; resolve: (reply: Reply) => void; reject: (reason: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
        function close(reason: unknown) {
            failure ??= { reason };
            context.signal.removeEventListener('abort', onAbort);
            const owned = worker; worker = undefined;
            if (owned) {
                owned.removeEventListener('message', onMessage); owned.removeEventListener('error', onError); owned.removeEventListener('messageerror', onMessageError);
                try { owned.terminate(); } catch {}
            }
            for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure.reason); }
            pending.clear();
        }
        function onAbort() { close(context.signal.reason); }
        function onError(event: ErrorEvent) { event.preventDefault?.(); close(new Error(event.message || 'APNG Worker failed to load or execute')); }
        function onMessageError() { close(new Error('APNG Worker message could not be decoded')); }
        function onMessage(event: MessageEvent) {
            const message = event.data, request = pending.get(message?.id);
            if (!request) return; // Ignore stale/unsolicited replies without acknowledging live work.
            if (message.version !== 1 || message.action !== request.action) { close(new Error('Invalid APNG Worker acknowledgement')); return; }
            if (message.error !== undefined) {
                if (typeof message.error?.message !== 'string' || typeof message.error?.name !== 'string') { close(new Error('Invalid APNG Worker error')); return; }
                const error = new Error(message.error.message); error.name = message.error.name; close(error); return;
            }
            if (request.action === 'finish' && (!(message.bytes instanceof Uint8Array) || !(message.bytes.buffer instanceof ArrayBuffer) || !message.bytes.byteLength ||
                (context.maxOutputBytes !== undefined && message.bytes.byteLength > context.maxOutputBytes))) { close(new Error('Invalid APNG Worker output or output budget exceeded')); return; }
            pending.delete(message.id); clearTimeout(request.timer); request.resolve(message);
        }
        function send(action: string, value?: unknown, transfer: Transferable[] = []): Promise<Reply> {
            if (!worker) return Promise.reject(failure?.reason);
            return new Promise((resolve, reject) => {
                const id = ++nextId;
                const timer = setTimeout(() => close(new Error(`APNG Worker ${action} timed out`)), timeoutMs);
                pending.set(id, { action, resolve, reject, timer });
                try { worker!.postMessage({ version: 1, id, action, value }, transfer); } catch (error) { close(error); }
                finally { value = undefined; transfer = []; }
            });
        }
        try {
            worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onMessageError);
            context.signal.addEventListener('abort', onAbort, { once: true });
            if (context.signal.aborted) onAbort();
        } catch (error) { close(error); throw failure!.reason; }
        const initialized = send('init', { plays, maxInputBytes: context.maxInputBytes, maxOutputBytes: context.maxOutputBytes });
        void initialized.catch(() => {});
        async function operation<T>(finish: boolean, work: () => Promise<T>): Promise<T> {
            if (!worker) throw failure?.reason;
            if (busy || finishing) throw new Error('APNG Worker operation already pending or finished');
            busy = true; finishing = finish;
            try { await initialized; if (!worker) throw failure?.reason; return await work(); }
            catch (error) { close(error); throw failure!.reason; }
            finally { busy = false; }
        }
        return {
            async addFrame(frame: ApngFrame | undefined) {
                try { await operation(false, async () => {
                    if (!frame) throw new TypeError('APNG frame is required');
                    await send('frame', frame, [frame.data.buffer as ArrayBuffer]);
                }); } finally { frame = undefined; } // Preserved transport errors may retain invocation closures.
            },
            finish() { return operation(true, async () => { const reply = await send('finish'); close(new Error('APNG Worker finished')); return reply.bytes as Uint8Array; }); },
            dispose() { close(new DOMException('APNG Worker disposed', 'AbortError')); }
        };
    };
}
