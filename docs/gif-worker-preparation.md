# GIF preparation in the existing Worker

Available in 0.6.1. Public exports/types remain unchanged from 0.6.0.
The supplied adapter now negotiates raw RGBA preparation with its runtime. The controller still takes
a complete canvas snapshot and owned copy before returning from `addFrame()`; readback/copy remain
synchronous and source pixels/canvas ownership stay with the caller.

## Selection and compatibility

No new option is needed. The supplied encoder instance exposes a non-enumerable, configurable,
versioned private capability using `Symbol.for`, so independently bundled copies can cooperate.
It is an implementation detail, not a supported plugin interface. Public `GifFrameEncoder.addFrame()`
continues receiving opaque RGBA and keeps its existing behavior.

The initial timer yield is preserved. The private operation awaits initialization, then checks the
runtime's optional `rawPreparationVersion: 1`. A missing/unknown version declines **before** transfer
or mutation. The controller then composites in cooperative chunks and calls ordinary `addFrame()`.
Thus older/custom Worker files, old adapters and public-method-only wrappers continue to work.
An in-place `addFrame` decorator or unbound Proxy selects fallback so public hooks keep running.
An observer explicitly forwarding the private operation with the original encoder receiver can use
the raw path; dropping the capability selects fallback too.

For a supported runtime the adapter validates and transfers the owned full-span ArrayBuffer once
in `raw-frame-v1`, including the copied background and rounded frame duration. The same `blendRange`
used by the fallback composites in place inside the **existing** encoding Worker, then calls gifenc.
No pixel buffer returns to the calling thread. The runtime acknowledges only after encoding finishes;
the controller commits counters/progress once. The old `frame` action and `{ id }` acknowledgement
remain accepted by the new runtime, so older adapters can use newer runtime assets too.

The new raw acknowledgement carries a version marker. An invalid acknowledgement, Worker error,
timeout or postMessage failure is terminal. For a raw request, `timeoutMs` covers composition plus
encoding; initialization retains its own timeout. After handoff, fallback/retry with a detached buffer is
forbidden. Abort/disposal rejects pending initialization/frame work, clears request timers/listeners,
terminates the owned Worker and releases the controller snapshot. Late replies/continuations do not
submit frames or advance progress. Frame ordering, limits and backpressure remain unchanged.

Both sides validate raw dimensions/byte length, duration and background; partial views and shared
buffers are rejected. No second Worker, queue, buffer pool or required deployment asset is added.
The controller and transport stay standalone and codec-free. The runtime inlines the helper and
continues importing only `gifenc.js`; the usual runtime/codec deployment layout remains valid.

## Verification

Node tests compare byte-identical output across real raw Workers, transparent Proxies, frozen 0.6.0
runtime/adapter fixtures and public-method wrappers, with both qualities, palette settings, backgrounds,
alpha boundaries, repeat and rounded/final delays. They verify immediate snapshot ownership, intact
caller buffers, raw transfer, unknown capability decline, malformed input/acknowledgement, transfer
errors, timeout, cancellation during init/after handoff, one-time cleanup and ignored late responses.
Separate GC probes retain terminated exporters and verify raw snapshot collection after init cancellation,
handoff cancellation, codec failure and success. This is a reference-retention test, not total RAM proof.

Real Chromium/Firefox scenarios assert actual `raw-frame-v1`/`frame` selection, no main-thread chunks
on the raw path, decoded bytes and fallback on old/unknown runtimes. A sideband probe immediately before
the real raw handler triggers cancellation and verifies Worker closure and a fresh decodable export.
The normal runtime has no testing hooks. Initial browser fixture failures were traced to lost init
messages during dynamic import; fixtures use static imports, and the dynamic benchmark bootstrap queues
startup events until its runtime is ready.

## Reproducible comparison

