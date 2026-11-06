# Shared export mechanisms: compatibility gates

Status: design/acceptance criteria, 2026-11-06. Companion to the
[mechanisms design](shared-export-mechanisms.md), based on
`7362c6c71c194e1c7165d83bcb428a2915b598ab`. These are gates for future implementation, not a
record of newly executed tests. Existing tests establish a starting point; missing characterization
below must be added before or with the corresponding extraction.

## Baseline and evidence

Capture the exact base and candidate SHA/dirty state, compiler/dependency versions, built assets
and hashes. The development baseline includes raw GIF preparation; published 0.6.0 is a separate
legacy compatibility target. Keep the frozen 0.6.0 Worker/adapter fixtures unchanged.

For deterministic fake adapters, record ordered calls, sync readback/copy points, progress snapshots,
state transitions, errors (type/name, option/component, reason identity and cause), disposal and
promise identity. Compare at deliberate barriers instead of relying on arbitrary sleeps. Do not
normalize away a changed progress event or scheduling boundary. Changes in private error stacks
or generated helper names are not compatibility failures; changed public behavior is.

## Gate matrix

| Gate | Required observable result | Existing starting coverage | Additional characterization before extraction |
| --- | --- | --- | --- |
| K1: API/package | Same declarations, runtime exports, entry paths, default values, option/result shapes and optional property presence; version/lock/exports unchanged | [packed consumer](../../scripts/test-package.mjs), standalone/import tests in [GIF](../../test/gif.test.mjs) and [video](../../test/offline-video.test.mjs) | Save baseline declarations/export-key lists; inspect actual installed candidate and dependency graph for changed helper consumers |
| K2: snapshot | Full owned copy before first yield, caller may redraw immediately; rejected frames cause no readback; input never detached/modified | [GIF](../../test/gif.test.mjs), [preparation](../../test/gif-preparation.test.mjs), [video](../../test/offline-video.test.mjs), [real canvas](../../test/browser/offline-video.spec.mjs) | Compare readback arguments/order and ownership for every M1 caller; preserve GIF default vs video sRGB request |
| K3: RGBA | Whole-range and chunked composition identical to baseline, alpha-255 skip unchanged, no extra allocation/yield | [GIF pixels](../../test/gif.test.mjs), [preparation](../../test/gif-preparation.test.mjs), [raw Worker](../../test/gif-raw-worker.test.mjs), [real video](../../test/browser/offline-video-real.spec.mjs) | Add pure M1 oracle/range tests and byte-exact fake video-encoder input comparison, including partial ranges and empty ranges |
| K4: timeline/audio | Preserve GIF rounding/repeats, video contiguous intervals/final hold, absolute sample counts and all trim metadata; capture pauses exclude wall time | [video controller](../../test/offline-video.test.mjs), [AAC](../../test/aac.test.mjs), [Opus](../../test/opus.test.mjs), [recorder](../../test/recorder.test.mjs), [real AAC](../../test/browser/offline-audio.spec.mjs), [real WebM](../../test/browser/offline-webm.spec.mjs) | Match baseline interval/sample summaries and decoder criteria; do not replace profile tolerances with one cross-format tolerance |
| K5: admission/finish | Overlap rejects without cancelling accepted work; preserve different repeated finish/stop behavior and synchronous state changes | [GIF](../../test/gif.test.mjs), [video](../../test/offline-video.test.mjs), [recorder](../../test/recorder.test.mjs) | Explicit promise-identity and state traces for repeated GIF finish, video finish, recorder stop/finished and pending start/pause/resume, especially before M2 |
| K6: progress/reentrancy | Same frozen snapshots, phase order, commit points/counters, ignored observer exceptions and observer-triggered cancellation/disposal | [GIF Worker](../../test/gif-worker.test.mjs), [video](../../test/offline-video.test.mjs) | Ordered traces for delayed packet output vs accepted frames, partial audio failure and finished-observer disposal; no new initial progress or percent |
| K7: limits | Inclusive bounds, same rejection point/error origin, rejected pixels not read/submitted; output budget includes headers and event metadata | [GIF limits](../../test/gif-worker.test.mjs), [video](../../test/offline-video.test.mjs), [MP4](../../test/video-adapters.test.mjs), [WebM](../../test/webm.test.mjs) | Trace exact-end output/rewrites and first over-budget write before page allocation for M3; distinguish file size from cumulative write traffic |
| K8: backpressure | Same video look-ahead and byte budgets, per-track order and one muxer write at a time; creation/flush can drain; no future-packet dependency | [video](../../test/offline-video.test.mjs), [native video](../../test/video-adapters.test.mjs), [Opus](../../test/opus.test.mjs) | Preserve blocked-sink/cancel and zero-byte event traces; GIF remains one public input at a time, recorder gains no artificial frame queue |
| K9: terminal outcomes | Same winning reason/cause, no late counters/results/packets, no unhandled late rejection; same caller-owned inputs survive | [GIF](../../test/gif.test.mjs), [preparation](../../test/gif-preparation.test.mjs), [raw Worker](../../test/gif-raw-worker.test.mjs), [video](../../test/offline-video.test.mjs), [recorder](../../test/recorder.test.mjs) | For any moved async/lifetime code, cover each barrier in the cancellation table below and already-settled promise/reentrant observer cases |
| K10: resources | Exactly-once disposal of acquired export adapters, late video acquisitions released, owned tasks/listeners/Workers/native inputs closed, returned Blob still valid | [GIF GC](../../test/fixtures/gif-raw-gc.mjs), [video](../../test/offline-video.test.mjs), [AAC](../../test/aac.test.mjs), [Opus](../../test/opus.test.mjs), [recorder](../../test/recorder.test.mjs) | Retain exporter/adapter handles after cleanup; test M3 late writes cannot recreate pages and returned Blob bytes survive clearing the store |
| K11: GIF protocol | Raw/current path and all legacy/custom opaque paths remain selected correctly; same GIF bytes with unchanged codec/settings; no retry after transfer | [raw Worker](../../test/gif-raw-worker.test.mjs), [native browser](../../test/browser/gif-raw.spec.mjs) | Preserve branch/transfer assertions through build extraction, not merely a decodable final file |
| K12: output storage | Exact final bytes for identical positioned-write traces, bounded logical size, no extra full-file buffer, same propagated first output error | [MP4 adapter](../../test/video-adapters.test.mjs), [WebM adapter](../../test/webm.test.mjs), [MP4 retry](../../test/browser/offline-video-real.spec.mjs), [WebM retry](../../test/browser/offline-webm.spec.mjs) | Add page-boundary/rewind/overwrite/mutation/failure tests for M3 and replay captured real writer traces; do not infer that current integration tests cover private page mechanics |

