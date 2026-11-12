import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
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
// Test-only writer: native zlib plus a bitwise CRC independent of the controller's lookup table.
export function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    return (crc ^ 0xffffffff) >>> 0;
}
export function chunk(type, data) {
    const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4); bytes.set(data, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4); return bytes;
}
export function file(frames, plays, { denominator = 1000, padding = 0 } = {}) {
    const { width, height } = frames[0], header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
    const animation = Buffer.alloc(8); animation.writeUInt32BE(frames.length); animation.writeUInt32BE(plays, 4);
    const pieces = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('acTL', animation)];
    let seq = 0;
    for (let f = 0; f < frames.length; f++) {
        const frame = frames[f], control = Buffer.alloc(26); control.writeUInt32BE(seq++); control.writeUInt32BE(width, 4); control.writeUInt32BE(height, 8);
        control.writeUInt16BE(frame.durationMs * (denominator || 100) / 1000, 20); control.writeUInt16BE(denominator, 22); control[24] = 1;
        pieces.push(chunk('fcTL', control));
        const filtered = Buffer.alloc((width * 4 + 1) * height), raw = Buffer.from(frame.data);
        for (let y = 0; y < height; y++) raw.copy(filtered, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
        const data = deflateSync(filtered);
        if (!f) pieces.push(chunk('IDAT', data));
        else { const number = Buffer.alloc(4); number.writeUInt32BE(seq++); pieces.push(chunk('fdAT', Buffer.concat([number, data]))); }
    }
    if (padding) pieces.push(chunk('tEXt', Buffer.concat([Buffer.from('note\0'), Buffer.alloc(padding, 97)])));
    pieces.push(chunk('IEND', Buffer.alloc(0))); return Buffer.concat(pieces);
}
export function rewrite(bytes, type, index, change, repair = true) {
    const output = Buffer.from(bytes); let found = 0;
    for (let p = 8; p < output.length;) {
        const length = output.readUInt32BE(p), name = output.toString('ascii', p + 4, p + 8), end = p + 12 + length;
        if (name === type && found++ === index) {
            change(output.subarray(p + 8, end - 4));
            if (repair) output.writeUInt32BE(crc32(output.subarray(p + 4, end - 4)), end - 4);
            return output;
        }
        p = end;
    }
    throw new Error('Test chunk not found: ' + type);
}
export function encoder(hooks = {}) {
    const stats = { made: 0, disposed: 0, frames: [], kept: [], owned: [], options: undefined, context: undefined, bytes: undefined };
    const factory = (options, context) => {
        stats.made++; stats.options = options; stats.context = context;
        const instance = {
            addFrame(frame) {
                stats.frames.push({ ...frame, data: frame.data.slice(), frozen: Object.isFrozen(frame) }); stats.kept.push(frame); stats.owned.push(new WeakRef(frame.data));
                return hooks.add?.(frame, context);
            },
            finish() {
                if (hooks.finish) return hooks.finish(stats);
                return stats.bytes = file(stats.kept, options.plays, hooks);
            },
            dispose() { stats.disposed++; stats.kept.length = 0; hooks.dispose?.(stats); }
        };
        return hooks.create ? hooks.create(instance, context) : instance;
    };
    return { stats, factory };
}
const compiled = (await build({ entryPoints: [fileURLToPath(new URL('../../dist/internal/apng-controller.js', import.meta.url))], bundle: true,
    format: 'cjs', platform: 'browser', target: 'es2022', write: false })).outputFiles[0].text;
export async function microtasks() { for (let i = 0; i < 64; i++) await Promise.resolve(); }
export function harness() {
    const timers = new Map(), callbacks = [], copies = [], progressSnapshots = [], module = { exports: {} }; let next = 0, scheduleError;
    const Pixels = new Proxy(Uint8ClampedArray, { construct(ctor, args) { const value = Reflect.construct(ctor, args, ctor); copies.push(new WeakRef(value)); return value; } });
    const Objects = new Proxy(Object, { get(target, key) { if (key === 'freeze') return value => { if (value && Object.hasOwn(value, 'phase')) progressSnapshots.push(value); return Object.freeze(value); }; return Reflect.get(target, key); } });
    runInNewContext(compiled, { module, exports: module.exports, Object: Objects, Uint8ClampedArray: Pixels, Uint8Array, ArrayBuffer, DataView, Blob,
        AbortController, DOMException, Error, TypeError, RangeError,
        setTimeout(callback) { if (scheduleError) throw scheduleError; const id = ++next; timers.set(id, callback); callbacks.push(callback); return id; },
        clearTimeout(id) { timers.delete(id); } });
    return { create: module.exports.createApngController, timers, callbacks, copies, progressSnapshots,
        failSchedule(error) { scheduleError = error; },
        async step() { const [id, callback] = timers.entries().next().value ?? []; assert.ok(callback, 'expected owned scheduled task'); timers.delete(id); callback(); await microtasks(); },
        async flush() { for (let i = 0; i < 100; i++) { await microtasks(); if (!timers.size) return; await this.step(); } throw new Error('Task loop did not settle'); }
    };
}
export async function add(h, exporter, canvas = source(), delay = 50) { const pending = exporter.addFrame(canvas, delay); await h.step(); return pending; }
export async function finish(h, exporter) { const pending = exporter.finish(); await h.flush(); return pending; }