```sh
npm run benchmark:gif:worker-preparation
# Short correctness/measurement smoke:
npm run benchmark:gif:worker-preparation -- --quick
# Also include ten-second memory cases:
npm run benchmark:gif:worker-preparation -- --full
# Ten paired repeats of mixed-alpha 1080p throughput:
npm run benchmark:gif:worker-preparation -- --throughput-study
node scripts/analyze-gif-worker-preparation.mjs benchmark-results/<recorded-directory>
```

The baseline is the actual controller/helper/adapter/runtime at `09299d7` (0.6.0), built from Git
history. Both variants use the same unchanged pinned gifenc implementation. Generated entry modules,
source hashes, raw JSON, summaries and GIF fixtures are saved under ignored
`benchmark-results/gif-worker-preparation-<UTC timestamp>/`. Baseline history must be present locally.
The observer preserves the private capability and **asserts raw message counts** on successful current
exports, avoiding accidental measurement of a wrapper-induced fallback. Ordinary memory cases use
the shipped runtime; only Worker-entry cancellation cases use the sideband bootstrap.

Memory profiling and timing run in separate lanes. Timing has no tracing or forced GC during export.
A 16 ms timer samples scheduling delay in throughput cases; these are scheduling observations, not
physical input latency. Cancellation arms a native timer 1 ms after snapshot entry, initial-yield
completion or real Worker frame-handler entry. The latter means codec entry for old opaque frames,
and preparation plus codec for raw frames. Pipeline deadline→settlement and abort→settlement are
reported separately; they are not isolated blend timings or a hard cancellation deadline.

The memory lane uses Chromium memory-infra `private_footprint_bytes` once per PID across the dedicated
browser, including its native/Worker processes. It is not RSS, VRAM or exact physical RAM. Both variant
pages stay open, one active at a time; per-case baselines include the same two idle pages. Main-isolate
JS heap/backing storage is a separate overlapping diagnostic, never added to private footprint.
GC runs only before/held/released checkpoints. A held checkpoint retains the caller canvas and result
Blob; release drops them, the exporter handle and resets/removes the canvas. Samples are intrusive,
finite sampled maxima, not exact transient peaks or throughput evidence. A retained 32 MiB buffer
control checks that the profiler notices backing storage and its subsequent release.

The raw path still allocates the immediate readback and owned full-frame copy. It changes where
composition runs, not the required RGBA size or compressed-output retention. A lower observed peak
would therefore be a lifetime/GC observation, not a fixed memory-saving guarantee. Failed CDP dump
requests are logged and retried at most three times using a fresh trace; failed data is never a zero
sample. Recorded sample service times include retries, and missed windows still limit peak accuracy.

## Recorded comparison

Recorded on 2026-11-05 (Moscow), AMD FX-8350, Windows 10 build 19045, Node 22.17.0,
headless Chromium 156.0.8078.4. Free RAM at start was 2.86 GiB of 15.97 GiB. The desktop was
not a controlled idle laboratory. Package version was 0.6.0 with uncommitted development changes;
the saved current entry hashes match the final built modules.

Main artifacts: `benchmark-results/gif-worker-preparation-2026-11-04T23-23-31-837Z/`.
The timestamp is UTC. All **182 cases** completed: 36 memory, 60 cancellation, 54 throughput and
32 repeated operations, plus two excluded warmups. Settings: 20 fps, 128 colors, high quality,
white background, alternating variant order. Memory uses three-second/60-frame GIFs in opaque,
mixed-alpha and translucent-gradient scenes at 720p/1080p, three repeats. Cancellation uses five
repeats per phase/resolution/variant. Throughput uses one-second/20-frame GIFs, three repeats,
three scenes and 360p/720p/1080p. These are finite clips, not a long-export or all-browser speed claim.

An earlier measurement attempt stopped after a failed CDP request; two development series were
interrupted while compatibility guards were finalized. None of those partial series contributes
to the numbers here. The completed run logged one failed dump, successfully retried. It collected
583 active memory samples: service median 370 ms, p95 544 ms, maximum **16,014 ms**, plus a nominal
100 ms gap. That long request/retry window can miss transient allocations; sampled maxima must
not be treated as exact peaks. Minimum samples per memory case were 7 (720p) and 15 (1080p).
The 32 MiB control added exactly 33,554,432 backing bytes and returned to a zero delta after release.
No timing/performance threshold was added to shared CI.

