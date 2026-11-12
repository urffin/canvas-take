# APNG export: proposed contract and implementation boundary

Status: design, locally verified [backend feasibility prototype](apng-backend-spike.md) and an
unreleased [private controller with contract tests](apng-controller-verification.md) and
[real Worker/backend integration](apng-integration-verification.md), 2026-11-12,
after the separate `0.6.1` release (`b9bb4d9e662208a8b77c8bf5025371b17669e02d`).
This document preserves the design history. The public `/apng`, `/apng/worker` and
`/apng/worker-runtime` entries are now implemented in the working tree, without a version change
or publication. See the [current API guide](../apng-export.md) and
[public-entry verification](apng-public-verification.md). The [draft declarations](apng-export-api.d.ts)
and [typed sketch](apng-export-example.ts) remain historical artifacts; public declarations are authoritative.
The personal roadmap remains outside the repository. Acceptance is defined in
[APNG compatibility gates](apng-export-compatibility.md).

## Direction

Add an independent offline APNG controller with a **required injected encoder factory** and an
optional supplied backend in a separate entry. Preserve full-frame transparency. Keep GIF, offline
video and MediaRecorder unchanged, following the [policy evaluation](shared-export-policy-evaluation.md).
Do not turn the GIF controller into a format switch or introduce a universal exporter.

Public entries: `/apng`, `/apng/worker`, `/apng/worker-runtime` (implemented, not yet released).
The first complete feature should have a supplied cancellable Worker backend. A custom synchronous
encoder remains possible through the contract, with its non-preemptible execution documented.
No audio, palette/quality controls, external streaming, frame rectangles, user disposal/blend modes,
Worker pools or WebP implementation are included in this first scope.

## Format facts and product choices

