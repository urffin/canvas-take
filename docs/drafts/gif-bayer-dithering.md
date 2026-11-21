# Optional Bayer dithering for the GIF adapters

Design proposal against CanvasTake 0.9.0 and benchmark commit `2e6ecd3`. On the 64-color
gradient, the Bayer prototype reduced 8×8 local-tone error by 40%, with 2.63× the GIF size
and 1.23× the export time. The flat fixture was exact at 64 or 256 colors with all methods.
This trade-off favors offering Bayer as an explicit adapter choice.
[Benchmark and measurements](../gif-dithering-benchmark.md)

## Proposed adapter option

Add the same optional property to the synchronous and Worker factories in a later implementation.
`GifWorkerOptions` already extends `GifencOptions`, so the proposal needs one declaration.

```ts
// Proposed member of GifencOptions
readonly dither?: 'none' | 'bayer-4x4';
```

Omission and explicit `'none'` select the existing `applyPalette` path. Both factories
validate the option synchronously. An unrecognized value, including `null` at a JavaScript
boundary, throws `TypeError` before an encoder session or Worker is created. The caller
can combine either mode with the existing `maxColors` and `quality` options.
`GifOptions` and the controller's custom encoder contract retain their current scope.

## Shared palette mapping

Select the mapping function once per factory. Both supplied adapters use `createGifencEncoder`
for palette generation, mapping, LZW writing and finalization. Put the Bayer mapper in a private
module bundled into `gifenc.js`. The Worker entry and controller stay codec-free. The Worker
runtime keeps its existing relative import of `gifenc.js`.

1. Use the existing per-frame `quantize` call with the configured `maxColors` and format
   derived from `quality`. The mapper takes that palette and the full opaque frame after
   compositing. Its output is one palette index byte per pixel.
2. Keep exact RGB matches in the palette, using a per-palette lookup and the last index for
   duplicate entries. This also covers a source color whose RGB bucket contains other colors.
   The exact-color guard is a proposed refinement of the measured prototype and its cost
   belongs in the implementation benchmark.
3. Use the first non-exact pixel in each bucket to find the two closest palette entries by
   squared RGB distance. Resolve ties in the same order as gifenc. Reuse that pair within
   the frame using gifenc's bucket key for the selected RGB565 or RGB444 format. At each
   pixel, project the RGB difference from the first color onto the color segment. Choose the
   second color when the projection exceeds the squared segment length multiplied by
   `(matrix[y % 4][x % 4] + 0.5) / 16`. Anchor the matrix at the upper-left corner of every
   frame. A one-entry palette emits that index for every pixel.
   [Measured Bayer mapper and matrix](../../benchmarks/gif-dithering.mjs)
4. Give gifenc the original palette and selected indices. Frame delays, the final hold,
   looping and the GIF writer configuration use their existing paths.

The mapper reads RGBA and writes its index buffer. Palette lookups and cached pairs live for one
frame. The lookup is bounded by the palette and the RGB bucket space, and the index buffer has
the same size as the current indexed frame. The raw Worker route uses the usual owned RGBA
buffer and one handoff. The prepared `frame` route passes its already composited RGBA through
the same mapper. Standalone synchronous work stays interruptible between encoder operations,
and Worker work can be terminated through the existing abort or disposal path. The current Worker
request timeout covers the additional mapping work.

## Worker initialization and mixed assets

The default request remains `init({ repeat, maxColors, quality })` with its existing
reply. Explicit Bayer adds exactly one request property and expects exactly the selected mode in
the reply. This uses the existing init round trip.

```js
// init value for explicit Bayer
{ repeat, maxColors, quality, dither: 'bayer-4x4' }
// init reply from a Worker that selected Bayer and supports raw preparation
{ id, rawPreparationVersion: 1, activeDither: 'bayer-4x4' }
```

The runtime and `gifenc.js` are separate deployable files. On Bayer init, the runtime creates
the encoder through the existing factory import, then checks that the actual encoder instance
advertises its selected mapper. Use a private, non-enumerable own marker keyed by a versioned
`Symbol.for`, in the same style as raw preparation. Set the marker only on a Bayer encoder
after selecting its mapper. The runtime confirms `activeDither` only after this check. A new
runtime loading an old `gifenc.js` can still import the existing factory and run default
exports. For explicit Bayer it disposes the tentative encoder and returns the existing
terminal init error reply with a message identifying the unsupported mode.

The adapter checks `activeDither` on the reply to its own pending init request. If the
Worker returns a successful reply with the field missing or with another value, the adapter
closes the Worker and rejects initialization with `NotSupportedError`. Existing Worker
errors and timeouts retain their existing handling. Init must settle successfully before
`frame`, `raw-frame-v1` or `finish` is sent. The existing `close` path removes
listeners, clears timers, terminates the Worker and rejects pending requests.

Raw preparation remains a separate negotiation. A confirmed Bayer mode with an absent or
unknown raw preparation marker uses the prepared `frame` route. A Bayer request with a
missing or invalid `activeDither` fails before either route can transfer a frame.
[Existing raw preparation protocol](../gif-worker-preparation.md)

| Adapter / runtime / codec | Request | Expected outcome |
| --- | --- | --- |
| Current or updated adapter with an older runtime and compatible codec | Omitted or explicit none on the updated adapter | The existing init shape works. The prepared-frame fallback remains available. |
| Older adapter with updated runtime and either codec generation | Omitted | Default export works. Its raw or prepared-frame route follows the existing negotiation. |
| Updated adapter and runtime with older `gifenc.js` | Omitted or none | Default export works through the existing factory import. |
| Updated adapter with older runtime | Bayer | Missing acknowledgement or existing init error terminates the session before a frame transfer. |
| Updated adapter and runtime with older `gifenc.js` | Bayer | Runtime rejects init after checking the actual encoder. |
| Updated supplied adapter, runtime and codec | Bayer | Init confirms Bayer. Both frame routes use the same mapping. |
| Updated adapter with a custom runtime | Bayer | Exact mode acknowledgement allows export. A custom runtime can independently support either frame route. |

## Verification for implementation

- **Default compatibility.** Compare omitted and explicit `'none'` byte for byte with the
  0.9.0 adapter and runtime. Cover both quality presets, small and large palettes, composited
  alpha, repeats, rounded delays and the final hold. Check exact default init and reply
  shapes alongside the existing legacy Worker fixtures. Verify invalid values throw at
  factory creation before allocating a Worker or encoder session.
- **Bayer correctness.** Cover exact colors that share RGB buckets, a one-entry palette,
  16/64/256-color palettes, and dimensions that end partway through a Bayer tile.
  Run RGB444 and RGB565. Compare synchronous, Worker raw and Worker prepared output
  byte for byte when inputs match. Decode with gifuct-js and verify palette, colors,
  dimensions, delays, looping and frame count. Check that the source buffer stays intact.
- **Asset skew and cleanup.** Exercise the matrix above, including the updated runtime with
  old codec assets, missing and malformed mode acknowledgements, and confirmed Bayer with an
  unknown raw marker. Check transfer counts, one-time termination and rejection on
  abort during init, abort after handoff and timeout. Verify a fresh export after each
  terminal failure. Extend the existing retained-exporter checks with the Bayer lane.
- **Consumer and performance.** Check public type inference and the isolated tarball after the
  implementation is authorized. Exercise real Chromium/Firefox Workers and the current
  Next.js Worker asset paths. Re-run the flat and gradient comparisons against the 0.9.0
  baseline, including the undithered path and the proposed exact-color guard. Record size,
  time, local-tone error and static-pixel variation using the established metrics. Check
  bundle size and the existing deployable Worker asset paths.
