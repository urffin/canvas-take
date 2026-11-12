import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';

const execute = promisify(execFile), signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// Independent of UPNG/Pako. Deliberately simple CRC oracle, used on small correctness fixtures.
export function crc32(data) {
    let crc = 0xffffffff;
    for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
    return (crc ^ 0xffffffff) >>> 0;
}
export function inspect(bytes) {
    const data = Buffer.from(bytes); assert.ok(data.subarray(0, 8).equals(signature), 'PNG signature');
    const chunks = [], frames = []; let width, height, count, plays, seq = 0, ended = false, seenIdat = false;
    for (let offset = 8; offset < data.length;) {
        assert.ok(offset + 12 <= data.length, 'chunk header bound');
        const length = data.readUInt32BE(offset), end = offset + 12 + length;
        assert.ok(end <= data.length, 'chunk payload bound');
        const type = data.toString('ascii', offset + 4, offset + 8), body = data.subarray(offset + 8, end - 4);
        assert.equal(data.readUInt32BE(end - 4), crc32(data.subarray(offset + 4, end - 4)), type + ' CRC');
        assert.ok(!ended, 'data after IEND'); chunks.push({ type, offset, end, body });
        if (type === 'IHDR') {
            assert.equal(chunks.length, 1); assert.equal(length, 13);
            width = body.readUInt32BE(0); height = body.readUInt32BE(4); assert.ok(width && height);
            assert.deepEqual([...body.subarray(8)], [8, 6, 0, 0, 0], 'full RGBA8 profile');
        } else if (type === 'acTL') {
            assert.equal(count, undefined, 'duplicate acTL'); assert.ok(!seenIdat && !frames.length); assert.equal(length, 8);
            count = body.readUInt32BE(0); plays = body.readUInt32BE(4); assert.ok(count > 0);
        } else if (type === 'fcTL') {
            assert.ok(count, 'missing acTL'); assert.equal(length, 26); assert.equal(body.readUInt32BE(0), seq++, 'frame sequence');
            if (frames.length) assert.ok(frames.at(-1).dataBytes > 0, 'empty frame');
            const frame = { width: body.readUInt32BE(4), height: body.readUInt32BE(8), x: body.readUInt32BE(12), y: body.readUInt32BE(16),
                num: body.readUInt16BE(20), den: body.readUInt16BE(22), dispose: body[24], blend: body[25], dataBytes: 0 };
            assert.ok(frame.width && frame.height && frame.x + frame.width <= width && frame.y + frame.height <= height, 'frame bounds');
            assert.ok(frame.dispose <= 2 && frame.blend <= 1 && frame.num && frame.den);
            frames.push(frame);
        } else if (type === 'IDAT') {
            assert.equal(frames.length, 1, 'first image must be an animation frame'); seenIdat = true; frames[0].dataBytes += length;
        } else if (type === 'fdAT') {
            assert.ok(seenIdat && frames.length > 1 && length > 4); assert.equal(body.readUInt32BE(0), seq++, 'data sequence'); frames.at(-1).dataBytes += length - 4;
        } else if (type === 'IEND') { assert.equal(length, 0); ended = true; }
        offset = end;
    }
    assert.ok(ended && seenIdat && count); assert.equal(count, frames.length, 'declared frame count'); assert.ok(frames.at(-1).dataBytes > 0);
    return { width, height, count, plays, frames, chunks };
}
export function checkEnvelope(bytes, spec, { profile = true } = {}) {
    const file = inspect(bytes);
    assert.equal(file.width, spec.width); assert.equal(file.height, spec.height); assert.equal(file.count, spec.delays.length);
    assert.equal(file.plays, spec.plays, 'total plays');
    file.frames.forEach((frame, i) => { assert.equal(frame.num * 1000, spec.delays[i] * frame.den, 'exact rational delay'); });
    if (profile) assert.ok(file.frames.every(f => f.x === 0 && f.y === 0 && f.width === file.width && f.height === file.height && f.blend === 0 && f.dispose === 1), 'full-frame SOURCE/BACKGROUND profile');
    return file;
}
export function comparePixels(decoded, job) {
    const size = job.width * job.height * 4; assert.equal(decoded.byteLength, size * job.frames.length, 'every submitted image decoded exactly once');
    let visible = 0;
    job.frames.forEach(({ data }, f) => {
        for (let i = 0; i < size; i += 4) {
            assert.equal(decoded[f * size + i + 3], data[i + 3], `alpha frame=${f} pixel=${i / 4}`);
            if (data[i + 3]) for (let c = 0; c < 3; c++) { assert.equal(decoded[f * size + i + c], data[i + c], `RGB frame=${f} pixel=${i / 4}`); visible++; }
        }
    });
    return { pixels: size / 4 * job.frames.length, visibleRgbChannels: visible };
}
export async function decode(path, spec, job) {
    const input = ['-hide_banner', '-nostdin', '-xerror', '-err_detect', 'explode', '-copyts', '-f', 'apng', '-ignore_loop', '1', '-max_fps', '0', '-i', path];
    const run = args => execute(ffmpeg, [...input, ...args], { encoding: 'buffer', timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
    const [raw, packets] = await Promise.all([
        run(['-map', '0:v:0', '-pix_fmt', 'rgba', '-vsync', '0', '-f', 'rawvideo', 'pipe:1']),
        run(['-map', '0:v:0', '-c:v', 'copy', '-f', 'framecrc', 'pipe:1'])
    ]);
    const pixels = comparePixels(raw.stdout, job), text = packets.stdout.toString();
    const tb = text.match(/#tb 0:\s*(\d+)\/(\d+)/); assert.ok(tb, text);
    const rows = text.split(/\r?\n/).filter(line => /^0,/.test(line)).map(line => line.split(',').map(s => Number(s.trim())));
    assert.equal(rows.length, spec.delays.length);
    let time = 0;
    rows.forEach(([, dts, pts, duration], i) => {
        assert.equal(pts * Number(tb[1]) * 1000, time * Number(tb[2]), 'packet PTS'); assert.equal(dts, pts);
        assert.equal(duration * Number(tb[1]) * 1000, spec.delays[i] * Number(tb[2]), 'packet duration'); time += spec.delays[i];
    });
    return { ...pixels, frames: rows.length, durationMs: time, timebase: [Number(tb[1]), Number(tb[2])], packets: rows.map(([, dts, pts, duration]) => ({ dts, pts, duration })) };
}
export function mutateChunk(bytes, type, index, change) {
    const data = Buffer.from(bytes), chunks = inspect(bytes).chunks.filter(c => c.type === type), chunk = chunks[index]; assert.ok(chunk);
    change(data.subarray(chunk.offset + 8, chunk.end - 4));
    data.writeUInt32BE(crc32(data.subarray(chunk.offset + 4, chunk.end - 4)), chunk.end - 4); return data;
}
