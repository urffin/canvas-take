# Optional GIF palette from a bounded clip sample

Design proposal based on CanvasTake 0.10.0 and commit `29851ca`, 2026-11-22.

Use one palette for all frames when the caller can replay selected frames from
the clip. At 64 colors, sampling reduced flicker on the measured moving gradient
from 1.740 to 0.090 and size from 326.2 to 256.0 KiB. Per-frame palettes
retained finer local tone. On the scene-cut fixture, reserving accent entries
alone reproduced 77.93% of accent pixels exactly. Assigning their indices by
full RGB raised that to 100%. The blue-channel guard preserved the exact bytes
in all 13 measured cases. It reduced median mapping time by 19.3–29.5% in
the 12 main cases and raised it by 6.9% in the shared-blue stress case.
[Sampling study](gif-sampled-palette-benchmark.md) ·
[Accent study](gif-accent-palette-benchmark.md) ·
[Mapping study](gif-accent-mapping-benchmark.md)

## Proposed option

Add an optional `palette` member to `GifencOptions` in a later public step.
`GifWorkerOptions` already extends that interface. Both adapters default to
the current per-frame quantizer, writer and Worker messages when `palette`
is omitted or `undefined`. The draft leaves the GIF controller options and
the custom encoder contract unchanged.

```ts
// Draft only. Proposed member of GifencOptions.
readonly palette?: {
    readonly mode: 'sampled';
    readonly source: {
        readonly frameCount: number;
        readonly readFrame: (
            index: number,
            signal: AbortSignal
        ) => HTMLCanvasElement | OffscreenCanvas | Promise<HTMLCanvasElement | OffscreenCanvas>;
    };
    readonly accentColors?: readonly (readonly [number, number, number])[];
};
```

- `source` is a replayable view of the clip. `frameCount` is a positive safe
  integer. The adapter borrows the result of `readFrame` for immediate readback
  after it is returned and never mutates the canvas. A renderer may reuse its
  sampling canvas between calls. It should keep the encode-loop canvas separate
  from sampling and honor the signal. Indexed sample reads run sequentially.
- The caller still submits frames and durations through `addFrame`. The
  source length controls sample positions. It is independent of the exporter's
  `totalFrames` display hint and frame limits. The caller should supply the
  same clip content for representative colors. The adapter checks sampled
  dimensions against the first encoded frame. It never compares frame bytes
  or requires the export to contain all source frames.
- Both factories validate the descriptor before creating a session or Worker.
  Require the `sampled` mode, a callable reader, and RGB tuples with three
  integer bytes. Snapshot the descriptor's count, reader and accent RGB values
  at factory creation. Invoke the captured reader with its original source
  receiver. Deduplicate accents by full RGB in first-seen order. A unique
  count exceeding `maxColors`, invalid numeric count or out-of-range channel
  throws `RangeError`. Invalid shape, length, mode, reader or channel type
  throws `TypeError`. An empty list behaves like omission.

## Capture, sampling and mapping

1. Begin the pre-pass on the first frame after the controller's existing
   limits, immediate owned snapshot and initial yield. Confirm Worker support
   before reading any sample source. Add an own private, versioned preparation
   capability to sampled sessions only. The controller passes fixed width,
   height and its validated copied background through that capability. Use
   guarded discovery as with raw frame preparation. A third-party encoder
   without the capability still receives the current opaque frame. Bundled
   encoders called directly can start the pre-pass from their first opaque
   `addFrame`; in this path sampled pixels must already be opaque because
   the encoder has no controller background. The same rule applies to a
   decorator that hides the private capability. Reject a sampled alpha value
   in that path to avoid choosing a palette against an implicit background.
2. Choose `k = min(4, frameCount)` indices. For `k = 1`, use index 0.
   Otherwise use `round(i * (frameCount - 1) / (k - 1))` for `i = 0..k-1`,
   with overflow-safe integer arithmetic at the upper safe-integer boundary.
   This includes both endpoints and selects `0, 8, 15, 23` for 24 frames.
   Each sampled frame contributes the pixel at the center of each of at most
   64×64 equally spaced grid cells, ordered by row. For an axis of length
   `n` with `m = min(64, n)` cells, the coordinate for cell `j` is
   `floor((j + 0.5) * n / m)`. Use the same RGBA8 readback as the controller.
   Copy up to 16 grid rows per task, check cancellation between tasks, and
   composite the compact pixels with the shared `blendRange` rounding and
   actual export background. One sampled readback can be live at a time.
   Release it before reading the next source canvas. The compact RGBA payload
   is at most 64 KiB. This bound excludes readback, the first encoded frame's
   snapshot, the caller's canvas, quantizer scratch memory and the GIF output.
   Removing reserved colors can briefly require a second, smaller buffer
   within this same 64 KiB per-buffer bound.
