# Offline H.264 / AAC / MP4 adapters (since 0.5.0)

The offline pipeline exports **H.264 video with optional AAC-LC audio**. Since 0.6.0, it also supports [VP8/Opus WebM](offline-webm.md) with the same controller. The snippet below is video-only; see the [AAC guide](offline-aac.md) for prepared narration, delay, trimming, sample counts and runtime deployment. Import the controller and providers separately:

```js
import { createOfflineVideoExporter } from '@grundyjs/canvas-take/video';
import { createWebCodecsVideoEncoder } from '@grundyjs/canvas-take/video/webcodecs';
import { createMp4Muxer } from '@grundyjs/canvas-take/video/mp4';

const exporter = await createOfflineVideoExporter({
    video: { encoder: createWebCodecsVideoEncoder(), config: {
        codec: 'avc1.42E028', bitstreamFormat: 'avc', width: 1080, height: 1920,
        bitrate: 8_000_000, frameRateHint: { numerator: 30, denominator: 1 }
    } },
    muxer: createMp4Muxer(), signal,
    maxFramePixels: 1080 * 1920, maxFrames: 300, maxDurationUs: 10_000_000,
    maxOutputBytes: 64_000_000
});
try {
    const boundary = i => Math.round(i * 1e6 / 30);
    for (let i = 0; i < 300; i++) {
        drawFrame(i);
        await exporter.addFrame(canvas, {
            timestampUs: boundary(i), durationUs: boundary(i + 1) - boundary(i)
        });
    }
    const result = await exporter.finish(); // video/mp4, H.264, no audio track
} finally {
    exporter.dispose();
}
```

The caller supplies `canvas`, `drawFrame` and `signal`. Native codec support depends on the browser, OS and configuration. Use localhost or HTTPS; initialization checks the exact configuration and rejects unsupported choices. It never silently selects another codec or container. The controller still accepts other independently implemented factories.

For a runnable preview/download UI, build, run `node examples/server.cjs`, and open
`http://127.0.0.1:3012/canvas-take/examples/offline-video.html`. It renders 120 portrait frames, then holds the last frame until five seconds; an optional generated tone covers the same timeline. MP4 selects H.264/AAC, WebM selects VP8/Opus (since 0.6.0). Cancellation releases the session; the next export creates fresh providers. Starting another export clears and revokes the previous preview URL.

## WebCodecs video profile

`createWebCodecsVideoEncoder()` implements `VideoEncoderFactory`. It accepts explicit H.264 Baseline codec strings (`avc1.42xxxx`) with AVC packet framing, or `vp8`/`vp8` (since 0.6.0), positive even dimensions and an explicit bitrate. High/Main profiles, Annex B, other codecs, alpha and HDR are rejected. Audio factories are separate optional imports. A `checkSupport` success is a native capability check, not a guarantee that later allocation/output succeeds; incompatible decoder descriptions fail during export.

The provider uses native **quality** mode, which does not permit frame dropping. Baseline excludes B pictures, and the adapter checks the returned avcC profile as well as packet timestamps/keys. It drains the native encoder after each input and waits for output consumption before accepting another frame. This intentionally favors bounded memory and deterministic timing over maximum encoding throughput. This native drain does not end the adapter track: only the adapter's final `flush()` emits `end`. It creates one temporary VideoFrame per input and closes it immediately after native encode submission.

Duration comes from the input interval, including variable duration and a long final hold; missing or differently rounded native chunk duration cannot shorten the interval. Dropped/duplicate/reordered output, a missing requested key frame, incompatible decoder configuration or absent supported color metadata fails the export. Asynchronous native callbacks are bridged to an owned, bounded output queue. Oversized packets/configuration fail before entering an unbounded queue. Cancellation closes the native encoder, rejects blocked work and suppresses late callbacks.

The input snapshot is opaque sRGB RGBA8. Its native VideoFrame declares BT.709 primaries, sRGB transfer and RGB/full range. The returned decoder metadata must describe BT.709 primaries/matrix with BT.709 or sRGB transfer and an explicit range flag. These **actual output** fields and the avcC bytes are passed to the MP4 writer; the adapter does not invent a common range/transfer for different browsers.

## MP4 writer and timeline precision

`createMp4Muxer()` implements `MuxerFactory`, using bundled Mediabunny 1.65.0. It accepts Baseline AVC video and optional AAC-LC audio at 44.1/48 kHz, mono/stereo. Audio descriptions and sample-unit accounting pass through the [AAC protocol](offline-aac.md); unsupported formats are rejected. Decoder descriptions, packet bytes and actual color metadata pass through to the container. The result is a regular MP4 with `moov` after `mdat`, rather than fragmented MP4 or an in-memory fast-start layout. No reencoding occurs in the writer.

