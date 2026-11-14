# Changelog

## 0.8.1 — 2026-11-14

- Generate the public WebP PROVENANCE notice with the actual package version instead of the stale unreleased 0.7.0 sentence. Preserve the pinned upstream provenance, codec bytes and licenses.
- Verify current consumer documentation from the installed tarball in both packed-consumer checks: WebP provenance, English/Russian README sections, API guide and versioned changelog. Add regression checks for stale status and mismatched versions while preserving historical reports.

## 0.8.0 — 2026-11-14

- Add public animated WebP controller/Worker/runtime/WASM entries with a caller-selected encoder, transparent snapshots, exact file holds, progress, limits and cancellation.
- Supply pinned libwebp assets/notices, a public example and API guide; verify installed consumers and Next.js integration.
- Run public WebP and production Next.js browser checks in CI with real Workers, cancellation, independently decoded retry output and resource cleanup; retain result files and failure diagnostics as artifacts.

## 0.7.0 — 2026-11-12

- Add public `/apng`, `/apng/worker` and `/apng/worker-runtime` entries with a caller-selected encoder, transparent owned RGBA snapshots, exact delays, limits, progress and cancellation-safe cleanup.
- Supply a dedicated APNG Worker backed by pinned UPNG/Pako with guarded source/license checks; verify independent decoding, public types, installed packages and Next.js Worker deployment. Update the API guide and public-import example.

## 0.6.1 — 2026-11-12

- Share positioned 64 KiB output-page storage between MP4 and WebM while retaining container-specific limits, errors and stream cleanup.
- Share the existing RGBA composition algorithm between GIF fallback/Worker preparation and offline video, preserving snapshot and scheduling behavior.
- Prepare raw GIF pixels in the existing encoder Worker after private version negotiation, retaining opaque-frame fallback for legacy assets and third-party encoders.
- Verify mixed Worker/adapter versions, cancellation after handoff and retained-exporter cleanup; compare latency, throughput and process memory against 0.6.0.
- Document shared-mechanism decisions and an isolated APNG backend feasibility study. APNG is not a public package export in this release.

## 0.6.0 — 2026-11-05

- Cooperative GIF alpha composition with cancellation between chunks, owned snapshot/task cleanup and unchanged encoder contracts.
- Paired preparation latency/scheduler benchmarks, retained-exporter GC checks and real-browser cancellation/retry coverage.
- Offline VP8 video and optional native 48 kHz mono/stereo Opus in WebM, using replaceable providers.
- Explicit Opus pre-skip/CodecDelay and final DiscardPadding, microsecond WebM video timing and staging limits.
- Real browser/independent decoder verification, separate public entries and a selectable MP4/WebM example.
- MP4/WebM discard late sink writes after size failure or abort, preserving the original error without an extra asynchronous stream-close failure.
- Reproducible GIF memory/cancellation benchmarks and reports, with explicit measurement limits and Worker cleanup checks.
- Verify installed release assets with real H.264/AAC MP4, VP8/Opus WebM and both GIF adapters, including independent decoding and timeline/sample checks.

## 0.5.0 — 2026-11-02

- Add offline video export through `/video` with caller-selected encoder/muxer factories, explicit frame/sample timing, prepared PCM, progress, bounded queues, limits and cancellation-safe resource ownership.
- Add separate WebCodecs H.264 Baseline, AAC-LC WASM Worker and MP4 adapters. Support 44.1/48 kHz mono/stereo audio, packet-derived priming, MP4 edit lists and final sample trimming; document decoder padding behavior, timebase precision, runtime assets and bundled licenses.
- Add recording `pause()`/`resume()`, a pause-aware `maxDurationMs`, the `finished` promise and `stopReason`, plus an audio/video browser example.
- Add GIF `maxFramePixels`, `maxFrames` and `maxDurationMs` limits, checked before readback, with terminal cleanup and actionable retry controls in the example.
- Skip blending for fully opaque GIF pixels. Add reproducible sync/Worker benchmarks, opacity scenes and paired gradient-regression tools/results, including measurement-noise caveats.
- Verify actual H.264/AAC and WebM recordings, offline MP4 sample counts and A/V markers with independent FFmpeg decoding, cancellation/retry, packed TypeScript consumers and browser CI. Add a packed-package 1080×1920 H.264/AAC release smoke test.

## 0.4.1 — 2026-10-28

- Correct package homepage to the CanvasTake page; refresh package description, keywords and English/Russian README navigation and test instructions.

- Browser CI tests in Chromium and Firefox exercise the real GIF module Worker, cancellation and a fresh export on the same page. Downloaded GIFs are independently decoded to verify pixels, dimensions, frame timings and loop count.

## 0.4.0 — 2026-10-26

- Ready-made `gif/worker` adapter with a dedicated module Worker, transferable frames, request timeouts and cleanup on completion/cancellation/errors.
- Encoder-independent `onProgress` notifications with completed frame count, encoded duration, optional total frame hint and finalization/terminal phases.
- Worker/progress example, integration tests and package asset checks.
- Packed Next.js 16.3 / Turbopack consumer build in CI; browser-verified Worker export, progress and cancellation under same-origin Worker CSP.

## 0.3.0 — 2026-10-15

- Offline canvas GIF export via `@grundyjs/canvas-take/gif` with an injected encoder factory.
- Optional isolated `gif/gifenc` adapter, configurable palette quality/color count, frame durations and repeat count.
- AbortSignal cancellation, owned-resource cleanup and asynchronous/Worker adapter support.
- Independent GIF decoding tests, package isolation checks and an offline canvas example.

## 0.2.0 — 2026-10-15

- Optional caller-provided `audioTracks`, cloned at start to preserve caller ownership.
- Audio-aware automatic WebM codec selection (Opus), with explicit MP4 support where available.
- Audio validation and cleanup on termination, cancellation and partial setup failure.
- Web Audio narration example and audio lifecycle tests.
- Verified vertical MP4 recording with H.264/AAC; GitHub Releases publish through npm trusted publishing with provenance.

## 0.1.0

- Silent canvas recording with automatic WebM/MP4 format selection.
- Promise-based start and stop, final-chunk handling and idempotent disposal.
- Resource cleanup on errors, resize and unexpected track termination.
- ESM and TypeScript declarations; no runtime dependencies.