3. Reserve one entry per unique accent. Remove exact matching sample pixels
   by compacting the owned RGBA buffer. If compaction shortened a nonempty
   sample, copy its prefix into an exact-length buffer. gifenc 1.0.3 reads
   the entire backing buffer even when passed a shorter view. Quantize
   the full-span sample with the remaining color budget and the existing
   quality format (RGB565 for high and RGB444 for fast). Drop quantized
   representatives equal to an accent, then append accents in their original order.
   Allow fewer colors than the cap. A remaining budget of one is valid.
   If all sample pixels are accents, the reserved entries suffice. If the
   accents fill the budget, skip sample reads and quantization entirely.
   Keep one stable palette per export. gifenc pads the serialized table to
   its required power-of-two size.
4. With `dither: 'none'`, run stock `applyPalette` on the full composited
   frame, then override the indices of pixels exactly matching an accent.
   Use the measured 256-byte blue-channel filter before the full RGB lookup.
   Skip the correction pass for an empty accent list. An accent must map
   to its reserved index even if a nearby color populated the same RGB565 or
   RGB444 cache bucket first. Leave all other indices from the stock mapper.
   With `dither: 'bayer-4x4'`, reuse the existing Bayer mapper's exact-color
   branch. Unique reserved entries give the same accent guarantee without an
   extra pass. Exactness refers to RGB **after** blending, including a match
   produced by blending. A nearby color can still be quantized to an accent.
5. Write the shared table on the first frame only. Subsequent writes omit the
   local table and reuse the global indices. Frame dimensions, order, rounded
   durations, final hold, disposal and repeat parameters follow the existing
   paths. `addFrame` continues to resolve after the actual frame is encoded.
   Sampling never consumes export limits or produces progress events.

The synchronous adapter runs the same shared codec logic on its calling
thread. The Worker path copies the compact sample on the calling thread and
transfers it once to the existing export Worker. Quantization, full-frame
mapping and encoding run there. The controller and Worker adapter retain
codec-free entry points. The existing Worker runtime loads `gifenc.js`
through the same relative import.

## Worker protocol and deployed assets

Keep the existing init and frame traffic byte-for-byte compatible in the
default mode, including existing Bayer init and acknowledgement. For sampled
mode, extend only that export's init request and reply, and add one request
for the compact sample. Ordinary `frame`, `raw-frame-v1` and `finish` payloads
and replies keep their existing shapes.

```js
// Request and reply fields in addition to the existing init fields.
{ paletteMode: 'sampled-v1', accentColors: [[242, 245, 249]] }
{ activePalette: 'sampled-v1' }
// Following init, using the existing request envelope and ID.
{ id, action: 'palette-sample-v1', value: { data: sampleRgba } }
{ id, paletteReady: 1 }
```

The runtime calls the existing `createGifencEncoder` import. For sampled init,
attach a versioned private request with a `Symbol.for` key to the factory
options inside the runtime. An updated codec returns an encoder with an own
private sample-install method. The runtime confirms the mode only after
checking that method on the actual encoder. This allows a new runtime to
load an old `gifenc.js`, run default exports and reject sampled init cleanly.
Use a sampled-only error code in the existing terminal error envelope for a
codec that lacks the capability. The adapter maps that code, or a successful
init lacking the exact mode confirmation, to `NotSupportedError`. The mode
acknowledgement is independent of the Bayer and raw preparation markers.

The sample request is ordered after init and before any frame. The runtime
accepts it once, validates the accent config and bounded full-span RGBA8
buffer (ordinary `ArrayBuffer`, opaque pixels, length divisible by four),
installs the palette, releases the sample and only then acknowledges. An
empty sample is legal only when the accents fill the cap. The runtime
rejects an early frame or finish, duplicate sample or invalid data as
terminal. The adapter requires the matching sample reply ID and `paletteReady`
value before frame handoff. A failed session cannot send any further transfers.

| Adapter, runtime, codec | Default or existing Bayer mode | Explicit sampled mode |
| --- | --- | --- |
| New adapter with 0.10.0 or older runtime | Existing behavior and raw/prepared fallback, Bayer subject to its own support | Missing mode confirmation or terminal init error before any pixel transfer |
| Older adapter with new runtime and compatible codec | Existing init and replies, including legacy prepared frames and supported Bayer | Older adapters send only their existing modes |
| New adapter and runtime with old `gifenc.js` | Default works. Bayer follows the existing capability check. | Runtime rejects init when the codec cannot install a sample |
| New adapter, runtime and codec | Existing behavior | Palette and raw preparation confirm independently. Either frame route can encode. |
| Custom runtime | Existing protocol | Exact palette acknowledgement required. An absent or unknown raw marker selects prepared frames after the palette is ready. |

## Cancellation, ownership and errors

