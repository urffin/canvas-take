# Optional Bayer dithering in the GIF adapters

Measured on 2026-11-21 with Node 22.17.0 on Windows 10.0.19045 and an AMD FX-8350.
The working tree implements the [Bayer design](drafts/gif-bayer-dithering.md) on top of
`0941341`. The package version is 0.9.0. [Raw measurements](gif-bayer-adapter-results.json)

## Quality, size and time

Each cell lists default → Bayer. Size is in KiB. Time is the median of eight
exports in milliseconds. Error is the 8×8 local-tone RMSE in eight-bit RGB units.
The synchronous and Worker adapters produced identical bytes for each setting,
so both share the same size and quality measurements.

| Scene | Colors | Local-tone error | Size, KiB | Sync, ms | Worker, ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flat | 16 | 9.479 → 6.130 | 168.1 → 262.3 | 428 → 724 | 575 → 887 |
| Flat | 64 | 0 → 0 | 194.1 → 194.1 | 424 → 532 | 571 → 660 |
| Flat | 256 | 0 → 0 | 194.1 → 194.1 | 429 → 570 | 570 → 689 |
| Gradient | 16 | 9.827 → 6.426 | 168.8 → 546.0 | 725 → 778 | 897 → 977 |
| Gradient | 64 | 4.592 → 2.775 | 359.3 → 944.4 | 751 → 888 | 988 → 1142 |
| Gradient | 256 | 2.432 → 1.490 | 662.5 → 1166.0 | 742 → 778 | 895 → 1028 |

- The 64-color gradient had 40% lower local-tone error, with a 2.63× file and
  18% / 16% longer median exports (sync / Worker). Per-pixel RGB RMSE rose
  from 5.204 to 5.336 as nearby pixels traded error to reproduce intermediate tones.
- The flat fixture was pixel-exact with a 64- or 256-color palette in both modes.
  At 16 colors Bayer reduced local-tone error by 35%, with a 56% larger file and
  higher per-pixel error. A 64-color palette reproduced this scene exactly at 194.1 KiB.
- The exact-color guard produced identical bytes to the earlier Bayer prototype in four
  cases. At 64 colors on the gradient it added 5 bytes. At 256 colors on the gradient
  it raised exact pixels from 6.225% to 6.277%, reduced local-tone error from
  1.493 to 1.490 and added 2,756 bytes (0.23%). The benchmark times the public
  adapters end to end and does not isolate the cost of the guard.

## Reproduce the comparison

```sh
npm run build
node scripts/benchmark-gif-dithering.mjs --adapters
```

Add `--quick` for a small smoke run. The full profile uses the same opaque flat scene
and gray/RGB gradient as the [prototype study](gif-dithering-benchmark.md).
Each input has 24 frames at 640×360 with a 2.4 s timeline including the final hold.
It runs 192 timed exports across four lanes with balanced ordering and one warm-up per
lane and case. All lanes use RGB565. The runner compares the default GIF with gifenc's
original mapping, checks every repeat by SHA-256, verifies sync/Worker byte parity and
decodes the palettes, frames and delays with gifuct-js. Quality metrics also record
per-pixel RGB error, exact-color share and variation between frames on unchanged pixels.

Timing starts at exporter creation and ends when the GIF Blob is ready. It includes
snapshot preparation, Worker startup and transfers where applicable. Raster generation,
browser readback, file I/O and decoding are outside the timing window. The Worker
lane runs the shipped module through Node worker_threads. Its timings describe these
fixtures and this process setup. The 64-color sync default had one 3.72 s sample,
retained in the raw results. The table uses medians throughout.

The runner saves GIFs and decoded contact sheets in `benchmark-results/gif-dithering-adapters/`.
The sheet shows the source and default output on top, and the supplied Bayer mode and
prototype below.

## Compatibility checks

- The Node suite passed 459 tests. The default matched the 0.9.0 codec path byte for
  byte across both quality presets and 16/64/256-color palettes. These checks cover
  mixed alpha, rounded delays, loop count and the final hold.
- Bayer matched byte for byte through synchronous, raw Worker and prepared Worker
  exports. Real Node Workers tested old runtime files, a new runtime paired with
  an old codec, and missing or invalid Bayer acknowledgements. In those cases the
  adapter rejected explicit Bayer before any frame transfer and closed the Worker.
  Cancellation, timeouts and snapshot collection were exercised in both modes.
- The isolated package check installed the tarball, compiled both public adapter option
  types and completed a Bayer GIF export with the installed synchronous adapter.
- All 10 worker tests passed in Chromium and Firefox in a serial run. Native workers
  reproduced the synchronous bytes, rejected an old runtime before frame transfer,
  terminated on abort and encoded a fresh GIF. The initial local parallel run timed
  out in page setup and teardown. The worker tests now use a standalone test page
  without the demo lifecycle handlers.
- A production Next.js 16.3.0 / Turbopack build consumed the local tarball. Chromium and
  Firefox each downloaded and independently decoded an 800×450 Bayer GIF with
  121 frames, 8,000 ms total duration and a 2,000 ms final hold. Each export closed its
  module Worker. The build used locally available dependencies after the standard
  fixture installation timed out.
- The set of deployable Worker files remains `gif-worker.js`, `gif-worker-runtime.js`
  and `gifenc.js`. The built controller stayed at 9,086 bytes. Gzipped sizes for the
  codec, Worker adapter and runtime grew by 591, 150 and 187 bytes, respectively.
