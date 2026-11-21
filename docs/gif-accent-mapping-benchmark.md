# Faster exact GIF accent mapping

Measured on 2026-11-22 with CanvasTake 0.10.0 (`908ce62`), Node 22.17.0, Windows
10.0.19045 and an AMD FX-8350. [Raw measurements](gif-accent-mapping-benchmark-results.json)

## Results

The blue filter reduced median mapping time by **19.3–29.5%** in all twelve
main cases. Only **2.84–4.08%** of pixels reached the full RGB lookup in
those clips. Median paired end-to-end encode time fell by **5.0–42.3%**
in eleven cases, with a **1.3% increase** for flat graphics at 32 colors.
Nine of the twelve paired ranges include a slowdown in at least one round.

In the shared-blue stress clip, every pixel reached the full lookup.
Median mapping time increased by **6.9%**. The median paired encode time
increased by **2.9%**, with runs showing both speedups and slowdowns.

All 13 reference and filtered GIFs matched byte for byte. The twelve main
cases also retained the exact hashes from the previous study. The
decoder found **100% exact accent pixels** and **zero accent flicker**
in every case. File sizes were identical.

| Scene | Colors | Full RGB lookups | Mapping ms, reference → filtered | Total encode ms, reference → filtered | Paired encode time saved |
| --- | ---: | ---: | ---: | ---: | ---: |
| Flat graphics | 32 | 2.84% | 196 [193–222] → 143 [135–181] | 400 [374–550] → 394 [377–662] | −1.3% [−61.9%, 27.1%] |
| Flat graphics | 64 | 2.84% | 199 [189–227] → 141 [136–162] | 431 [377–539] → 392 [378–429] | 6.4% [−0.1%, 28.8%] |
| Flat graphics | 128 | 2.84% | 195 [191–252] → 141 [133–235] | 410 [389–650] → 387 [373–549] | 5.0% [−34.5%, 35.6%] |
| Flat graphics | 256 | 2.84% | 194 [191–205] → 138 [134–146] | 405 [376–472] → 386 [376–388] | 5.2% [−1.7%, 17.8%] |
| Moving gradient | 32 | 4.08% | 213 [209–237] → 156 [148–174] | 493 [425–659] → 396 [387–433] | 18.2% [6.7%, 39.9%] |
| Moving gradient | 64 | 4.08% | 226 [215–278] → 172 [161–198] | 631 [506–736] → 434 [384–573] | 30.3% [22.2%, 40.3%] |
| Moving gradient | 128 | 4.08% | 284 [257–326] → 202 [186–243] | 759 [703–942] → 437 [402–807] | 42.3% [−9.4%, 57.3%] |
| Moving gradient | 256 | 4.08% | 336 [290–392] → 251 [236–268] | 776 [719–849] → 683 [599–747] | 13.3% [−3.9%, 29.4%] |
| Scene cut | 32 | 3.49% | 211 [200–420] → 154 [148–360] | 435 [394–1225] → 398 [376–1069] | 9.4% [−21.2%, 41.3%] |
| Scene cut | 64 | 3.49% | 221 [208–271] → 164 [157–341] | 538 [465–693] → 420 [387–752] | 21.0% [−8.5%, 31.0%] |
| Scene cut | 128 | 3.49% | 240 [229–309] → 188 [177–243] | 630 [562–744] → 510 [432–726] | 17.2% [2.1%, 31.5%] |
| Scene cut | 256 | 3.49% | 262 [243–363] → 211 [189–252] | 584 [547–808] → 566 [521–658] | 9.0% [−2.7%, 19.7%] |
| Shared-blue stress | 64 | 100.00% | 197 [192–308] → 211 [207–216] | 394 [378–716] → 427 [388–472] | −2.9% [−20.6%, 40.5%] |

Each timing cell shows the median and the observed minimum and maximum
across eight samples. The last column uses the percentage saved within
each paired round, with positive values indicating a faster export.
These measurements cover the synchronous Node benchmark with a prepared
palette and four accent colors.

The package build and all 39 GIF tests passed. The previous accent
benchmark's quick mode also reproduced its GIF hashes, palette bytes,
quality metrics and RGB565 collision result.

## Method

Both lanes first apply the existing gifenc RGB565 mapper. The reference then
looks up every 24-bit RGB value in the map of accent indices. The candidate
adds a 256-byte table of blue values present in the accents. A pixel with a
blue value in the table receives the same full RGB lookup as the reference.
Every exact RGB match necessarily has its blue value in the table. The other
RGB565 indices come from the same gifenc call in both lanes.

The full run reuses all 24 opaque 640×360 frames, the four named accent colors,
and the exact lane's actual palettes from the [previous study](gif-accent-palette-benchmark.md).
The main matrix covers flat graphics, a moving gradient and a scene cut at
32, 64, 128 and 256 colors. A separate 64-color stress clip reuses the scene-cut
fixture and replaces every blue byte with 249, the title accent's blue value.
Every pixel in that clip reaches the full RGB lookup.

There is one warm-up per case and lane followed by eight paired repetitions.
The runner rotates the color-limit order and alternates the first lane. There
are **208 timed exports** in the full matrix. Timing begins before mapper and
exporter creation and ends at the finalized Blob. Both paths use the same
synchronous writer, prepared palette and source pixels. The raw report tracks
total encode time and time spent inside the per-frame index mapper. Source
rendering, palette preparation, Blob byte extraction, independent decoding
and file writes run outside the timer.

Every warm-up compares complete byte arrays. Every timed output must
match the reference SHA-256. The twelve main cases also match the archived
exact-lane GIFs. The independent gifuct-js decoder checks palette structure,
frame count, dimensions, opacity and delays, along with exact accent RGB and
zero accent flicker. The runner reproduces the previous RGB565 collision GIF.
Direct index checks cover two accents sharing a blue value, a nearby
nonaccent color, alpha variation in the RGB mapper, an empty accent list,
and palette indices 0 and 255.

## Reproduce

```sh
npm run build
node scripts/benchmark-gif-accent-mapping.mjs
```

Add `--quick` for two repetitions at 160×96 with four frames. The runner
writes raw JSON and one byte-verified GIF for each case under
`benchmark-results/gif-accent-mapping/`.
