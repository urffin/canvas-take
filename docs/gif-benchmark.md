# GIF adapter benchmark

Install dependencies and Chromium (`npm ci`, `npx playwright install chromium`), then run:

```sh
npm run benchmark:gif
# Short local check: two resolutions, two durations, one repeat
npm run benchmark:gif -- --quick
```

The full matrix uses 640×360, 1280×720 and 1920×1080; 3, 10 and 30 seconds; 20 fps; three repeats for each adapter. Both adapters use gifenc with 128 colors and `quality: 'high'`. The renderer generates identical opaque flat-graphics frames from the frame index, without random values, fonts, external images or wall-clock animation. Full output SHA-256 hashes must match across adapters and repeats for each case. Pixel/timing correctness is covered separately by the browser tests.

Runs are sequential in headless Chromium, after an excluded one-second warm-up for each adapter. The first adapter alternates between pairs. Each export gets a fresh encoder/Worker. Startup, rendering, canvas readback, compositing, encoding and finalization are included in export time; module loading, hashing and transferring measurements to Node are excluded. Frame p95 includes rendering plus awaited addFrame. Finalization time is also retained in JSON/CSV.

An independent 16 ms timer records excess main-thread scheduling delay during each export. The p95 and maximum help compare responsiveness, but are not measurements of input latency. Worker export still reads and composites pixels on the main thread. A faster export is not necessarily more responsive. Memory consumption and cancellation latency are **not measured** by this benchmark; JS heap alone would omit Worker/native buffers and would not be a fair memory comparison.

Timestamped `benchmark-results/` directories contain raw per-frame/timer samples and environment information in JSON, per-run CSV, and a Markdown table of medians. Partial JSON survives a later failure; a failing or timed-out case stops the command with a nonzero exit code. Each case has a five-minute timeout. Generated results are ignored by Git. A quick run is a smoke measurement, not a statistically robust comparison.

Run on an otherwise idle machine, with stable power settings, and retain the environment metadata when comparing results. This synthetic scene is not representative of photos, noisy imagery or every algorithm visualization. No performance thresholds are imposed in shared CI: hardware contention would make them misleading. Run this command explicitly when evaluating adapter changes.

## Baseline: 2026-10-28

All 54 exports completed: nine configurations, two adapters, three repeats. All six GIFs for each configuration were byte-identical (SHA-256). Environment: AMD FX-8350, Windows 10 build 19045, Chromium 156.0.8078.4, Node 22.17.0, CanvasTake 0.4.1 at `2fcabcc557ce6cbd10e342045221a9787c1b61c0`, with the benchmark files uncommitted. The run started on October 28 in Europe/Moscow (October 27 UTC).

Export times below are medians of three runs. Timer lag columns are medians of the three per-run p95 values, not pooled percentiles. Negative time change means Worker took less time.

| Resolution | GIF duration (s) | Sync export (s) | Worker export (s) | Worker time change | Sync timer lag p95 (ms) | Worker timer lag p95 (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 640×360 | 3 | 1.26 | 1.09 | -13.5% | 8.0 | 2.2 |
| 640×360 | 10 | 4.28 | 3.51 | -18.0% | 7.3 | 2.4 |
| 640×360 | 30 | 13.00 | 10.56 | -18.8% | 8.0 | 3.1 |
| 1280×720 | 3 | 4.12 | 3.95 | -4.3% | 66.6 | 25.2 |
| 1280×720 | 10 | 13.85 | 13.32 | -3.8% | 58.1 | 27.2 |
| 1280×720 | 30 | 41.97 | 39.95 | -4.8% | 62.9 | 27.4 |
| 1920×1080 | 3 | 8.98 | 9.07 | +0.9% | 155.4 | 62.0 |
| 1920×1080 | 10 | 29.98 | 30.76 | +2.6% | 144.1 | 63.0 |
| 1920×1080 | 30 | 92.94 | 93.54 | +0.6% | 158.1 | 63.6 |

On this machine and scene, Worker reduced export time by 13–19% at 360p and 4–5% at 720p. At 1080p, export time was similar, with Worker taking 0.6–2.6% longer. Worker reduced timer lag in every configuration, although 1080p still showed around 62–64 ms p95 lag. Three repeats do not establish statistical significance for small differences; these figures are a local baseline, not general performance guarantees.

## Opaque-pixel blending optimization: 2026-11-01

The exporter now skips background blending when a pixel's alpha is exactly 255. Other alpha values keep the existing composition and rounding. Snapshot ownership and the cancellation yield are unchanged.

A fresh before/after comparison used the core from commit `2f71f3c` and the optimized core, served alongside the same adapters and deterministic renderer. The environment and encoding settings were the same as above. Each core/adapter received an excluded warm-up; exports ran sequentially with alternating before/after order and three repeats. This focused matrix covers three-second GIFs at all three resolutions plus ten-second GIFs at 1080p (48 exports); it does not rerun the full 30-second matrix. All 48 output hashes matched the historical baseline. An exploratory run overlapped browser tests and is excluded from this table; the reported run started after all browser tests ended.

| Resolution | GIF duration (s) | Adapter | Before (s) | After (s) | Time reduction | Timer lag p95 before (ms) | Timer lag p95 after (ms) |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 640×360 | 3 | Sync | 1.28 | 1.02 | 20.6% | 17.4 | 8.9 |
| 640×360 | 3 | Worker | 1.05 | 0.80 | 23.8% | 1.8 | 2.6 |
| 1280×720 | 3 | Sync | 3.94 | 3.06 | 22.5% | 55.5 | 43.7 |
| 1280×720 | 3 | Worker | 3.88 | 3.00 | 22.7% | 24.4 | 10.3 |
| 1920×1080 | 3 | Sync | 8.79 | 6.96 | 20.7% | 164.8 | 161.0 |
| 1920×1080 | 3 | Worker | 8.99 | 6.83 | 24.0% | 63.1 | 27.4 |
| 1920×1080 | 10 | Sync | 29.72 | 22.51 | 24.3% | 150.7 | 105.9 |
| 1920×1080 | 10 | Worker | 30.04 | 23.65 | 21.3% | 63.0 | 29.2 |

Values are medians across repeats (timer columns use per-run p95); reductions use unrounded timings. Export time decreased by 21–24% on this opaque scene. At 1080p, Worker timer lag p95 fell from about 63 ms to 27–29 ms. Lag did not improve uniformly: the 360p Worker value rose from 1.8 to 2.6 ms. These are measurements on one machine, with only three repeats; they do not establish a universal speedup or responsiveness guarantee. Scenes containing translucent pixels still perform blending for those pixels.
