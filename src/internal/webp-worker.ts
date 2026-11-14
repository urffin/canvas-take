import type { WebpEncoderFactory, WebpFrame } from './webp-types.js';
import { checkCodec, checkLimits, checkPlays, webpProfile } from './webp-config.js';
export interface WebpWorkerOptions {
    readonly workerUrl?: string | URL;
    readonly wasmUrl?: string | URL;
    readonly timeoutMs?: number;
    readonly lossless?: boolean;
    readonly quality?: number;
    readonly method?: number;
}
/** Acquiring an encoder creates one dedicated Worker; imports never load a codec. */
export function createWebpWorkerEncoder(options: WebpWorkerOptions = {}): WebpEncoderFactory {
    const workerUrl = options.workerUrl === undefined ? undefined : String(options.workerUrl);
    const wasmUrl = options.wasmUrl === undefined ? undefined : String(options.wasmUrl);
    const timeoutMs = options.timeoutMs === undefined ? 30000 : options.timeoutMs;
    const codec = checkCodec({ lossless: options.lossless === undefined ? true : options.lossless,
        quality: options.quality === undefined ? 100 : options.quality, method: options.method === undefined ? 4 : options.method });
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new RangeError('Invalid WebP timeoutMs');
    return ({ plays }, context) => {
        const reason = () => context.signal.reason ?? new DOMException('WebP Worker aborted', 'AbortError');
        if (context.signal.aborted) throw reason();
        checkPlays(plays); const limits = checkLimits(context.limits);
        if (typeof Worker === 'undefined') throw new Error('WebP Worker encoding is not supported');
        const base = typeof document !== 'undefined' ? document.baseURI : typeof location !== 'undefined' ? location.href : import.meta.url;
        const wasm = wasmUrl === undefined ? new URL('./webp-codec.wasm', import.meta.url) : new URL(wasmUrl, base);
        // Asset emitters can replace static new URL with a relative-URL shim. The wire URL
        // must still be absolute; normalize dynamically on acquisition, never during SSR.
        const absoluteWasmUrl = new URL(wasm.href, base).href;
        const url = workerUrl === undefined ? new URL('./webp-worker-runtime.js', import.meta.url) : new URL(workerUrl, base);
        let worker: Worker | undefined, nextId = 0, busy = false, finishing = false, failure: { reason: unknown } | undefined;
        type Reply = { bytes?: Uint8Array };
        const pending = new Map<number, { action: string; resolve: (reply: Reply) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> | undefined }>();
        const failed = () => failure?.reason;
        function close(error: unknown): void {
            failure ??= { reason: error };
            try { context.signal.removeEventListener('abort', onAbort); } catch {}
            const owned = worker; worker = undefined;
            if (owned) {
                for (const [type, fn] of [['message', onMessage], ['error', onError], ['messageerror', onMessageError]] as const) {
                    try { owned.removeEventListener(type, fn as EventListener); } catch {}
                }
                try { owned.terminate(); } catch {}
            }
            for (const request of pending.values()) { if (request.timer !== undefined) clearTimeout(request.timer); request.reject(failure.reason); }
            pending.clear();
        }
        function onAbort(): void { close(reason()); }
        function onError(event: ErrorEvent): void { event.preventDefault?.(); close(new Error(event.message || 'WebP Worker failed')); }
        function onMessageError(): void { close(new Error('WebP Worker message could not be decoded')); }
        function onMessage(event: MessageEvent): void {
            const m = event.data, request = pending.get(m?.id);
            if (!request) return;
            try {
                if (m.format !== 'webp' || m.version !== 1 || m.action !== request.action) throw new Error('Invalid WebP Worker acknowledgement');
                if (Object.hasOwn(m, 'error')) {
                    if (Object.hasOwn(m, 'value') || Object.hasOwn(m, 'bytes') || typeof m.error?.name !== 'string' || typeof m.error?.message !== 'string') throw new Error('Invalid WebP Worker error');
                    const error = new Error(m.error.message); error.name = m.error.name; throw error;
                }
                if (request.action === 'init') {
                    if (m.value?.bindingAbi !== 1 || m.value?.profile !== webpProfile || Object.hasOwn(m, 'bytes')) throw new Error('Incompatible WebP binding/profile');
                } else if (request.action === 'frame') {
                    if (Object.hasOwn(m, 'bytes') || Object.hasOwn(m, 'value')) throw new Error('Invalid WebP frame acknowledgement');
                } else if (Object.hasOwn(m, 'value') || !(m.bytes instanceof Uint8Array) || !(m.bytes.buffer instanceof ArrayBuffer) || !m.bytes.length ||
                    m.bytes.byteOffset !== 0 || m.bytes.byteLength !== m.bytes.buffer.byteLength || m.bytes.byteLength > limits.maxOutputBytes) throw new Error('Invalid WebP Worker output or budget');
                pending.delete(m.id); if (request.timer !== undefined) clearTimeout(request.timer); request.resolve(m);
            } catch (error) { close(error); }
        }
        function send(action: string, value?: unknown, transfer: Transferable[] = []): Promise<Reply> {
            if (!worker || failure) return Promise.reject(failure?.reason);
            return new Promise((resolve, reject) => {
                const id = ++nextId, request = { action, resolve, reject, timer: undefined as ReturnType<typeof setTimeout> | undefined };
                pending.set(id, request);
                try {
                    if (!Number.isSafeInteger(id)) throw new RangeError('WebP request id exhausted');
                    request.timer = setTimeout(() => { if (pending.get(id) === request) close(new Error('WebP Worker ' + action + ' timed out')); }, timeoutMs);
                    if (!worker || failure || !pending.has(id)) { if (request.timer !== undefined) clearTimeout(request.timer); return; }
                    worker.postMessage({ format: 'webp', version: 1, id, action, ...(value === undefined ? {} : { value }) }, transfer);
                } catch (error) { close(error); }
                finally { value = undefined; transfer = []; }
            });
        }
        try {
            worker = new Worker(url, { type: 'module' });
            // Constructor/getters can synchronously deliver cancellation before a handle is assigned.
            if (context.signal.aborted) throw reason();
            worker.addEventListener('message', onMessage); worker.addEventListener('error', onError); worker.addEventListener('messageerror', onMessageError);
            context.signal.addEventListener('abort', onAbort, { once: true });
            if (context.signal.aborted) throw reason();
        } catch (error) { close(error); throw failed(); }
        const initialized = send('init', { plays, limits, codec, wasmUrl: absoluteWasmUrl }); void initialized.catch(() => {});
        async function operation<T>(finish: boolean, work: () => Promise<T>): Promise<T> {
            if (!worker || failure) throw failure?.reason;
            if (busy || finishing) throw new Error('WebP Worker operation already pending or finished');
            busy = true; finishing = finish;
            try { await initialized; if (!worker || failure) throw failed(); return await work(); }
            catch (error) { close(error); throw failure!.reason; }
            finally { busy = false; }
        }
        return {
            async addFrame(frame: WebpFrame | undefined) {
                try { await operation(false, async () => {
                    if (!frame || !(frame.data instanceof Uint8ClampedArray) || !(frame.data.buffer instanceof ArrayBuffer) ||
                        !frame.data.length || frame.data.byteOffset || frame.data.byteLength !== frame.data.buffer.byteLength) throw new TypeError('WebP requires an owned full-span snapshot');
                    await send('frame', frame, [frame.data.buffer]);
                }); } finally { frame = undefined; }
            },
            finish() { return operation(true, async () => { const reply = await send('finish'); close(new Error('WebP Worker finished')); return reply.bytes!; }); },
            dispose() { close(new DOMException('WebP Worker disposed', 'AbortError')); }
        };
    };
}
