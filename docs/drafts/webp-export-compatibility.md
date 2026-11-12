# WebP controller: compatibility and acceptance gates

Status: design gates, 2026-11-13, baseline `459dc6f97a58deec43d6e3e7552fee50162bbdce`.
Companion to the [controller/Worker design](webp-export.md) and
[draft types](webp-export-api.d.ts). **No proposed controller/transport gate is claimed passed.**
The [backend proof](webp-libwebp-backend.md) and its
[dated observations](webp-libwebp-backend-results.json) remain evidence for their explicit subset.
Do not relabel the 17 backend fixtures or the baseline's successful CI as new controller tests.

| Gate | Evidence required before accepting implementation | Existing evidence / gap |
| --- | --- | --- |
| W1: injected encoder | Fake third-party factory without codec imports; synchronous fresh ownership; capability/factory errors and exact causes; reentrant abort; invalid async factory/late release | Proposed; no controller implementation |
| W2: capture and transfer | Canvas redraw immediately after add cannot alter pixels; explicit sRGB/RGBA8; caller arrays never detached; full-span owned copy; dimension changes/taint/readback failures; release after delayed ack/error | Backend receives synthetic arrays only; canvas path and handoff unimplemented |
| W3: timeline/file | Long final hold, finite/infinite plays and one-frame animation; merged/split presentation equivalence; invalid envelopes and corrupt valid metadata/pixels fail the appropriate oracle | Proof: 33 encoded payloads/35 input intervals and native one-frame plays; merged uint24 overflow splitting still needs coverage |
| W4: limits | Exact inclusive boundary then first excess, before readback/transfer; pending reservations; fixed size; signed timestamp overflow; context/Worker normalized budgets; output cap before Blob and before posting | Private codec has validation/fault tests, not public admission or protocol defence |
| W5: progress and promises | Full ordered frozen snapshots, omitted optional keys, commit after ack, reentrant observers, cached finish identity, overlap rejection without cancelling admitted work | Proposed; no encoded-frame/percentage progress claim |
| W6: terminal races | Pre-abort, factory/readback/progress reentrancy, init/add/finish/output-validation abort/dispose, local reason identity, cleanup errors, late settlements and exactly-once owned disposal | Proof covers native callback abort/Worker termination; not controller races or new transport |
| W7: Worker protocol | New format/version/ABI/profile handshake; init/frame/finish ordering and timers; duplicate/stale/malformed messages; messageerror/error/postMessage/timeout; no legacy fallback or retry | Existing proof's untagged messages are not this protocol |
| W8: resources | Retain handles while checking snapshots/canvas/error closures, timers/listeners/pending maps/native allocations; successful/cancelled/failed retries; observe real Worker/thread close and final empty inventory | Proof: native allocation faults/repeated jobs/paused-callback termination. No arbitrary hot-loop or immediate-RSS certification |
| W9: deployment and packaging | Node/SSR import safety, no calling-thread codec import, matching JS/WASM/ABI/profile and notices, default/explicit URLs, CORS/CSP/load failures, installed consumer/types and Next bundling | Reproducible Windows build proven; packaged tagged binding/runtime/asset deployment unimplemented |
| W10: existing formats | Existing entry keys/declarations/defaults unchanged; GIF/APNG/video/recording tests, package consumers, Worker protocols and independent outputs unchanged | Baseline CI passed; a candidate implementation needs its own regression/CI evidence |

## Controlled controller tests

Use deterministic fake canvas/readback and encoder barriers, not arbitrary sleeps:

- Check factory construction without reading a frame, one fresh encoder per exporter, normalized
  frozen context, no codec choice fields in controller options, and no acquisition on pre-abort.
  Test synchronous throw, invalid shape, thenable/getter failure and late invalid-factory results.
- Sweep cancellation between snapshot, scheduled continuation, encoder invocation, ack resolution,
  counter commit, observer return, finish result copy, envelope checkpoints and Blob success commit.
  Assert pending bytes are reserved privately, not prematurely published or refunded after transfer.
- Inspect the transferred buffer identity and detachment through a fake Worker. Send only the owned
  snapshot; redraw/readback caller storage must stay usable. Test subviews, shared/detached buffers,
  wrong data types, malicious metadata mutation and exceptions that retain invocation closures.
- Assert the complete tuple trace with two 1×1 frames: counts 1/2, times 55/2055, bytes 4/8,
  finalizing/finished with unchanged totals and outputBytes only on success. No ctor/init event,
  no phantom frames from merging, no percentage. Test totalFrames below/above actual input.
- Observer throws must not fail work. Observer abort/dispose after acknowledgement must preserve
  committed counters while rejecting the add. Overlap from an observer must reject independently.
  Reentrant finish during finalizing must see the original promise. Finished-observer disposal
  cannot invalidate Blob/success; later finish after disposal rejects.
- Check first controller-observed reason under simultaneous component failure/abort; reasons
  0/false/empty-string must survive, null/undefined use the specified AbortError fallback. Verify
  factory/add/finish cause identity locally, transported name/message limits, cleanup throwing or
  returning a rejected promise, and no unhandled rejection from late work.

