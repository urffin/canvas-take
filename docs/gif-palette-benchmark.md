# GIF palette size and quantization quality

Measured on 2026-11-21 with CanvasTake 0.10.0 (`8d67a92`), Node 22.17.0, Windows
10.0.19045 and an AMD FX-8350. [Raw measurements](gif-palette-benchmark-results.json)

## Results

- **Flat graphics with text.** `high`/64 reproduced 98.54% of pixels exactly.
  `fast`/64 reproduced 29.53%, with a 13% smaller GIF. Within each preset, 64,
  128 and 256 produced identical GIF bytes. The 56 source colors occupied 54
  RGB565 buckets and 39 RGB444 buckets. The two presets had overlapping timing
  ranges, and measured flicker was zero throughout this fixture.
- **Moving gradient.** At 64 colors, `fast` reduced median time from 1,067 to
  409 ms in sync and from 1,205 to 545 ms in Worker. Local-tone error rose
  from 5.169 to 7.528, while flicker fell from 1.740 to 1.396. With `high`,
  moving from 64 to 128 colors lowered local-tone error to 3.763 and flicker
  to 1.066 at 452.9 KiB. At 256 colors the two errors fell to 2.915 and
  0.625 at 611.8 KiB.
- **Scene cut.** Going from 32 to 64 colors lowered cut flicker from 5.157 to
  0.377 with `high`, and from 3.476 to 0.354 with `fast`. At 128 and 256 colors,
  `fast` had greater cut flicker than at 64. With `high`/256, all 57,376
  unchanged source pixels had stable decoded colors across the cut.
- **Bayer control.** On the moving gradient at `high`/64, Bayer reduced local-tone
  error by 34%, increased flicker from 1.740 to 2.024 and made the GIF 2.47× as
  large. Undithered `high`/256 had lower RGB error, local-tone error and flicker
  and produced 611.8 KiB versus 804.8 KiB with `high`/64 and Bayer.

The tables give one quality/size result per setting because sync and Worker
produced the same GIF bytes. Times are median milliseconds with minimum and
maximum in brackets. All eight timed samples enter the median and remain in the
raw report. Some gradient samples were substantially slower than the median.

### Flat graphics with text

| Colors | Quality | RGB RMSE | 8×8 RMSE | Flicker | Exact pixels % | KiB | Sync ms | Worker ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | high | 0.867 | 0.782 | 0.000 | 87.06 | 210.0 | 389 [375–406] | 559 [522–681] |
| 32 | fast | 3.273 | 3.105 | 0.000 | 26.38 | 184.0 | 388 [374–408] | 530 [517–618] |
| 64 | high | 0.453 | 0.400 | 0.000 | 98.54 | 223.1 | 401 [384–478] | 562 [525–836] |
| 64 | fast | 3.237 | 3.074 | 0.000 | 29.53 | 193.5 | 382 [363–437] | 541 [504–555] |
| 128 | high | 0.453 | 0.400 | 0.000 | 98.54 | 223.1 | 384 [376–466] | 562 [535–648] |
| 128 | fast | 3.237 | 3.074 | 0.000 | 29.53 | 193.5 | 382 [369–403] | 525 [507–590] |
| 256 | high | 0.453 | 0.400 | 0.000 | 98.54 | 223.1 | 403 [372–500] | 535 [499–629] |
| 256 | fast | 3.237 | 3.074 | 0.000 | 29.53 | 193.5 | 384 [372–402] | 538 [506–789] |

### Moving gradient

| Colors | Quality | RGB RMSE | 8×8 RMSE | Flicker | Exact pixels % | KiB | Sync ms | Worker ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | high | 8.562 | 7.547 | 3.028 | 18.90 | 231.0 | 1,007 [973–1,716] | 1,206 [1,043–2,217] |
| 32 | fast | 9.833 | 8.956 | 2.259 | 19.03 | 228.8 | 397 [387–1,141] | 554 [523–1,668] |
| 64 | high | 6.072 | 5.169 | 1.740 | 22.35 | 326.2 | 1,067 [984–1,190] | 1,205 [1,174–2,007] |
| 64 | fast | 8.297 | 7.528 | 1.396 | 23.34 | 316.5 | 409 [387–801] | 545 [534–1,467] |
| 128 | high | 4.641 | 3.763 | 1.066 | 23.81 | 452.9 | 1,057 [1,011–1,783] | 1,242 [1,195–3,017] |
| 128 | fast | 7.240 | 6.482 | 1.062 | 24.87 | 405.4 | 433 [398–977] | 568 [528–1,653] |
| 256 | high | 3.697 | 2.915 | 0.625 | 27.26 | 611.8 | 1,088 [1,055–1,250] | 1,272 [1,227–2,280] |
| 256 | fast | 6.925 | 6.139 | 0.835 | 23.76 | 452.6 | 411 [374–1,231] | 569 [535–1,298] |
| 64 | high + Bayer | 6.638 | 3.412 | 2.024 | 22.37 | 804.8 | 1,158 [1,094–1,212] | 1,351 [1,315–1,456] |

