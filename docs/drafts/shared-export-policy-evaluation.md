# Remaining export policies: extraction evaluation

Status: evaluated 2026-11-12 against `ae558ab7ee8dcfc75f41f14dddc515477fa92bd6`.
This assessment completes the reassessment after M1 RGBA, M2 deferred and M3 paged bytes in the
[design](shared-export-mechanisms.md). It changes documentation only: no candidate helper, runtime,
public type/export, Worker protocol, package version or dependency change. Version remains 0.6.0.

## Decision

Keep timeline, buffer lifetime, cancellation and progress policy in their current consumers.
Share their compatibility rules and test scenarios. No further production extraction is justified
by the current code. This is a decision for the audited consumers, not a prohibition on future reuse.

| Candidate | Benefit considered | Decision and cost |
| --- | --- | --- |
| One timeline/interval accumulator | Centralize validation, rounding and duration limits | Reject across GIF/video/recording: clock, commit point and limit outcome differ |
| Pure integer rescaling within video adapters | Reduce repeated sample/time arithmetic | Defer: potentially reusable mathematics, but signedness, ties, overflow checks and error origins need a separate numeric contract and measured maintenance benefit |
| Common snapshot or resource owner | Centralize copying, transfer and cleanup | Keep local: copy points, ownership handoffs and release operations differ; reuse M1/M3 where already applicable |
| Common cancellation scope or operation runner | Centralize promise races, first failure and disposal | Reject a cross-controller engine; a smaller scope still needs policy callbacks for acquisition, queues, tasks and tracks, with no demonstrated simplification |
| Shared progress state/counters | Centralize phases and completion percentage | Reject: acknowledgement, input acceptance and muxed packets are different facts; recording has no progress API |
| Frozen observer notification helper | Deduplicate `try`/optional callback/`Object.freeze` | Defer: only two short reporters; construction timing, invocation receiver and reentrancy must remain intact, so the small saving does not currently justify another boundary |