### Cancellation

Pipeline deadline→settlement, median of five repeats in ms. The deadline is one millisecond after
the selected boundary, not the time the abort callback finally runs:

| Resolution | Boundary | 0.6.0 | Raw Worker |
| --- | --- | ---: | ---: |
| 1280×720 | Snapshot/readback entry | 16.40 | 9.90 |
| 1280×720 | Initial yield / preparation handoff | 7.90 | 0.60 |
| 1280×720 | Worker frame-handler entry | 1.50 | 1.50 |
| 1920×1080 | Snapshot/readback entry | 30.10 | 23.60 |
| 1920×1080 | Initial yield / preparation handoff | 7.90 | 1.20 |
| 1920×1080 | Worker frame-handler entry | 0.90 | 1.30 |

At the 1080p handoff boundary the ranges were 7.70–8.30 ms before and 0.80–1.60 ms after.
Median abort-delivery→settlement was approximately 0.1–0.3 ms across the groups. Neither variant
committed an extra frame after the arm point in these gradient cases. The new path lets the timer
run while the Worker prepares pixels. Worker-entry measurements already had a free calling thread,
so that boundary did not show a consistent improvement.

The snapshot probe also measured a lower median in this run, but its readback/copy code remains
synchronous and unchanged. These pipeline observations do not establish that capture became
interruptible or that the observed values are a universal readback floor. Allocation, scheduling
and later work can affect when the abort task runs.

### Process memory

Sampled peak private-footprint increase over each case's post-GC baseline, MiB; median of three
repetitions, with the observed range. This includes both pages and Worker/native processes:

| Resolution | Scene | 0.6.0 MiB (range) | Raw Worker MiB (range) |
| --- | --- | ---: | ---: |
| 1280×720 | opaque | 95.25 (94.85–104.27) | 72.24 (71.30–99.13) |
| 1280×720 | mixed | 71.56 (69.25–76.71) | 75.00 (74.02–76.92) |
| 1280×720 | gradient | 79.37 (78.06–86.71) | 82.48 (77.18–88.09) |
| 1920×1080 | opaque | 126.87 (112.76–130.78) | 113.96 (112.63–126.34) |
| 1920×1080 | mixed | 124.47 (115.90–141.36) | 123.94 (117.20–129.53) |
| 1920×1080 | gradient | 138.84 (135.14–146.47) | 131.30 (127.77–137.95) |

There is **no consistent demonstrated memory reduction**: some medians decreased, others increased,
and ranges overlap. Timing of GC/allocation and finite sampling limit causal conclusions. The same
readback, owned RGBA copy and compressed GIF storage remain necessary. Post-release backing deltas
in memory cases ranged from −9 to +31 bytes, with zero median in every scene/resolution group.

### Unprofiled throughput and scheduling

One-second GIF export time, median of three runs in ms, including rendering/readback, startup,
preparation, encoding and finalization. The 16 ms timer's p95 is a sampled scheduling-delay
diagnostic, not physical input latency or a bound on uninterrupted work:

| Resolution | Scene | Export 0.6.0→raw ms | Timer p95 0.6.0→raw ms |
| --- | --- | ---: | ---: |
| 640×360 | opaque | 397.8→359.1 | 4.3→3.6 |
| 640×360 | mixed | 440.8→434.9 | 8.0→4.5 |
| 640×360 | gradient | 589.6→606.7 | 10.5→5.3 |
| 1280×720 | opaque | 1168.5→1171.9 | 16.8→12.5 |
| 1280×720 | mixed | 1475.4→1433.0 | 18.6→12.5 |
| 1280×720 | gradient | 2216.5→2211.2 | 24.0→23.3 |
| 1920×1080 | opaque | 2451.5→2363.0 | 31.4→27.9 |
| 1920×1080 | mixed | 3104.8→3375.9 | 25.9→25.5 |
| 1920×1080 | gradient | 4729.1→4790.8 | 54.7→50.3 |