All gates apply as invariants. The commands and new characterization needed for a slice depend on
which consumers/build entries actually change; this is not a requirement to run every expensive
benchmark on every documentation or independent helper change.

## Required targeted cases

### M1 composition oracle and capture

Use a baseline formula independent of the extracted helper. Include alpha 0, 1, 127, 128, 254,
255; RGB extremes and intermediate values; black, white and colored backgrounds; small, odd-sized
and multi-chunk frames. Compare full-frame composition to arbitrary adjacent ranges, including
empty ranges. Pixels outside a selected range must remain unchanged. Verify the alpha-255 path
retains exact RGB bytes. No new validation semantics for private ranges should leak into callers.

Compare opaque frame bytes delivered to fake video/GIF adapters before/after extraction. Also
compare real GIF files across sync, current Worker, old runtime, old adapter, unknown capability,
public-method wrappers, strict Proxies and public `addFrame` decorators. A wrapper-induced fallback
is not evidence that raw execution was preserved. Keep native browser branch assertions.

Check `addFrame()` readback/copy before the first yield, immediate caller mutation/resize, tainted
canvas and reentrant abort from readback. Preserve existing active guards. Video composition must
still be synchronous at its current call site; GIF retains its initial timer and cooperative scheduler.

### M2 promises and observation

