# Offline VP8 / Opus / WebM (unreleased)

The same offline controller can export VP8 video with optional prepared Opus audio.
These additions are local development after 0.5.0; they are not in the published 0.5.0 package.
Providers are explicit and replaceable; unsupported native configurations reject without switching formats.

```js
import { createOfflineVideoExporter } from '@grundyjs/canvas-take/video';
import { createWebCodecsVideoEncoder } from '@grundyjs/canvas-take/video/webcodecs';
import { createWebCodecsAudioEncoder } from '@grundyjs/canvas-take/video/opus';
import { createWebmMuxer } from '@grundyjs/canvas-take/video/webm';

// Caller supplies canvas, drawFrame and a prepared 48 kHz Float32Array narration.
const exporter = await createOfflineVideoExporter({
    video: { encoder: createWebCodecsVideoEncoder(), config: {
        codec: 'vp8', bitstreamFormat: 'vp8', width: 1080, height: 1920,
        bitrate: 8_000_000, frameRateHint: { numerator: 30, denominator: 1 }
    } },
    audio: { encoder: createWebCodecsAudioEncoder(), config: {
        codec: 'opus', bitstreamFormat: 'opus', sampleRate: 48000,
        numberOfChannels: 1, bitrate: 128000
    }, source: { sampleRate: 48000, channels: [narration] }, endPolicy: 'error' },
    muxer: createWebmMuxer(),
    maxFrames: 300, maxDurationUs: 10_000_000, maxOutputBytes: 64_000_000
});
try {
    const boundary = i => Math.round(i * 1e6 / 30);
    for (let i = 0; i < 300; i++) {
        drawFrame(i);
        await exporter.addFrame(canvas, {
            timestampUs: boundary(i), durationUs: boundary(i + 1) - boundary(i)
        });
    }
    const result = await exporter.finish(); // video/webm, extension webm
} finally { exporter.dispose(); }
```

Omit `audio` for video only. Use 480,000 narration samples for this ten-second example.
The [runnable example](../examples/offline-video.html) offers MP4 and WebM and optional generated audio.
Use localhost or HTTPS. VP8 and Opus require native WebCodecs support for the requested configuration;
Opus is not the AAC WASM Worker and has no extra runtime asset. Imports are safe without browser globals.
VP9, AV1, Vorbis, alpha, HDR, resampling and live microphone input are outside this adapter profile.

## Codec and sample timeline

VP8 uses native quality mode and drains each input before accepting the next. It validates visible
version-0 frames, key-frame dimensions, timestamps and actual SDR color metadata. Even positive dimensions
and an explicit bitrate are required. Per-input video drain can produce extra key frames on some backends.
The requested interval, including the final hold, remains authoritative.

`createWebCodecsAudioEncoder()` currently accepts only `opus`/`opus`, 48 kHz mono/stereo and
an integer bitrate from 8,000 to 512,000. It packs arbitrary planar input blocks into 960-sample
(20 ms) native inputs, retaining a bounded partial frame. It disables DTX, checks native queue size
and closes each temporary AudioData after submission. A final partial input keeps its actual sample count.
Native audio flush occurs once at track end; flushing every input would introduce padding.

The native OpusHead must contain version 1, mapping family 0, matching channels and pre-skip no larger
than 5,760 samples. It is copied unchanged to CodecPrivate. Native 20 ms packet durations, packet order,
TOC duration and a consistent clock are checked. Chromium's zero-based clock and Firefox's clock shifted
after the first packet are normalized to the common coded timeline `packetIndex * 960 - preSkip`.
Unexpected clocks fail instead of silently shifting narration. The adapter reports presentation input,
leading discard and final trailing discard in samples through the existing controller protocol.

The writer records CodecDelay in nanoseconds from pre-skip, SeekPreRoll from the pinned writer
(currently 400 ms), and final **signed DiscardPadding**. Audio timestamps are derived from sample
positions, independently of rounded input microseconds. Padding is never removed by deleting compressed
bytes. Segment duration excludes codec delay and trailing padding. PCM source ownership, strict versus
trim/pad policy, snapshots and cancellation follow the [controller contract](offline-video-api.md).

## Container precision, bounds and distribution

WebM uses a 1,000 ns TimestampScale: one tick is one microsecond. Integer video boundaries therefore
remain exact; audio packet boundaries are rounded to a microsecond, CodecDelay/DiscardPadding to a
nanosecond. Decoded sample positions are verified independently. Signed 16-bit cluster-relative timestamps
mean clusters split frequently (roughly every 32 ms with ordinary frame rates), sometimes at a delta frame.
This increases container overhead and may make seeking less efficient than a millisecond timebase.
The result is a regular seekable WebM with final duration/cues, not a streaming API.
Native HTML video duration can round an audio endpoint down by one microsecond (observed in Firefox);
the EBML segment and video block boundaries retain the exact integer microseconds.

