# Video recording verification

The unreleased pause/resume and active-time limit API is described in the English and Russian README. `examples/video.html` demonstrates manual controls, automatic completion, a generated audio track, preview and download.

## Automated checks

```sh
npm test
npm run test:package
npm run test:browser
# Focused synchronization check:
npx playwright test test/browser/video-sync.spec.mjs --workers=1
```

Node tests use controlled clocks and a MediaRecorder fixture to verify active-time accounting across multiple pauses, stopping while paused, repeated/pending operations, error/disposal/limit races, long timer segmentation, option validation and preservation of caller-owned audio tracks. The packed consumer checks the public types.

Browser tests record actual WebM VP8/Opus and MP4 H.264/AAC when supported. They play recordings through the browser, check decoded audio and dimensions, verify that a pause longer than the budget does not stop recording, stop manually from a pause and complete automatically after resuming. Unsupported explicit codecs are skipped rather than substituted. Separate checks exercise the actual video example. Existing GIF tests run alongside these checks.

## A/V synchronization after pauses

`video-sync.spec.mjs` records three active segments separated by two 600 ms pauses. Each segment contains two 180 ms white flashes and 1 kHz tone pulses driven from the same AudioContext clock, giving six marker pairs. The canvas is 160×90 at a target 30 fps. The producer schedules new pulses only within active segments; pausing the recorder does not pause the caller's audio clock or drawing.

The same producer is recorded through CanvasTake and through an independent, direct MediaRecorder control (including the same timeslice). Input flash scheduling lag is retained too. The test-only helper uses the pinned `ffmpeg-static` development dependency. It is not imported or bundled by the library. Installing development dependencies downloads its platform binary. FFmpeg decodes the completed file without modifying it, preserving container timestamps with `-copyts`:

- Video: one gray sample per decoded frame plus its presentation timestamp; a transition above 200 detects a flash.
- Audio: mono float32 at 48 kHz, plus decoded-frame presentation timestamps and sample counts. Five-ms RMS windows above 0.05 detect tone starts. Each onset is mapped back to the audio frame's timestamp, retaining the audio stream's initial offset.

Comparing PCM sample indices alone with video media times is insufficient: a PCM-only browser decoder can discard the initial audio timestamp. The independent decoder keeps both streams on the same container timeline and also verifies the actual H.264/AAC or VP8/Opus codecs.

Every file must contain all six marker pairs, with video-minus-audio onset offset spread at most 80 ms across the recording. Both decoded stream endpoints must remain within 300 ms of active recording time, so leaving the 1.2 seconds of pauses in the file fails. Audio/video endpoints must be within 250 ms of each other. These are end-to-end tolerances, including canvas scheduling, frame cadence and encoder behavior; they are not a sample-accurate synchronization guarantee.

Absolute offset is reported separately, including a diagnostic `absoluteOffsetWithin120Ms` flag. An initial parallel run exceeded that diagnostic for Chromium MP4 (133 ms maximum, 38 ms spread); this observation is retained rather than dismissed by retrying. A constant capture/encoder startup offset is different from drift introduced by pausing. The regression assertion concerns drift; absolute offsets and the direct native control are retained for investigation. Passing this test does not promise an absolute offset under 120 ms on every machine.

A Chromium/WebM negative control remuxes a copy with audio deliberately delayed by 300 ms, using stream copy rather than re-encoding. Its absolute-offset diagnostic must exceed 120 ms, and the detector must recover the injected shift within 15 ms. A constant injected delay does not increase drift; this control verifies timestamp-aware offset measurement rather than the drift assertion. The original recording is untouched.

Recordings and `sync-metrics.json` (per-marker timestamps and offsets, codec names, stream endpoints and active/wall durations) are retained in Playwright outputs/report attachments. CI uploads those artifacts with the browser report. Codec support and observed precision can vary by browser, machine and load.

## Observed local run: 2026-11-02

Windows 10, AMD FX-8350; Chromium and Firefox installed by Playwright 1.64.1. This is one run with two workers, not a universal latency guarantee.

| Browser | Recorder | Codecs | Max absolute offset (ms) | Offset spread (ms) | Max input draw lag (ms) |
| --- | --- | --- | ---: | ---: | ---: |
| Chromium | library | h264/aac | 13.9 | 24.7 | 19.3 |
| Chromium | library | vp8/opus | 31 | 23.5 | 19.3 |
| Firefox | library | vp8/opus | 32 | 50 | 11.3 |
| Chromium | native | h264/aac | 23 | 31.7 | 8.7 |
| Chromium | native | vp8/opus | 34.5 | 21 | 11.3 |
| Firefox | native | vp8/opus | 29 | 35 | 10.7 |

The native control uses the same input producer and requested format. Similar values do not identify the cause of every startup offset, and the earlier 133 ms MP4 diagnostic remains an observed limitation. No growing offset beyond the 80 ms regression bound was found after the two pauses.
