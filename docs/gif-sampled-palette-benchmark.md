# GIF palette from a bounded clip sample

Measured on 2026-11-21 with CanvasTake 0.10.0 (`31e62a5`), Node 22.17.0, Windows
10.0.19045 and an AMD FX-8350. [Raw measurements and sampled RGB entries](gif-sampled-palette-benchmark-results.json)

## Results

At 64 colors, the clip-sampled palette gave the following results:

- **Flat graphics with text.** The sampled palette recovered 98.05% exact
  pixels from 0.29% with the fixed preset. The per-frame lane reached 98.54%.
  All three lanes had zero flicker. Preparation took 125.5 ms, bringing median
  total time to 505 ms versus 410 ms for the per-frame lane.
- **Moving gradient.** Sampling lowered local-tone error from 10.293 with the
  fixed preset to 7.327. The per-frame palette reached 5.169. Flicker fell
  from 1.740 with per-frame palettes and 0.134 with the fixed preset to
  0.090 with sampling. The sampled GIF was 256.0 KiB versus 326.2 KiB
  in the per-frame lane. Median total time was 599 ms versus 1,047 ms
  in the per-frame lane, including 205.0 ms median preparation.
- **Scene cut.** Both common palettes preserved the decoded color of all 57,376
  unchanged pixels across the cut. The per-frame cut error was 0.377.
  The sampled lane reached 0.085 whole-clip flicker and 5.104 local-tone error
  versus 0.906 and 3.521 with per-frame palettes. Median total time was 542 ms
  versus 685 ms in the per-frame lane.

### Quality, size and timing

Each triple is **per-frame / fixed / sampled**. The time columns are medians
in milliseconds. The sampled preparation column also shows its range.
Medians are calculated independently for each interval.

| Scene | Colors | 8×8 RMSE | Flicker | KiB | Export ms | Total ms | Sampled prep ms |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| Flat | 32 | 0.782 / 6.830 / 1.101 | 0.000 / 0.000 / 0.000 | 210.0 / 134.3 / 210.2 | 396 / 372 / 378 | 396 / 372 / 500 | 121.3 [111.3–127.6] |
| Flat | 64 | 0.400 / 5.557 / 0.982 | 0.000 / 0.000 / 0.000 | 223.1 / 145.0 / 218.4 | 410 / 371 / 382 | 410 / 371 / 505 | 125.5 [108.9–221.5] |
| Flat | 128 | 0.400 / 2.600 / 0.982 | 0.000 / 0.000 / 0.000 | 223.1 / 172.9 / 218.4 | 415 / 371 / 379 | 415 / 371 / 497 | 119.2 [111.3–132.5] |
| Flat | 256 | 0.400 / 1.203 / 0.982 | 0.000 / 0.000 / 0.000 | 223.1 / 192.7 / 218.4 | 389 / 375 / 380 | 389 / 375 / 496 | 115.4 [112.3–130.6] |
| Gradient | 32 | 7.547 / 12.656 / 10.791 | 3.028 / 0.126 / 0.083 | 231.0 / 205.1 / 191.2 | 1013 / 375 / 379 | 1013 / 375 / 585 | 203.7 [184.9–252.7] |
| Gradient | 64 | 5.169 / 10.293 / 7.327 | 1.740 / 0.134 / 0.090 | 326.2 / 267.6 / 256.0 | 1046 / 379 / 388 | 1047 / 379 / 599 | 205.0 [187.2–235.8] |
| Gradient | 128 | 3.763 / 8.827 / 5.535 | 1.066 / 0.173 / 0.135 | 452.9 / 367.3 / 332.5 | 1064 / 395 / 392 | 1064 / 395 / 605 | 198.6 [189.1–273.5] |
| Gradient | 256 | 2.915 / 7.928 / 4.307 | 0.625 / 0.194 / 0.169 | 611.8 / 469.2 / 448.8 | 1080 / 492 / 474 | 1080 / 492 / 662 | 205.8 [184.9–242.3] |
| Cut | 32 | 5.053 / 8.317 / 8.232 | 1.363 / 0.083 / 0.071 | 228.5 / 179.1 / 178.2 | 672 / 385 / 380 | 672 / 385 / 527 | 142.3 [132.1–152.3] |
| Cut | 64 | 3.521 / 5.315 / 5.104 | 0.906 / 0.084 / 0.085 | 284.2 / 225.8 / 231.5 | 685 / 381 / 385 | 685 / 381 / 542 | 147.7 [134.4–243.7] |
| Cut | 128 | 2.642 / 3.744 / 3.728 | 0.610 / 0.110 / 0.105 | 349.0 / 286.7 / 288.6 | 726 / 393 / 391 | 726 / 393 / 553 | 157.3 [148.2–177.9] |
| Cut | 256 | 2.052 / 2.705 / 2.749 | 0.390 / 0.128 / 0.117 | 429.0 / 355.2 / 362.4 | 733 / 415 / 436 | 733 / 415 / 604 | 156.7 [143.6–186.3] |

At 64 colors, the median grid-copy stage took 0.78–0.92 ms across the
three in-memory clips. Worker quantization took 9.7 ms on the flat chart,
114.0 ms on the gradient and 54.9 ms on the cut. The full preparation
also includes Worker startup, messaging and shutdown.

### Peak resident memory

All measurements are in MiB. Entries are medians with minimum and maximum
in brackets. The preparation column is the sampled lane's rise over its
own process high-water baseline. The three export columns give absolute
process peaks through the end of export.

