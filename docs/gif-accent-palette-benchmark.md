# Exact accent colors in a sampled GIF palette

Measured on 2026-11-22 with CanvasTake 0.10.0 (`b58bdf7`), Node 22.17.0, Windows
10.0.19045 and an AMD FX-8350. [Raw measurements, per-color metrics and palettes](gif-accent-palette-benchmark-results.json)

## Results

- **Scene cut, 64 colors.** Exact accent pixels increased from 7.48% with
  unconstrained sampling to 77.93% with reserved slots and 100% with exact
  mapping. Accent flicker was 0.000 / 0.511 / 0.000. The sampled colors were
  stable across frames even when their RGB was wrong. RGB error on other pixels
  was 5.797 / 5.954 / 5.954. Size was 231.5 / 231.6 / 231.6 KiB. Median total
  time was 543 / 556 / 698 ms.
- **Moving gradient.** At 256 colors the three lanes reproduced 7.59%,
  42.38% and 100% of accent pixels exactly. Exact mapping removed the
  0.579 accent flicker measured with reservation alone. At 64 colors
  reservation already reached 100% and the exact pass produced the same
  GIF bytes.
- **Flat graphics.** The sampled palette already reproduced all specified
  accent pixels exactly at every cap. Reservation and the exact pass
  produced the same decoded quality and size in this fixture.
- **RGB565 collision.** With both colors present in the global palette,
  normal mapping matched two of three accent pixels exactly. Its unchanged
  accent pixel changed by 1.333 channel units between frames. The exact pass
  matched all three, eliminated that change, and left both nonaccent error
  measurements at zero. In the full matrix, reservation alone missed at
  least one accent pixel in four scene-and-cap combinations.

The exact pass added a median paired encode cost of 223 ms on flat graphics,
273 ms on the gradient and 157 ms on the cut at 64 colors. The study pairs
each exact run with the reserved run from the same round. The prep algorithms
of these two modes are identical. In the flat and gradient tests, prep and
export time samples showed wide ranges. At 64 colors on the cut, total time
ranged from 535 to 566 ms sampled, 513 to 574 ms reserved, and 650 to 772 ms
with exact mapping. The raw report retains all samples.

### Quality

Each triple is **sampled / reserved / exact**. Accent exactness is a percentage.
The errors and flicker are in eight-bit RGB channel units.

| Scene | Colors | Exact accents % | Accent RGB RMSE | Accent flicker | Other RGB RMSE | 8×8 RMSE | Whole-image flicker |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| Flat | 32 | 100.00 / 100.00 / 100.00 | 0.000 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 1.969 / 1.969 / 1.969 | 1.101 / 1.101 / 1.101 | 0.000 / 0.000 / 0.000 |
| Flat | 64 | 100.00 / 100.00 / 100.00 | 0.000 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 1.879 / 1.879 / 1.879 | 0.982 / 0.982 / 0.982 | 0.000 / 0.000 / 0.000 |
| Flat | 128 | 100.00 / 100.00 / 100.00 | 0.000 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 1.879 / 1.879 / 1.879 | 0.982 / 0.982 / 0.982 | 0.000 / 0.000 / 0.000 |
| Flat | 256 | 100.00 / 100.00 / 100.00 | 0.000 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 1.879 / 1.879 / 1.879 | 0.982 / 0.982 / 0.982 | 0.000 / 0.000 / 0.000 |
| Gradient | 32 | 0.00 / 100.00 / 100.00 | 10.226 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 11.792 / 12.327 / 12.327 | 10.791 / 11.252 / 11.252 | 0.083 / 0.068 / 0.068 |
| Gradient | 64 | 0.00 / 100.00 / 100.00 | 9.142 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 8.244 / 8.592 / 8.592 | 7.327 / 7.577 / 7.577 | 0.090 / 0.084 / 0.084 |
| Gradient | 128 | 7.59 / 100.00 / 100.00 | 4.044 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 6.501 / 6.429 / 6.429 | 5.535 / 5.432 / 5.432 | 0.135 / 0.130 / 0.130 |
| Gradient | 256 | 7.59 / 42.38 / 100.00 | 2.812 / 4.900 / 0.000 | 0.000 / 0.579 / 0.000 | 5.211 / 5.183 / 5.183 | 4.307 / 4.299 / 4.252 | 0.169 / 0.203 / 0.168 |
| Cut | 32 | 0.00 / 100.00 / 100.00 | 10.423 / 0.000 / 0.000 | 0.000 / 0.000 / 0.000 | 8.986 / 9.621 / 9.621 | 8.232 / 8.780 / 8.780 | 0.071 / 0.070 / 0.070 |
| Cut | 64 | 7.48 / 77.93 / 100.00 | 5.806 / 2.726 / 0.000 | 0.000 / 0.511 / 0.000 | 5.797 / 5.954 / 5.954 | 5.104 / 5.228 / 5.214 | 0.085 / 0.101 / 0.078 |
| Cut | 128 | 7.48 / 93.69 / 100.00 | 2.629 / 0.598 / 0.000 | 0.000 / 0.114 / 0.000 | 4.404 / 4.412 / 4.412 | 3.728 / 3.724 / 3.724 | 0.105 / 0.101 / 0.096 |
| Cut | 256 | 24.34 / 68.48 / 100.00 | 1.004 / 1.862 / 0.000 | 0.000 / 0.511 / 0.000 | 3.381 / 3.389 / 3.389 | 2.749 / 2.764 / 2.754 | 0.117 / 0.142 / 0.120 |

