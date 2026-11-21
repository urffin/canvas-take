# Shared versus per-frame GIF palettes

Measured on 2026-11-21 with CanvasTake 0.10.0 (`b94ee27`), Node 22.17.0, Windows
10.0.19045 and an AMD FX-8350. [Raw measurements and palette RGB entries](gif-shared-palette-benchmark-results.json)

## Results

- **Flat graphics with text.** Both modes measured zero flicker at every limit.
  At 64 colors the shared preset reduced the file from 223.1 to 145.0 KiB
  and reduced the exact-pixel share from 98.54% to 0.29%. Median export time
  changed from 403 to 372 ms with overlapping sample ranges.
- **Moving gradient.** At 64 colors the shared preset reduced flicker from
  1.740 to 0.134, median export time from 1,059 to 406 ms and file size from
  326.2 to 267.6 KiB. Local-tone error rose from 5.169 to 10.293.
  Color tables account for 4.31 KiB of the 58.6 KiB reduction. The remainder
  came from GIF image data as the indexed pixels changed.
- **Scene cut.** At 64 colors the decoded color change on the 57,376 unchanged
  source pixels at the transition fell from 0.377 to zero. Over the whole clip,
  flicker fell from 0.906 to 0.084 and local-tone error rose from 3.521 to 5.315.
  The shared preset already reached zero cut flicker at 32 colors. Both modes
  reached zero at 256 colors.

The shared presets covered all three scene families. They traded higher color
error for temporal stability in the moving scenes. A palette tailored to one
animation can have a different trade-off.

Tables show **per-frame → shared**. Times are median milliseconds with minimum
and maximum in brackets. Every sample contributes to the median and appears
in the raw report.

### Flat graphics with text

| Limit | RGB RMSE | 8×8 RMSE | Flicker | Exact pixels % | Size KiB | Color tables KiB | Export ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 0.867 → 7.476 | 0.782 → 6.830 | 0.000 → 0.000 | 87.06 → 0.00 | 210.0 → 134.3 | 2.25 → 0.09 | 396 [380–452] → 372 [365–393] |
| 64 | 0.453 → 5.972 | 0.400 → 5.557 | 0.000 → 0.000 | 98.54 → 0.29 | 223.1 → 145.0 | 4.50 → 0.19 | 403 [377–432] → 372 [368–395] |
| 128 | 0.453 → 2.849 | 0.400 → 2.600 | 0.000 → 0.000 | 98.54 → 38.71 | 223.1 → 172.9 | 4.50 → 0.38 | 395 [380–453] → 386 [371–391] |
| 256 | 0.453 → 1.328 | 0.400 → 1.203 | 0.000 → 0.000 | 98.54 → 80.13 | 223.1 → 192.7 | 4.50 → 0.75 | 398 [372–504] → 375 [369–398] |

### Moving gradient

| Limit | RGB RMSE | 8×8 RMSE | Flicker | Size KiB | Color tables KiB | Export ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 8.562 → 13.528 | 7.547 → 12.656 | 3.028 → 0.126 | 231.0 → 205.1 | 2.25 → 0.09 | 1,036 [1,008–1,585] → 388 [375–535] |
| 64 | 6.072 → 11.110 | 5.169 → 10.293 | 1.740 → 0.134 | 326.2 → 267.6 | 4.50 → 0.19 | 1,059 [1,003–1,369] → 406 [374–436] |
| 128 | 4.641 → 9.520 | 3.763 → 8.827 | 1.066 → 0.173 | 452.9 → 367.3 | 9.00 → 0.38 | 1,069 [998–1,268] → 419 [380–592] |
| 256 | 3.697 → 8.524 | 2.915 → 7.928 | 0.625 → 0.194 | 611.8 → 469.2 | 18.00 → 0.75 | 1,115 [1,048–1,400] → 508 [429–955] |

### Scene cut

