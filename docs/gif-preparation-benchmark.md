# Cooperative GIF preparation: latency comparison

Included in version 0.6.0 with the existing public GIF API. Measurements below were recorded
on the development tree at version 0.5.0 before release preparation.
This report compares the controller at `fe2f6f397a311e3b70ea4aae05840ba144a9b2b3`
with cooperative alpha composition. Preparation in the encoder Worker was designed in the
[separate proposal](drafts/gif-frame-preparation.md).

The subsequent unreleased implementation is measured separately in the
[Worker preparation report](gif-worker-preparation.md). This historical study and its command
deliberately retain main-thread cooperative preparation through public-method wrappers.

## Implementation

The controller still reads the entire canvas and makes an owned pixel copy **before returning
from `addFrame()`**. Composition uses the same alpha-255 shortcut and channel rounding, in
16,384-pixel blocks. A task stops at approximately 4 ms or 1,048,576 pixels; the budget can
overshoot by a block, GC or system scheduling. It is an internal tuning target, not a deadline.

The initial yield remains a zero-delay timer. Further chunks use MessageChannel when available,
otherwise timers. Each continuation closes both ports. Abort/disposal cancels the pending task,
settles its waiter and clears the owned snapshot. Late callbacks check their identity before
doing anything. After composition the helper hands off its buffer and drops its reference before
awaiting the adapter. No partially composited frame reaches an adapter or advances progress.
The helper is bundled into the standalone, codec-free controller; no new public entry is added.

The synchronous snapshot/copy and calling-thread quantization/LZW remain uninterrupted. This
change improves preparation responsiveness, not every possible phase of GIF export.

## Reproduction

```sh
npm ci
npx playwright install chromium
npm run benchmark:gif:preparation
npm run benchmark:gif:preparation -- --tune
# Smaller correctness/smoke matrix:
npm run benchmark:gif:preparation -- --quick
```

The runner needs the baseline commit in local Git history. It builds old/current controllers
from source, saves their generated plain and instrumented modules, alternates variant order
between pairs and uses fresh encoders/Workers. Results and GIF fixtures are saved under ignored
`benchmark-results/gif-preparation-<UTC timestamp>/`. There are no performance thresholds in CI.

Recorded runs on 2026-11-04 UTC: AMD FX-8350, Windows 10 build 19045, Node 22.17.0,
headless Chromium 156.0.8078.4. Main-run free RAM was 2.76 GiB of 15.97 GiB. This is one
machine/browser under ordinary desktop load, not an idle laboratory or a cross-browser speed claim.

- Tuning: `gif-preparation-2026-11-04T20-32-10-971Z`, 140 cases, five repetitions,
  720p/1080p translucent gradients, baseline plus identical A/A control and five scheduling candidates.
- Main: `gif-preparation-2026-11-04T20-35-41-727Z`, 398 cases. Three scenes
  (opaque, mixed transparency, translucent gradient), 640×360/1280×720/1920×1080,
  both real adapters. 90 isolated timing, 180 timer-cancellation, 108 throughput and 20 input cases.
- Five repetitions for timing/cancellation/input; three for throughput. Successful exports have
  three frames of 50 ms, 128 colors, high quality and background `[20,40,60]`.
  This study does **not** establish long-export throughput or process-memory behavior.

Timing uses a no-codec adapter to isolate composition tasks; probes bracket each preparation task.
The synchronous `addFrame()` prefix and actual `getImageData()` duration are recorded separately.
Their difference includes copying and controller overhead, not a pure copy-only measurement.
Throughput uses plain, uninstrumented controller modules and the actual codec adapters.
Cancellation arms a native 1 ms timer at the first composition task; subsequent blocking work
remains included. A short post-settlement drain checks for late work and is excluded from timing.
No tracing, memory sampling or forced GC runs during these measurements.

## Scheduler selection

1080p gradients, three frames, medians of five runs. “Max task” is the median of each run's
largest composition task. The cancellation column is deadline→settlement for a no-codec adapter,
so it must not be compared directly with real-codec results below.

| Candidate | Export ms | Max task ms | Cancellation ms | Timer missed before five-frame cap |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 359.6 | 69.0 | 237.4 | 0/5 |
| Identical baseline control | 365.6 | 68.8 | 245.1 | 0/5 |
| Timers, 2 ms | 826.1 | 2.5 | 3.6 | 0/5 |
| Timers, 4 ms | 593.7 | 4.5 | 7.8 | 0/5 |
| Timers, 8 ms | 457.3 | 8.5 | 15.5 | 0/5 |
| MessageChannel, 4 ms | 380.5 | 4.6 | 7.6 | 0/5 |
| scheduler.yield, 4 ms | 360.5 | 4.5 | 539.0* | 5/5 |

`*` The last row completed all five frames before its cancellation timer executed; 539.0 ms is
deadline→**successful completion**, not successful cancellation latency. The same happened in all
five 720p scheduler cases (244.7 ms median). Smaller tasks alone do not establish cancellation fairness.
The A/A export medians differed by 0.2% at 720p and 1.7% at 1080p; tails varied more.

MessageChannel was selected to avoid the measured timer overhead while preserving cancellation
opportunities in these cases. The production implementation retains the initial timer boundary;
tuning candidates used their respective scheduler for that boundary too. The main comparison below
measures the actual production combination. Timer fallback is covered by deterministic tests, not
claimed to match MessageChannel throughput. Browser task interleaving can differ.