The writer checks encoded payload and actual growing output against `maxOutputBytes`, retains seekable
64 KiB pages and releases them after the final Blob or disposal. Interleaving and current-cluster payload
plus 64 bytes per packet count against `maxPendingBytes`; exceeding that budget rejects. The held final
audio packet and adapter/controller queues also have finite budgets. These options bound work/output,
not total native or browser heap: PCM snapshots, native allocations, metadata, page slack and Blob copies
consume additional memory. Abort closes owned native encoders and cancels the writer; a retry uses fresh instances.
After a terminal size error or abort, already queued sink writes are discarded before allocating pages.
The adapter reports the original error while the owned stream remains closable, avoiding an extra asynchronous close error.

`/video/mp4` and `/video/webm` share a bundled Mediabunny 1.65.0 runtime in
`dist/video-container-*.js`. Deploy those generated files with the entry files. Bundlers resolve them normally.
Mediabunny is MPL-2.0; its license and complete bundled source are included, including modified WebM source,
in `dist/mediabunny-LICENSE.txt` and `dist/video-container-*.js.map` (`sourcesContent`). Own adapters are MIT.
There is no runtime npm dependency. The build applies guarded integration changes for microsecond timebase,
final Opus DiscardPadding, presentation duration and staging limits; it does not modify node_modules and
fails if pinned upstream anchors change. The build transformation is in `scripts/webm-muxer-patch.mjs`.
The package also includes this transform, the pristine upstream TS/JS module and reproduction
notes in `dist/webm-sources/` and `dist/webm-PROVENANCE.md`.

## Independent verification

Node tests cover explicit support, VP8 packet checks, both native Opus clocks, input closure,
metadata/packet errors, backpressure/cancellation, writer limits and pinned integration changes.
Browser tests use real encoders and the real WebM writer, a separate EBML reader and development-only
FFmpeg VP8/Opus decoding plus a separate native Web Audio container decode. They check variable video intervals/final hold, mono/stereo sample counts,
CodecDelay/DiscardPadding, native playback, correlation and delayed-render flash/tone synchronization.
The negative control removes all discards and must reveal the priming shift and extra decoded samples.
Assertions concern timing/decodability rather than byte-identical native output.

There is a narrow raw-decoder exception: pinned FFmpeg 6 can expose leading pre-skip when one Opus
packet also carries final DiscardPadding. A one-sample file returns 313 raw samples at negative PTS,
including 312 priming samples; Firefox Web Audio also returns 313 raw samples for that file.
This also happens with a one-sample WebM created by FFmpeg's own
libopus encoder; the [demuxer creates skip side data for final padding](https://github.com/FFmpeg/FFmpeg/blob/n6.1/libavformat/matroskadec.c#L3736).
The test helper recognizes only this independently accounted single-packet case and removes its leading
samples using the file's OpusHead and decoded negative PTS, never the requested test sample count.
Metrics retain raw counts/PTS and the normalization. The Web Audio helper applies the same file-based leading
trim only if a single padded packet produces exactly the container presentation count plus pre-skip.
Chromium Web Audio needs no adjustment. Multi-packet output is checked directly without
that adjustment. Web Audio separately checks decoded presentation counts, including 1/647/648/649
and 959/960/961 samples. Firefox Web Audio can differ by one sample from the container/FFmpeg count;
the native check allows at most one sample and checks first/last signal correlation with zero lag.
Chromium returns the exact count in these cases. The one-sample fixture must decode to one sample.
Do not promise exact PCM length from every native/raw decoder: a consumer of tiny files may need
container-aware leading trim. After accounting for that leading discard, native presentation length
can differ by one sample (20.83 µs at 48 kHz).

Local verification on Windows, 2026-11-02: all 34 targeted WebM/MP4/AAC browser cases passed,
along with 69 Node tests. Chromium used the default profile. Firefox used software WebRender,
disabled layer acceleration and disabled process prelaunch in an ignored local configuration;
the ordinary Windows profile intermittently stalled at page/context teardown. This configuration
does not change the library, codecs, test timeouts or CI settings. The three Firefox preferences were
`gfx.webrender.software: true`, `layers.acceleration.disabled: true`, and
`dom.ipc.processPrelaunch.enabled: false`.

Both browsers produced four flash/tone offsets of 0 ms (1 ms detector resolution); removing Opus
discard metadata produced about 6 ms of offset. Container/FFmpeg presentation counts were exactly
50,003 mono, 120,017 stereo and 137,003 marker samples; first/last signal correlations had zero lag.
The installed-tarball MP4 control also passed at 1080×1920, ten seconds, 300 video frames and
480,000 presentation audio samples, with four 0 ms A/V offsets. The shared container bundle was
loaded from the installed package; no transcoding was used. Files and metrics are under `test-results/`.

References: [WebCodecs Opus registration](https://www.w3.org/TR/webcodecs-opus-codec-registration/),
[WebM container guidelines](https://www.webmproject.org/docs/container/),
[Matroska elements](https://www.matroska.org/technical/elements.html),
[Mediabunny WebM output](https://mediabunny.dev/guide/output-formats#webm).
