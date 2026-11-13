import vm from 'node:vm';
import { build } from 'esbuild';
export const limits = Object.freeze({ maxFramePixels: 4194304, maxFrames: 1000, maxDurationMs: 2147483647, maxInputBytes: 67108864, maxOutputBytes: 33554432 });
export const codec = { lossless: true, quality: 100, method: 4 };
export const profile = 'libwebp-batch-animation-v1';
export const context = overrides => ({ signal: new AbortController().signal, limits, ...overrides });
export const frame = () => ({ width: 1, height: 1, durationMs: 55, data: new Uint8ClampedArray([90, 60, 30, 128]) });
export const init = (extra = {}) => ({ format: 'webp', version: 1, id: 1, action: 'init', value: { plays: 3, limits, codec, wasmUrl: 'https://test.invalid/codec.wasm', ...extra } });
export const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const host = (await build({ entryPoints: ['src/internal/webp-worker.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser', define: { 'import.meta.url': '"https://test.invalid/internal/webp-worker.js"' } })).outputFiles[0].text;
const runtime = (await build({ entryPoints: ['src/internal/webp-worker-core.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser' })).outputFiles[0].text;
export function hostHarness(hooks = {}) {
    const workers = [], timers = new Map(); let next = 0;
    class Worker {
        listeners = new Map(); messages = []; terminated = 0;
        constructor(url, options) { this.url = url.href; this.options = options; workers.push(this); hooks.construct?.(this); }
        addEventListener(type, fn) { this.listeners.set(type, fn); hooks.listen?.(this, type); }
        removeEventListener(type, fn) { if (this.listeners.get(type) === fn) this.listeners.delete(type); }
        terminate() { this.terminated++; hooks.terminate?.(this); }
        postMessage(data, transfer) { if (this.throwPost) throw this.throwPost; this.messages.push({ data, transfer }); hooks.post?.(this, data); }
        reply(extra = {}, index = this.messages.length - 1) { const { format, version, id, action } = this.messages[index].data; this.listeners.get('message')?.({ data: { format, version, id, action, ...(action === 'init' ? { value: { bindingAbi: 1, profile } } : {}), ...extra } }); }
    }
    const module = { exports: {} };
    vm.runInNewContext(host, { module, exports: module.exports, Worker, URL, Error, TypeError, RangeError, DOMException, Uint8Array, Uint8ClampedArray, ArrayBuffer,
        ...(hooks.globals ?? {}), setTimeout(fn) { const id = ++next; timers.set(id, fn); hooks.schedule?.(fn); return id; }, clearTimeout(id) { timers.delete(id); } });
    return { create: module.exports.createWebpWorkerEncoder, workers, timers };
}
export function runtimeHarness(load) {
    const module = { exports: {} }, messages = []; let closed = 0;
    vm.runInNewContext(runtime, { module, exports: module.exports, URL, Error, TypeError, RangeError, DOMException, Uint8Array, Uint8ClampedArray, ArrayBuffer, TextDecoder, AbortController });
    const scope = { onmessage: null, postMessage(data, transfer) { messages.push({ data, transfer }); }, close() { closed++; } };
    module.exports.startWebpWorker(scope, load);
    return { scope, messages, get closed() { return closed; }, send(data) { scope.onmessage?.({ data }); } };
}
export function nativeStub() {
    const stats = { opens: 0, closes: 0, frees: 0, adds: [], live: 0 };
    const module = { HEAPU8: new Uint8Array(4096), _ct_binding_abi: () => 1, _ct_profile: () => 1, _ct_version: () => 0x010600,
        _ct_open() { stats.opens++; stats.live++; return 1; }, _ct_malloc: () => 32, _ct_free() { stats.frees++; },
        _ct_close() { stats.closes++; stats.live--; }, _ct_add(s, p, n, d) { stats.adds.push({ bytes: [...module.HEAPU8.subarray(p, p + n)], delay: d }); return 1; },
        _ct_finish: () => 1, _ct_data: () => 128, _ct_size: () => 4, _ct_error: () => 256 };
    module.HEAPU8.set([82, 73, 70, 70], 128); return { module, stats };
}
