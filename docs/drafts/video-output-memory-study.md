# Offline video output memory: measurements and prototype checks

Date: 2026-11-14. Research based on 0.8.1; no new version or public API.
See the [design](external-video-output.md) and [draft contract](external-video-output-api.d.ts).
The full persistent-profile matrix completed. The [compact results](video-output-memory-results.json)
record exact counters, medians/ranges, hashes and lifecycle outcomes; raw media/checkpoints stay local.

## Results

Windows, Node 22.17.0, Playwright Chromium 156.0.8078.4. Each table cell summarizes three
successful silent exports. MiB means 1,048,576 bytes. Process growth is relative to that export's
initialized checkpoint; it is not the absolute footprint of Chromium.

| Format | Seconds | File MiB | Peak Blob pages MiB | Peak receiver snapshot MiB | Median sampled private growth, Blob / file MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| H.264 MP4 | 60 | 101.33 | 101.38 | 1.06 | 254.82 / 81.20 |
| H.264 MP4 | 180 | 303.61 | 303.63 | 1.06 | 746.31 / 79.37 |
| VP8 WebM | 60 | 37.22 | 37.25 | 0.18 | 125.91 / 77.84 |
| VP8 WebM | 180 | 110.99 | 111.00 | 0.18 | 270.13 / 79.71 |

| Format / seconds | Sampled private-growth range, Blob / file MiB | After disposal + GC, result retained: median growth Blob / file MiB | After result release + GC: median growth Blob / file MiB |
| --- | ---: | ---: | ---: |
| MP4 / 60 | 187.76–294.07 / 48.75–121.19 | 113.86 / 5.64 | 16.93 / 17.55 |
| MP4 / 180 | 721.04–751.41 / 78.59–86.05 | 320.58 / 3.30 | 15.54 / 11.32 |
| WebM / 60 | 102.81–131.60 / 47.67–78.51 | 38.95 / −0.95 | 17.68 / 19.50 |
| WebM / 180 | 264.88–314.92 / 64.18–84.67 | 114.45 / 0.07 | 11.23 / 14.43 |

The last column uses **page-ready**, rather than initialized, as its reference and includes download
cache effects. Negative relative values mean below the initialized checkpoint, not negative memory.
Complete ranges for these states and heap/backing counters are in the JSON snapshot.

The receiver removes the output-length-proportional page store in these workloads: tripling
duration triples retained page capacity, while its largest owned write stays 1,113,597 bytes for
MP4 and 191,939 bytes for WebM. Sampled process growth also falls substantially here, but is noisier
and larger than the receiver snapshot. This does not establish constant total RAM at arbitrary
duration/resolution or with long PCM tracks. Residual process growth after releasing the result
is also visible; closure/ownership counters are not a promise that native caches return to zero.

All 28 normal outputs were fully decoded: **69,312 video frames**. Each file-mode result had a
physical OPFS backing file with its exact output length (14 confirmations). One memory-dump
request failed and succeeded on retry; it was not substituted with zero. Hash comparison and the
independent final sample/block interval check accompany the linked JSON snapshot.

## Method and boundaries

Two isolated bundles reuse current source and real WebCodecs. Baseline retains 64 KiB output
pages and returns a Blob. External writes to a new owned OPFS file and returns a receipt.
A fresh persistent browser profile and its single initial page are used per memory case:
640×360 opaque deterministic noise,
24 fps, 60/180 seconds plus a 250 ms final hold, requested 2 Mbit/s. Each cell runs three times,
alternating target order. Noise and the current one-input/flush encoder behavior can yield files
well above the requested bitrate; actual sizes are reported.

