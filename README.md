# CanvasTake

[Русский](ru/README.md)

[Website](https://grundyjs.ru/en/canvas-take/) · [npm](https://www.npmjs.com/package/@grundyjs/canvas-take) · [Issues](https://github.com/urffin/canvas-take/issues)

Independent TypeScript library for HTML canvas recording with audio, offline H.264/AAC MP4, VP8/Opus WebM, GIF and APNG export through separate entry points. ESM with TypeScript declarations, no external runtime npm dependencies or dependency on AlgiViz. CanvasTake source is MIT licensed; optional adapters include [Mediabunny MPL-2.0](docs/offline-video-adapters.md#distribution-and-sources), [AAC WASM / FFmpeg LGPL components](docs/offline-aac.md#distribution-and-source) and [UPNG/Pako MIT/Zlib](docs/apng-export.md#custom-encoders). The package does not start or draw your animation.

## Install

```sh
npm install @grundyjs/canvas-take
```

## Record a canvas

```js
import { createCanvasRecorder } from "@grundyjs/canvas-take";
const recorder = createCanvasRecorder(canvas, { fps: 30 });
await recorder.start();
// Run your animation, then:
const { blob, extension, mimeType, durationMs } = await recorder.stop();
const url = URL.createObjectURL(blob);
// Use url in a video player or download link. Revoke it when no longer needed.
recorder.dispose();
```

`start` resolves after the MediaRecorder start event. `stop` waits for the final dataavailable and stop events; repeated calls return the same promise. Errors reject pending operations, stop owned tracks and release chunks. `dispose` cancels an unfinished recording; it is idempotent. Each instance records once. State stays idle while start is pending; a second start is rejected.

Auto format order: WebM VP9, VP8, generic WebM, MP4. With audio, the VP9 and VP8 candidates include Opus. An explicit unsupported MIME fails without silently changing the format. The result reports the actual MIME and matching extension. FPS and bitrate are targets, not guarantees. `durationMs` measures active recording time, excluding pauses; it is not parsed file duration.

Keep canvas bitmap dimensions fixed from start until stop, including while paused. CSS scaling is allowed. Size changes fail the recording. Canvas must remain origin-clean. The video recorder does not support screen capture, frame-by-frame video encoding or server upload. Chunks are retained in memory: use a duration limit or stop explicitly. If background-tab throttling is unacceptable, the caller should dispose when the page becomes hidden. Codec support depends on the browser and available resources.

Development: Node.js 22+, `npm install`, `npm test`, `npm pack`. ESM and declarations are emitted to dist. `npm pack` rebuilds automatically; `npm publish` runs tests before packing. The integration example expects AlgiViz in a sibling directory and is served by the included local server.

See [MediaRecorder stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/stop) and [format support](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).
MediaRecorder WebM output may omit duration metadata: playback can work while the player reports an indefinite duration. For reliable seeking or publication, remux the output separately. CanvasTake does not rewrite container metadata.

## Options and result

| Option | Meaning |
| --- | --- |
| `fps` | Required positive finite capture rate target |
| `videoBitsPerSecond` | Optional positive finite encoder bitrate target |
| `mimeType` | Optional explicit supported `video/webm` or `video/mp4` MIME, including codecs |
| `audioTracks` | Optional readonly list of live audio `MediaStreamTrack`s; omitted or empty records silently |
| `maxDurationMs` | Since 0.5.0: optional positive safe integer; active-time budget in ms, excluding pauses |

`stop()` returns `{ blob, mimeType, extension, durationMs, stopReason }` (`stopReason` is available since 0.5.0). Keep the recorder in a try/finally and call `dispose()` even if your animation fails. Revoke object URLs when no longer needed.

### Pause, resume and active-time limit (since 0.5.0)

```js
const recorder = createCanvasRecorder(canvas, { fps: 30, maxDurationMs: 30_000 });
try {
    await recorder.start();
    // In your UI handlers: await recorder.pause(); await recorder.resume();
    const result = await recorder.finished;
    // finished waits for automatic completion; calling stop() would stop immediately.
    console.log(result.stopReason, result.durationMs); // 'duration-limit' or 'manual'
} finally {
    recorder.dispose();
}
```

`pause()` and `resume()` resolve after their native events. State changes between `recording` and `paused` at those events; the native recorder can change state earlier. Repeated calls toward the current stable state succeed without further action; repeated calls to the same pending operation return the same promise. An opposite operation while one is pending rejects. Calls before start completes, during stopping, or after completion/disposal reject. Stopping from a pause succeeds. Stopping, disposal or failure rejects an unfinished pause/resume operation; normal stopping still produces the final video.

`finished` is a stable promise available from creation. It resolves with the final result on manual or automatic completion, and rejects on failure/disposal. `stop()` remains idempotent and returns that same result. `stopReason` is `manual` or `duration-limit`, according to the first stop request. Without `maxDurationMs` there is no automatic stop. Invalid limits throw before capture; supplied limits are snapshotted at creation.

The budget starts at the start event, stops counting at the pause event, and resumes at the resume event. The limit requests normal stopping and retains the final chunk; it does not discard the recording. Timers, event delivery and encoding can be delayed, so this is not a frame-exact file-duration cap. The active time reported in `durationMs` can exceed the requested limit under load. Pause/stop never stop caller-owned audio tracks or pause your animation/narration source; coordinate those separately if their timeline should pause too. Owned capture tracks and audio clones are stopped, and timers/listeners/chunks released, on completion, failure or disposal.

Build and serve `examples/video.html` with the example server for format selection, a generated tone, pause/resume, manual stop, an active-time limit, preview and download. Browser tests record and play real WebM and supported H.264/AAC MP4, check decoded audio, pause exclusion and track ownership; unavailable codecs are explicitly skipped. Native event behavior is specified by [MediaStream Recording](https://www.w3.org/TR/mediastream-recording/#methods).

The [video verification notes](docs/video-recording.md) describe six flash/beep markers across two pauses, independent FFmpeg decoding with container timestamps, and a negative control with intentionally delayed audio. FFmpeg is a development-only dependency.

Initial captured video material can precede the native start event, especially while an audio engine starts. The active-time budget does not trim such startup material from the file; file duration can therefore include additional startup time as well as finalization delay.

## Record with narration

Mix audio into one Web Audio destination track (multiple audio tracks are not supported by every encoder). Decode your narration before starting. Call this from a user gesture so the browser can resume the audio context:

```js
async function recordNarration(canvas, narrationBytes) {
    const audio = new AudioContext();
    let recorder;
    let destination;
    try {
        await audio.resume();
        const buffer = await audio.decodeAudioData(narrationBytes);
        destination = audio.createMediaStreamDestination();
        const source = audio.createBufferSource();
        source.buffer = buffer;
        source.connect(destination);
        recorder = createCanvasRecorder(canvas, {
            fps: 30,
            mimeType: "video/mp4",
            audioTracks: destination.stream.getAudioTracks(),
        });
        const finished = new Promise(resolve => {
            source.addEventListener("ended", resolve, { once: true });
        });
        await recorder.start();
        source.start();
        // Run your canvas animation while the narration plays.
        await finished;
        return await recorder.stop();
    } finally {
        recorder?.dispose();
        destination?.stream.getTracks().forEach(track => track.stop());
        await audio.close();
    }
}
```

MP4 with audio requires browser encoder support; an explicit MP4 request never falls back to WebM. CanvasTake uses MediaRecorder directly and does not transcode. Audio playback and canvas animation remain caller-controlled and use real time.

`video/mp4` selects a container, not specific codecs: a browser may produce VP9/Opus in MP4. If your destination requires H.264/AAC, request an explicit codec MIME such as `video/mp4;codecs=avc1,mp4a.40.2` and handle unsupported-format errors.

For a browser smoke test, run `node examples/server.cjs` after building and open `http://127.0.0.1:3012/canvas-take/examples/audio.html`. It records a generated tone and moving 1080×1920 canvas with explicit H.264/AAC, requests stop after two seconds, previews the result and saves it to `canvastake-test.mp4` in the server's temporary directory. Verified in the local browser: H.264 Constrained Baseline, progressive 4:2:0, stereo AAC-LC at 48 kHz, 2.476 seconds and approximately 29.1 fps. No transcoding or remuxing was used. Actual duration/frame rate and codec support depend on the browser and runtime load.

The audio track list is copied at creation and validated again at start. CanvasTake clones the tracks at start and stops only its clones and canvas capture tracks on completion, disposal or failure. The caller owns the original tracks and AudioContext. Unexpected termination of a recorded clone fails recording. Calling `stop()` on an original track does not stop its clone; call `recorder.stop()` to finish the recording. Finishing an AudioBufferSource does not end the destination track either.

## Offline video controller (since 0.5.0)

Since 0.6.0, the same controller supports explicit **VP8/Opus WebM** through
`createWebmMuxer` from `/video/webm`, native `createWebCodecsAudioEncoder` from `/video/opus`
and VP8 in `/video/webcodecs`. Audio is optional, 48 kHz mono/stereo; CodecDelay and final
DiscardPadding preserve presentation samples. See the [WebM guide](docs/offline-webm.md).
Use version 0.6.0 or later for these entries.
Native/raw decoders have documented [leading-trim and endpoint-rounding limits](docs/offline-webm.md#independent-verification); container sample accounting remains explicit.

`@grundyjs/canvas-take/video` exports `createOfflineVideoExporter` and adapter contracts for offline frame/audio timelines. Supply separate encoder and muxer factories. Optional `/video/webcodecs` (`createWebCodecsVideoEncoder`), `/video/aac` (`createAacAudioEncoder`) and `/video/mp4` (`createMp4Muxer`) entries export real **H.264 Baseline / AAC-LC MP4**, with optional prepared PCM audio. Video requires native WebCodecs support; AAC runs in a dedicated Worker using a bundled libavcodec WASM backend, including where native AAC encoding is unavailable. Independent FFmpeg decoding checks sample counts, priming, padding and A/V timing.

```js
import { createOfflineVideoExporter } from '@grundyjs/canvas-take/video';
// options supplies video.encoder/config, optional prepared audio, and muxer.
const exporter = await createOfflineVideoExporter(options);
try {
    drawFrame(0);
    await exporter.addFrame(canvas, { timestampUs: 0, durationUs: 33_333 });
    const result = await exporter.finish();
} finally {
    exporter.dispose();
}
```

Frames form a contiguous timeline from zero in integer microseconds; durations and audio sample positions do not depend on encoding speed. The controller snapshots inputs, limits queues, serializes muxing and releases owned adapters on completion/failure/abort. Audio uses an explicit strict or trim/pad policy. See [real adapters, usage and timing precision](docs/offline-video-adapters.md), [AAC delay and sample-count verification](docs/offline-aac.md), the [runnable example](examples/offline-video.html) and [API details](docs/offline-video-api.md). Video boundaries use 57,600 Hz ticks; audio uses sample positions, a priming edit and a shortened final sample duration. MP4 presentation length excludes AAC padding; raw decoders that return full AAC frames must apply the container endpoint.

## Offline GIF export

Available since version 0.3.0.

```js
import { createGifExporter } from '@grundyjs/canvas-take/gif';
import { createGifencEncoder } from '@grundyjs/canvas-take/gif/gifenc';

const controller = new AbortController();
const gif = createGifExporter({
    encoder: createGifencEncoder({ maxColors: 128, quality: 'high' }),
    repeat: 0,
    signal: controller.signal,
});
try {
    for (let time = 0; time < 6000; time += 50) {
        drawTimeline(time); // Your deterministic renderer draws into canvas.
        await gif.addFrame(canvas, 50);
    }
    drawTimeline(6000);
    await gif.addFrame(canvas, 2000); // Hold the final frame for two seconds.
    const blob = await gif.finish(); // image/gif; 8 seconds, 121 frames.
    // Download/preview blob; revoke any object URL when no longer needed.
} finally {
    gif.dispose();
}
```

`encoder` is required and supplied by the caller. The `/gif` entry has no codec dependency; `/gif/gifenc` is an optional, self-contained adapter bundling the MIT-licensed gifenc codec. The root video import loads neither GIF module. You can replace the adapter without changing the export loop.

| Setting | Meaning |
| --- | --- |
| `repeat` | Default `0`: forever. `-1`: play once. `1..65535`: extra repetitions after the first play |
| `signal` | Optional AbortSignal; abort rejects pending work and disposes the encoder |
| `background` | RGB byte tuple, default `[255, 255, 255]`; composites transparency onto an opaque background |
| Adapter `maxColors` | Maximum palette colors per frame, integer `2..256`, default `256` |
| Adapter `quality` | `high` (default, RGB565) or `fast` (RGB444); no dithering |

`addFrame(canvas, durationMs)` snapshots a 2D HTMLCanvasElement or OffscreenCanvas immediately, then yields before encoding. Await each call before another frame or `finish()`. All frames must have identical positive dimensions (GIF limit 65535 per axis). Durations must be finite and between 10 and 655350 ms; they are rounded to the nearest 10 ms. GIF players may clamp short delays; 50 ms is a practical timeline step. The drawing time and encoding wall time do not affect the GIF duration. The canvas remains caller-owned and unmodified. Tainted canvases fail with the readback error.

With synchronous/custom encoders and legacy Worker runtimes, alpha composition runs in cooperative chunks, allowing cancellation during preparation. Internal tasks
target about 4 ms, using MessageChannel between chunks with a timer fallback. This is not a wall-clock
deadline: the full snapshot/copy and synchronous codec calls remain uninterrupted. Abort/disposal clears
pending preparation tasks and releases its owned snapshot without submitting a partial frame.

`finish()` requires at least one frame, returns a Blob and releases the encoder. Each exporter produces one GIF. `dispose()` is idempotent, cancels pending work and releases encoder resources. Invalid frame data, changed dimensions and encoder errors make the exporter terminal. Concurrent calls are rejected without cancelling the ongoing operation. State is `ready`, `encoding`, `finished`, `failed`, `aborted` or `disposed`.

The built-in adapter incrementally encodes full frames with individual palettes, retaining compressed output rather than all raw frames. It performs synchronous work per frame on the calling thread, with cancellation serviced between frames. For expensive frames, use the ready-made `/gif/worker` adapter, run with OffscreenCanvas in a Worker or supply an asynchronous Worker adapter; there is no automatic Worker pool. GIF bytes and the final Blob consume memory, so callers should bound dimensions and frame count. File size depends on visual complexity; an 800 px, 6–10 second animation is a target, not a guaranteed 2–3 MB output.

### Worker adapter and progress (0.4.0)

```js
import { createGifExporter } from '@grundyjs/canvas-take/gif';
import { createGifWorkerEncoder } from '@grundyjs/canvas-take/gif/worker';

const gif = createGifExporter({
    encoder: createGifWorkerEncoder({ maxColors: 128, quality: 'high' }),
    signal: controller.signal,
    totalFrames: 121,
    onProgress({ phase, framesEncoded, totalFrames, durationMs }) {
        status.textContent = `${phase}: ${framesEncoded}/${totalFrames}, ${durationMs} ms`;
    },
});
```

The dedicated module Worker performs quantization and GIF encoding. Canvas readback and the owned
snapshot remain on the calling thread. Each exporter owns one Worker, terminated on finish,
cancellation, failure or disposal. Pixel buffers are transferred; the source canvas is unchanged.
This adapter requires browser Worker support and does not silently fall back to main-thread encoding.

Since 0.6.1, alpha composition also runs in that same Worker when its runtime
advertises support. Older/custom Worker files keep the opaque-frame protocol and cooperative preparation
on the calling thread. Third-party encoders keep their existing public contract; wrappers exposing only
public methods use the same fallback. No new option or deployment asset is required. See
[compatibility and measured comparison](docs/gif-worker-preparation.md). Published 0.6.0 still composites on the calling thread.

The default Worker URL is resolved relative to the adapter module. For direct browser imports, serve `gif-worker.js`, `gif-worker-runtime.js` and `gifenc.js` together with JavaScript MIME types. With a bundler, ensure the Worker asset and its dependencies are emitted; if necessary, copy the runtime and `gifenc.js` to the same public directory and pass `workerUrl: '/assets/gif-worker-runtime.js'`. The runtime is also exported at `@grundyjs/canvas-take/gif/worker-runtime` for asset resolution (do not import it on the main thread). Follow your site's same-origin and CSP `worker-src` rules. No Blob URL or inline worker is required.

`timeoutMs` defaults to 30000 ms **per request**, including startup, each frame and finalization. A timeout, script-load error or message-transfer error rejects work and terminates the Worker; increase the timeout explicitly for unusually expensive frames.

Progress works with every encoder, not just the Worker adapter. Immutable snapshots arrive after each completed frame (`encoding`), before finishing (`finalizing`), and at `finished`, `failed`, `aborted` or unfinished `disposed`. `framesEncoded` and `durationMs` include only successfully encoded frames, using rounded GIF durations. `totalFrames` is an optional positive-integer display hint, not a limit; absent hints are omitted from events. No percentage or ETA is guessed; a full frame count does not mean finalization is complete. There is no initial event. Observer exceptions are ignored; aborting or disposing from an observer is supported. Disposing after a terminal outcome emits no additional event.

The offline `examples/gif.html` demonstrates this adapter, progress and cancellation. Its limit controls (since 0.5.0) default to the example's exact 800×450, 121-frame, 8,000 ms output, including the final hold. Empty fields omit limits. A limit error explains what to increase, restores the controls for retry, and clears any previous download/preview when a new attempt starts.

### GIF limits (since 0.5.0)

Set optional limits on `createGifExporter`; they apply to every encoder, including the synchronous and Worker adapters:

```js
const gif = createGifExporter({
    encoder: createGifWorkerEncoder(),
    maxFramePixels: 1920 * 1080,
    maxFrames: 600,
    maxDurationMs: 30_000
});
try {
    await gif.addFrame(canvas, 50);
    const blob = await gif.finish();
} catch (error) {
    // A limit violation rejects addFrame with RangeError naming the limit.
    console.error(error);
} finally {
    gif.dispose();
}
```

All three values must be positive safe integers; omitting one leaves that dimension unlimited by this API (existing GIF format constraints still apply). Bounds are inclusive: `maxFramePixels` checks `width * height`, `maxFrames` counts successfully encoded frames, and `maxDurationMs` sums frame delays **after rounding each to GIF's 10 ms units**, excluding playback repetitions. For example, two 54 ms frames consume 100 ms; a 55 ms frame consumes 60 ms. `totalFrames` remains a display hint independent of `maxFrames`.

Invalid limit values throw `RangeError` during creation, before allocating an encoder/Worker. Exceeding a limit rejects `addFrame` before reading pixels or submitting the rejected frame. The exporter enters terminal `failed`, emits one failed progress event with only previously completed frames/duration, detaches its abort listener and disposes its encoder (terminating the owned Worker). `finish` cannot return a partial GIF after this failure; create a fresh exporter to retry. Source canvases are retained. These limits bound input work, not exact memory usage or output byte size.

### Supplying another encoder

Implement the exported `GifEncoderFactory` contract:

```ts
import type { GifEncoderFactory } from '@grundyjs/canvas-take/gif';

const encoder: GifEncoderFactory = ({ repeat }) => ({
    addFrame({ data, width, height, durationMs }) {
        // Pass the opaque RGBA snapshot to your codec; may return Promise<void>.
    },
    async finish() {
        // Return complete GIF bytes as Uint8Array.
        return encodedBytes;
    },
    dispose() {
        // Drop buffers, terminate owned Workers, settle pending operations.
    },
});
```

Each factory call must allocate a fresh encoder and honor the supplied repeat count. The exporter calls methods sequentially and invokes `dispose()` once on success, failure or cancellation. The adapter may transfer the owned frame buffer to a Worker; it must release frame references after each operation and support disposal during pending work. Cancellation rejects exporter operations immediately, but cleanup of external work belongs to the adapter. Synchronous codec work cannot be preempted on the same thread. Cleanup exceptions are suppressed to preserve the primary outcome.

Run `node examples/server.cjs` after building and open `http://127.0.0.1:3012/canvas-take/examples/gif.html` for a standalone offline example with cancel, preview and download. Codec rationale and measured module sizes are in [docs/gif-encoder.md](docs/gif-encoder.md).

With a built AlgiViz checkout in the sibling `algiviz` directory, open `http://127.0.0.1:3012/canvas-take/examples/gif-bfs.html` for the real BFS integration. Verified output: 800×560, 141 frames, 9 seconds including a 2-second final hold, about 1.60 MB. The example uses AlgiViz's existing algorithm and renderer and does not modify that project.

## APNG export (since 0.7.0)

APNG is available through separate public entries starting with 0.7.0.

```js
import { createApngExporter } from '@grundyjs/canvas-take/apng';
import { createApngWorkerEncoder } from '@grundyjs/canvas-take/apng/worker';

const exporter = createApngExporter({ encoder: createApngWorkerEncoder(), plays: 3 });
try {
    await exporter.addFrame(canvas, 55); // Complete transparent snapshot; draw each next image yourself.
    const blob = await exporter.finish(); // image/apng; suggested extension .apng
} finally {
    exporter.dispose();
}
```

Exact integer delays are 1..65535 ms. One frame keeps animation metadata; identical frames and
transparent erasure are preserved. The Worker retains inputs until finish; the default 64 MiB raw
input limit is not a peak-memory bound. Use AbortSignal for cancellation and await each operation.
Worker asset entry: `@grundyjs/canvas-take/apng/worker-runtime`. See [APNG API and deployment](docs/apng-export.md)
for limits, progress, custom encoders, Worker URLs and viewer limitations, and the [example](examples/apng.html).

## Browser and server use

Recording requires a browser with `canvas.captureStream`, `MediaRecorder` and `MutationObserver`. Importing the module does not access these APIs; creating a recorder checks capture/encoder support. Node.js has no recording implementation. Codec support is detected at runtime, not inferred from the browser name.

The integration example was verified with an actual VP9 recording at 1920×1080. This is not a promise that every browser can produce WebM or MP4. A canvas containing cross-origin content without CORS may not be captured.

## Development checks

The [shared export mechanisms design](docs/drafts/shared-export-mechanisms.md) compares the current
GIF, offline-video and recorder implementations. Its [compatibility gates](docs/drafts/shared-export-compatibility.md)
define checks for individual internal extractions. [Shared RGBA verification](docs/drafts/shared-rgba-verification.md)
records the first implementation slice; public APIs remain unchanged.
The [deferred evaluation](docs/drafts/shared-deferred-evaluation.md) retains the small local helpers
and records promise-identity, ordering and error checks for future work.
[Paged output verification](docs/drafts/shared-paged-bytes-verification.md) records shared MP4/WebM
byte storage, positioned-write compatibility and cleanup checks introduced in 0.6.1.
The [remaining-policy evaluation](docs/drafts/shared-export-policy-evaluation.md) keeps timeline,
ownership, cancellation and progress local and records conditions for future extraction.
The [APNG design](docs/drafts/apng-export.md), [backend spike](docs/drafts/apng-backend-spike.md),
[controller verification](docs/drafts/apng-controller-verification.md) and
[Worker integration report](docs/drafts/apng-integration-verification.md) preserve the earlier implementation evidence.
Current public imports and asset deployment are described in the [APNG guide](docs/apng-export.md).
The [animated WebP research](docs/drafts/webp-backend-research.md) compares backend candidates and
records real Worker/independent-decoder observations; it does not add WebP export to the package.
The subsequent [libwebp backend proof](docs/drafts/webp-libwebp-backend.md) records reproducible
Windows WASM builds, exact animation checks, native cancellation and resource cleanup.

Run `npm test` for unit and Node Worker tests, and `npm run test:package` for an isolated packed consumer. For real browser tests, first run `npx playwright install chromium firefox`, then `npm run test:browser`. These check recording, offline MP4/AAC, WebM/Opus, GIF and APNG export, cancellation/retry, resource cleanup and independently decoded timing/audio. `npm run test:next` checks the packed library with Next.js/Turbopack; add `-- --apng-browser` for actual default/package/copied APNG Worker checks. `npm run test:apng:package` verifies public APNG types and actual Workers from an installed tarball. See [GIF verification](docs/gif-encoder.md#verification) and [AAC/sample-count verification](docs/offline-aac.md#independent-verification).

`npm run test:release-video` packs and installs the candidate, then exports a 10-second 1080×1920 H.264/AAC video from only the installed assets. It checks all 300 decoded frames, 480,000 presentation audio samples, playback, dimensions and four independent A/V markers. It also verifies VP8/Opus WebM with exact samples, a final frame hold and A/V markers, plus byte-identical sync/Worker GIFs after cancellation/retry. Files and metrics are saved under `test-results/release-video/`.

GIF performance comparisons: run `npm run benchmark:gif` (or add `-- --quick` for a short run). See [benchmark methodology and reports](docs/gif-benchmark.md) for the resolution/duration matrix, timing boundaries and limitations.

For process memory, cancellation delivery/settlement and repeated-session cleanup, run `npm run benchmark:gif:lifecycle` (smoke: add `-- --quick`). See the separate [memory and cancellation report](docs/gif-memory-benchmark.md), including Worker/native-memory coverage, GC controls and measurement limits.

Run `npm run benchmark:gif:preparation` for paired comparisons against the pre-chunking controller
(`-- --tune` compares schedulers/budgets; `-- --quick` is a smoke run). See the
[preparation latency report](docs/gif-preparation-benchmark.md) for results and timing boundaries.

`npm run benchmark:gif:worker-preparation` compares actual 0.6.0 Worker assets with raw preparation,
including process-memory samples, cancellation, throughput and repeated cleanup. Add `-- --quick`
for smoke or `-- --full` to include ten-second memory cases. The older preparation command deliberately
isolates the cooperative fallback; the new comparison asserts actual raw protocol use.

Use `npm run benchmark:gif -- --compare-opacity` to compare the pre-optimization core with the current core on opaque, mixed-alpha and translucent-gradient scenes.

## Release

Run `npm test` and `npm run test:package` (packs and installs the tarball in an isolated consumer, then checks TypeScript declarations and runtime imports). The archive contains dist, README, LICENSE, CHANGELOG and package metadata. Source and issues: [urffin/canvas-take](https://github.com/urffin/canvas-take). The 0.x API may change in later minor releases.

After CI passes on the release commit, publish a stable GitHub Release tagged `v<package version>`. The `npm-publish.yml` workflow checks version consistency, verifies the packed consumer and publishes with OIDC/provenance. Configure npm's trusted publisher for owner `urffin`, repository `canvas-take`, workflow `npm-publish.yml` before the first automated release. No npm token is used. Publishing is a separate maintainer action.