- Each export has its own sample state, cancel signal for the reader, and
  at most one active pre-pass. A pre-aborted controller creates neither
  encoder nor Worker. During init, readback scheduling or sampling, abort
  and `dispose` stop local work, reject the pending operation and clear any
  first-frame snapshot, sample readback and compact RGBA references. Preserve
  the exporter's existing error identity and single terminal progress event.
  Before any next read, upload or frame write, check the session is active.
- While awaiting `readFrame`, cancellation settles the adapter's own wait
  and detaches its continuations from session data. Late values are discarded
  without readback. Observe late rejections to avoid unhandled promises.
  The callback's own resources remain its responsibility if it ignores
  the signal. Synchronous callback work and canvas readback are non-preemptible.
- Yield before and after synchronous quantization so a pending cancellation
  can stop frame submission after that step. Synchronous quantization, mapping
  and writer calls run to completion on the calling thread. Worker abort
  terminates the owned Worker even during quantization or frame encoding.
  Existing per-request timeouts cover init, the sample upload through its
  acknowledgement, each frame and finish. The caller controls cancellation
  of the local replay callback, which is outside the Worker request timeout.
- `close` is idempotent. On failure, abort or dispose it clears listeners,
  timers, pending requests and palette/sample state, cancels scheduled sampling tasks
  and terminates the Worker once. The receiver owns transferred buffers.
  Release the prepared palette and mapper lookup on success as well. A late
  reply cannot restart work, advance progress or finalize a GIF. Retrying
  creates a new encoder session and, on the Worker path, a new Worker.

## Implementation order

Start with private sampling, palette construction and the synchronous path.
Then add private Worker negotiation and compare both frame routes with the
synchronous result. Validate the public option and publish it only after
the implementation gates pass and the public step is authorized.

## Acceptance checks for implementation

| ID | Verification |
| --- | --- |
| G1 | Freeze `29851ca` built artifacts and compare exact default GIF bytes, init/reply shape, frame handoff and progress with omitted/undefined palette. Exercise 0.10.0 Bayer too. Cover custom encoders and strict proxies. |
| G2 | Validate factory inputs, deduplication order, accidental later mutation, one remaining slot, all slots reserved, all sample pixels reserved, absent accents, single-color samples and no quantizer reads past the compacted prefix. Invalid factory input must avoid Worker creation and source reads. |
| G3 | Check sample indices, grid centers and compact length for 1, 2, 4 and 24 frames, a safe-integer boundary count and dimensions below 64. Track one concurrent readback and cover reused sample canvas, changed live canvas right after `addFrame`, dimension mismatch, tainted canvas and a rejected reader. |
| G4 | Compare complete GIF bytes across sync, Worker raw and Worker prepared for identical inputs. Cover both `quality` settings, both dither modes, limits 2/32/64/128/256, composited accents, exact RGB bucket collisions, same-blue near matches and palette indices 0/255. Compare the archived `high`/undithered opaque fixture with the reference exact mapper when the sampled RGB input and palette order match. |
| G5 | Decode with gifuct-js. Verify one global table, zero local tables, palette capacity and ordering, unchanged rounded frame timing and final hold, repeats, one frame and empty-export failure. Require 100% exact accent pixels and zero variation where that accent is unchanged. Check caller data, controller limits and progress counters. |
| G6 | Exercise the asset matrix with frozen old Worker/adapter/codec fixtures. Test missing and malformed mode/sample acknowledgements, unsupported Bayer+sampled, unknown raw marker with sampled confirmed, a sample before init, a duplicate sample, a frame or finish before sample acknowledgement and invalid sample length/buffer. Ensure unsupported modes fail before any sample read or pixel transfer. The controller may already own the first full-frame snapshot. |
| G7 | Use controlled barriers for pre-abort, pending init, pending source callback, grid copy, quantizer entry, sample handoff, first frame and finish. Exercise abort, dispose, timeout, transport failure and late settlement. Check original reason, one cleanup, cleared listeners/timers, no stale progress or Blob, live Worker closure and byte-identical fresh retry. |
| G8 | Profile repeat exports and retained terminal handles. Track reference release/detachment, actual sample-buffer size, preparation and full encode times, abort latency and peak memory. Include the two adapters, flat text, moving gradient, scene cut, shared-blue stress and a longer replayable clip. Compare against per-frame and the reference exact mapper. Report paired ranges and separate timing from memory profiling. |
| G9 | Exercise native Workers in Chromium and Firefox, including a decoded retry and an independently confirmed prepared-frame fallback. Verify bundle graph and, before exposing the option, declarations, installed tarball, deployed Worker assets, production Next.js and required CI on the release candidate. |

Design review checked the two adapter factories, their shared codec use, the
controller's snapshot and disposal order, and the current Worker handshake.
A local gifenc 1.0.3 and gifuct-js check confirmed a one-entry logical palette
with a padded global table, no local tables, two frame delays and the loop
count for both RGB565 and RGB444. A second check confirmed why a shortened
sample needs a full-span buffer. G1–G9 are implementation gates.
