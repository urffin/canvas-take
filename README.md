# CanvasTake

[Русский](ru/README.md)

Independent TypeScript library for HTML canvas video recording with optional audio tracks and offline GIF export through a separate entry point. No external runtime dependencies or dependency on AlgiViz. ESM only, with TypeScript declarations. MIT licensed. The package does not start or draw your animation.

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

Auto format order: WebM VP9, VP8, generic WebM, MP4. With audio, the VP9 and VP8 candidates include Opus. An explicit unsupported MIME fails without silently changing the format. The result reports the actual MIME and matching extension. FPS and bitrate are targets, not guarantees. durationMs measures recording wall time, not parsed file duration.

Keep canvas bitmap dimensions fixed from start until stop. CSS scaling is allowed. Size changes fail the recording. Canvas must remain origin-clean. No screen capture, pause, frame-by-frame encoding or server upload. Chunks are retained in memory: the caller should limit duration. If background-tab throttling is unacceptable, the caller should dispose when the page becomes hidden. Codec support depends on the browser and available resources.

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

`stop()` returns `{ blob, mimeType, extension, durationMs }`. Keep the recorder in a try/finally and call `dispose()` even if your animation fails. Revoke object URLs when no longer needed.

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

The dedicated module Worker performs quantization and GIF encoding. Canvas readback and alpha compositing remain on the calling thread. Each exporter owns one Worker, terminated on finish, cancellation, failure or disposal. Pixel buffers are transferred; the source canvas is unchanged. This adapter requires browser Worker support and does not silently fall back to main-thread encoding.

The default Worker URL is resolved relative to the adapter module. For direct browser imports, serve `gif-worker.js`, `gif-worker-runtime.js` and `gifenc.js` together with JavaScript MIME types. With a bundler, ensure the Worker asset and its dependencies are emitted; if necessary, copy the runtime and `gifenc.js` to the same public directory and pass `workerUrl: '/assets/gif-worker-runtime.js'`. The runtime is also exported at `@grundyjs/canvas-take/gif/worker-runtime` for asset resolution (do not import it on the main thread). Follow your site's same-origin and CSP `worker-src` rules. No Blob URL or inline worker is required.

`timeoutMs` defaults to 30000 ms **per request**, including startup, each frame and finalization. A timeout, script-load error or message-transfer error rejects work and terminates the Worker; increase the timeout explicitly for unusually expensive frames.

Progress works with every encoder, not just the Worker adapter. Immutable snapshots arrive after each completed frame (`encoding`), before finishing (`finalizing`), and at `finished`, `failed`, `aborted` or unfinished `disposed`. `framesEncoded` and `durationMs` include only successfully encoded frames, using rounded GIF durations. `totalFrames` is an optional positive-integer display hint, not a limit; absent hints are omitted from events. No percentage or ETA is guessed; a full frame count does not mean finalization is complete. There is no initial event. Observer exceptions are ignored; aborting or disposing from an observer is supported. Disposing after a terminal outcome emits no additional event.

The offline `examples/gif.html` now demonstrates this adapter, progress and cancellation.

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

## Browser and server use

Recording requires a browser with `canvas.captureStream`, `MediaRecorder` and `MutationObserver`. Importing the module does not access these APIs; creating a recorder checks capture/encoder support. Node.js has no recording implementation. Codec support is detected at runtime, not inferred from the browser name.

The integration example was verified with an actual VP9 recording at 1920×1080. This is not a promise that every browser can produce WebM or MP4. A canvas containing cross-origin content without CORS may not be captured.

## Release

Run `npm test` and `npm run test:package` (packs and installs the tarball in an isolated consumer, then checks TypeScript declarations and runtime imports). The archive contains dist, README, LICENSE, CHANGELOG and package metadata. Source and issues: [urffin/canvas-take](https://github.com/urffin/canvas-take). The 0.x API may change in later minor releases.

After CI passes on the release commit, publish a stable GitHub Release tagged `v<package version>`. The `npm-publish.yml` workflow checks version consistency, verifies the packed consumer and publishes with OIDC/provenance. Configure npm's trusted publisher for owner `urffin`, repository `canvas-take`, workflow `npm-publish.yml` before the first automated release. No npm token is used. Publishing is a separate maintainer action.