### Size and time

Each triple uses the same mode order. Times are medians in milliseconds.

| Scene | Colors | KiB | Prep ms | Export ms | Total ms |
| --- | ---: | --- | --- | --- | --- |
| Flat | 32 | 210.2 / 210.2 / 210.2 | 173 / 176 / 163 | 489 / 421 / 643 | 662 / 604 / 806 |
| Flat | 64 | 218.4 / 218.4 / 218.4 | 176 / 148 / 150 | 422 / 402 / 620 | 674 / 549 / 753 |
| Flat | 128 | 218.4 / 218.4 / 218.4 | 185 / 149 / 164 | 489 / 487 / 623 | 672 / 645 / 778 |
| Flat | 256 | 218.4 / 218.4 / 218.4 | 176 / 277 / 392 | 637 / 662 / 1224 | 876 / 1022 / 1605 |
| Gradient | 32 | 191.2 / 187.8 / 187.8 | 256 / 245 / 263 | 404 / 387 / 688 | 657 / 631 / 941 |
| Gradient | 64 | 256.0 / 257.0 / 257.0 | 255 / 269 / 247 | 470 / 445 / 734 | 718 / 709 / 981 |
| Gradient | 128 | 332.5 / 334.3 / 334.3 | 261 / 252 / 263 | 565 / 470 / 749 | 827 / 716 / 1020 |
| Gradient | 256 | 448.8 / 444.9 / 444.9 | 243 / 244 / 247 | 712 / 667 / 759 | 955 / 908 / 992 |
| Cut | 32 | 178.2 / 177.1 / 177.1 | 151 / 169 / 163 | 385 / 384 / 481 | 536 / 548 / 652 |
| Cut | 64 | 231.5 / 231.6 / 231.6 | 160 / 168 / 161 | 385 / 384 / 526 | 543 / 556 / 698 |
| Cut | 128 | 288.6 / 286.4 / 286.4 | 160 / 164 / 168 | 391 / 410 / 577 | 556 / 581 / 749 |
| Cut | 256 | 362.4 / 363.0 / 363.0 | 160 / 162 / 164 | 444 / 476 / 590 | 612 / 636 / 765 |

## Method

The study reuses the flat chart with text, moving gradient, and scene-cut clip
from the [sampled palette study](gif-sampled-palette-benchmark.md). Each full
clip has 24 opaque 640×360 frames with a 2.4 s timeline including its final hold.
All modes copy the same 64×64 pixel grid from frame indices 0, 8, 15 and 23.
They use RGB565 and the same full-frame gifenc writer, with dithering off.

The four specified RGB accents come from the scene artwork. The title is
`#F2F5F9`, the counter is `#62D4B9`, the footer line is `#ADC2D7`, and the
highlight is `#F9DA70`. Every mode configured with accents gets the same list,
including on the moving gradient where the highlight is absent from the source.

- **Sampled** uses the existing unconstrained sampled palette at the given cap.
- **Reserved** allocates four slots for the specified RGB colors. The Worker
  removes matching pixels from the compact sample, quantizes the rest with
  the reduced cap, drops representatives that duplicate a specified color
  and appends the specified RGB entries. The normal gifenc mapper assigns
  indices using its per-frame RGB565 cache.
- **Exact** uses the byte-identical reserved palette. It applies the same
  RGB565 mapping and then overrides indices at pixels whose full RGB matches
  a specified accent. The override preserves the mapping of all other pixels
  relative to the reserved mode.

The cap is 32, 64, 128 or 256 colors in every mode. A source can yield fewer
colors than the cap. The raw report stores actual palette entries as successive
six-digit RGB triples, the entry count, the padded global table size, and the
number of source samples remaining after removing reserved RGBs. The decoder
checks the palette and the use of one global table per animation.

Each lane receives one warm-up and six timed exports at each cap and scene.
The cap order rotates and the six permutations of mode order appear once
per clip. There are **216 timing samples and 36 GIF cases**. The source frames
are pre-rendered. Preparation includes sampling, Worker startup and shutdown,
and quantization. Export includes mapping and writing through the finalized
Blob. Total time covers both. The exact-lookup setup and scan are included
in the exact mode's export time. Decoding, byte extraction and file writes
occur outside the timer.

The runner verifies repeated output hashes and matches baseline GIFs against
the previous sampled study. gifuct-js 2.1.2 independently decodes every
case and checks dimensions, frame count, delays and opacity. Accent exactness
and RGB error cover pixels whose **source** RGB is in the specified list.
The raw data includes the metrics per color, RGB error on all remaining pixels,
whole-image 8×8 local-tone error and whole-image flicker. Flicker uses adjacent
frames at positions where source RGB stayed identical. Accent flicker uses
the subset of those positions with specified source RGB.

A separate two-frame 8×8 fixture pairs `#F0F4F8` with `#F2F5F9`, both in the
same RGB565 bucket and both in the same fixed palette. It varies which color
the mapper encounters first and keeps a second title-colored pixel fixed.
The fixture isolates exact-index selection from quantization.

## Reproduce

```sh
npm run build
node scripts/benchmark-gif-accent-palette.mjs
```

Add `--quick` for one repetition at 160×96 with four frames. The runner writes
JSON, 36 GIFs and contact sheets under `benchmark-results/gif-accent-palette/`.
The sheets show source, sampled, reserved and exact output at 64 colors. The
cut sheet shows frames immediately before and after the transition.
