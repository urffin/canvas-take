# Offline AAC-LC in MP4 (unreleased)

Use the optional AAC factory with the existing controller, H.264 provider and MP4 writer:

```js
import { createOfflineVideoExporter } from '@grundyjs/canvas-take/video';
import { createWebCodecsVideoEncoder } from '@grundyjs/canvas-take/video/webcodecs';
import { createAacAudioEncoder } from '@grundyjs/canvas-take/video/aac';
import { createMp4Muxer } from '@grundyjs/canvas-take/video/mp4';

const exporter = await createOfflineVideoExporter({
    video: { encoder: createWebCodecsVideoEncoder(), config: videoConfig },
    audio: { encoder: createAacAudioEncoder(), config: {
        codec: 'mp4a.40.2', bitstreamFormat: 'aac',
        sampleRate: narration.sampleRate, numberOfChannels: narration.channels.length,
        bitrate: 192_000
    }, source: narration, endPolicy: 'trim-or-pad' },
    muxer: createMp4Muxer(), signal,
    maxAudioInputBytes: 64_000_000, maxOutputBytes: 64_000_000
});
try {
    for (const frame of timeline) {
        drawFrame(frame);
        await exporter.addFrame(canvas, { timestampUs: frame.startUs, durationUs: frame.durationUs });
    }
    const result = await exporter.finish();
    // result.audioPresentationSamples counts audible input, excluding codec priming/padding.
} finally {
    exporter.dispose();
}
```

`narration` is `PreparedAudio`: planar Float32 PCM, finite values in [-1, 1], equal channel lengths. The caller supplies the canvas, timeline, drawing function and [Baseline AVC config](offline-video-adapters.md). Audio uses 44,100 or 48,000 Hz with one or two channels and AAC-LC/raw `aac` framing. Other rates, channel layouts, profiles or ADTS framing are explicitly unsupported. Bitrate is an integer from 8,000 to 512,000 bps. There is no resampling, mixing, live audio capture, automatic encoder substitution or native AAC fallback. Omit `audio` to retain video-only export.

`error` requires source sample count to match `round(videoDurationUs * sampleRate / 1e6)`; `trim-or-pad` explicitly discards extra input or adds PCM silence. Codec padding is separate and is never counted as accepted source samples. The [full typed narrated example](drafts/offline-video-example.ts) uses the real providers. The [browser example](../examples/offline-video.html) offers an optional generated AAC tone, cancellation, preview and download.

## Backend, deployment and resource ownership

`createAacAudioEncoder({ workerUrl?, timeoutMs? })` implements `AudioEncoderFactory`. A dedicated module Worker loads the pinned **@mediabunny/aac-encoder 1.65.0 libavcodec WASM build**. CanvasTake uses that package's published WASM ABI directly; it does not globally register a Mediabunny encoder or create a second hidden container. This makes the audio encoder and MP4 writer independently replaceable, and avoids guessing native WebCodecs AAC latency. The source algorithm remains FFmpeg's existing AAC encoder.

The default Worker URL is relative to `dist/video-aac.js`: `./video-aac-worker.js`. Copy both assets together when serving unbundled files. With a bundler, copy the `@grundyjs/canvas-take/video/aac-worker` asset and pass its emitted URL as `workerUrl`; do not evaluate the worker entry on the main thread. The bundled Worker contains its WASM, requiring no additional binary fetch, Blob Worker, SharedArrayBuffer or cross-origin isolation. Browser WebAssembly/SIMD support and permission to load the module Worker are required. A strict CSP must permit the worker asset and WebAssembly compilation (for example, `worker-src 'self'` and the appropriate `script-src 'wasm-unsafe-eval'` policy). Native H.264 availability is checked separately.

The source PCM is copied by the controller. The adapter accumulates one 1,024-sample interleaved frame; only owned copies are transferred to the Worker. One command is in flight at a time. Raw input, encoded response bytes and the serial output sink have finite budgets; an undersized `maxPendingBytes` rejects rather than waiting forever. The WASM heap, retained source PCM, muxer output pages and final Blob are separate allocations, so these work budgets are not a total heap limit.

The default per-command timeout is 30 seconds, including startup; `timeoutMs` must be an integer in 1..2147483647. Worker errors, malformed responses and timeouts fail the export. Abort/dispose immediately terminate the Worker, reject outstanding commands/output waits and suppress late messages. Successful finalization also terminates the Worker. A fresh exporter can run after cancellation, size failure or initialization error; caller PCM remains usable.

## Encoder delay, end padding and MP4 representation

The adapter reads **sample-unit PTS and durations from libavcodec AVPackets**. A negative first packet position defines leading discard; final packet end minus accepted PCM count defines trailing discard. It checks contiguous 1,024-sample packet intervals and a valid delay instead of assuming that all AAC backends have the same latency. In this pinned backend, independent decoding measured 1,024 leading samples at both supported rates. For `N` accepted samples, trailing padding is `(1024 - N % 1024) % 1024`.

Packet timestamp/duration conversion uses absolute integer sample boundaries. The MP4 writer recovers sample positions, retains one bounded final AAC packet until the audio end event, writes negative first PTS as an **edit list** that removes leading priming, and shortens the final MP4 sample duration to the exact presentation endpoint. It preserves the compressed AAC payload needed for decoder overlap. It validates leading/trailing accounting and the controller's final sample count before returning the Blob.

