// Container envelope only; pixel decompression/round-trip verification belongs to codec tests.
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    let crc = n;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    return crc >>> 0;
});
function invalid(detail: string): never { throw new TypeError('Invalid APNG container: ' + detail); }
export async function validateApngEnvelope(bytes: Uint8Array<ArrayBuffer>, expected: {
    readonly width: number; readonly height: number; readonly plays: number; readonly durations: readonly number[];
}, checkpoint: () => Promise<void>, guard: () => void): Promise<void> {
    guard();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 8 || signature.some((n, i) => bytes[i] !== n)) invalid('signature');
    let position = 8, chunks = 0, sequence = 0, frames = 0, dataBytes = 0, work = 0;
    let header = false, animation = false, idat = false, ended = false;
    while (position < bytes.length) {
        guard();
        if (ended || position + 12 > bytes.length) invalid('chunk bounds or trailing data');
        const length = view.getUint32(position), end = position + 12 + length, data = position + 8;
        if (end > bytes.length) invalid('chunk length');
        const type = String.fromCharCode(...bytes.subarray(position + 4, position + 8));
        if (!/^[A-Za-z]{4}$/.test(type)) invalid('chunk type');
        let crc = 0xffffffff;
        for (let i = position + 4; i < end - 4; i++) {
            crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
            if (++work === 65536) { work = 0; await checkpoint(); guard(); }
        }
        if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(end - 4)) invalid('CRC ' + type);
        if (!chunks++ && type !== 'IHDR') invalid('IHDR must be first');
        if (type === 'IHDR') {
            if (header || length !== 13 || view.getUint32(data) !== expected.width || view.getUint32(data + 4) !== expected.height) invalid('IHDR dimensions');
            const depths: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
            if (!depths[bytes[data + 9]]?.includes(bytes[data + 8]) || bytes[data + 10] || bytes[data + 11] || bytes[data + 12] > 1) invalid('IHDR profile');
            header = true;
        } else if (type === 'acTL') {
            if (!header || animation || frames || idat || length !== 8 || view.getUint32(data) !== expected.durations.length || view.getUint32(data + 4) !== expected.plays) invalid('animation count or plays');
            animation = true;
        } else if (type === 'fcTL') {
            if (!animation || length !== 26 || frames >= expected.durations.length || view.getUint32(data) !== sequence++) invalid('frame control or sequence');
            if (frames && !dataBytes) invalid('empty frame');
            const width = view.getUint32(data + 4), height = view.getUint32(data + 8), x = view.getUint32(data + 12), y = view.getUint32(data + 16);
            if (!width || !height || x + width > expected.width || y + height > expected.height ||
                (!frames && (x || y || width !== expected.width || height !== expected.height))) invalid('frame dimensions');
            const numerator = view.getUint16(data + 20), denominator = view.getUint16(data + 22) || 100;
            if (numerator * 1000 !== expected.durations[frames] * denominator || bytes[data + 24] > 2 || bytes[data + 25] > 1) invalid('frame delay or operation');
            frames++; dataBytes = 0;
        } else if (type === 'IDAT') {
            if (frames !== 1 || !animation) invalid('default image must be first animation frame');
            idat = true; dataBytes += length;
        } else if (type === 'fdAT') {
            if (!idat || frames < 2 || length < 4 || view.getUint32(data) !== sequence++) invalid('frame data or sequence');
            dataBytes += length - 4;
        } else if (type === 'IEND') {
            if (length || !header || !animation || !idat || frames !== expected.durations.length || !dataBytes) invalid('incomplete animation');
            ended = true;
        } else if (type[0] === type[0].toUpperCase() && type !== 'PLTE') invalid('unknown critical chunk');
        position = end;
    }
    if (!ended) invalid('missing IEND');
    guard();
}
