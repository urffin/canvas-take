# GIF dithering benchmark

Measured on 2026-11-21 against CanvasTake 0.9.0 (`5a2c95e`), using Node 22.17.0 on Windows
10.0.19045 and an AMD FX-8350. [Recorded measurements](gif-dithering-benchmark-results.json)

## What changed the result

- **Flat graphics.** The 27-color scene was reproduced exactly at the 64- and 256-color
  limits. All three methods produced the same GIF bytes in both cases. Bayer and
  Floyd–Steinberg still added 27–31% and 125–134% to export time, respectively.
  At 16 colors both brought the average tones closer to the source by adding visible
  texture to solid tiles. Moving from 16 to 64 colors without dithering restored exact
  colors and produced a smaller file than dithering at 16 colors.
- **Gradients.** At 64 colors, Bayer reduced local-tone error by 40% for a 2.63×
  larger file and 1.23× export time. Floyd–Steinberg reduced it by 73% for a 4.23×
  larger file and 2.59× export time. The decoded middle frame shows Bayer's regular
  texture and smoother bands with Floyd–Steinberg. Floyd–Steinberg also produced
  more frame-to-frame color variation on pixels that stayed constant in the source.
- **Palette size versus dithering.** On this gradient, 256 colors without dithering
  beat 64 colors with Bayer on local-tone error, file size and median time. At the
  256-color limit, Bayer reduced local-tone error by another 39%, and
  Floyd–Steinberg by 85%, compared with the undithered 256-color export. Their files
  were 1.76× and 3.17× larger, respectively.

These results favor the current default for flat art and a larger palette before adding
dither to gradients. Bayer is the lower-cost candidate of the two measured prototypes
when the palette limit is fixed and smooth tones matter. Floyd–Steinberg is suited to
cases that can trade more bytes, CPU time and temporal stability for smoother tones.

## Measurements

Times are median with minimum–maximum in brackets, in milliseconds. Size is KiB.
The error columns use eight-bit RGB units. Lower is better for both errors and for
static-pixel delta.

| Scene | Color limit | Mapping | Time [range], ms | Size, KiB | RGB RMSE | 8×8 RMSE | Exact pixels, % | Static-pixel delta |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Flat | 16 | None | 238.4 [227.1–262.4] | 168.1 | 9.730 | 9.479 | 53.88 | 0.000 |
| Flat | 16 | Bayer | 332.7 [322.3–367.1] | 262.3 | 13.935 | 6.130 | 53.88 | 0.000 |
| Flat | 16 | Floyd–Steinberg | 693.9 [677.0–855.3] | 587.5 | 16.764 | 4.839 | 53.70 | 0.000 |
| Flat | 64 | None | 262.6 [247.0–296.1] | 194.1 | 0.000 | 0.000 | 100.00 | 0.000 |
| Flat | 64 | Bayer | 344.0 [328.1–370.3] | 194.1 | 0.000 | 0.000 | 100.00 | 0.000 |
| Flat | 64 | Floyd–Steinberg | 591.1 [576.0–676.2] | 194.1 | 0.000 | 0.000 | 100.00 | 0.000 |
| Flat | 256 | None | 249.8 [238.0–300.1] | 194.1 | 0.000 | 0.000 | 100.00 | 0.000 |
| Flat | 256 | Bayer | 316.1 [304.9–386.3] | 194.1 | 0.000 | 0.000 | 100.00 | 0.000 |
| Flat | 256 | Floyd–Steinberg | 585.1 [576.7–610.0] | 194.1 | 0.000 | 0.000 | 100.00 | 0.000 |
| Gradient | 16 | None | 322.4 [317.6–342.7] | 168.8 | 10.427 | 9.827 | 0.83 | 3.246 |
| Gradient | 16 | Bayer | 442.5 [429.7–470.5] | 546.0 | 12.183 | 6.426 | 0.83 | 4.110 |
| Gradient | 16 | Floyd–Steinberg | 832.1 [805.9–935.3] | 1087.9 | 17.027 | 5.101 | 0.83 | 11.875 |
| Gradient | 64 | None | 366.1 [334.9–440.0] | 359.3 | 5.204 | 4.592 | 2.68 | 0.493 |
| Gradient | 64 | Bayer | 451.3 [433.8–593.8] | 944.4 | 5.336 | 2.775 | 3.34 | 0.612 |
| Gradient | 64 | Floyd–Steinberg | 947.4 [902.5–1039.1] | 1519.6 | 7.413 | 1.227 | 3.32 | 3.696 |
| Gradient | 256 | None | 366.0 [359.1–401.0] | 662.5 | 3.005 | 2.432 | 6.04 | 0.070 |
| Gradient | 256 | Bayer | 502.0 [459.5–626.5] | 1163.3 | 2.616 | 1.493 | 6.22 | 0.069 |
| Gradient | 256 | Floyd–Steinberg | 988.7 [947.7–1074.4] | 2098.6 | 3.409 | 0.358 | 6.12 | 1.075 |

## Method

The inputs are two deterministic opaque RGBA animations at 640×360. Flat graphics
use a grid of solid tiles, two backgrounds and a moving marker. The gradient
combines a gray ramp and a two-dimensional RGB ramp with the same marker. Each has
24 frames, 80 ms per frame and 560 ms for the last frame, for a 2.4 s loop.
Each case has one warm-up and six timed exports, using all six permutations of method order.

All variants use gifenc 1.0.3 for per-frame palette generation in `rgb565` mode and
for writing the GIF. The control uses gifenc's `applyPalette`. Bayer 4×4 selects
between the two nearest palette entries using the projection onto their color segment
and a fixed screen-aligned threshold matrix. Floyd–Steinberg diffuses RGB error with
7/16, 3/16, 5/16 and 1/16 weights in alternating scan directions. The prototypes use
gifenc's RGB bucket key to cache palette lookups within each frame. Timing covers
quantization, mapping and the GIF writer from creation to finalized bytes. Source
rasterization, browser canvas readback, Worker transport, decoding and file writes
are outside this interval. [FFmpeg palette-use implementation for algorithm context](https://www.ffmpeg.org/doxygen/8.0/vf__paletteuse_8c_source.html)

The runner asserts that the control matches the built CanvasTake adapter byte for byte,
each method is deterministic across repeats, and each set of three methods has identical
decoded palettes. gifuct-js 2.1.2 independently decodes every result and checks dimensions,
frame count, opacity and delays. RGB RMSE compares individual channels. The 8×8 metric
averages channels inside each non-overlapping tile before comparing them, so adjacent
errors can cancel and show the quality of local tones. Exactness counts pixels whose
three RGB values match. Static-pixel delta averages the absolute channel change in
decoded pixels whose RGB values stayed the same between two input frames. Metrics
weight each decoded frame equally. The two fixtures and timings describe this benchmark
and these JavaScript prototypes.

## Reproduce and inspect

```sh
npm run build
node scripts/benchmark-gif-dithering.mjs
```

Add `--quick` for the smoke profile. A full run writes a timestamped directory under
`benchmark-results/gif-dithering/` with all 18 GIFs, raw timings and contact sheets
for 16 and 64 colors. In each sheet the top row is source and undithered output.
The bottom row is Bayer and Floyd–Steinberg. The saved JSON includes exact byte counts,
output and palette hashes, frame metrics, and the breakdown of quantization, indexing
and GIF writing time.
