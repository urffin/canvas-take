# GIF memory, cancellation and repeated exports

This developer benchmark compares the shipped synchronous gifenc and real module Worker adapters.
It uses existing factories and cancellation contracts; it changes no library API or codec implementation.

```sh
npm run benchmark:gif:lifecycle -- --quick  # smoke: one repeat, three repeated-session cycles
npm run benchmark:gif:lifecycle           # measured default: three repeats, eight cycles
npm run benchmark:gif:lifecycle -- --full # adds 1080p and 30-second GIFs; substantially longer
node scripts/analyze-gif-lifecycle.mjs benchmark-results/<printed-directory>
```

Install Chromium with `npx playwright install chromium` first. Run the benchmark by itself on an idle
machine with stable power settings. The command saves environment/commit/settings, full samples and
checkpoints in `results.json`, scalar runs in `results.csv`, sample GIFs, and `summary.md` under an
ignored timestamped `benchmark-results/gif-lifecycle-*` directory. The analyzer regenerates the report
and checks recorded resource invariants without re-running encoding. A failed invariant or timeout
produces a nonzero exit status and a partial report identifying the failed case.

## Method

The default memory matrix is 640×360 and 1280×720, three- and ten-second GIFs, 20 fps, 128 colors,
high quality, three repeats per adapter. Order alternates between adapter pairs. Both adapters receive
an excluded warm-up. The deterministic mixed-alpha moving-bar renderer is shared with the
[throughput benchmark](gif-benchmark.md); frames are generated sequentially, not preloaded in memory.
Completed files must be byte-identical across adapters/repeats for each configuration. An independent
gifuct-js decoder LZW-decodes each frame in turn and checks dimensions, frame count and delays;
it does not retain a whole animation's RGBA patches in the Node harness.