The audio `mdhd`/`stts` tables use the sample rate: media duration is `leading + N`. The edit's media start is `leading`; thus the sample-table presentation is exactly `N`. The movie and edit segment duration use 57,600 Hz ticks, while video remains quantized from absolute microsecond boundaries. Edit duration differs by at most one movie tick (17.36 µs), with at most one audio sample of end quantization in a player. This does not accumulate as drift over the recording.

**Raw decoder output is not the presentation sample count.** FFmpeg 6's MP4 demuxer applies the leading edit, but its AAC-to-raw-PCM path returns the complete final coded frame. For 50,003 accepted samples, a direct decode returns 50,176 samples: the last 173 are beyond MP4 presentation. Ignoring edit lists returns 51,200 samples, including the 1,024 leading samples as well. When exporting raw PCM from such a decoder, apply the container endpoint. The tests independently read MP4 tables, validate that endpoint against the source count, and apply it with `atrim=end_sample=<container count>`; they never use an exporter result or hard-coded expected length to choose the trim. Do not infer support for every third-party player's gapless handling from these tests.

## Independent verification

`test/browser/offline-audio.spec.mjs` exports actual files in Chromium and Firefox. A separate FFmpeg executable decodes every packet, while a small reader independently checks `mdhd`, `stts` and `elst`:

- 44.1 kHz mono / 50,003 samples and 48 kHz stereo / 120,017 samples; exact table-derived presentation counts and both channels' first/last signal windows.
- Counts 1, 1,023, 1,024 and 1,025 around codec-frame boundaries, plus explicit source trim and silence padding.
- Band-limited noise correlation: zero-sample lag after the priming edit, 1,024-sample lag when the edit is ignored. Tests require correlation above 0.9.
- Four synchronized flashes/tones over 137,003 samples with deliberately delayed rendering. Full native H.264/AAC playback must reach `ended`. A/V marker offset must stay below 3 ms, with less than 2 ms spread. Ignoring the priming edit is the negative control and must produce more than 15 ms of offset.
- Worker closure on cancellation/initialization/output-size failures, preserved PCM and a successful retry.

Node tests additionally cover startup/encode/flush/blocked-output cancellation, timeouts, invalid packets, absent delay, configuration/budget errors and idempotent disposal. Artifacts include MP4s, sample-count tables and A/V metrics under `test-results/`; the existing browser CI artifact includes them. FFmpeg used for verification is independent of the pinned WASM encoder build.

Local verification on 2026-11-02: 60 Node tests passed; the complete one-worker browser run passed 44 tests and skipped four existing MediaRecorder MP4/audio cases unavailable in Firefox. All ten new AAC cases passed in both browsers. The four corrected A/V marker offsets were 0 ms at the detector's 1 ms resolution, with 0 ms measured spread; the ignored-edit negative control measured about 21 ms on every marker. These are measurements of the fixtures, not a universal timing guarantee for other decoders.

| Fixture | Presentation samples | Leading discard | Trailing discard | Raw decode after leading edit |
| --- | ---: | ---: | ---: | ---: |
| 44.1 kHz mono | 50,003 | 1,024 | 173 | 50,176 |
| 48 kHz stereo | 120,017 | 1,024 | 815 | 120,832 |
| 48 kHz A/V markers | 137,003 | 1,024 | 213 | 137,216 |

Both browsers produced the same sample accounting. Correlation of the first and last signal windows in each non-padded channel found zero-sample lag. The MP4 movie/edit duration remains quantized as described above.

## Distribution and source

The AAC Worker includes a size-reduced **runtime FFmpeg AAC encoder**, unlike the separate `ffmpeg-static` test executable. This code is loaded only by the optional AAC Worker; the controller, WebCodecs video provider and MP4 writer do not load it. The pinned npm package is a dev dependency used to build the self-contained runtime, not a required dependency of consumers.

The package ships `dist/aac-licenses/` (MPL-2.0 wrapper license, FFmpeg LGPL-2.1-or-later license, upstream license notes and `bridge.c`), `dist/aac-PROVENANCE.md` (exact FFmpeg/Emscripten revisions and rebuild commands), and `dist/video-aac-worker.js.map` with the adapter and glue source. The build only converts the published glue's CommonJS export wrapper to ESM; it does not modify the WASM. The unmodified FFmpeg source revision is [60a2818f76dcd1fee3155b1791304af104a0fc1b](https://github.com/FFmpeg/FFmpeg/tree/60a2818f76dcd1fee3155b1791304af104a0fc1b); the bridge/build instructions are also in the [upstream AAC package](https://github.com/Vanilagy/mediabunny/tree/main/packages/aac-encoder). Applications redistributing modified runtime assets should preserve those licenses, source information and rebuild/replacement access.

Primary references: [AAC WebCodecs registration and priming](https://www.w3.org/TR/webcodecs-aac-codec-registration/), [AAC encoder extension](https://mediabunny.dev/guide/extensions/aac-encoder), [Apple AAC delay explanation](https://developer.apple.com/documentation/quicktime-file-format/background_aac_encoding). WebCodecs native AAC support alone is not treated as proof of accurate priming.