Throughput did not improve universally. The largest median slowdown was mixed-alpha 1080p (+8.7%);
that case is examined with ten additional paired repeats below. Readback continues to cause sizable
scheduling stalls, including a current 50.3 ms timer p95 on 1080p gradients.

### Ten-pair throughput follow-up

The mixed-alpha 1080p case was repeated in a separate completed series:
`benchmark-results/gif-worker-preparation-2026-11-04T23-39-09-968Z/` (`--throughput-study`).
It uses the same final entry hashes, browser/machine, 20 frames and settings, ten alternating-order
pairs, and matched 1080p/20-frame warmups. Free RAM at this series' start was 5.18 GiB. Timing
excludes tracing/GC; memory checkpoints remain outside each export. Results are kept separate from
the original three-repeat matrix.

| Pair | 0.6.0 export ms | Raw export ms | Paired change |
| ---: | ---: | ---: | ---: |
| 1 | 2979.4 | 3079.2 | +3.35% |
| 2 | 2992.5 | 3111.0 | +3.96% |
| 3 | 3000.7 | 3085.5 | +2.83% |
| 4 | 3016.9 | 3138.7 | +4.04% |
| 5 | 2980.2 | 3183.3 | +6.81% |
| 6 | 3047.5 | 3163.5 | +3.81% |
| 7 | 3032.9 | 3110.4 | +2.56% |
| 8 | 2976.2 | 3112.3 | +4.57% |
| 9 | 3036.7 | 3080.2 | +1.43% |
| 10 | 3034.8 | 3181.7 | +4.84% |

The median paired change is **+3.88%** (+117.25 ms); all ten pairs are slower. The separate
variant medians are 3008.80→3111.65 ms (+3.42%), with ranges 2976.2–3047.5 and 3079.2–3183.3 ms.
Median timer scheduling p95 improves from 25.30 to 20.55 ms. Thus the original +8.7% magnitude
is not stable, but this follow-up supports a throughput cost for this scene on this machine;
it should not be dismissed as measurement noise. This is not an isolated blend/codec/GC study
and does not identify which component causes the cost or establish an all-device regression.

All 20 measured GIFs have one identical SHA-256, 400 independently decoded frames and correct
raw/fallback selection. All 22 Workers including warmups closed, with zero browser errors.
The additional series is not folded into memory/cancellation results. The former fallback-only
preparation benchmark also passes its final quick run, asserting zero raw-frame messages.

### Repeated sessions and output

Each variant completed eight success/cancel cycles in the same page (16 operations). After reference
release and GC, backing storage remained constant at 35,327 bytes for 0.6.0 and 38,111 bytes for raw,
with zero slope. JS used-size first→last changed by −72 bytes before and +21,836 bytes after.
Private footprint first→last was 156.34→158.94 MiB before and 158.34→158.39 MiB after.
This finite study did not show accumulation of large RGBA buffers, but small heap/cache growth and
native retention cannot be classified as leak-free behavior from eight cycles alone.

All **106 completed measured GIFs** matched across variants/repeats by SHA-256 and were independently
LZW-decoded (3,560 frames). Every successful current export asserted the expected raw-frame count.
All **184 constructed/loaded Workers closed**, including warmups; owned request timers/listeners,
abort listeners and preparation ports were cleared, source corner pixels stayed intact and no Worker
CDP target survived cleanup. Page/console errors were zero. The analyzer revalidated all 182 resource
and path-selection records. Current built entry hashes match the saved measured modules exactly.

Validation: 88 Node tests; full GIF browser suite 24 passes, followed by six focused final-guard cases
in Chromium/Firefox; isolated packed TypeScript/runtime consumer; final installed-tarball Next.js/
Turbopack build. Public declarations/exports are unchanged, and package/lock version remains 0.6.0.
This change adds no public preparation option and does not publish a release.
