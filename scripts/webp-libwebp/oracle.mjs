import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { inspect, comparePixels } from '../webp-spike/oracle.mjs';
export { inspect, comparePixels };
export function verify(bytes, spec, job) {
    const envelope = inspect(bytes);
    assert.equal(envelope.animated, true, 'even a single frame must retain ANIM/ANMF');
    assert.equal(envelope.loopCount, spec.plays);
    assert.equal(envelope.width, job.width); assert.equal(envelope.height, job.height);
    assert.equal(envelope.durationMs, job.frames.reduce((sum, frame) => sum + frame.duration, 0), 'complete timeline including last hold');
    let canvas = new Uint8Array(job.width * job.height * 4), previous, start = 0, comparisons = 0;
    const frames = [];
    for (const frame of envelope.frames) {
        assert.ok(frame.x + frame.width <= job.width && frame.y + frame.height <= job.height);
        assert.equal(frame.flags & ~3, 0, 'reserved frame bits');
        if (previous?.flags & 1) for (let y = 0; y < previous.height; y++) {
            canvas.fill(0, ((previous.y + y) * job.width + previous.x) * 4, ((previous.y + y) * job.width + previous.x + previous.width) * 4);
        }
        assert.ok(frame.chunks.length === 1 && ['VP8L', 'VP8 '].includes(frame.chunks[0]), 'diagnostic payload profile');
        const payload = Buffer.from(bytes).subarray(frame.payloadOffset, frame.payloadOffset + frame.payloadLength);
        const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(payload.length + 4, 4); header.write('WEBP', 8);
        const decoded = execFileSync(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-f', 'webp_pipe', '-i', 'pipe:0', '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
            { input: Buffer.concat([header, payload]), stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000,
                maxBuffer: frame.width * frame.height * 4 + 1048576 });
        assert.equal(decoded.length, frame.width * frame.height * 4);
        for (let y = 0; y < frame.height; y++) for (let x = 0; x < frame.width; x++) {
            const src = (y * frame.width + x) * 4, dst = ((y + frame.y) * job.width + x + frame.x) * 4;
            // Refuse to certify generic partial-alpha blending with a homemade compositor.
            if (frame.flags & 2 || decoded[src + 3] === 255) canvas.set(decoded.subarray(src, src + 4), dst);
            else assert.equal(decoded[src + 3], 0, 'only transparent/opaque OVER is certified');
        }
        const end = start + frame.durationMs;
        let inputStart = 0;
        for (let i = 0; i < job.frames.length; i++) {
            const inputEnd = inputStart + job.frames[i].duration;
            if (inputStart < end && inputEnd > start) {
                const pixels = comparePixels(canvas, job.frames[i].data, job.lossless);
                assert.equal(pixels.matches, true, spec.name + ': presentation pixels at input frame ' + i);
                comparisons++;
            }
            inputStart = inputEnd;
        }
        frames.push({ durationMs: frame.durationMs, flags: frame.flags, width: frame.width, height: frame.height });
        start = end; previous = frame;
    }
    return { envelope, frames, intervalComparisons: comparisons, independentPayloads: frames.length, presentationMatches: true };
}