Disk-backed OPFS is a required measurement condition. The driver checks a physical storage file
inside its own temporary profile with the exact final output size **before** downloading it.
It closes the context and removes only its verified, newly created profile directory. User profiles
and tabs are never attached. An initial full incognito run is kept as a separate
[memory-filesystem control](video-output-memory-incognito-results.json): Chromium documents
[memory-backed incognito and disk-backed normal filesystem implementations](https://chromium.googlesource.com/chromium/src/+/main/storage/browser/file_system).
That initial run must not be used as evidence for disk-output memory savings. Its 28 exports and
decoder results remain valid; its target/storage mode answers a different question.

The measured boundary includes browser native codec/storage work and the input scene, excluding
the Node driver and independent FFmpeg decoder. Checkpoints: page-ready after GC, initialized,
25/50/75/100% frames, finished result retained, disposed result retained after GC, and result
released after download/GC. Downloads and decoding follow the retained-result samples; the final
release checkpoint consequently also includes their cache effects.

Chromium memory-infra gives per-process private footprint and optional resident totals. The
existing sampler deduplicates PIDs, never counts a failed dump as zero and records retries.
Page `Runtime.getHeapUsage` is separate and does not replace native/browser-wide memory.
Summaries use sampled maxima and medians, not guaranteed instantaneous peaks. GC is forced only
at named checkpoints. Encoding time includes measurement pauses on a shared machine; it is diagnostic.

Exact counters record baseline page capacity and receiver current/peak owned snapshots. They omit
vendor staging, stream queues, native allocations, OS file cache and transient Blob-construction
overlap. File size is high-water length; rewrite traffic is separate. Process private footprint
does not measure all machine memory or imply immediate RSS reclamation after disposal.
Blob backing storage is browser-managed too: page capacity during encoding and memory with the
finished Blob retained are different quantities. Neither is inferred solely from final file size.

Long memory cases are **video-only**, isolating the output change. Short real AAC/Opus cases check
A/V completion with prepared PCM, not long-audio memory. The controller's PCM snapshot and caller
retention must be budgeted separately; an external output cannot remove those allocations.

All results are independently demuxed/copied and completely decoded by FFmpeg. Frame count,
packet timestamps, container duration, final hold and short-case presentation audio samples are
checked. A separate post-measurement pass also checks the final MP4 video-track/packet interval
and WebM BlockDuration, independently of the container's aggregate duration. Existing independent
MP4/WebM readers check metadata; the encoder's own decoder is not used. Source/build/harness
hashes accompany the results.

## Earlier harness observations

Initial smoke setup used wrong helper-reader property names and an incorrect Opus factory name;
these were corrected in the harness. The later Opus file-output failure had the actual cause
`Opus maxPendingBytes/maxPendingInputs output budget exceeded`. Its default-small-queue snapshot
and log are retained separately. Long video uses 4 pending inputs; short A/V success cases explicitly
use 32. The separate slow-output experiment varies this budget instead of hiding the constraint.

These development observations are not reasons to skip assertions, lengthen codec timeouts or
retry an export until success. Earlier failed/incomplete runs are not the final proof.

## Receiver and lifecycle checks

**249/249 Node tests passed, including 27 focused receiver/muxer tests.** The focused suite
exercises real pinned MP4/WebM muxers as well as controlled destinations:
positioned rewrites, subviews mutated immediately after admission, inclusive byte limits,
short writes, zero-progress rejection, readiness, and abort during write/truncate/commit.
Tests distinguish prompt logical rejection from physical cleanup. A cancelled write keeps its
owned snapshot until non-cancellable I/O settles; `settled()` then confirms removal of the owned
partial file. Ready/write/truncate/commit errors preserve the primary cause when cleanup also fails.
Repeated finish preserves Promise identity. Successful output survives late disposal/abort.

Real browser controls inject cancellation, a write error and a commit error for each format.
They require no successful receipt, no remaining owned OPFS file, zero retained receiver bytes
and closure of the native handles instrumented by this harness. A fresh export on the same page
must then decode successfully. These counters cover handles created by the study; they do not
prove that every internal browser allocation has been reclaimed.

Completed browser evidence:

- 14/14 matched Blob/file pairs are byte-identical by SHA-256, including short A/V pairs.
- 28/28 final sample/block interval checks passed, preserving the extra 250 ms final hold.
- Four real A/V cases each decode to 108,000 presentation samples at 48 kHz for 2.25 seconds.
- All six cancel/write/commit controls removed the owned file; all six fresh retries decoded.
- At an injected 5 ms readiness delay, Opus budgets 2/4/8 failed with the expected bounded
  output-budget error and cleanup; 16/32 succeeded and decoded. These are finite probes.
- The current-code quick run passed 12 exports, six controls and five budget probes. Its source
  hashes match the full matrix; the only changed harness file is the receiver's null-reason guard.

A separate Node weak-reference probe retains the receiver while overwriting the same position
128 times with 1 MiB chunks. All owned snapshots are collectible after GC both before and after
commit. This checks JavaScript ownership; it cannot diagnose native codec, OPFS or OS cache memory.

These checks establish the research receiver behavior, not completion of every public-integration
gate. Factory acquisition/overwrite/result typing are still design decisions; E10 remains open,
and installed/Next.js tests of a future public destination API belong to E12.

The ordinary package build and `npm run test:package` also passed: the installed 0.8.1 tarball's
public types/imports/assets and five current documentation files were checked. Strict checking of
the draft destination contract passed. All 14 public entry-point declarations match the 0.8.1 baseline, and
13 local documentation links resolve. Runtime source, dependencies, lockfile, exports and version
remain unchanged. The long browser memory matrix is a local research run; CI separately exercises
the Node suite, installed package and existing browser/Next.js regressions. This prototype is not
a published public destination API.

## Design decision

Keep the external destination experimental. Current regular MP4/WebM layouts need seekable
positioned output; append-only sinks are rejected. An explicit committed receipt is needed because
the public controller still promises a Blob. Neither the Blob contract nor public types are changed
by the guarded source-build prototype.

The full matrix uses bundles frozen at launch, identified by its source/harness hashes. During
the run, two receiver guards were corrected to preserve an explicit `AbortSignal.abort(null)`
reason instead of synthesizing an AbortError. A focused regression covers that edge. This does
not change the successful memory workload or Error-reason browser controls; a current-code quick
run is recorded separately rather than relabelling the frozen matrix hashes.

Before production integration, resolve bounded Opus callback/flush flow control under a slow
destination at ordinary queue limits (gate E10 in the design). Raising an existing budget for a
short successful A/V check does not resolve that requirement. Acquisition, overwrite policy,
commit ownership and cleanup completion also need a public result/lifecycle decision. Fragmented
MP4, network streaming, arbitrary user-file rollback and long-audio memory remain separate work.

## Reproducing the study

```sh
npm run test:video:output
npm run benchmark:video:output -- --quick
npm run benchmark:video:output
node scripts/video-output-study/timeline-proof.mjs
node scripts/video-output-study/summarize.mjs
node --expose-gc scripts/video-output-study/retention-probe.mjs
```

The full driver writes raw checkpoints, source/harness hashes, logs and media under ignored
`benchmark-results/video-output-study/`. The summarizer verifies the completed matrix and physical
backing-file evidence, hashes matched outputs and writes the compact checked-in snapshot. The
`--incognito` option explicitly selects the memory-backed control; it is not the default. Browser
debugging still requires the permission described in the repository instructions.
