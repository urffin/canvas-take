# Changelog

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
