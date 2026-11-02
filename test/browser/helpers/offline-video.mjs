import ffmpeg from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
/** Independent FFmpeg demux/copy and full decode; neither uses the writing library. */
export async function inspectOfflineVideo(path) {
    const run = args => execute(ffmpeg, ['-hide_banner', '-nostdin', '-xerror', '-err_detect', 'explode', '-copyts', '-i', path, ...args],
        { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
    const [packets, decoded] = await Promise.all([
        run(['-map', '0:v:0', '-c:v', 'copy', '-f', 'framecrc', 'pipe:1']),
        run(['-map', '0:v:0', '-vf', 'scale=1:1,format=rgb24,showinfo', '-vsync', '0', '-f', 'rawvideo', 'pipe:1'])
    ]);
    const text = packets.stdout.toString();
    const tb = text.match(/#tb 0:\s*(\d+)\/(\d+)/); assert.ok(tb, text);
    const rows = text.split('\n').filter(line => /^0,/.test(line)).map(line => {
        const [, dts, pts, duration, size] = line.split(',').map(s => Number(s.trim()));
        return { dts, pts, duration, size };
    });
    const colors = Array.from({ length: decoded.stdout.length / 3 }, (_, i) => [...decoded.stdout.subarray(i * 3, i * 3 + 3)]);
    const log = decoded.stderr.toString();
    assert.equal(colors.length, rows.length, 'Every demuxed frame must decode, including the last');
    assert.doesNotMatch(log, /Audio:/, 'Silent offline export must have no audio track');
    assert.match(log, /Video:\s*h264/);
    assert.match(log, /90x160/);
    assert.doesNotMatch(log, /type:B/, 'Baseline output must contain no B frames');
    const ptsUs = log.split('\n').filter(line => line.includes('Parsed_showinfo') && line.includes('pts_time:'))
        .map(line => Number(line.match(/pts_time:([\d.e+-]+)/)[1]) * 1e6);
    assert.equal(ptsUs.length, rows.length);
    return { timebase: [Number(tb[1]), Number(tb[2])], packets: rows, colors, ptsUs,
        codec: 'h264', log };
}

/** Read only movie/track headers for an exact container duration independent of the muxer. */
export function mp4Headers(bytes) {
    const result = { movie: undefined, tracks: [], topLevel: [] };
    function boxes(start, end, track) {
        for (let p = start; p + 8 <= end;) {
            const size32 = bytes.readUInt32BE(p), name = bytes.toString('ascii', p + 4, p + 8);
            const header = size32 === 1 ? 16 : 8;
            const size = size32 === 1 ? Number(bytes.readBigUInt64BE(p + 8)) : size32 || end - p;
            assert.ok(size >= header && p + size <= end, `Invalid ${name} box`);
            const data = p + header;
            if (start === 0) result.topLevel.push(name);
            if (name === 'trak') { const t = {}; result.tracks.push(t); boxes(data, p + size, t); }
            else if (['moov', 'mdia'].includes(name)) boxes(data, p + size, track);
            else if (name === 'mvhd' || name === 'mdhd') {
                const version = bytes[data], scaleOffset = data + (version === 1 ? 20 : 12);
                const timescale = bytes.readUInt32BE(scaleOffset);
                const duration = version === 1 ? Number(bytes.readBigUInt64BE(scaleOffset + 4)) : bytes.readUInt32BE(scaleOffset + 4);
                if (name === 'mvhd') result.movie = { timescale, duration }; else Object.assign(track, { timescale, duration });
            } else if (name === 'hdlr' && track) track.type = bytes.toString('ascii', data + 8, data + 12);
            p += size;
        }
    }
    boxes(0, bytes.length); return result;
}
