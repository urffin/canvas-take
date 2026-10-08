# CanvasTake

Independent TypeScript library for silent HTML canvas video recording. No runtime dependencies or dependency on AlgiViz. The npm name is `canvas-take`; publication is disabled until release preparation.

```js
import { createCanvasRecorder } from "canvas-take";
const recorder = createCanvasRecorder(canvas, { fps: 30 });
await recorder.start();
// Run your animation, then:
const { blob, extension, mimeType, durationMs } = await recorder.stop();
const url = URL.createObjectURL(blob);
// Use url in a video player or download link. Revoke it when no longer needed.
recorder.dispose();
```

`start` resolves after the MediaRecorder start event. `stop` waits for the final dataavailable and stop events; repeated calls return the same promise. Errors reject pending operations, stop owned tracks and release chunks. `dispose` cancels an unfinished recording; it is idempotent. Each instance records once. State stays idle while start is pending; a second start is rejected.

Auto format order: WebM VP9, VP8, generic WebM, MP4. An explicit unsupported MIME fails without silently changing the format. The result reports the actual MIME and matching extension. FPS and bitrate are targets, not guarantees. durationMs measures recording wall time, not parsed file duration.

Keep canvas bitmap dimensions fixed from start until stop. CSS scaling is allowed. Size changes fail the recording. Canvas must remain origin-clean. No audio, screen capture, pause, frame-by-frame encoding or server upload. Chunks are retained in memory: the caller should limit duration. If background-tab throttling is unacceptable, the caller should dispose when the page becomes hidden. Codec support depends on the browser and available resources.

Development: Node.js 22+, `npm install`, `npm test`, `npm pack`. ESM and declarations are emitted to dist. Choose a license before public release. The integration example expects AlgiViz in a sibling directory and is served by the included local server.

See [MediaRecorder stop](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/stop) and [format support](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder/isTypeSupported_static).
MediaRecorder WebM output may omit duration metadata: playback can work while the player reports an indefinite duration. For reliable seeking or publication, remux the output separately. CanvasTake does not rewrite container metadata.
