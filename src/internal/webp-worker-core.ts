import { createWebpNativeEncoder, type WebpNativeModule } from './webp-native.js';
import { checkCodec, checkLimits, checkPlays, webpProfile, type WebpCodecOptions } from './webp-config.js';
import type { WebpExportLimits, WebpFrameEncoder } from './webp-types.js';
export interface WebpWorkerScope {
    postMessage(data: unknown, transfer?: Transferable[]): void;
    close(): void;
    onmessage: ((event: MessageEvent) => void) | null;
}
type Request = { format: string; version: number; id: number; action: string;
    value: { plays: number; limits: WebpExportLimits; codec: WebpCodecOptions; wasmUrl: string } };
/** Private protocol core, with a loader seam for deterministic resource/fault probes. */
export function startWebpWorker(scope: WebpWorkerScope, load: (url: string, signal: AbortSignal) => Promise<WebpNativeModule>): void {
    let lastId = 0, busy = false, initialized = false, terminal = false, encoder: WebpFrameEncoder | undefined;
    const abort = new AbortController();
    function close(): void {
        if (terminal) return; terminal = true; scope.onmessage = null; abort.abort();
        try { encoder?.dispose(); } catch {} finally { encoder = undefined; scope.close(); }
    }
    function fail(id: unknown, action: unknown, error: unknown): void {
        if (terminal) return;
        try { scope.postMessage({ format: 'webp', version: 1, id, action, error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) } }); }
        finally { close(); }
    }
    scope.onmessage = event => {
        if (terminal) return;
        let data: Request | undefined = event.data; const id = data?.id, action = data?.action;
        try {
            if (!data || data.format !== 'webp' || data.version !== 1 || !Number.isSafeInteger(id) || id! <= lastId || busy) throw new TypeError('Invalid or overlapping WebP Worker request');
            lastId = id!; busy = true;
        } catch (error) { fail(id, action, error); return; }
        void (async () => {
            try {
                const reply = { format: 'webp', version: 1, id, action };
                if (action === 'init') {
                    if (initialized) throw new Error('WebP Worker already initialized');
                    const value = data!.value; checkPlays(value?.plays);
                    const limits = checkLimits(value?.limits), codec = checkCodec(value?.codec);
                    if (typeof value.wasmUrl !== 'string' || new URL(value.wasmUrl).href !== value.wasmUrl) throw new TypeError('WebP wasmUrl must be absolute');
                    let module: WebpNativeModule | undefined = await load(value.wasmUrl, abort.signal);
                    if (terminal) { module = undefined; return; }
                    encoder = createWebpNativeEncoder(module, value.plays, limits, codec); module = undefined; initialized = true;
                    scope.postMessage({ ...reply, value: { bindingAbi: 1, profile: webpProfile } });
                } else {
                    if (!initialized || !encoder) throw new Error('WebP Worker not initialized');
                    if (action === 'frame') { await encoder.addFrame(data!.value as unknown as Parameters<WebpFrameEncoder['addFrame']>[0]); if (!terminal) scope.postMessage(reply); }
                    else if (action === 'finish') {
                        const bytes = await encoder.finish();
                        if (terminal) return;
                        encoder.dispose(); encoder = undefined;
                        if (!(bytes.buffer instanceof ArrayBuffer) || bytes.byteOffset || bytes.byteLength !== bytes.buffer.byteLength) throw new TypeError('Invalid WebP output span');
                        scope.postMessage({ ...reply, bytes }, [bytes.buffer]); close();
                    } else throw new TypeError('Unknown WebP Worker action');
                }
            } catch (error) { fail(id, action, error); }
            finally { data = undefined; busy = false; }
        })().catch(() => { close(); });
    };
}