Memory is measured in a dedicated headless Chromium instance using
[Tracing.requestMemoryDump](https://chromedevtools.github.io/devtools-protocol/tot/Tracing/#method-requestMemoryDump).
Each sample sums `private_footprint_bytes` once per PID over all processes in that browser, including
allocations for Worker and native buffers visible in those process totals. This is Chromium's
platform-specific private footprint, **not JS heap, unique physical RAM or GPU VRAM**. RSS is retained
only if the platform supplies it for every process; unavailable fields stay null. The measured browser
does not include the Node decoder/runner or unrelated browsers and desktop applications.

Samples are requested 100 ms apart, after the previous request finishes. Each request starts and ends
its own short memory-infra trace, avoiding growth of one accumulated trace buffer across the export.
The report records actual sample counts/service times. The reported peak is a **sampled maximum**:
short-lived allocations can be missed and profiling can perturb scheduling/GC. It is not an exact peak
or a throughput comparison. No forced GC is requested while encoding or measuring cancellation.

Each case has a forced-GC baseline, a snapshot with the caller's canvas and successful output Blob held,
and a released snapshot after clearing those references and resetting/removing the canvas. Output
verification/transfer happens outside the peak/export timer; its allocator caches can affect the later
released private footprint. Main-isolate
[Runtime.getHeapUsage](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage)
JS used heap and ArrayBuffer/external-string backing storage are separate diagnostics. They overlap
process memory and are never added to its total. At cleanup no Worker isolate may remain. Full GC
diagnoses reachability; it is not the timing or reclamation policy a normal application will observe.

A positive control deliberately retains and touches a 32 MiB Uint8Array, then releases it. Backing storage
must detect the allocation and return within 1 MiB of its baseline after full GC. This tests the measurement
path, not a memory-performance threshold for the library. Private-footprint differences can retain JIT,
browser and allocator caches even when the buffer has gone.

## Cancellation and lifecycle checks

Cancellation runs have no active memory sampler or tracing. A one-millisecond deadline is armed at:

- `prepare`: entry to the real full-frame getImageData/readback, before the owned copy and existing yield;
- `blend`: the existing yield's resolver, immediately before the real alpha-compositing loop, using an
  all-translucent gradient; the observer neither adds a yield nor replaces the loop;
- `encode`: the real synchronous adapter entry, or a marker immediately before the real Worker handler.
  Only this Worker cancellation probe uses a bootstrap around the shipped runtime. Ordinary memory
  and repeated successful exports use the default shipped Worker URL.

The report separates overdue timer delivery, abort-call-to-operation-settlement and intended-deadline-to-
settlement. Measuring only the time after abort() would conceal main-thread blocking. Subsequent
render/snapshot/encoding work can delay delivery; these are caller-visible pipeline delays, not isolated
loop costs. Raw records retain delivery phase, accepted frames and encoder/Worker target completion
timestamps. Small frames can complete before the timer runs. The probe requests cancellation; it does
not preempt synchronous JavaScript.

The fourth frame is targeted after three real warm frames. For each adapter, eight repeated-session
cycles then alternate a successful two-second export and an encoding cancellation in the same page,
using a fresh owned encoder each time. Thus default mode measures 24 memory exports, 36 cancellations
and 32 repeated-session operations (92 cases, plus excluded warm-ups).

Each operation checks exactly one owned encoder disposal, no remaining abort/message listeners or
request timers, an unchanged source corner pixel, transferred/detached Worker frame buffers and matching native
Worker create/close events. CDP must independently show no remaining Worker targets. Cancellation must
produce aborted state/AbortError without finalizing a GIF; the next fresh export must decode and hash
correctly. Retention is reported as all post-GC checkpoints, their range and a Theil–Sen slope. This finite
session can reveal accumulation but cannot prove that no leak exists for every scene, browser or duration.

## Recorded results

Measured on **2026-11-04, 19:17–19:22 Europe/Moscow**. Command:
`npm run benchmark:gif:lifecycle` (the recorded invocation used the already built entry directly:
`node scripts/benchmark-gif-lifecycle.mjs`). AMD FX-8350, eight logical CPUs, Windows 10 build 19045,
Chromium 156.0.8078.4, Node 22.17.0, CanvasTake 0.5.0 at
`e283e972cbaa3f96c75729a64063ffe3180125a1`, benchmark tooling uncommitted. Total OS memory
15.97 GiB; free at start 2.19 GiB. These are measurements from a shared desktop session, not an
isolated machine or a general performance guarantee. No repeats or outliers were excluded.

**All 92 measured cases passed**, plus excluded warm-ups. Forty successful GIFs were independently
decoded; 52 cancellations produced no final GIF. All **47/47 Workers** (including warm-up) closed,
with no remaining Worker targets, request timers, tracked listeners or browser errors. Every encoder
was disposed once. A separate smoke run passed 32 cases; all 72 Node tests passed.

### Memory

Medians of three independent exports. Peak ranges are all three observed sampled maxima, relative to
each run's own forced-GC baseline. Held snapshots keep the caller canvas and output Blob alive; released
snapshots drop them and the export handle. MiB = 1,048,576 bytes. Negative deltas mean lower process
memory than that run's baseline, not negative allocation.

| Resolution | GIF s | Sync peak Δ MiB (range) | Worker peak Δ MiB (range) | Sync held Δ MiB | Worker held Δ MiB | Sync released Δ MiB | Worker released Δ MiB |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| 640×360 | 3 | 14.81 (10.81–15.40) | 73.66 (73.34–74.51) | 1.89 | 3.92 | -0.84 | 1.11 |
| 640×360 | 10 | 15.35 (14.02–15.79) | 86.90 (71.51–87.40) | 2.45 | 4.14 | -0.71 | 0.13 |
| 1280×720 | 3 | 36.88 (30.87–47.45) | 73.11 (70.32–91.84) | 6.09 | 8.93 | -0.54 | -0.87 |
| 1280×720 | 10 | 48.19 (47.13–52.48) | 115.12 (111.93–115.22) | 8.55 | 16.60 | -2.00 | -2.56 |

Worker had the higher sampled process-memory peak in this session. Moving the encoder off the main
thread is not a demonstrated memory reduction. Separate isolate/startup/GC budgets are plausible
contributors; this measurement does not attribute allocations to those causes. The longer output also
has to remain in memory until finalization, so duration-dependent growth during an active export is
expected from the current in-memory encoder and does not itself establish a leak.

The 32 MiB positive control increased backing storage by **33,554,432 bytes exactly**, then returned to
its baseline after dropping the reference and full GC. Its process private-footprint delta was +32.95 MiB
while held and +0.16 MiB after release. Across measured operations, released backing-storage deltas
were **0–31 bytes** and all memory-table medians were zero; this does not indicate accumulation of large
RGBA/index/encoder ArrayBuffers after the normal release workflow.

There were 329 active-export samples. Service-time median was **309.99 ms**, p95 **450.72 ms**, maximum
**2339.93 ms**; the extra 100 ms gap is added after each completed sample. Actual cadence is therefore
much coarser than 10 Hz. Short 360p/three-second exports had as few as three samples; 720p/ten-second
exports had at least 27/32 (sync/Worker). These peaks are lower-bound observations with intrusive
profiling overhead, not precise allocation maxima or a throughput result.

### Cancellation

Medians of three probes. Each cell is **deadline-to-settled milliseconds**, followed by the complete
three-run range. `prepare` and `encode` use the mixed scene; `blend` uses the translucent gradient.

| Target | Resolution | Sync ms (range) | Worker ms (range) |
| --- | --- | --- | --- |
| Readback/snapshot | 640×360 | 19.10 (18.80–19.80) | 6.10 (5.70–6.20) |
| Compositing boundary | 640×360 | 54.60 (54.50–55.90) | 8.10 (7.80–8.10) |
| Encoder entry | 640×360 | 33.50 (32.30–35.40) | 1.00 (0.80–2.40) |
| Readback/snapshot | 1280×720 | 77.50 (75.90–89.70) | 26.60 (26.50–28.40) |
| Compositing boundary | 1280×720 | 205.40 (201.50–213.50) | 32.90 (31.70–32.90) |
| Encoder entry | 1280×720 | 115.70 (113.10–116.30) | 1.00 (0.80–1.10) |

The operation settled roughly 0.0–0.2 ms after abort delivery in the median cases. Most observed delay
was therefore **before abort() could execute**, especially for the synchronous adapter. That adapter
accepted one extra frame in snapshot probes and two in blend/encoder probes; Worker accepted none
after the arm point. These are pipeline observations, not a claim that the alpha-compositing loop alone
took 205 ms. The Worker adapter still performs readback, the owned copy and alpha composition on the
main thread: its approximately 27–33 ms preparation-related delay at 720p remains visible.

### Repeated exports and release

Each adapter completed eight success→cancel cycles (16 operations) in the same page. The table shows
post-GC values after normal reference release, **not while intentionally retaining completed exporters**.

| Adapter | Private first→last MiB | Private range MiB | JS used change bytes | Backing first→last bytes | Backing slope bytes/op |
| --- | --- | --- | ---: | --- | ---: |
| Sync | 112.14→113.37 | 111.48–114.35 | +276 | 32,793→32,793 | 0 |
| Worker | 114.20→114.33 | 112.88–115.96 | +124 | 32,793→32,793 | 0 |

No retained large ArrayBuffer accumulation or surviving owned Worker was observed in these cycles.
Private footprint did not return to exactly its starting value; its changes cannot be assigned to either
allocator caching or a native leak by this finite experiment. Small JS/cache changes and eight cycles
do not prove that every longer-lived use pattern is leak-free. The report does not cover consumers
that retain Blob/download URLs or old exporter objects.

The next measurement-led candidate is reducing/bounding **main-thread preparation latency**, while
preserving output and snapshot ownership. The data does not justify changing encoder algorithms or
claiming that Worker minimizes memory. No production optimization or public API change is part of
this benchmark task.

Full raw checkpoints/samples, scalar CSV, independently decoded GIF fixtures and the generated report
are saved locally in `benchmark-results/gif-lifecycle-2026-11-04T16-17-46-575Z/`. These raw artifacts
are ignored by Git, following the existing benchmark convention. The tables above preserve the recorded
result in the repository. The analyzer regenerates the detailed report from that directory's `results.json`.