The acceptance conditions are in [remaining-policy extraction gates](shared-export-compatibility.md#remaining-policy-extraction-gates).
They are conditions for a later implementation, not tests passed by an unimplemented abstraction.

## Timeline evidence

The [GIF controller](../../src/gif.ts) rounds **each** supplied delay to 10 ms, checks limits before
readback, and commits frames/duration only after preparation and encoder acknowledgement. Repeat
loops are playback metadata, outside `maxDurationMs`. The input delay can be fractional.

The [video controller](../../src/video.ts) validates safe-integer contiguous microsecond boundaries,
starting at zero. It registers expected packet intervals before encoding; accepted-frame duration
commits after video input and audio feeding succeed. Audio targets come from the absolute video end,
and PCM blocks use absolute sample offsets. `frameRateHint` does not synthesize timestamps.

The [recorder](../../src/index.ts) accounts `performance.now()` segments at native start/pause/resume
events and stopping, with paused time excluded. Its duration limit requests a successful stop and
retains final data. It neither receives explicit frame intervals nor controls MediaRecorder's
encoded timestamps. The same name `maxDurationMs` in GIF and recording does not imply the same policy.

Concrete counterexamples to a generic clock:

| Input/rule | Current result | Incompatible shortcut |
| --- | --- | --- |
| Two GIF frames of 14.9 ms | 10 + 10 = 20 ms; a 20 ms limit accepts both | Round the summed input 29.8 ms to 30 ms |
| Two video intervals of 34 us, audio at 44,100 Hz | Absolute endpoints map to 1 and 3 samples; increments are 1 then 2 | Round each interval to 1 sample and accumulate only 2 |
| AAC at 48,000 Hz, offset -3 samples | Signed nearest/half-away-from-zero conversion gives -63 us | `Math.round(-62.5)` gives -62 us |
| Recording 40 ms, pause 1,000 ms, recording 60 ms | 100 ms active time; duration-limit stop can succeed | Use elapsed wall time, frame count/fps or offline failure-on-limit semantics |

[AAC `us`](../../src/video-aac.ts), [Opus `timestamp`](../../src/video-opus.ts),
[MP4 ticks/sample conversion](../../src/video-mp4.ts) and the video controller's `rounded` use
related arithmetic. They are not identical validators: the controller's helper accepts nonnegative
results and checks safe integers; audio packets need negative priming timestamps; MP4 maps absolute
boundaries to 57,600 Hz ticks and rejects collapsed intervals. An eventual pure rescaler may share
arithmetic while those wrappers stay local. Do not introduce it as a universal timeline or replace
endpoint differences with rounded per-frame deltas. APNG/WebP timing requirements have not been
evaluated here and are not evidence of a second compatible consumer.

## Ownership evidence

| Boundary | Existing responsibility | Why one owner/copy routine is insufficient |
| --- | --- | --- |
| Caller canvas to snapshot | GIF preparation copies immediately, before its initial task yield; video copies and composites synchronously before its first yield | GIF keeps default readback arguments, video requests sRGB; validation errors/order and scheduling differ |
| Snapshot to GIF adapter | Fallback hands off an owned opaque array; negotiated raw Worker path transfers the owned raw buffer | Decline must precede mutation/transfer; decorators, old Workers and third-party encoders retain the opaque path; no retry after transfer |
| Prepared PCM to codec | Video copies source planes before initialization awaits, then creates independent bounded blocks | A source plane and a transferable block have different lifetimes; one shared backing buffer would let transfer detach retained input |
| Codec output to muxer | Video validates and copies config/packet bytes before asynchronous serial writes; write acknowledgement follows muxer consumption | These bytes have a queue reservation and acknowledgement contract absent from GIF and recording |
| Adapter/native lifetime | Video releases acquired and late-created adapters; GIF owns one synchronously created encoder plus preparation tasks; native codecs close temporary VideoFrame/AudioData | The release operations and acquisition windows differ; a disposable bag would still need domain policy |
| Recording tracks | Recorder owns capture tracks/audio clones and event listeners, including partial clone/addTrack failure paths | Caller originals must survive; track cleanup is not the export adapter registry's exactly-once-dispose contract |
| Completed output | M3 owns MP4/WebM pages; GIF copies complete encoder bytes into a Blob; recorder assembles Blob chunks | Paging GIF bytes or live chunks adds an unnecessary copy; caller-owned completed Blobs survive later cleanup |

[Preparation](../../src/gif-preparation.ts), [Worker adapter](../../src/gif-worker.ts),
[native video](../../src/video-webcodecs.ts), [native audio](../../src/video-opus.ts) and
[M3 verification](shared-paged-bytes-verification.md) show these concrete boundaries.
Clearing a registry/reference cannot preempt a running synchronous codec, reclaim every local in a
pending adapter promise or guarantee immediate physical memory release. Keep the finite GC/Worker
checks and their limitations; a generic owner would not establish a stronger memory guarantee.

## Cancellation evidence

The similar promise races serve different admission and completion rules:

- GIF creates its encoder synchronously. `operation` admits only `ready`, keeps public state
  `encoding` while finalizing, races pending work with cancellation and checks activity around
  preparation/adapter calls. Abort sets state/reason, rejects cancellation, cleans up and reports.
  Repeated `finish` is rejected; cancellation of an owned task or Worker also needs actual cleanup.
- Video asynchronously checks support and acquires muxer/video/audio instances. `end` records the
  terminal outcome, rejects the cancellation promise, aborts the adapter signal, rejects in-flight,
  queued and idle waiters, cleans up and reports. Factories resolving later are still released.
  Cached `finish()` identity and component/cause wrapping are part of the existing contract.
- Recording has no AbortSignal option. Manual/limit `stop` completes with final data; `dispose`
  rejects unfinished recording with its existing Error. Native error/track/resize events, pending
  start/pause/resume and stop races have their own completion rules. `finished` observes completion
  without initiating it; repeated `stop` shares its promise.

A common `Promise.race` does not dispose late acquisitions, cancel a scheduled GIF task, release a
transferred Worker buffer or await final recorder data. An abstract scope needing callbacks for all
those policies would relocate rather than remove the complexity. Keep reentrant cleanup and first
outcome guards local. Do not normalize existing truthiness/nullish checks, signal reasons, error
wrapping or post-success `dispose` state changes as an incidental extraction. M2's
[promise evaluation](shared-deferred-evaluation.md) remains applicable; its helper stays local too.

## Progress evidence

Both offline controllers call synchronous observers with frozen snapshots and ignore synchronous
observer exceptions, but snapshot contents and report points belong to their controllers:

- GIF has no initial `initializing` notification. `framesEncoded` and rounded duration advance
  together only after acknowledgement. `finalizing` is a progress phase while state is `encoding`.
- Video reports initialization, successful muxer events, accepted frames and finalization. Muxed
  packet counters can advance while `framesAccepted` is still zero. Accepted audio blocks can
  advance before a later block fails, without committing the frame. Config/end events can report
  progress without advancing packet counts. A successful input can report before delayed packets.
- `totalFrames` is an optional hint, not a cap or percentage denominator. Video's `outputBytes` is
  absent until successful finalization. Keep absent keys absent, rather than assigning `undefined`.
- A finalizing observer can cancel; a finished observer can dispose after success is committed.
  Do not batch/queue these callbacks, await an observer, roll back success, or freeze one mutable
  object and reuse it for all reports. Existing async-observer rejection behavior is not extended.
- An encoding observer can cancel after counters commit, causing the pending `addFrame` to reject
  while those committed counters remain. Promise success and counter commitment are not one event.
- Recording has no `onProgress`, counters or corresponding subscription surface.

Even a notification-only helper needs care. Current optional calls build no snapshot when the
observer is absent. An eager `notify(observer, snapshot)` would change that. GIF invokes a captured
function; video invokes a property of its private config object. Removing that receiver changes
observable JavaScript behavior, although neither API documents a useful callback `this` value.
Any extraction must characterize invocation without promising a new public receiver contract.
Snapshot construction must stay inside the current protected synchronous call path. Retain the
surrounding active/terminal guards; a wrapper cannot own those state transitions.

## Existing evidence and remaining work

Source audit and existing tests support this decision; no prototype of a new shared scope, clock,
owner or notifier was implemented or declared compatible. The following existing suites were
rerun on the unchanged M3 build on 2026-11-12:

```sh
node --test test/gif.test.mjs test/gif-worker.test.mjs test/gif-preparation.test.mjs test/gif-raw-worker.test.mjs test/offline-video.test.mjs test/recorder.test.mjs
```

Result: **70/70 pass**, no skips. Local log: ignored
`benchmark-results/shared-policy-evaluation-tests.log`.

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| [GIF](../../test/gif.test.mjs), [preparation](../../test/gif-preparation.test.mjs), [raw Worker](../../test/gif-raw-worker.test.mjs) | Immediate owned snapshot, delay/decode behavior, cancellation/task/transfer barriers, retention checks and late replies | A generic ownership/scheduling scope or every possible third-party adapter behavior |
| [GIF Worker](../../test/gif-worker.test.mjs) | Throwing/cancelling/finished-disposing observers, acknowledged counters, limits before readback, old/current Worker behavior | Complete ordering of all possible reentrant observer actions |
| [Video](../../test/offline-video.test.mjs) | Explicit/fractional intervals, PCM/sample clock, copied packets, transfer safety, blocked sinks, cancellation at ten barriers, late acquisitions, listener cleanup and promise identity | Exhaustive ordered packet/input/audio counter traces or every terminal observer combination |
| [Recorder](../../test/recorder.test.mjs) | Controlled active clock, pauses, long timer segments, limit/transition races, final data, clone ownership and partial acquisition failures | Offline cancellation/progress semantics or control of native encoded timestamps |

Before moving any of these policies, add baseline characterization for the missing cases in the
linked gates, especially complete progress tuples under delayed video and partial PCM failure,
reentrant encoding/terminal observers, callback invocation details, and reason/cleanup ordering.
Do not infer complete coverage from this regression count. If only one domain needs a helper,
evaluate it in that domain instead of requiring all three controllers to adopt it.

The existing full integration [CI on the baseline](https://github.com/urffin/canvas-take/actions/runs/43115486384)
passed all six jobs before this documentation task. It is historical runtime evidence, not a new CI
run for these documents. Runtime/build/tests/package files remain unchanged; browser/Next/packed
consumer checks and performance benchmarks are not rerun for this documentation-only assessment.
No speed, memory reduction or universally faster cancellation is claimed.

The three scalar arithmetic counterexamples above were checked independently; they do not validate
a proposed rescaler or replace codec/container tests. Documentation checks cover five changed files,
155 local links, ten Markdown anchors and whitespace/newlines, with unchanged runtime/build/tests,
package metadata and lockfile.

## Conditions to revisit and next step

Reconsider a **specific small mechanism** when there are at least two concrete consumers with the
same semantics, a maintenance problem or measured benefit, passing baseline/candidate traces, and
an acceptable standalone bundle/Worker packaging result. Keep validation, error messages and domain
commit points outside a pure arithmetic/byte helper. A future format may supply evidence, not
automatic authorization for a new abstraction.

The remaining stage-4 assessment is complete with local policies retained; it is not an unfinished
universal-engine implementation. External receivers/streaming still require a separate API and
container capability proposal. The next functional roadmap item, only on request, is APNG adapter
design with its own frame/delay/transparency/ownership/cancellation and decoder acceptance criteria.
This task does not implement APNG, add streaming, commit/push or publish a release.
