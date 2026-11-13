import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
export const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
export function source(width = 1, height = 1) {
    const data = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => (i * 37 + 128) % 256);
    return { width, height, data, reads: 0, contexts: 0, args: [], getContext(kind) {
        assert.equal(kind, '2d'); this.contexts++;
        return { getImageData: (...args) => { this.reads++; this.args.push(args); return { data }; } };
    } };
}
export function chunk(type, data = Buffer.alloc(0)) {
    const bytes = Buffer.alloc(8 + data.length + (data.length & 1)); bytes.write(type, 0, 'ascii'); bytes.writeUInt32LE(data.length, 4); bytes.set(data, 8); return bytes;
}
export function riff(pieces) {
    const data = Buffer.concat(pieces), header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(data.length + 4, 4); header.write('WEBP', 8); return Buffer.concat([header, data]);
}
// Test-only envelope writer. Image payload is deliberately a stub, NOT a real WebP codec.
// Successful controller tests certify metadata/lifecycle only, never independent pixel decoding.
export function file(frames, plays, { merge = false, split = false, paddingChunks = 0, imageType = 'VP8L', alpha = false, tail = false, metadata = false } = {}) {
    const { width, height } = frames[0], extended = Buffer.alloc(10), animation = Buffer.alloc(6);
    extended[0] = 2 | 16 | (metadata ? 0x2c : 0); extended.writeUIntLE(width - 1, 4, 3); extended.writeUIntLE(height - 1, 7, 3); animation.writeUInt16LE(plays, 4);
    const pieces = [chunk('VP8X', extended)];
    if (metadata) pieces.push(chunk('EXIF', Buffer.from('x')), chunk('ICCP', Buffer.from('rgb')), chunk('XMP ', Buffer.from('xmp')));
    pieces.push(chunk('ANIM', animation));
    const packets = [];
    for (const frame of frames) {
        const previous = packets.at(-1);
        if (merge && previous && Buffer.from(previous.data).equals(Buffer.from(frame.data))) previous.durationMs += frame.durationMs;
        else packets.push({ ...frame });
    }
    for (const frame of packets) {
        let duration = frame.durationMs;
        do {
            const delay = split ? Math.min(duration, 16777215) : duration, control = Buffer.alloc(16);
            control.writeUIntLE(width - 1, 6, 3); control.writeUIntLE(height - 1, 9, 3); control.writeUIntLE(delay, 12, 3); control[15] = 2;
            const payload = [control]; if (alpha) payload.push(chunk('ALPH', Buffer.from([0])));
            payload.push(chunk(imageType, Buffer.from([0x2f, 0, 0, 0, 0])));
            if (tail) payload.push(chunk('zzzz', Buffer.from([9])));
            pieces.push(chunk('ANMF', Buffer.concat(payload))); duration -= delay;
        } while (duration > 0);
    }
    for (let i = 0; i < paddingChunks; i++) pieces.push(chunk('JUNK', Buffer.from([97])));
    return riff(pieces);
}
export function chunks(bytes, start = 12, end = bytes.length) {
    const result = [];
    for (let p = start; p < end;) { const size = bytes.readUInt32LE(p + 4); result.push({ type: bytes.toString('ascii', p, p + 4), offset: p, data: p + 8, size, end: p + 8 + size + (size & 1) }); p += 8 + size + (size & 1); }
    return result;
}
export function rewrite(bytes, type, index, mutate) {
    const output = Buffer.from(bytes), found = chunks(output).filter(c => c.type === type)[index];
    assert.ok(found, 'test chunk exists'); mutate(output.subarray(found.data, found.data + found.size), output, found); return output;
}
export function encoder(hooks = {}) {
    const stats = { made: 0, disposed: 0, frames: [], kept: [], owned: [], detached: [], options: undefined, context: undefined, bytes: undefined };
    const factory = (options, context) => {
        stats.made++; stats.options = options; stats.context = context;
        const instance = {
            addFrame(frame) {
                stats.frames.push({ ...frame, data: frame.data.slice(), frozen: Object.isFrozen(frame) }); stats.owned.push(new WeakRef(frame.data));
                const owned = hooks.transfer ? structuredClone(frame, { transfer: [frame.data.buffer] }) : frame;
                stats.detached.push(frame.data.byteLength === 0); stats.kept.push(owned); return hooks.add?.(owned, context);
            },
            finish() { return stats.bytes = hooks.finish ? hooks.finish(stats) : file(stats.kept, options.plays, hooks); },
            dispose() { stats.disposed++; stats.kept.length = 0; return hooks.dispose?.(stats); }
        };
        return hooks.create ? hooks.create(instance, context) : instance;
    };
    return { stats, factory };
}
const compiled = (await build({ entryPoints: [fileURLToPath(new URL('../../dist/internal/webp-controller.js', import.meta.url))], bundle: true,
    format: 'cjs', platform: 'browser', target: 'es2022', write: false })).outputFiles[0].text;
export async function microtasks(count = 64) { for (let i = 0; i < count; i++) await Promise.resolve(); }
export function harness() {
    const timers = new Map(), callbacks = [], copies = [], progressSnapshots = [], module = { exports: {} }; let next = 0, scheduleError, copyHook;
    const Pixels = new Proxy(Uint8ClampedArray, { construct(ctor, args) { const value = Reflect.construct(ctor, args, ctor); copies.push(new WeakRef(value)); copyHook?.(); return value; } });
    const Objects = new Proxy(Object, { get(target, key) { if (key === 'freeze') return value => { if (value && Object.hasOwn(value, 'phase')) progressSnapshots.push(value); return Object.freeze(value); }; return Reflect.get(target, key); } });
    runInNewContext(compiled, { module, exports: module.exports, Object: Objects, Uint8ClampedArray: Pixels, Uint8Array, ArrayBuffer, DataView, Blob,
        AbortController, DOMException, Error, TypeError, RangeError,
        setTimeout(callback) { if (scheduleError) throw scheduleError; const id = ++next; timers.set(id, callback); callbacks.push(callback); return id; },
        clearTimeout(id) { timers.delete(id); } });
    return { create: module.exports.createWebpController, timers, callbacks, copies, progressSnapshots,
        failSchedule(error) { scheduleError = error; }, onCopy(callback) { copyHook = callback; },
        async step() { const [id, callback] = timers.entries().next().value ?? []; assert.ok(callback, 'expected owned task'); timers.delete(id); callback(); await microtasks(); },
        async flush() { for (let i = 0; i < 100; i++) { await microtasks(); if (!timers.size) return; await this.step(); } throw new Error('Task loop did not settle'); }
    };
}
export async function add(h, exporter, canvas = source(), delay = 50) { const pending = exporter.addFrame(canvas, delay); await h.step(); return pending; }
export async function finish(h, exporter) { const pending = exporter.finish(); await h.flush(); return pending; }
