# WebP controller: compatibility and acceptance gates

Status: private controller/Node Worker/native-decoder and local browser subset checked, 2026-11-13, after
`f0bebc1cddcc94575d37f9797ed8d9abb9af6631`.
Companion to the [controller/Worker design](webp-export.md) and
[draft types](webp-export-api.d.ts). The [controller report](webp-controller-verification.md)
records 28 fake-encoder test groups. The [Worker integration](webp-worker-verification.md)
adds 17 protocol/native groups, six real-integration groups and 20 independent full-file decodes.
Authorized Chromium/Firefox checks are saved in the [browser observations](webp-browser-results.json).
The [public-entry report](webp-public-verification.md) now records installed types/assets and
Next.js/browser checks. An earlier unreproduced Firefox failure remains recorded separately.
The [backend proof](webp-libwebp-backend.md) and its
[dated observations](webp-libwebp-backend-results.json) remain evidence for their explicit subset.
Do not relabel the 17 backend fixtures or the baseline's successful CI as new controller tests.

| Gate | Evidence required before accepting implementation | Existing evidence / gap |
| --- | --- | --- |
| W1: injected encoder | Fake third-party factory without codec imports; synchronous fresh ownership; capability/factory errors and exact causes; reentrant abort; invalid async factory/late release | Controller/fake subset checked, including falsy causes, late release and codec-free graph |
| W2: capture and transfer | Canvas redraw immediately after add cannot alter pixels; explicit sRGB/RGBA8; caller arrays never detached; full-span owned copy; dimension changes/taint/readback failures; release after delayed ack/error | Fake/Node and actual browser canvas/OffscreenCanvas readback, immediate redraw and transfer checked in Chromium/Firefox |
| W3: timeline/file | Long final hold, finite/infinite plays and one-frame animation; merged/split presentation equivalence; invalid envelopes and corrupt valid metadata/pixels fail the appropriate oracle | Twenty native-Pillow files and 24 actual-canvas cases per browser checked, including uint24 split/partial alpha. Negative controls rejected; Firefox short-delay clamping and FFmpeg ALPH discrepancy explicit |
| W4: limits | Exact inclusive boundary then first excess, before readback/transfer; pending reservations; fixed size; signed timestamp overflow; context/Worker normalized budgets; output cap before Blob and before posting | Controller boundaries/reservation plus runtime input/output defence checked; native allocation/output faults release resources |
| W5: progress and promises | Full ordered frozen snapshots, omitted optional keys, commit after ack, reentrant observers, cached finish identity, overlap rejection without cancelling admitted work | Controller trace, lazy snapshots, reentrancy and finish identity checked; no encoded-frame/percentage progress claim |
| W6: terminal races | Pre-abort, factory/readback/progress reentrancy, init/add/finish/output-validation abort/dispose, local reason identity, cleanup errors, late settlements and exactly-once owned disposal | Fake/Node cases plus real browser before-init/fetch/capture-yield/finalizing/native-hook cancellation and fresh retries checked |
| W7: Worker protocol | New format/version/ABI/profile handshake; init/frame/finish ordering and timers; duplicate/stale/malformed messages; messageerror/error/postMessage/timeout; no legacy fallback or retry | Tagged protocol checked with fakes, real Node and browser runtime integration; real browser incompatible-profile acknowledgement rejected |
| W8: resources | Retain handles while checking snapshots/canvas/error closures, timers/listeners/pending maps/native allocations; successful/cancelled/failed retries; observe real Worker/thread close and final empty inventory | GC/fault/native-repeat probes, real Node exits and actual browser target closure/zero handler inventories checked. Native-probe retries free tracked allocations; RSS remains unclaimed |
| W9: deployment and packaging | Node/SSR import safety, no calling-thread codec import, matching JS/WASM/ABI/profile and notices, default/explicit URLs, CORS/CSP/load failures, installed consumer/types and Next bundling | Private and public assets/notices/types checked. Installed public tarball and Next16.3 automatic/package/copied Worker+WASM modes pass in both browsers. Standalone loader and absolute URL fixes have regressions; early Firefox observation retained |
| W10: existing formats | Existing entry keys/declarations/defaults unchanged; GIF/APNG/video/recording tests, package consumers, Worker protocols and independent outputs unchanged | Public WebP adds four isolated entry keys; existing format entry values unchanged. Build, 217 Node tests and packed consumer pass; local public WebP/Next browser evidence separate, no new CI claimed |

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

## Execution and scope

The design was checked with isolated TypeScript and relative-link/whitespace checks. The subsequent
private implementation adds controller/Worker tests, strict comparison with draft types, full Node
regression and a packed Node consumer check. The Worker slice adds two source builds and separate
native full-animation decoding; see its dated report for exact evidence. It changes internal runtime
and build assets only. Subsequent local browser sessions were explicitly authorized and verified;
no benchmark or new CI run is claimed. Typechecking alone
is not runtime evidence; older backend observations and green baseline CI remain historical.

For future browser work, use the built-in browser by default, keep at most two agent-opened tabs,
preserve user tabs, and obtain explicit permission before starting/attaching external-browser
debugging, with the concrete reason built-in verification is insufficient. This includes local
Playwright/CDP or extension debugger attachment; a prior task's authorization is not sufficient.

Private controller/fake, Node Worker/backend/protocol and the local browser slice are checked within
their reported limits. The separately authorized public-entry slice has checked installed WebP
assets/types/Next. Preserve the earlier Firefox reliability observation; CI wiring/release need
separate authorization. This implementation request does not authorize a version bump, release,
commit or push.
