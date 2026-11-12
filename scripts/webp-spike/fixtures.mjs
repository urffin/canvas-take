// Research fixtures only. Each frame is a complete straight-RGBA snapshot.
const solid = (width, height, rgba) => {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
    return data;
};
export const specs = [
    { name: 'final-hold', width: 1, height: 1, delays: [55, 2000], colors: [[255, 0, 0, 255], [0, 255, 0, 128]] },
    { name: 'alpha-ramp', width: 6, height: 3, delays: [70, 90, 130], ramp: true },
    { name: 'transparent-erasure', width: 5, height: 3, delays: [50, 75, 100], colors: [[210, 30, 80, 255], [91, 82, 73, 0], [0, 255, 0, 128]] },
    { name: 'identical', width: 3, height: 3, delays: [55, 2000], colors: [[255, 0, 0, 255], [255, 0, 0, 255]] },
    { name: 'duplicate-middle', width: 3, height: 3, delays: [50, 70, 90, 200], colors: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]] },
    { name: 'single', width: 3, height: 1, delays: [2000], colors: [[0, 255, 0, 128]] },
    { name: 'short-delays', width: 1, height: 1, delays: [1, 10, 11, 100], colors: [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 255, 0, 128]] },
    { name: 'lossy-40', width: 16, height: 16, delays: [75, 175], gradient: true, lossless: false, quality: 40 },
    { name: 'lossy-90', width: 16, height: 16, delays: [75, 175], gradient: true, lossless: false, quality: 90 }
];
export function makeJob(spec) {
    const frames = spec.delays.map((duration, frame) => {
        const data = solid(spec.width, spec.height, spec.colors?.[frame] ?? [0, 0, 0, 0]);
        if (spec.ramp || spec.gradient) for (let i = 0; i < data.length; i += 4) {
            const x = i / 4 % spec.width, y = Math.floor(i / 4 / spec.width);
            data.set([(x * 37 + frame * 61) % 256, (y * 67 + frame * 97) % 256, (x * 23 + y * 29 + frame * 41) % 256,
                spec.ramp ? [0, 1, 127, 128, 254, 255][(x + frame) % 6] : 255], i);
        }
        return { data, duration };
    });
    return { width: spec.width, height: spec.height, frames, lossless: spec.lossless !== false, quality: spec.quality ?? 100 };
}
export function stressJob() {
    let state = 7;
    const data = new Uint8Array(1024 * 1024 * 4);
    for (let i = 0; i < data.length; i += 4) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        data.set([state & 255, state >>> 8 & 255, state >>> 16 & 255, 255], i);
    }
    return { width: 1024, height: 1024, lossless: true, quality: 100, frames: [{ data, duration: 100 }] };
}
