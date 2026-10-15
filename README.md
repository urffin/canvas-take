# CanvasTake

Independent TypeScript library for HTML canvas video recording with optional audio tracks. No runtime dependencies or dependency on AlgiViz. ESM only, with TypeScript declarations. MIT licensed. The package does not start or draw your animation.

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

## Browser and server use

Recording requires a browser with `canvas.captureStream`, `MediaRecorder` and `MutationObserver`. Importing the module does not access these APIs; creating a recorder checks capture/encoder support. Node.js has no recording implementation. Codec support is detected at runtime, not inferred from the browser name.

The integration example was verified with an actual VP9 recording at 1920×1080. This is not a promise that every browser can produce WebM or MP4. A canvas containing cross-origin content without CORS may not be captured.

## Release

Run `npm test` and `npm run test:package` (packs and installs the tarball in an isolated consumer, then checks TypeScript declarations and runtime imports). The archive contains dist, README, LICENSE, CHANGELOG and package metadata. Source and issues: [urffin/canvas-take](https://github.com/urffin/canvas-take). The 0.x API may change in later minor releases.

After CI passes on the release commit, publish a stable GitHub Release tagged `v<package version>`. The `npm-publish.yml` workflow checks version consistency, verifies the packed consumer and publishes with OIDC/provenance. Configure npm's trusted publisher for owner `urffin`, repository `canvas-take`, workflow `npm-publish.yml` before the first automated release. No npm token is used. Publishing is a separate maintainer action.