For each limit, test equality and one over; verify no readback/transfer for rejection. Include
delay 0/1/10/11/55/16777215/16777216, fractional/nonfinite values, dimensions 1 and 16383, size
change, empty finish, exact raw bytes, maxFrames with a blocked add, output subview/copy, shared
output and signed timestamp overflow. Large numeric-limit tests must not allocate enormous images:
use metadata/fakes and verify that rejection precedes capture.

## Worker and backend integration tests

1. Prove a fresh dedicated Worker and initialization failure memoization, including the documented
   idle-failure/next-operation behavior. A frame waiting for init must not transfer early; distinguish
   the init timeout from the frame timeout started at posting. No reply may extend either timer.
2. Tag requests/replies with format/version/id/action; a matching ID with a wrong action/profile/
   error shape fails deterministically. Ignore stale/unsolicited IDs without committing progress
   or clearing the live request's timer; an unmatched reply cannot prevent timeout. Test
   duplicate runtime requests, unknown actions, partial/error replies and a finish response whose
   view exposes unrelated backing bytes. Never send these messages to GIF/APNG/AAC runtimes.
3. Exercise abort/dispose before Worker creation returns, during fetch/compile/init, after transfer,
   while native finish is active, and after output arrival before validation success. Include
   `error`, `messageerror`, request timeout and synchronous postMessage failure. Assert map/timer/
   handler cleanup, no accepted result from cancelled jobs, and late replies cannot resurrect work.
4. Test the batch mapping from owned Uint8ClampedArray to an exact Uint8Array view, all normalized
   limits and plays/duration field names; no accidental copy budget, missing hold or hidden default.
   After cooperative native errors release C allocations; after hard cancellation observe actual
   target/thread closure independently of promise rejection. Retain old handles while exporting
   again to distinguish genuine ownership release from losing the test's own references.
5. Package the profile/ABI-tagged binding. Relocate worker and WASM independently; changing workerUrl
   must not secretly change wasmUrl. Test default URLs, explicit absolute/relative/base URLs, static
   copies, stale/missing/mismatched assets, HTML served as WASM, CORS/CSP errors and runtime import
   safety. A codec-version string or self-declared tag is not the independent file proof.

Use ordinary production Worker mechanisms. Shared barriers may instrument codec-entry/exit for
controlled probes but must not become a production SAB/cross-origin-isolation requirement. Preserve
the current proof's distinction between cancellation settlement, target closure, freed native
allocations, retained WASM capacity and process RSS. Performance/peak-memory claims require their
own repeatable workload and timing boundaries.

## Independent animation oracle

Combine a bounded RIFF reader with independent full-file browser decoders and payload decoding.
Check plays, single-frame metadata, dimensions, total duration, final hold and images over every
input interval. Do not require encoded count equality. If splitting/merging is used, exercise
`A:50,B:70,B:90,C:200`, identical images, identical holds crossing uint24 and a long final hold.
Check captured alpha 0/1/127/128/254/255, fully transparent odd-size input and erasure after opaque.
For lossless compare alpha exactly and visible RGB exactly in a decoder that preserves straight
RGB; ignore hidden RGB at zero alpha. For lossy include partial alpha/erasure, retaining exact alpha,
with an explicitly defined image-quality comparison rather than exact RGB equality.

Runtime envelope validation cannot certify these pixels or all interval boundaries. Exercise valid
wrong-delay/plays/pixels/blend ghost controls in native decoders; malformed RIFF length/padding,
ANIM ordering, missing image payload, wrong rectangle, static-only single frame and trailing bytes
in the envelope checker. Add a total-preserving wrong-hold control to demonstrate the runtime
validator's documented limit and the independent presentation oracle's stronger rejection.

The installed FFmpeg 6.1.1 lacks the complete animated-WebP demux used in the research; extracted
payload checks alone do not certify arbitrary partial-alpha composition. Chromium/Firefox native
RGBA conversions can also round/premultiply RGB. Keep those boundaries explicit; do not substitute
the encoder's own decoder. Viewer short-delay clamping must be recorded separately from file bytes.

## Execution and scope of this design

This change requires only isolated TypeScript checks for the draft declarations/examples, relative
link/whitespace checks and confirmation that runtime/build/manifest/exports remain unchanged.
It does not require a new browser session, WASM build, benchmark or CI run. Typechecking a declaration
is not implementation evidence for W1–W9. The older 164 tests and green baseline CI remain historical.

For future browser work, use the built-in browser by default, keep at most two agent-opened tabs,
preserve user tabs, and obtain explicit permission before starting/attaching external-browser
debugging, with the concrete reason built-in verification is insufficient. This includes local
Playwright/CDP or extension debugger attachment; a prior task's authorization is not sufficient.

Implementation should proceed in separately authorized slices: private controller/fake-encoder
tests; supplied Worker/backend/protocol integration; then installed assets/types/Next and public
entries if approved. A version bump, release, commit or push is not authorized by this design task.
