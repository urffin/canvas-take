# Opus backpressure through a slow external receiver

Date: 2026-11-14. Unreleased correction based on
`e1857789ab84a6e0820d064e5a7a1b4bd9582562` / CanvasTake 0.8.1.
No public API, options/defaults, codec profile, dependencies or package-version change.
The external destination remains a private [verification prototype](external-video-output.md).

## Cause and correction

The native input queue can empty before output callbacks run. Awaiting a snapshot of the existing
output Promise tail does not account for those future callbacks. The old adapter could therefore
accept many inputs during native initialization, then exhaust its event budget when output arrived
as a burst behind a slow sink. Native final flush was another point where delayed output arrived.

The adapter now counts native input submissions and acknowledged output packets. Before submitting
another 960-sample input, it drains the current output tail (rechecking if callbacks extended it)
and checks both native queue size and the unacknowledged-input window. Packet-write completion
wakes credit waiters. Native dequeue wakes them too, but does not return a credit by itself.
The same failure/cancellation Promise interrupts these waits; there is no polling delay, production
timeout, larger default budget or per-input native flush.

The final partial input keeps its actual length. Native flush still occurs exactly once at track
end, followed by the ordered sink tail and audio end. Configuration and codec-priming packets use
a bounded event reserve: `1 + max(1, ceil(preSkip / 960))`. With the observed 312-sample pre-skip this
is the existing two-event reserve; the already supported maximum 5,760-sample pre-skip needs seven.
This allowance does not enlarge the input-credit window or `maxPendingBytes`. Oversized/genuinely
over-budget output still fails. Codec/PCM/native/storage memory remains outside any promise of
constant total RAM.

Abort also preserves an explicit null reason. Already borrowed bytes remain subject to their sink's
physical completion/cleanup contract; closing an encoder does not claim to cancel arbitrary I/O.
The [WebCodecs AudioEncoder specification](https://www.w3.org/TR/webcodecs/#audioencoder-interface)
describes native input-queue processing separately from output delivery and final flush. Actual
native ordering was also observed in the installed Chromium/Firefox binaries; the correction does
not assume a particular number of milliseconds between dequeue and output.

## Verification

Results are saved in [the compact snapshot](opus-backpressure-results.json). Local verification:

- 255/255 Node tests passed, including 10 Opus groups (six added).
- 28/28 real OPFS scenarios passed across Chromium 156 and Firefox 157: 22 complete files
  independently decoded and six failure/cancel exports with cleanup and decoded fresh retries.
- All successful exports performed one native flush. Observed input/native queue peaks stayed
  within the configured 1/2/4 limit; owned native objects, dequeue/gate listeners and receiver
  bytes were zero after settling. Failed exports had no committed receipt or remaining file.
- All 16 pre-existing public WebM browser cases passed. The two new slow-muxer cases passed
  after correcting their wrapper's required format metadata (separate targeted run).
- Build and installed-tarball checks passed, including public imports/types/assets and five
  current package documents. All 14 public declarations match the baseline; package metadata,
  dependencies, exports and existing default limits are unchanged.
- One-sample/partial endpoints and 1,440,001-sample stereo tracks decoded to their exact
  presentation counts. First/last signal windows had zero lag and correlation above 0.9.

The original matched 5 ms OPFS probes now all succeed, with exactly 108,000 decoded samples:

| maxPendingInputs | Before | After |
| ---: | --- | --- |
| 2 | Output-budget overflow | Passed |
| 4 (default value) | Output-budget overflow | Passed |
| 8 | Output-budget overflow | Passed |
| 16 | Passed | Passed |
| 32 | Passed | Passed |

The expanded matrix also omits limit options to exercise the actual controller defaults; this is
not a change to those defaults. Raw logs/files are under ignored `benchmark-results/opus-backpressure/`.

Node regression tests model dequeue-before-callback bursts with a blocked sink and limits 1/2/4.
They check input admission before the sink is released, exactly one final flush, final packet/end
ordering, partial input, both native clocks, maximum supported priming, original sink error,
cancellation during credit/native/sink/flush waits, null cancellation reason, late callbacks and
single close of inputs/encoders. The old implementation fails the new admission and credit-wait
checks; the fixed implementation passes them.

The real file-output driver uses a fresh owned persistent profile per browser and one page at a
time. Chromium and Firefox exercise real VP8/Opus, the existing private positioned receiver and
OPFS writes delayed by 5/25/50/100 ms, limits 1/2 and omitted options (actual defaults 4 / 16 MiB).
Cases include one sample, a partial 961-sample endpoint, mono/stereo, 30 seconds of stereo PCM,
cancellation while feeding/while flush awaits packet acknowledgement, a file-write error after
native flush begins, and a fresh decoded retry after each failure. Instrumentation records peak
unacknowledged submissions/native queue and owned AudioData/VideoFrame/encoder/listener closure.

The oracle uses independent EBML reading and complete FFmpeg VP8/Opus decoding. It checks sample
counts, pre-skip/padding, final video BlockDuration and first/last signal correlation with zero lag.
Tiny single-packet decoding uses the existing file-derived leading-trim exception, without trimming
to an expected test sample count. No output receipt or partial file may survive failure. Audio end
can legitimately precede a later container write error; that error must still reject the export,
preserve its cause, remove the owned file and allow retry. A first harness assertion incorrectly
forbade this ordering in Firefox; the corrected assertion checks the actual result/ownership contract.

A smaller ordinary browser regression delays the real public WebM muxer at limits 2/4 and checks
independent decoding/native playback. It is part of the existing browser suite used by CI; the
dedicated OPFS driver is opt-in and needs the browser-debugging permission specified for this repo.
The local Firefox run uses the documented Windows software-renderer/no-prelaunch preferences;
library code and CI browser settings are unchanged.

## Scope after this correction

This addresses E10's observed queue-overflow failure. It does not expose a public file/streaming
destination API. Acquisition, overwrite policy, committed result ownership and public result types
still need a separate decision/implementation, followed by installed/Next.js checks for that API.
The [earlier memory study](video-output-memory-study.md) remains historical evidence for the old
adapter and its 2/4/8-input failures; its results are not rewritten as post-fix measurements.

```sh
npm test
npm run test:opus:backpressure
npm run test:browser -- offline-webm.spec.mjs
npm run test:package
```
