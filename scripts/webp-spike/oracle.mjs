import assert from 'node:assert/strict';

// Independent bounded RIFF reader. It never calls the candidate's decoder or writes WebP.
export function inspect(input) {
    const b = Buffer.from(input);
    assert.ok(b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP', 'RIFF/WEBP header');
    assert.equal(b.readUInt32LE(4) + 8, b.length, 'exact RIFF length');
    const u24 = p => b.readUIntLE(p, 3);
    const walk = (start, end) => {
        const chunks = [];
        for (let p = start; p < end;) {
            assert.ok(p + 8 <= end, 'complete chunk header');
            const size = b.readUInt32LE(p + 4), next = p + 8 + size + (size & 1);
            assert.ok(next <= end, 'complete chunk body/padding');
            if (size & 1) assert.equal(b[next - 1], 0, 'zero RIFF padding');
            chunks.push({ type: b.toString('ascii', p, p + 4), offset: p, size, data: p + 8 });
            p = next;
        }
        return chunks;
    };
    const chunks = walk(12, b.length), extended = chunks.find(c => c.type === 'VP8X'), anim = chunks.find(c => c.type === 'ANIM');
    if (extended) assert.equal(extended.size, 10);
    if (anim) assert.equal(anim.size, 6);
    const frames = chunks.filter(c => c.type === 'ANMF').map(c => {
        assert.ok(c.size >= 16, 'ANMF header');
        const p = c.data, sub = walk(p + 16, p + c.size);
        assert.ok(sub.some(c => c.type === 'VP8L' || c.type === 'VP8 '), 'encoded frame payload');
        return { x: u24(p) * 2, y: u24(p + 3) * 2, width: u24(p + 6) + 1, height: u24(p + 9) + 1,
            durationMs: u24(p + 12), flags: b[p + 15], durationOffset: p + 12,
            payloadOffset: p + 16, payloadLength: c.size - 16, chunks: sub.map(c => c.type) };
    });
    if (anim || frames.length) assert.ok(extended && b[extended.data] & 2 && anim && frames.length, 'consistent animation chunks');
    return { animated: Boolean(anim), loopCount: anim ? b.readUInt16LE(anim.data + 4) : null,
        width: extended ? u24(extended.data + 4) + 1 : null, height: extended ? u24(extended.data + 7) + 1 : null,
        durationMs: frames.reduce((sum, f) => sum + f.durationMs, 0), frames, chunks: chunks.map(c => c.type) };
}
// Diagnostic extraction only: copy an existing still-image payload into a RIFF envelope.
// No compression, animation writing, compositing or timing validation happens here.
export function extractStill(input, envelope, index) {
    const bytes = Buffer.from(input), frame = envelope.frames[index];
    if (!envelope.animated) return bytes;
    assert.ok(frame.chunks.length === 1 && ['VP8L', 'VP8 '].includes(frame.chunks[0]), 'simple extracted payload only');
    assert.equal(frame.x, 0); assert.equal(frame.y, 0);
    assert.equal(frame.width, envelope.width); assert.equal(frame.height, envelope.height);
    const payload = bytes.subarray(frame.payloadOffset, frame.payloadOffset + frame.payloadLength);
    const header = Buffer.alloc(12); header.write('RIFF'); header.writeUInt32LE(payload.length + 4, 4); header.write('WEBP', 8);
    return Buffer.concat([header, payload]);
}
export function checkExactTimeline(envelope, spec) {
    assert.equal(envelope.animated, true, 'animation metadata must exist for this diagnostic');
    assert.deepEqual(envelope.frames.map(f => f.durationMs), spec.delays, 'exact input frame durations');
}
export function comparePixels(actual, expected, lossless) {
    assert.equal(actual.length, expected.length, 'decoded RGBA byte count');
    let alphaErrors = 0, rgbErrors = 0, maxRgbError = 0;
    for (let i = 0; i < actual.length; i += 4) {
        if (actual[i + 3] !== expected[i + 3]) alphaErrors++;
        // Hidden RGB at alpha=0 is outside the visual-lossless contract of this candidate.
        if (expected[i + 3]) for (let c = 0; c < 3; c++) {
            const error = Math.abs(actual[i + c] - expected[i + c]);
            if (error) rgbErrors++;
            maxRgbError = Math.max(maxRgbError, error);
        }
    }
    return { alphaErrors, rgbErrors, maxRgbError, matches: alphaErrors === 0 && (!lossless || rgbErrors === 0) };
}
