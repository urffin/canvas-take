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