| Profile | Sampled prep growth | Per-frame peak | Fixed peak | Sampled peak |
| --- | --- | --- | --- | --- |
| Flat 640×360, 24 frames | 15.4 [12.2–16.7] | 61.1 [60.8–61.7] | 62.0 [59.6–62.5] | 67.7 [65.1–68.1] |
| Gradient 640×360, 24 frames | 16.7 [16.1–16.7] | 71.8 [71.2–73.2] | 60.9 [60.7–62.2] | 68.5 [68.5–69.4] |
| Cut 640×360, 24 frames | 17.6 [16.4–17.9] | 71.2 [70.8–71.5] | 60.9 [60.7–62.6] | 68.9 [68.7–69.2] |
| Cut 1280×720, 48 frames | 25.1 [19.5–27.3] | 106.0 [106.0–111.7] | 99.1 [99.1–99.2] | 110.2 [103.7–110.4] |

The sample buffer stayed at 64 KiB in each profile. Preparation also
allocates a source frame and runs a separate Node Worker isolate. Overall
peaks include later export buffers, with overlapping sampled and per-frame
ranges for the long cut.

### Cancellation and retry

All 16 attempts rejected with the same abort reason supplied by the caller.
Every fresh export matched the expected GIF hash. Values are median
milliseconds from abort request to rejection, with observed ranges.

| Stage | Settle ms |
| --- | ---: |
| Pre-aborted | 0.119 [0.100–1.434] |
| During sampling | 0.127 [0.062–0.191] |
| At Worker quantizer entry | 34.081 [29.035–37.894] |
| After the first encoded frame | 0.274 [0.184–0.377] |

## Method

The timing and quality study reuses the flat chart with text, moving gradient,
and abrupt scene cut from the [previous palette study](gif-shared-palette-benchmark.md).
Each clip has 24 opaque 640×360 frames and a 2.4 s timeline including the 560 ms
final hold. The three lanes are the existing per-frame strategy, the previous
fixed preset shared across clips, and a common palette computed from each clip.
They use RGB565, the same gifenc build and writer, and `dither: 'none'` at limits
of 32, 64, 128 and 256 colors. The first frame supplies the global table.
The two common-palette lanes reuse that table through the clip.

The prototype samples up to four frames by index across a replayable clip, including
the first and last. The full timing profile selects zero-based frames 0, 8, 15
and 23. It copies at most a 64×64 grid of pixels from each selected frame into
one 64 KiB RGBA buffer. Grid coordinates are the centers of equally sized
regions. Sampling processes at most 16 rows per event-loop turn. It transfers
the compact buffer to a dedicated Node Worker for gifenc quantization and waits
for the Worker to close. The encoder then reads frames in order using the
resulting palette. The sample can produce fewer colors than the requested cap.

Each lane has a warm-up and six measured repetitions per clip and limit. That
gives **216 timing samples** and **36 distinct GIF cases**. The runner rotates
the order of limits and uses the six permutations of the three lanes. The timed
source frames are already rendered in memory for all lanes. Preparation includes
reading the four source frames, copying the grid, Worker startup, quantization and
cleanup. The raw report splits copying and quantization from full preparation.
Export time runs from exporter creation through a finalized Blob. Total time
covers both stages. The fixed baseline starts with its palette available.
Source rendering, Blob byte extraction, GIF decoding and file writes are
outside the timing intervals.

The runner verifies every warm-up and repeated output through SHA-256, checks
both control lanes against the previous study, and confirms that source RGBA
stays intact. gifuct-js 2.1.2 independently verifies the dimensions, frame count,
delays, full-frame opacity, and palette structure. RGB RMSE measures per-channel
color error. The 8×8 RMSE measures local tone after averaging signed RGB errors
within each 8×8 block. Flicker is the mean absolute change in decoded RGB at
positions where the source RGB was the same in adjacent frames. Cut flicker
uses only the two frames around the transition. Lower errors are better.

### Peak memory

At 64 colors, each lane and profile runs three times in a fresh Node process
with GC before the baseline. This gives 36 independent runs across the three
640×360 clips and a 48-frame 1280×720 scene-cut clip. The memory profiles
generate a frame on demand in both preparation and export, so the benchmark
holds no pre-rendered clip array in these processes. `process.resourceUsage().maxRSS`
records the process's resident-memory high-water mark including its Worker
thread. The report stores snapshots before preparation, after preparation,
after export and after a final GC. Preparation and export growth use the
preparation baseline's high-water mark. Process startup, source rendering,
temporary buffers and the encoded output contribute to this measurement. The
64 KiB sample size describes the transferred pixel buffer. [Node.js resource usage](https://nodejs.org/docs/latest-v22.x/api/process.html#processresourceusage)

### Cancellation

The scene-cut clip exercises four stages, repeated four times each. A pre-aborted
signal prevents frame reads. Cancellation after the first sampling chunk stops
further sampling and Worker creation. Cancellation on the quantizer's start
message checks the detached sender buffer and closed Worker before rejection.
That message marks Worker entry and can race with the synchronous quantizer's
completion. Cancellation after the first encoded frame goes through the shipped
exporter and verifies one disposal and zero finalized GIFs. The same abort
reason is observed in all stages. Every attempt is followed by a fresh export
that must match the successful reference hash. Settling times run from abort
request through rejection and include Worker shutdown where applicable.

## Reproduce

```sh
npm run build
node scripts/benchmark-gif-sampled-palette.mjs
```

Add `--quick` for one repetition at 160×96 with four frames and a reduced
memory and cancellation matrix. The runner writes JSON, 36 GIFs and contact
sheets under `benchmark-results/gif-sampled-palette/`. Each sheet shows the
source, per-frame, fixed and sampled outputs at 64 colors. The scene-cut sheet
shows the frames immediately before and after the transition.