The pinned writer uses a **57,600 Hz movie/track timescale** without a `frameRate` track option. A frame-rate hint configures encoding only; it must not snap variable intervals in the muxer. The adapter rounds **absolute** microsecond boundaries to ticks and subtracts adjacent tick positions. This preserves the final hold and prevents accumulated rounding drift at fractional rates. Timeline endpoints differ from requested time by at most half a tick (about 8.68 µs), while individual intervals can differ by up to one tick (about 17.36 µs). Positive intervals that collapse to zero ticks, or intervals exceeding the MP4 sample-duration field, are rejected. Result `durationUs` remains the requested timeline; container time is the quantized value.

Encoded payload is counted against `maxOutputBytes`; actual header/media writes also check their end positions. Overflow rejects the adapter operation before retaining those bytes. Late queued writes after failure/abort are discarded so the owned stream remains closable without replacing the original error. Seekable 64 KiB pages support metadata patching without building an ever-growing contiguous JS array. The final Blob copies the output, and pages are released after finalization or disposal. This is an output-size limit, not a cap on browser/native heap use: page slack, sample tables, muxer staging, native allocations and the Blob copy also use memory. Finalization checks frame count and endpoint against the controller summary.

## Verification

`test/browser/offline-video-real.spec.mjs` runs both providers on real canvas frames in Chromium and Firefox. It checks:

- Portrait dimensions, H.264 without audio, distinct decoded colors and full-file playback to `ended`.
- Independently demuxed FFmpeg PTS, DTS, sample durations and every decoded frame, including the long final hold.
- Exact MP4 movie/track header duration and a single video track, using a small independent box reader.
- Sixty frames at 30000/1001 with absolute rounded microsecond boundaries plus a final hold; fast and artificially delayed rendering produce the same file timeline.
- Cancellation after actual packet output, MP4 size failure, native codec closure and successful creation of a fresh export.

Node tests cover unavailable/unsupported configurations, native failures, malformed/reordered output, callback queue bounds, blocked-output cancellation, temporary VideoFrame closure, header size limits and intervals too small for the container timebase. Packed-consumer checks verify separate public imports/types without requiring a native encoder in Node. Chromium support is required in CI; other browsers report a precise skip if the requested native configuration is unavailable. On the local Windows verification (2026-11-02), all eight real-pipeline/example tests passed in Chromium and Firefox.

Both browsers produced these independently measured timelines:

| Scenario | Frames | Requested duration (µs) | MP4 duration (ticks at 57,600 Hz) | Endpoint error (µs) |
| --- | ---: | ---: | ---: | ---: |
| Variable intervals + final hold | 5 | 900,125 | 51,847 | −3.4722 |
| 30000/1001 + final hold, fast | 61 | 2,502,001 | 144,115 | −4.4722 |
| Same timeline, delayed rendering | 61 | 2,502,001 | 144,115 | −4.4722 |

Before AAC integration, the Node suite passed 56 tests. That complete browser run with one worker passed 34 tests and skipped four older MediaRecorder MP4/audio cases unavailable in Firefox. An earlier two-worker run completed all new checks but hit a Firefox `Browser.removeBrowserContext` teardown error after a successful GIF export; the complete single-worker rerun passed without library changes. Local MP4s and inspection JSON are saved under `test-results/`; CI collects them through the existing browser artifact upload.

The independent FFmpeg executable remains a development/test dependency. The optional AAC Worker includes a separate pinned libavcodec WASM encoder at runtime; see its [licenses, provenance and sample-count verification](offline-aac.md). Native video bytes may vary across backends; timeline equality and decodability are the assertions. Real AAC/MP4 priming, padding and A/V are tested. See the [WebM profile (since 0.6.0)](offline-webm.md) for VP8/Opus; higher-throughput scheduling remains future work.

## Distribution and sources

The controller and WebCodecs entries import no third-party muxer. `/video/mp4` and `/video/webm` (since 0.6.0) share a bundled Mediabunny runtime (`dist/video-container-*.js`); deploy those chunks alongside the entries. There is no runtime npm dependency. The package includes its MPL-2.0 license in `dist/mediabunny-LICENSE.txt` and complete bundled source in `dist/video-container-*.js.map` (`sourcesContent`), including [WebM integration changes](offline-webm.md#container-precision-bounds-and-distribution). CanvasTake's own sources remain MIT. Mediabunny source is available in the [upstream repository](https://github.com/Vanilagy/mediabunny) and pinned npm distribution. Its legacy DOM declarations conflict with TypeScript 6's built-in declarations, so the repository build skips dependency declaration checking; project code stays strict and the packed consumer independently typechecks the public declarations.

Relevant primary references: [WebCodecs quality mode](https://www.w3.org/TR/webcodecs/#latency-mode), [AVC framing/decoder descriptions](https://www.w3.org/TR/webcodecs-avc-codec-registration/), [Mediabunny encoded packet sources](https://mediabunny.dev/api/EncodedVideoPacketSource), [MP4 output options](https://mediabunny.dev/guide/output-formats#mp4).
