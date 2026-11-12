export const cases = [
    ...[0, 1, 3, 0xffffffff].map(plays => ({ name: 'alpha-' + plays, scene: 'alpha', width: 13, height: 7, delays: [1, 54, 65535], plays })),
    { name: 'erase', scene: 'erase', width: 17, height: 9, delays: [14, 15, 800], plays: 1 },
    { name: 'gradient', scene: 'gradient', width: 31, height: 17, delays: [1, 14, 55, 2000], plays: 3 },
    { name: 'opaque', scene: 'opaque', width: 9, height: 5, delays: [50, 55], plays: 0 },
    { name: 'transparent', scene: 'transparent', width: 5, height: 3, delays: [1, 65535], plays: 1 },
    { name: 'identical', scene: 'identical', width: 7, height: 3, delays: [54, 55, 2000], plays: 3 },
    { name: 'noise', scene: 'noise', width: 127, height: 65, delays: [14, 15, 55], plays: 1 },
    ...[0, 1, 3, 0xffffffff].map((plays, i) => ({ name: 'single-' + plays, scene: 'alpha', width: i % 2 ? 13 : 1, height: i % 2 ? 7 : 1, delays: [i % 2 ? 65535 : 1], plays }))
];
export function makeJob(spec) {
    let seed = 0x1234abcd;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    const { width, height, scene, plays } = spec;
    const frames = spec.delays.map((durationMs, frame) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
            const i = (y * width + x) * 4;
            if (scene === 'noise') { const v = random(); data.set([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, v >>> 24], i); }
            else if (scene === 'erase') { if (frame !== 1 && x >= frame && x < frame + 4 && y < 4) data.set([210, 40, 90, 255], i); }
            else {
                const f = scene === 'identical' ? 0 : frame;
                const alpha = scene === 'opaque' ? 255 : scene === 'transparent' ? 0 : scene === 'gradient' ? Math.round(255 * x / Math.max(1, width - 1)) : [0, 1, 127, 128, 254, 255][(x + y + f) % 6];
                data.set([(x * 37 + f * 19) & 255, (y * 53 + f * 41) & 255, (x * 13 + y * 29 + f * 7) & 255, alpha], i);
            }
        }
        return { data, durationMs };
    });
    return { width, height, plays, frames };
}
export const stress = { name: 'cancel-compression', scene: 'noise', width: 2048, height: 1280, delays: [50, 55, 800], plays: 1 };