The [M2 evaluation](shared-deferred-evaluation.md) records the new controller characterization,
isolated candidate and negative controls. Extraction is deferred; these checks do not certify a
future production migration or replace its packaging/browser gates.

Verify deferred resolves/rejects the original promise with the supplied value/reason, no converted
error and no added task. An internal ignored rejection handler must not make consumers observe a
resolved/undefined promise. Exercise rejection before consumer attachment and rejected late work
without unhandled rejections. Use public controller tests to verify ordering, not only helper tests.

Explicitly compare these incompatible completion policies:

- GIF `finish()` while another operation is active or after success rejects; it must not become
  cached/idempotent. Check that the first accepted operation's result is unaffected.
- Video `finish()` in finalizing/finished returns the same completion promise. Finishing while a
  frame is active rejects without starting finalization; a failed/disposed state stays terminal.
- Recorder repeated `stop()` returns its existing stop promise; `finished` observes without stopping.
  Stop during pending start and pending pause/resume keeps existing completion/error behavior.

Preserve GIF encoded-frame commits versus video's input/audio/packet commits. Callback exceptions
remain ignored. Abort during initializing/encoding/finalizing must keep its reason; disposal from a
finished observer does not invalidate the committed successful Blob/result. No recorder observer
or unified progress shape is added.

### M3 positioned bytes and error propagation

Use valid writer traces starting with actual data coverage. Test writes ending on a page boundary,
crossing 65,536 bytes, appending small pieces, and rewriting overlapping earlier bytes without
shrinking the high-water length. Mutate the source Uint8Array immediately after the synchronous
write; final bytes must retain the snapshot. Compare concatenated used pages/Blob bytes to an
independent reference for those traces. Do not introduce arbitrary sparse-file semantics.

Replay representative MP4/WebM target writes, including rewound headers. Validate both the early
media-payload reservation and actual final endpoint/header checks. An exact inclusive output limit
passes; the first exceeding write fails before rejected-page allocation. Preserve format-specific
RangeError and first-error propagation through the adapter's guard, including errors reported by
non-throwing target observers. After abort/failure/disposal, queued vendor writes retain no new
pages but stream closure can finish. Reject incomplete output rather than returning a partial file.

Clear session-owned pages on success/failure/cancel. Read a returned Blob after disposal to confirm
its bytes survive. Use the same future helper tests for both container consumers; keep adapter tests
for vendor closure, metadata, track timing, AAC edits and Opus discards outside the storage helper.

### Cancellation and cleanup barriers

| Consumer | Controlled barriers |
| --- | --- |
| GIF | Pre-abort/factory, readback reentrancy, initial yield, between fallback chunks, Worker initialization, before/after raw transfer, opaque addFrame, finish; timeout/error/malformed ack and late replies |
| Offline video | Each support check, muxer/video/audio creation (including late resolution), initial output config, frame acceptance, PCM block, blocked muxer write, queue overflow, flush, track end and finalize; callback failure while otherwise idle |
| Recorder | Before capture, partial audio cloning/addTrack, pending start, pending pause/resume, stop/final chunk, duration-limit race, ended clone/video track, resize and native encoder error |

Use explicit entry/continue barriers and controlled fake tasks. Verify no later call or progress
after terminal outcome, no detached-buffer retry, and preservation of source canvas/PCM/original
audio tracks. Count disposal once for acquired export adapters; native recorder track cleanup
uses its own existing semantics. Native browser tests separately observe actual Worker closure,
fresh export on the same page and independent decoding. A fast AbortError alone is not cleanup proof.

## Independent file checks

| Result | Comparison and validity checks |
| --- | --- |
| GIF | Exact SHA-256/bytes for same codec/settings, independent LZW decode of every frame/pixel patch, dimensions/delays/repeat/final hold; sync/raw/fallback path evidence |
| Silent MP4/WebM | Independently demux/decode full file, frame count, per-frame PTS/durations, first presentation zero, variable/fractional timing and long final hold, dimensions/colors/native playback |
| MP4/AAC | Presentation sample count, 44.1/48 kHz mono/stereo, priming/edit-list and final endpoint/padding accounting, explicit trim/pad/strict errors, A/V markers and missing-priming negative control |
| WebM/Opus | 48 kHz mono/stereo, pre-skip/CodecDelay/final DiscardPadding, tiny endpoints, exact presentation samples, trim/pad and A/V markers with missing-discard negative control |
| MediaRecorder | Decode final chunk, pauses/limit/stopReason, clone ownership and A/V markers using capture-start accounting from [recording verification](../video-recording.md), not offline timestamp-zero rules |

