# Changelog

## Unreleased

- Optional caller-provided `audioTracks`, cloned at start to preserve caller ownership.
- Audio-aware automatic WebM codec selection (Opus), with explicit MP4 support where available.
- Audio validation and cleanup on termination, cancellation and partial setup failure.
- Web Audio narration example and audio lifecycle tests.

## 0.1.0 — unreleased

- Silent canvas recording with automatic WebM/MP4 format selection.
- Promise-based start and stop, final-chunk handling and idempotent disposal.
- Resource cleanup on errors, resize and unexpected track termination.
- ESM and TypeScript declarations; no runtime dependencies.