APNG uses animation control/frame-control/data chunks, rational frame delays and total-play metadata.
Its frame operations can replace or alpha-composite regions. The specification permits a one-frame
animation and defines both PNG and APNG MIME types. These format facts come from the
[W3C PNG third edition](https://www.w3.org/TR/png-3/#apng-frame-based-animation). The following narrower rules are
**proposed CanvasTake choices**, not claims about all valid APNG files:

| Topic | Initial contract |
| --- | --- |
| Input | Complete independent canvas snapshots, fixed dimensions after the first accepted frame |
| Pixels | Straight-alpha sRGB RGBA8 from explicit sRGB canvas readback; no background flattening |
| Delay | Positive integer milliseconds, 1..65535 per submitted frame; encode exactly, without GIF rounding |
| Timing | Concatenate supplied delays; no fps inference, wall-clock capture or frame insertion/merging |
| Plays | `plays` is total plays, 0 infinite, 1 once, up to 4,294,967,295; default 0 |
| Output | Complete Blob, `image/apng`, suggested filename extension `.apng`; no static-PNG fallback |
| One frame | Must retain animation metadata and its delay; empty finish fails |

The delay subset fits a millisecond denominator without splitting a frame. Reject zero, fractional,
nonfinite and longer delays before readback; do not truncate fields or silently change duration.
Longer holds or arbitrary rational input require a later explicit contract. Browser playback may
clamp short delays; exact file timing does not promise a 1 ms display refresh rate.

The output must reconstruct each submitted full image. A codec may optimize rectangles/disposal,
but reconstructed pixels, frame count, delays, final hold and plays must match. Transparent regions
must erase an earlier opaque object rather than leave trails. Compare decoded alpha and RGB where
alpha is nonzero to the captured snapshot; hidden RGB under zero alpha is not an output guarantee.
Do not compare against ideal draw colors lost during the browser's own canvas round trip.

## Ownership, limits and scheduling

Validate options and pre-abort before encoder creation. At frame admission validate duration,
dimension/range/overflow, fixed size, count, duration and byte limits before `getImageData`.
Require positive integer dimensions and safe `width * height * 4`; PNG/backend dimension restrictions
also apply. Capture a full owned Uint8ClampedArray synchronously, before the first yield. Never
detach the caller's canvas/readback storage. No tiled snapshot, opaque composition or extra copy
through M1 is needed for the transparent path.

The encoder exclusively receives the owned snapshot, may transfer it, and may retain it until
finish/abort/dispose. `addFrame` acknowledgement means **accepted**, not compressed. There is no
fallback retry after handoff. A batch backend retains inputs proportional to submitted raw bytes;
do not claim streaming/bounded total memory or reuse GIF's shorter frame-borrow contract.

Proposed limits are inclusive positive safe integers: `maxFramePixels`, `maxFrames`, `maxDurationMs`,
`maxInputBytes` and `maxOutputBytes`. Only `maxInputBytes` has a proposed default, 64 MiB. It caps
cumulative admitted RGBA bytes, including the pending frame; its accounting remains reserved after
transfer/acknowledgement until terminal cleanup. Even a streaming custom encoder uses this same
conservative input budget. Codec scratch, compressed output and native/Blob copies are outside that
budget. The display hint `totalFrames` neither caps input nor enlarges the budget.

Check the output limit in a supplied backend before returning/posting its bytes and again before
Blob construction. A whole-file codec may already have allocated output: this is a logical output
bound, not prevention of all peak allocation. Failure returns no partial file. A 65,536 ms delay and
a frame exceeding the remaining input budget must fail before readback/transfer.

Use a new dedicated module Worker for a supplied batch encoder, retaining input in the Worker after
transfer and compressing during finish. Termination must interrupt an active synchronous compression
call; a cancellation message queued in that same Worker cannot do so. The calling thread still has
one synchronous full-canvas snapshot. No promise race makes it or a caller's synchronous codec
preemptible. Do not reuse the GIF Worker URL/protocol or add private APNG messages to legacy assets.

## Lifecycle and progress

The synchronous factory produces one fresh encoder; it must reject unavailable Worker/backend
capabilities before accepting a frame. Imports must remain safe without browser globals. A factory
owns cleanup if it throws before returning an instance. If it reentrantly triggers cancellation and
then returns an instance, the controller must release that instance before throwing the primary
reason. The controller uses its own adapter AbortSignal and releases acquired work once.

| Operation | Proposed behavior |
| --- | --- |
| Add | `ready -> adding`; overlapping add/finish rejects without cancelling accepted work |
| Ack | Increment accepted frame/duration/byte counters, synchronously report `collecting`, check activity, then return to `ready` |
| Finish | Set `finalizing` and cache the original completion promise before reporting; repeated finish during/after success returns it |
| Success | Validate returned bytes/animation envelope and output bound, construct an independent Blob, commit `finished`, release inputs/Worker, report success |
| Failure/cancel | Preserve the first reason/component cause, reject pending work, abort adapter signal, release owned work/listeners and report terminal phase |
| Dispose | Abort unfinished work with AbortError; repeated calls release nothing twice; post-success disposal cannot invalidate an already returned Blob/promise |

`finish` after disposal rejects, even when an earlier successful promise remains usable. Keep
terminal notifications singular; ignore late acknowledgements/replies/rejections. Cleanup exceptions
must not replace the primary result. Reject malformed/empty/non-APNG output rather than relabel it.
Envelope validation must detect a missing animation declaration, wrong dimensions/count/delays/plays
or incomplete chunks without duplicating pixel decompression in the controller.

The private controller wraps factory/add/finish failures with a component-specific Error retaining
the exact `cause`, including primitive causes. Controller validation/readback failures retain their
original identity. The first terminal reason wins; cleanup failures and late work cannot replace it.
Abort uses the external reason with a nullish AbortError fallback. Disposal after failure retains that
failure for subsequent calls. An invalid asynchronous factory is rejected synchronously; its eventual
result is observed and disposed defensively, not treated as supported asynchronous acquisition.

Returned encoder bytes are copied before cooperative envelope validation, so an encoder cannot
mutate a yielded validation buffer. Bounds, animation metadata, sequence and all chunk CRCs are
checked; the CRC scan yields after each 64 KiB of scanned type/payload bytes. Activity is checked
again after each asynchronous boundary before counters, success or another task can be committed.
The validator is not a PNG decompressor and does not certify arbitrary codec output pixels.

Progress describes acceptance: `framesAccepted`, `durationMs`, `inputBytesAccepted`; phases are
`collecting`, `finalizing`, `finished`, `failed`, `aborted`, `disposed`. No initialization notification,
compression percentage or invented encoded-frame count. Optional `totalFrames` is absent when unset;
`outputBytes` appears only at success. Snapshots are fresh, shallow frozen, synchronous and lazy when
there is no observer; synchronous observer exceptions are ignored. Observer abort after counter
commit may reject an add call without rolling counters back. Finished-observer disposal cannot
retract success. These are explicit new-domain choices, not a shared state-machine extraction.

## Backend investigation and decision gate

The [spike](apng-backend-spike.md) selects patched, pinned UPNG/Pako as an implementation baseline;
it is not an installed/production dependency. UPNG's documented lossless mode accepts
RGBA frame arrays. The published `upng-js@2.1.0` metadata identifies git revision
`5e5af183a3dda1e320b90a1830b3f64bc92010d4`; its writer hardcodes infinite plays, omits animation for
one frame, and stores integer delays with denominator 1000. See the
[published-revision source](https://github.com/photopea/UPNG.js/blob/5e5af183a3dda1e320b90a1830b3f64bc92010d4/UPNG.js#L358).
It is **not suitable unmodified** for this draft. Metadata was checked via the
[versioned registry document](https://registry.npmjs.org/upng-js/2.1.0), without installing it.

Repository revision `88f504b6577b726975f593caa38ba85d327c7c1f` differs: its writer accepts loop
metadata and exposes `encodeLL`, but still decides animation from a frame count greater than one.
See [pinned source](https://github.com/photopea/UPNG.js/blob/88f504b6577b726975f593caa38ba85d327c7c1f/UPNG.js#L515),
[manifest](https://github.com/photopea/UPNG.js/blob/88f504b6577b726975f593caa38ba85d327c7c1f/package.json) and
[MIT license](https://github.com/photopea/UPNG.js/blob/88f504b6577b726975f593caa38ba85d327c7c1f/LICENSE).
Do not mistake repository metadata for the published npm artifact.

The completed **backend feasibility spike** checks exact-alpha multi-frame and
single-frame animation, once/finite/infinite plays, identical frames, odd dimensions, noisy input,
1/65535 ms delays and Worker termination during finish. Use independent decoding and complete chunk
checks. Its report pins sources/licenses, three guarded changes and independent evidence for the
full-frame lossless SOURCE/BACKGROUND path. Rectangle optimization remains deferred, including an
observed FFmpeg limitation for an OVER metadata mutation. The private controller now has separate
fake-adapter evidence and real backend/browser/package integration; public-entry acceptance remains pending. Avoid a
homemade PNG compressor or silently accepting a weaker contract.

## Verification and next slice

The design preserves all existing package entries and Worker deployment layouts. Future backend
dependencies stay out of root/GIF/video controllers. Native GIF/MP4/WebM tests, types, packed consumers
and Next.js remain acceptance gates when runtime/build files change. No new package entry is added
by these documents.

Local design verification checks draft TypeScript, links, options/lifecycle consistency, unchanged
runtime/package and available independent tools. Existing `ffmpeg-static@5.3.0` lists APNG demuxer
and decoder support; this is **not** a successful CanvasTake APNG export/decode test. The
[FFmpeg demuxer guide](https://ffmpeg.org/ffmpeg-formats.html#apng) documents loop handling and frame-rate
options; a future oracle must explicitly ignore looping and avoid artificial frame-rate conversion.
Do not reuse the current 1x1/RGB video helper for full-frame RGBA validation.

Initial design-stage checks completed on 2026-11-12 (before the separately reported spike):

| Check | Result |
| --- | --- |
| Draft declarations and usage sketch | Strict no-emit TypeScript check passes with ES2022/DOM and NodeNext; isolated from production tsconfig using `--ignoreConfig` |
| Documentation scope | Six files, 54 local links and nine local Markdown anchors; whitespace/newline and `git diff --check` pass |
| Compatibility boundary | Source, build, tests, package metadata/lockfile, existing public API and version 0.6.0 unchanged |
| Independent tools | Existing FFmpeg lists APNG decoder and demuxer; no generated APNG was decoded |
| Baseline CI | [4cc479b CI](https://github.com/urffin/canvas-take/actions/runs/43163065714) passed all six jobs for the committed policy evaluation; the new APNG draft is local and has no separate CI result |

The later [spike report](apng-backend-spike.md) adds real-backend/Worker/decode evidence; the historical
table above describes the preceding design task. No production API or general performance claim is added.

The [private controller report](apng-controller-verification.md) records the completed fake-adapter
slice after release 0.6.1, including controlled cancellation and finite retained-buffer checks.
It does not replace the spike's independent real-backend decoding evidence or establish a complete
APNG browser feature.

The later [integration report](apng-integration-verification.md) records the pinned backend, dedicated
Worker, real-canvas decoding, development example and private installed-package/Next.js checks.
The new tests are part of the existing Node/browser jobs; local results are distinct from remote CI.

The public-entry slice is documented in [its verification report](apng-public-verification.md).
The historical snapshots above are not rewritten as evidence for later code. Commit/push and
exact-candidate CI remain separate from local public-entry verification; releases require a separate request.