### Scene cut

| Colors | Quality | RGB RMSE | 8×8 RMSE | Flicker | Cut flicker | KiB | Sync ms | Worker ms |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | high | 5.746 | 5.053 | 1.363 | 5.157 | 228.5 | 623 [602–647] | 816 [760–910] |
| 32 | fast | 6.790 | 6.185 | 1.250 | 3.476 | 221.0 | 402 [375–431] | 540 [521–900] |
| 64 | high | 4.156 | 3.521 | 0.906 | 0.377 | 284.2 | 686 [641–780] | 870 [798–1,172] |
| 64 | fast | 5.734 | 5.174 | 0.821 | 0.354 | 270.3 | 400 [381–581] | 536 [512–760] |
| 128 | high | 3.252 | 2.642 | 0.610 | 0.321 | 349.0 | 688 [662–906] | 874 [826–1,281] |
| 128 | fast | 5.249 | 4.687 | 0.658 | 1.140 | 313.6 | 396 [380–449] | 548 [528–616] |
| 256 | high | 2.610 | 2.052 | 0.390 | 0.000 | 429.0 | 717 [680–830] | 882 [839–1,164] |
| 256 | fast | 5.100 | 4.537 | 0.515 | 0.562 | 332.7 | 387 [382–520] | 556 [502–1,119] |

## Method

The full profile uses 24 opaque 640×360 RGBA frames per scene. The first 23
frames last 80 ms each and the final frame lasts 560 ms, for a 2.4 s timeline.
Input RGBA hashes identify the exact frames used for every setting.

- **Flat graphics with text.** A bar chart with moving bars and indicators,
  solid accent colors, a persistent title and a changing two-digit counter.
  Fixed bitmap glyphs make the source independent of the platform font renderer.
- **Moving gradient.** A shifting gray ramp and color gradient with a stationary
  lower strip, title and footer. The stationary regions provide pixels to measure
  temporal color error as the rest of the frame changes.
- **Scene cut.** Twelve frames of a warm-color chart followed by twelve frames of
  the cooler gradient. The title, dark bars and footer carry across the cut.

The main matrix crosses `maxColors` 32/64/128/256 with `quality` `high` (RGB565)
and `fast` (RGB444) while using `dither: 'none'`. The moving gradient also uses
a Bayer control at `high`/64. Each setting gets one warm-up and eight timed
exports per adapter, for **400 timed exports** across both adapters and the
control. The main setting order rotates every round. The two adapters alternate
which runs first. The Bayer control alternates between the start and end of
its scene's rounds. The raw report records the full order.

Timing starts at exporter creation and stops when the GIF Blob is ready. It
includes snapshot preparation and, for the Worker adapter, creation of a fresh
Node module Worker and frame transfers. Source pixels are generated before
the timed interval. Blob byte extraction, Worker exit confirmation, decoding,
and file writes run afterward. These timings describe the Node benchmark,
including its Worker transport.

Both adapters use the same rendered input. Every timed output must match the
warm-up SHA-256, and sync and Worker must match byte for byte. The runner checks
that each Worker terminates once and has exited before the next export, and that
source RGBA remains intact. The independent gifuct-js 2.1.2 decoder verifies the
frame dimensions, opacity, frame count and delays and supplies the RGB pixels
used for quality metrics.

- **RGB RMSE** averages squared channel error over all source pixels and frames.
  **8×8 RMSE** measures error after taking the signed mean of each channel
  inside each 8×8 tile, so it captures local tones. **Exact pixels** counts RGB
  triplets that match the original.
- **Flicker** is the mean absolute per-channel change between adjacent decoded
  frames on pixel pairs whose source RGB stayed identical. **Cut flicker** is
  the same calculation just across the scene transition. The raw report records
  the qualifying pixel counts. Frame comparisons cover the encoded sequence
  from start to finish, with equal weight per frame or qualifying pixel pair.
  Error and flicker are in eight-bit channel units, and lower values are better.

## Reproduce

```sh
npm run build
node scripts/benchmark-gif-palette.mjs
```

Add `--quick` for one repetition at 160×96 with four frames. The runner saves
raw JSON, 25 GIFs and contact sheets under `benchmark-results/gif-palette/`.
Each main contact sheet shows source, `high`/64 and `fast`/64 from left to right.
The cut sheet has a row immediately before and immediately after the transition.
The Bayer sheet shows source and `high`/64 on top, then `high`/64 with Bayer and
`high`/256 on the bottom.
