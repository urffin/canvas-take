# Shared RGBA extraction: verification

Status: M1 implemented and verified locally, 2026-11-06. Baseline:
`7362c6c71c194e1c7165d83bcb428a2915b598ab`; package version stays 0.6.0.
See the [design](shared-export-mechanisms.md) and [compatibility gates](shared-export-compatibility.md).
This report covers M1 only; deferred promises, byte stores, clocks, queues and public interfaces
are not refactored.

## Change and boundaries

[internal/rgba.ts](../../src/internal/rgba.ts) contains the unchanged `blendRange` function from
the former GIF preparation helper. GIF preparation still chooses its existing chunks/initial yield
or private raw transfer, and the existing GIF Worker composites immediately before encoding.
Offline video calls the same range loop synchronously where its former inline loop ran.

No validation, buffer copy, task, protocol or cancellation policy was added to the pure function.
Alpha 255 still bypasses RGB access/writes. Other pixels use the same floating-point expression,
rounding and alpha replacement. Dimensions, timing, backgrounds, progress and ownership stay with
their existing controllers. The Worker transport, negotiation and timeout behavior are unchanged.

The build now also bundles `video.js`, inlining the helper so direct users deploy no additional
asset. GIF entries continue inlining it; the GIF runtime keeps its sole `gifenc.js` dependency.
The fallback benchmark's helper override now supplies its source directory for resolving the new
private import. Its historical comparison baseline and scheduler experiments are unchanged.

## Algorithm and synchronous-boundary checks

[RGBA tests](../../test/rgba.test.mjs) compare every source byte and every alpha value against an
independent integer-weight oracle for four backgrounds (black, white, colored and mixed extremes).
They compare adjacent/partial/empty ranges on an odd 259×131 frame, require untouched outside pixels
and check the opaque path without permitting RGB reads/writes.

The new [video test](../../test/offline-video.test.mjs) observes one owned copy and its fully blended
pixels before `addFrame()` returns its promise, while the first task is still pending. It preserves
the explicit sRGB readback arguments and shows subsequent source/background mutation and canvas
resize do not alter the accepted frame, interval or first-keyframe flag. Existing GIF tests verify
the distinct chunk/yield behavior, immediate snapshots, cancellation and owned buffer collection.

The first version of the new VM test omitted the native ArrayBuffer constructor, causing its fake
packet to fail a cross-context brand check. The fixture now supplies matching typed-array/buffer
constructors; no production validation was weakened.

## Exact baseline comparison

Ignored artifacts: `benchmark-results/rgba-extraction-2026-11-06T06-17-48-774Z/`, with results.json,
before/after controller modules and source/module SHA-256 hashes. Baseline source dependencies
were loaded from Git at the exact commit, rather than resolved from the refactored working tree.
Both variants use the same unchanged gifenc implementation.

- Twelve GIF pairs: two qualities, 16/256 colors, three backgrounds, alpha boundaries, immediate
  source mutation, rounded delays 15/54 ms and a 2000 ms hold, repeat 3. Each complete file matches
  byte for byte; this is a correctness comparison, not a performance measurement.
- Three fake-video scenarios: three backgrounds, frame intervals 33333/33334/700001 us. Owned RGBA
  inputs, frame metadata, codec events, progress, result metadata/bytes, repeated-finish identity and
  adapter disposal match the baseline. Real video is checked separately by browser decoding.
- All ten public declaration entries compare unchanged; runtime GIF/video export keys, package.json
  and package-lock.json match the baseline. No new package export or version is introduced.

## Integration results

| Check | Result |
| --- | --- |
| Final standard `npm test` (build and full Node suite) | **92/92 pass**, no skips; includes final test changes |
| Sequential Node diagnostic run | 92/92 pass with `--test-concurrency=1` |
| Additional focused RGBA run | 3/3 pass, including empty ranges |
| `npm run test:package` | Build/prepack, tarball install, strict TypeScript consumer and runtime imports pass at 0.6.0 |
| Chromium browser cases | 39/39 pass in the initial mixed-browser run, before its Firefox section was interrupted |
| Clean Firefox browser run | 35 pass, 4 expected unsupported MediaRecorder MP4 skips; one worker, trace off |
| `npm run test:next` | Installed-tarball Next.js 16.3.0/Turbopack build passes; workspace `C:/Users/Grundy/AppData/Local/Temp/canvastake-next-w8de6a` |
| Fallback benchmark `--quick` | 34 cases complete, output/cleanup assertions pass; historical `fe2f6f3` baseline unchanged |
| Declaration/dependency checks | Ten emitted public declarations exactly match baseline; standalone index/video/GIF/transport, runtime imports only gifenc; moved function text identical |

The browser cases cover independent GIF and MP4/WebM decoding, timestamps/audio samples, A/V
markers, native Worker raw/fallback selection, legacy assets, cancellation, retry and resource
closure. The four Firefox skips concern real-time MediaRecorder MP4 only; offline H.264/AAC,
GIF and VP8/Opus checks pass. Counts combine the completed Chromium portion and the separate clean
Firefox run, not one claimed all-green mixed run.

Two earlier parallel Node runs hit the existing independent FFmpeg Opus-control timeout; the first
also exposed the corrected VM fixture issue. Sequential execution and the final standard `npm test`
both pass that same control. No test timeout was increased and no failed case was skipped to pass.

The initial mixed run and a subsequent one-worker Firefox run stalled under local retain-on-failure
tracing: the GIF example reached only 26/121 frames at its 30-second download expectation, and
context teardown also timed out. Those runs were interrupted after verifying the exact owned runner
and descendants. No unrelated processes were stopped. The clean run used:

```sh
node node_modules/@playwright/test/cli.js test --project=firefox --workers=1 --trace=off
```

It passes the same assertions/timeouts, including the complete GIF example in 13.9 seconds and
chunk cancellation in 1.1 seconds. This records an instrumentation/load-sensitive local limitation;
it does not claim to fix default tracing. Repository Playwright configuration and browser tests
are unchanged. An intermediate concurrent standalone diagnostic timed out its locator despite
eventually observing a complete GIF; it is not counted as a passing test or speed measurement.

The benchmark smoke artifacts are under `benchmark-results/gif-preparation-2026-11-06T06-49-41-036Z/`.
This verifies the helper override/import change and its existing assertions; its historical baseline
does not isolate M1 timing, so it establishes no new performance conclusion. Logs are under ignored
`benchmark-results/rgba-extraction-*.log`. This report records pre-commit local verification; CI is
checked separately against the exact pushed SHA. No throughput, memory-saving or cancellation-speed
improvement is claimed by extraction.