| Limit | RGB RMSE | 8×8 RMSE | Flicker | Cut flicker | Size KiB | Color tables KiB | Export ms |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 32 | 5.746 → 9.124 | 5.053 → 8.317 | 1.363 → 0.083 | 5.157 → 0.000 | 228.5 → 179.1 | 2.25 → 0.09 | 804 [621–1,216] → 438 [385–494] |
| 64 | 4.156 → 6.061 | 3.521 → 5.315 | 0.906 → 0.084 | 0.377 → 0.000 | 284.2 → 225.8 | 4.50 → 0.19 | 813 [644–1,233] → 411 [375–711] |
| 128 | 3.252 → 4.372 | 2.642 → 3.744 | 0.610 → 0.110 | 0.321 → 0.000 | 349.0 → 286.7 | 6.75 → 0.38 | 810 [681–1,226] → 523 [392–674] |
| 256 | 2.610 → 3.284 | 2.052 → 2.705 | 0.390 → 0.128 | 0.000 → 0.000 | 429.0 → 355.2 | 11.25 → 0.75 | 853 [790–980] → 560 [457–1,058] |

## Method

The full profile reuses all 24 opaque 640×360 frames and the 2.4 s timeline of
each scene from the [palette-size benchmark](gif-palette-benchmark.md). The
moving-gradient scene includes a stationary strip. The cut changes from a warm
chart to the gradient while retaining some text and interface pixels.

The study uses one fixed palette at each of the 32, 64, 128 and 256 color limits.
All three measured clips use the same fixed palette for a given limit. The runner
prepares the fixtures from separate 320×180 renders of the same three scene
families. It samples zero-based indices 1, 4, 8 and 11 of each 12-frame calibration render
with a staggered four-pixel stride in both axes. The combined 43,200 pixels
contribute equally by scene. gifenc quantizes this sample in RGB565. The raw report
records every RGB triple and a hash for each preset. The measured 640×360 source
frames never enter this preparation step.

Both lanes run synchronously through `createGifExporter` and use the same
gifenc 1.0.3 build, RGB565 index mapper, full-frame GIF writer and writer settings.
The benchmark supplies private encoder factories. The per-frame factory quantizes
each frame and writes the first palette as the GIF global color table and subsequent
palettes as local tables. The shared-palette factory uses the predetermined RGB
entries and writes them once as the global table. Both lanes use `dither: 'none'`.
The runner asserts that the per-frame files match the shipped adapter byte for byte
in both profiles and match the earlier matrix hashes at full resolution.

Each lane gets one warm-up and eight timed exports per scene and limit, for
**192 timed exports**. The runner rotates the order of the four limits and
alternates which lane runs first in each pair. The timer starts at exporter
creation with the shared palette already available and stops when the Blob is
ready. It includes frame snapshots, palette mapping, writing and per-frame
quantization where applicable. Source rendering, calibration, Blob byte
extraction, decoding and file writes occur outside the timer.

The runner checks each timed GIF hash and confirms that source RGBA stays intact. The
independent gifuct-js 2.1.2 decoder checks the dimensions, opacity, frame count
and delays. Parsed GIF structure confirms the table count, entries and loop
extension. Color-table bytes count the stored RGB entries including any padding
and are included in total file size. GIF image data also changes when the palette
changes the pattern of color indices.

`RGB RMSE` is per-channel error over decoded pixels. `8×8 RMSE` measures local
tone after averaging signed channel errors in each block. Flicker is the mean
absolute channel change on adjacent-frame pixel pairs whose source RGB stayed
identical. Cut flicker covers only the transition pair. Lower values are better.
The existing gifenc mapper caches the first mapped color per RGB565 bucket in
each frame. As the input changes, pixels within the same bucket can therefore
map differently even with a fixed table. Every measure reflects these fixtures,
the chosen palette entries and the synchronous timing path.

## Reproduce

```sh
npm run build
node scripts/benchmark-gif-shared-palette.mjs
```

Add `--quick` for one repetition at 160×96 with four frames. The runner saves
raw JSON, 24 GIFs and three decoded contact sheets under
`benchmark-results/gif-shared-palette/`. The sheets show the source, per-frame
palette and shared palette at 64 colors. The cut sheet has one row on either
side of the transition.
