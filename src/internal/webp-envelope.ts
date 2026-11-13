// Envelope validation only. No pixel decompression, timing resampling, codec import or CRC.
function invalid(detail: string): never { throw new TypeError('Invalid WebP container: ' + detail); }
export async function validateWebpEnvelope(bytes: Uint8Array<ArrayBuffer>, expected: {
    readonly width: number; readonly height: number; readonly plays: number; readonly durationMs: number;
}, checkpoint: () => Promise<void>, guard: () => void): Promise<void> {
    guard();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const four = (p: number) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
    const u24 = (p: number) => bytes[p] | bytes[p + 1] << 8 | bytes[p + 2] << 16;
    if (bytes.length < 12 || four(0) !== 'RIFF' || four(8) !== 'WEBP' || view.getUint32(4, true) + 8 !== bytes.length) invalid('RIFF signature or length');
    let work = 0, flags = 0, extended = false, animation = false, frames = 0, duration = 0;
    let iccp = false, exif = false, xmp = false;
    function chunk(p: number, end: number) {
        guard();
        if (p + 8 > end) invalid('chunk header bounds');
        const size = view.getUint32(p + 4, true), data = p + 8, bodyEnd = data + size, next = bodyEnd + (size & 1), type = four(p);
        if (next > end || !/^[\x20-\x7e]{4}$/.test(type)) invalid('chunk body bounds or FourCC');
        if ((size & 1) && bytes[bodyEnd] !== 0) invalid('nonzero RIFF padding');
        return { type, size, data, bodyEnd, next };
    }
    for (let p = 12; p < bytes.length;) {
        const c = chunk(p, bytes.length);
        if (!extended && c.type !== 'VP8X') invalid('VP8X must be first');
        if (c.type === 'VP8X') {
            if (extended || c.size !== 10) invalid('VP8X shape or duplicate');
            flags = bytes[c.data];
            if ((flags & ~0x3e) || !(flags & 2) || u24(c.data + 1) ||
                u24(c.data + 4) + 1 !== expected.width || u24(c.data + 7) + 1 !== expected.height) invalid('VP8X flags or canvas');
            extended = true;
        } else if (c.type === 'ANIM') {
            if (animation || frames || c.size !== 6 || view.getUint16(c.data + 4, true) !== expected.plays) invalid('ANIM shape, order or plays');
            animation = true;
        } else if (c.type === 'ANMF') {
            if (!animation || c.size < 16) invalid('ANMF shape or order');
            const x = u24(c.data) * 2, y = u24(c.data + 3) * 2, w = u24(c.data + 6) + 1, h = u24(c.data + 9) + 1;
            const delay = u24(c.data + 12);
            if (x + w > expected.width || y + h > expected.height || (bytes[c.data + 15] & ~3)) invalid('frame bounds or reserved flags');
            if (!delay || delay > expected.durationMs - duration) invalid('frame duration');
            let alpha = false, image = false, tail = false;
            for (let p = c.data + 16; p < c.bodyEnd;) {
                const part = chunk(p, c.bodyEnd);
                if (part.type === 'ALPH') {
                    if (alpha || image || tail || !part.size) invalid('alpha subchunk');
                    alpha = true;
                } else if (part.type === 'VP8 ' || part.type === 'VP8L') {
                    if (image || tail || !part.size || (part.type === 'VP8L' && alpha)) invalid('image subchunk');
                    image = true;
                } else {
                    if (['VP8X', 'ANIM', 'ANMF', 'ICCP', 'EXIF', 'XMP '].includes(part.type) || !image) invalid('frame subchunk order');
                    tail = true; // Unknown frame data is allowed after the image, not before it.
                }
                p = part.next;
                if (++work === 256) { work = 0; await checkpoint(); guard(); }
            }
            if (!image) invalid('missing frame image');
            frames++; duration += delay;
        } else if (c.type === 'ICCP') {
            if (iccp || animation || frames || !c.size) invalid('ICCP shape or order');
            iccp = true;
        } else if (c.type === 'EXIF' || c.type === 'XMP ') {
            if (c.type === 'EXIF') { if (exif) invalid('duplicate EXIF'); exif = true; }
            else { if (xmp) invalid('duplicate XMP'); xmp = true; }
        } else if (['ALPH', 'VP8 ', 'VP8L'].includes(c.type)) invalid('static image outside animation frame');
        p = c.next;
        if (++work === 256) { work = 0; await checkpoint(); guard(); }
    }
    if (!extended || !animation || !frames || duration !== expected.durationMs) invalid('incomplete animation or total duration');
    if (Boolean(flags & 0x20) !== iccp || Boolean(flags & 8) !== exif || Boolean(flags & 4) !== xmp) invalid('metadata feature flags');
    guard();
}
