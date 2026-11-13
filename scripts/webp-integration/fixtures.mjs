import { specs as previous, jobFor as baselineJob } from '../webp-libwebp/fixtures.mjs';
export const specs = [...previous,
    { name: 'identical-uint24-split', width: 1, height: 1, delays: [16777215, 55], colors: [[255, 0, 0, 255], [255, 0, 0, 255]], plays: 3 },
    { name: 'lossy-partial-alpha', width: 6, height: 3, delays: [70, 90, 130], ramp: true, lossless: false, quality: 75, plays: 1 },
    { name: 'lossy-alpha-erasure', width: 5, height: 3, delays: [50, 75, 100], colors: [[210, 30, 80, 255], [91, 82, 73, 0], [0, 255, 0, 128]], lossless: false, quality: 75, plays: 1 }
];
export const jobFor = baselineJob;
export function canvasFor(job, frame) {
    return { width: job.width, height: job.height, getContext: () => ({ getImageData: () => ({ data: new Uint8ClampedArray(frame.data) }) }) };
}