## Composition tasks and timer cancellation

Gradient-only task timings, excluding snapshot and codec; medians of five runs:

| Resolution | Max task before→after ms | Pooled task p95 before→after ms |
| --- | ---: | ---: |
| 640×360 | 11.2→4.4 | 12.2→4.5 |
| 1280×720 | 35.4→4.6 | 36.2→4.5 |
| 1920×1080 | 67.1→4.6 | 88.8→4.5 |

The largest preparation task observed in the current variant's entire isolated timing matrix
was 5.7 ms. This finite result is not a hard upper bound. At 1080p the synchronous prefix still
took about 55.3 ms per gradient frame (including 49.0 ms readback), versus 56.5/49.3 ms before.
The optimization leaves that substantial initial stall in place.

Timer deadline→settlement with real codecs on gradients, medians of five repetitions:

| Resolution | Sync before→after ms | Worker before→after ms |
| --- | ---: | ---: |
| 640×360 | 54.8→7.9 | 13.8→9.3 |
| 1280×720 | 224.1→8.4 | 38.1→9.2 |
| 1920×1080 | 423.5→7.6 | 71.4→8.6 |

The current 1080p ranges were 7.3–8.3 ms sync and 8.3–9.0 ms Worker. No frame was submitted
in the current gradient cancellation cases; baseline medians submitted two with sync and one
with Worker. This improvement partly avoids subsequent codec work and another snapshot: these
are pipeline measurements, not just alpha-loop speedups. Tiny/opaque frames can still finish
composition and enter the synchronous codec before the timer can run.

## Trusted browser input

Playwright sends a native trusted button click after receiving the first-preparation marker.
The metric starts at the click event's `timeStamp` and ends at settlement; it includes event queueing,
not the earlier automation transport/coordination. Five repetitions, 1080p gradients:

| Adapter | Event→settled before→after ms | Event→handler before→after ms |
| --- | ---: | ---: |
| Sync | 207.6→4.9 | 207.6→4.6 |
| Worker | 0.8→4.2 | 0.6→4.1 |

The Worker result worsened by 3.4 ms in this probe. The baseline can already be waiting for Worker
encoding when the click arrives, whereas the new path can still be composing a chunk. Actual input
arrival does not target the same exact instruction in both variants. Do not infer universal input
improvement from the timer result or hide this phase-dependent tradeoff. Physical input devices and
other browsers were not latency-benchmarked.

## Throughput and output

Three-frame export time, median of three runs; includes rendering, readback, composition,
codec, Worker startup where applicable and finalization. No timing probes:

| Resolution | Scene | Sync before→after ms | Worker before→after ms |
| --- | --- | ---: | ---: |
| 640×360 | opaque | 41.4→38.9 | 89.8→86.5 |
| 640×360 | mixed | 53.4→50.5 | 109.5→94.3 |
| 640×360 | gradient | 78.4→78.0 | 140.0→127.3 |
| 1280×720 | opaque | 176.9→162.8 | 225.4→227.0 |
| 1280×720 | mixed | 209.3→195.9 | 276.6→242.8 |
| 1280×720 | gradient | 296.4→299.2 | 348.5→351.3 |
| 1920×1080 | opaque | 348.4→331.1 | 405.1→398.5 |
| 1920×1080 | mixed | 429.0→420.1 | 491.9→483.0 |
| 1920×1080 | gradient | 660.6→635.0 | 704.6→701.1 |

The largest median slowdown here was about 0.9%; three throughput repetitions and desktop load
do not establish a general speedup or rule out regressions elsewhere. The intended improvement
is shorter uninterrupted preparation work. All 108 real-codec GIFs were independently LZW-decoded
and matched by SHA-256 across baseline/current, adapters and repeats (324 decoded frames).

## Cleanup and correctness

All 398 main cases passed resource checks: one adapter disposal, zero remaining tracked timers
and ports after drain, matched Worker constructor/termination counts and zero surviving Worker
CDP targets. All 154 constructed Workers were terminated; 153 reached Playwright's loaded-Worker
event and all 153 closed. One was terminated during startup before that event. The current variant
also had zero tracked preparation timers/ports **at settlement**; the baseline could leave its initial
timer queued until the drain. No page errors were observed.

Deterministic tests exercise both port scheduling and timer fallback, cancellation before/between
chunks, original abort reasons, stale callbacks, concurrent calls, exact opaque pixels and immediate
snapshot ownership. A separate `--expose-gc` process deliberately retains aborted, disposed,
failed and completed exporters; WeakRefs verify all four owned RGBA snapshots become collectible.
This checks controller references, not total native/process memory or a guaranteed GC schedule.
Real Chromium/Firefox tests hold a real chunk continuation, cancel via a trusted click, verify closed
ports/no partial frame, then independently decode a fresh export with each real adapter. That hold
and a synthetic clock make the functional boundary deterministic; they are not latency measurements.

Validation: 78 Node tests, 18 GIF browser tests across Chromium/Firefox, the isolated packed
TypeScript/runtime consumer and Next.js/Turbopack production build passed. Generated public GIF
declarations matched the baseline; the measurement candidate used package/lock version 0.5.0.
Release 0.6.0 includes this implementation with the same public GIF contract.

The next separate stage is raw-RGBA preparation in the existing Worker. No codec changes,
public scheduling knobs, protocol negotiation or new release are included in this implementation.
