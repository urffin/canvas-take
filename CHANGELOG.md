# Changelog

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
