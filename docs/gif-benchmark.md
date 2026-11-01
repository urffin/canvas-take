# GIF adapter benchmark

Install dependencies and Chromium (`npm ci`, `npx playwright install chromium`), then run:

```sh
npm run benchmark:gif
# Short local check: two resolutions, two durations, one repeat
npm run benchmark:gif -- --quick
# Compare opacity scenes before/after the opaque-pixel optimization
npm run benchmark:gif -- --compare-opacity
# Smoke check of the comparison (one repeat, 360p and 720p)
npm run benchmark:gif -- --compare-opacity --quick
```

The full matrix uses 640×360, 1280×720 and 1920×1080; 3, 10 and 30 seconds; 20 fps; three repeats for each adapter. Both adapters use gifenc with 128 colors and `quality: 'high'`. The renderer generates identical opaque flat-graphics frames from the frame index, without random values, fonts, external images or wall-clock animation. Full output SHA-256 hashes must match across adapters and repeats for each case. Pixel/timing correctness is covered separately by the browser tests.

`--compare-opacity` uses three-second clips at the same three resolutions, three repeats, both adapters and two core versions (108 exports). It compares the core from Git commit `2f71f3c` (before the optimization) with the current built core, sharing the current adapters and renderer. The baseline requires that commit in local Git history; its TypeScript is transpiled in memory, without changing the checkout. Before/after order alternates alongside adapter order. Every scene/core/adapter receives an excluded warm-up. Output hashes must match across both versions, both adapters and all repeats within each scene/resolution/duration. `comparison.md` adds paired medians and percentage changes to the raw JSON/CSV and full summary.

The opacity scenes are `opaque` (solid background and moving bars), `mixed` (an opaque background on one third of the canvas, transparent gaps, and alternating opaque/half-alpha bars), and `gradient` (an animated color gradient with alpha from 0.15 to 0.85, without any opaque pixels). The canvas is cleared before each frame, preventing alpha accumulation. A separate, untimed inspection of the first frame asserts the expected alpha categories and records their pixel counts in metadata. The default exporter background is white for all scenes. Scene timings include drawing; compare versions within a scene rather than interpreting differences between scenes as pure encoding costs.

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

## Opacity scene comparison: 2026-11-01

Command: `npm run benchmark:gif -- --compare-opacity`. All 108 exports completed, with byte-identical results within each scene/resolution across both core versions, adapters and all three repeats. This is a fresh comparison against the pre-optimization core, not a comparison with historical wall times. Environment: AMD FX-8350, Windows 10 build 19045, Chromium 156.0.8078.4, Node 22.17.0; current core at `6930a09`, baseline at `2f71f3c`; benchmark changes were uncommitted.

At 1080p, the first mixed frame contained 45.4% opaque, 40.4% fully transparent and 14.2% partially transparent pixels. The opaque scene was 100% opaque; the gradient was 100% partially transparent. These proportions describe the inspected first frame, not every animated frame.

Times are medians; lag values are medians of per-run p95. Positive time reduction means faster; negative means slower.

| Scene | Resolution | Seconds | Adapter | Before ms | After ms | Time reduction | Lag p95 before ms | Lag p95 after ms |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| opaque | 640×360 | 3 | sync | 1406.5 | 1063.4 | 24.4% | 10.1 | 5.3 |
| opaque | 640×360 | 3 | worker | 1260.2 | 933.5 | 25.9% | 4.9 | 2.8 |
| opaque | 1280×720 | 3 | sync | 4584.4 | 3369.7 | 26.5% | 75.0 | 46.5 |
| opaque | 1280×720 | 3 | worker | 4561.3 | 3227.2 | 29.2% | 35.2 | 13.9 |
| opaque | 1920×1080 | 3 | sync | 9966.9 | 7116.1 | 28.6% | 163.3 | 158.6 |
| opaque | 1920×1080 | 3 | worker | 10156.1 | 7261.3 | 28.5% | 80.5 | 33.1 |
| mixed | 640×360 | 3 | sync | 1399.7 | 1252.5 | 10.5% | 10.0 | 7.8 |
| mixed | 640×360 | 3 | worker | 1217.2 | 1060.0 | 12.9% | 4.6 | 2.6 |
| mixed | 1280×720 | 3 | sync | 4604.9 | 4080.2 | 11.4% | 71.2 | 66.0 |
| mixed | 1280×720 | 3 | worker | 4596.3 | 3955.7 | 13.9% | 31.9 | 22.4 |
| mixed | 1920×1080 | 3 | sync | 10239.6 | 8883.4 | 13.2% | 199.3 | 191.7 |
| mixed | 1920×1080 | 3 | worker | 10599.5 | 9097.6 | 14.2% | 79.0 | 53.7 |
| gradient | 640×360 | 3 | sync | 1865.1 | 1929.0 | -3.4% | 20.9 | 21.1 |
| gradient | 640×360 | 3 | worker | 1805.4 | 1678.0 | 7.1% | 12.9 | 11.4 |
| gradient | 1280×720 | 3 | sync | 6168.2 | 6256.3 | -1.4% | 95.4 | 103.2 |
| gradient | 1280×720 | 3 | worker | 6168.6 | 6112.9 | 0.9% | 53.0 | 52.8 |
| gradient | 1920×1080 | 3 | sync | 13678.2 | 14551.0 | -6.4% | 279.2 | 306.8 |
| gradient | 1920×1080 | 3 | worker | 14454.1 | 15027.8 | -4.0% | 125.8 | 128.9 |

Opaque scenes took 24–29% less time and mixed-alpha scenes 10–14% less time in this run. Gradients showed no consistent benefit: the synchronous adapter was 1.4–6.4% slower, while Worker varied from 7.1% faster to 4.0% slower. At 1080p, both gradient medians regressed (Sync 6.4%, Worker 4.0%); this observed cost must not be described as a universal speedup. With three repeats and noticeable run-to-run variation, the experiment does not establish statistical significance or isolate the extra branch from runtime/system noise. More gradient repetitions and profiling would be appropriate before claiming a stable regression magnitude.

At 1080p, Worker timer lag p95 improved from 80.5 to 33.1 ms for opaque frames and from 79.0 to 53.7 ms for mixed alpha, but increased from 125.8 to 128.9 ms for gradients. The optimization benefits pixels that can skip blending; it does not eliminate readback, copying, drawing or encoding work.
