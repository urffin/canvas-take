import { specs as baseline, makeJob, stressJob } from '../webp-spike/fixtures.mjs';
export { makeJob, stressJob };
export const specs = baseline.map(spec => ({ ...spec, plays: 3 }));
for (const name of ['final-hold', 'single']) for (const plays of [0, 1, 65535]) {
    specs.push({ ...baseline.find(spec => spec.name === name), name: name + '-plays-' + plays, plays });
}
specs.push({ name: 'single-transparent', width: 3, height: 5, colors: [[123, 45, 67, 0]], delays: [999], plays: 1 });
specs.push({ name: 'maximum-delay', width: 1, height: 1, colors: [[255, 0, 0, 255], [0, 255, 0, 128]], delays: [16777215, 55], plays: 1 });
export const jobFor = spec => ({ ...makeJob(spec), plays: spec.plays });