Preserve the current per-profile container-tick/sample/decoder tolerances and negative controls in
[offline adapters](../offline-video-adapters.md), [AAC](../offline-aac.md) and [WebM](../offline-webm.md).
Do not loosen tolerances to make a refactor pass. Hardware/native codec bytes need not be identical;
use encoded-event replay for byte-exact M3 tests and semantic independent decode for actual video.

## Verification commands and packaging

For a runtime extraction affecting controllers/containers, the final integration gate includes:

```sh
npm test
npm run test:package
npm run test:browser
npm run test:next
```

Use focused mechanism/consumer tests during development. Full browser verification requires its
documented browser/audio environment; an unsupported skip is recorded, not counted as a passed
codec check. The existing CI matrix covers Node 22/24 on Linux/Windows, packed consumers, browser
video/GIF and Next.js; only a CI run on the actual candidate SHA establishes its result.

Compare emitted public declarations with baseline, including generic/readonly/optional members.
Compare runtime export keys, package `exports`, version and lockfile. Import controllers without
browser globals. Bundle dependency-graph checks must still see standalone controller/transport
entries; the GIF runtime keeps only the existing codec import. Test old copied Worker layouts and
Next.js default Worker URL resolution from an installed tarball. Keep licenses, maps, source
packaging and current MP4/WebM shared vendor chunks. No consumer should deploy an extra helper
asset because internal code moved. API snapshots must not be updated just to accept a changed API.

## Performance and memory evidence

For M1/M3, use identical frames/events, unchanged settings/codecs and paired before/after builds of
the actual refactor baseline. Record source hashes and assert actual raw/fallback selection.
Existing GIF comparison scripts pin older historical baselines (`09299d7` for raw Worker comparison,
`fe2f6f3` for chunking); running them unchanged cannot isolate a new extraction from `7362c6c`.
A later measurement change must freeze all required helper dependencies too, label the baseline
explicitly and keep historical reports intact. Do not mix runs from different source sets.

Begin with a correctness smoke; measure throughput/cancellation without active memory tracing,
memory separately with control/GC checkpoints, and repeated success/cancel operations while
retaining handles. Inspect distributions/pair order and increase repeats for an apparent regression.
For M3 compare write traces, logical output size, page counts and release; do not equate pages with
total native/Blob memory. No extra readback, owned full-frame copy, full-file concatenation or
unbounded queue should be introduced by extraction. Any measured tradeoff needs explanation or a
revised design; no universal speedup/memory-saving or leak-free claim follows from moving code.

Keep private footprint separate from JS/backing storage, report sampling overhead/failures, and
state the finite scope of cancellation/GC tests. Preserve [measurement limitations](../gif-worker-preparation.md).
Shared CI verifies output/ownership/cleanup; machine-dependent timing/memory thresholds stay out.

## Evidence record for each future slice

- Base/candidate SHA and dirty state, mechanism/consumers/build entries changed.
- Gates exercised, commands/environment, explicit new characterization vs reused tests.
- Declaration/export/package comparison and packed/browser/Next results; CI URL and exact SHA.
- File/timing/sample/ownership checks, output artifacts, hashes and raw/fallback branch evidence.
- Performance/memory results when relevant, unresolved failures/skips and reason to accept or reject.

The initial design task checked these documents and unchanged runtime/API/version files. The later
[M1 verification](shared-rgba-verification.md) records checks for the first extraction. The
[M2 evaluation](shared-deferred-evaluation.md) records characterization and prototype checks;
production M2/M3 gates remain pending if those extractions are later requested.
