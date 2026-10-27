# GIF encoder selection and integration

The export controller accepts a `GifEncoderFactory`. Codec-specific tuning belongs to the adapter factory, not the controller. This keeps frame scheduling, cancellation and resource ownership independent of palette algorithms or Worker transport.

## Candidates inspected

| Encoder | License | Shipped JavaScript | Worker model | Fit |
| --- | --- | --- | --- | --- |
| [gifenc 1.0.3](https://github.com/mattdesl/gifenc) | MIT | CanvasTake's bundled adapter is 10,478 bytes / 4,539 gzip | No automatic pool; can encode in Workers | Incremental frames, palette controls, no dependencies, fits flat algorithm graphics |
| [gif.js 0.2.0](https://github.com/jnordberg/gif.js) | MIT | 13,451-byte main script + 16,636-byte Worker script, excluding maps | Built-in Worker orchestration with a separately hosted workerScript | Useful full exporter, but overlaps our controller and needs another deployment asset |

Sizes were measured from the installed/published versions on 2026-10-15; they are not comparative speed benchmarks. gifenc's npm unpacked size is 172,516 bytes including sources/maps. gif.js's npm unpacked size is 3,096,699 bytes including its demo media; this is not its browser download cost. The chosen adapter copies gifenc's complete MIT license into `dist/gifenc-LICENSE.txt`.

gifenc was selected for the supplied adapter, not embedded into the controller. It has no dithering and is less suited to photographs. Per-frame palettes may change quantized colors between frames. The current adapter encodes full opaque frames, not changed rectangles; size savings depend on the source. Alpha is composited onto the controller's configurable background before reaching any adapter.

## Loading and execution

Measured emitted files in release 0.3.0 (uncompressed / gzip, before Worker/progress additions):

- `dist/index.js`: 8,120 / 2,128 bytes. The video entry remains unchanged.
- `dist/gif.js`: 5,207 / 1,688 bytes. Controller only, no runtime imports.
- `dist/gifenc.js`: 10,478 / 4,539 bytes. Self-contained optional codec adapter.

The adapter is bundled at build time; gifenc, esbuild and the test decoder are development dependencies. Consumers install no additional runtime packages. Bundle-graph tests verify that each entry is standalone. Packed-consumer tests import all three public entries, compile their types and produce GIF bytes after installing the tarball in an isolated project.

The supplied adapter runs on the calling thread. The controller snapshots pixels before its first yield and yields before each frame, allowing UI cancellation between frames. It cannot interrupt synchronous quantization halfway through a frame. For large workloads, the caller can run the exporter with OffscreenCanvas in a Worker or supply an async Worker adapter. The adapter owns its Workers; `dispose()` must terminate them, reject pending calls and release buffers. A real Node Worker integration test transfers the owned pixel copies and independently decodes the returned result, then verifies Worker termination.

### Ready-made Worker adapter (0.4.0)

The `/gif/worker` entry provides `createGifWorkerEncoder`, with one dedicated module Worker per export. It transfers owned pixel buffers and runs quantization and encoding in that Worker; canvas readback and alpha compositing stay on the calling thread. The default runtime URL is relative to the adapter. Serve the runtime and `gifenc.js` together, or configure `workerUrl` when deploying copied/bundled assets. The runtime is exported at `/gif/worker-runtime` for asset resolution only. Startup, frame and finish requests each have a configurable 30-second default timeout. Success, failure, cancellation and disposal terminate the Worker and settle pending calls. Real Worker tests independently decode its result and verify termination; fault tests cover startup cancellation, transport errors and timeouts.

The controller's optional `onProgress` observer works with every encoder. It reports completed frames and their accumulated rounded duration, finalization, and terminal outcomes. `totalFrames` is an optional display hint, not a frame limit. See the README for event semantics and deployment details. The browser example now uses this adapter; the measurements below describe the synchronous adapter in 0.3.0.

## Verification

Run `npx playwright install chromium firefox` once, then `npm run test:browser`. The browser suite serves built modules with `worker-src 'self'`, observes actual Worker creation/closure, exports through a real canvas and downloads the GIF for independent decoding with gifuct-js. It checks every pixel, dimensions, frame count/durations, repeat count and progress events. An open-ended frame producer keeps the cancellation case active until the test clicks Cancel after observing a completed frame; no machine-speed-dependent delay is used. A second export on the same page must create and close a fresh Worker and produce the expected GIF. CI installs both browsers and retains the HTML report, GIF outputs, and failure screenshots/traces for seven days. These tests exercise direct module loading; the separate Next.js job covers bundler compilation.

`npm run test:next` packs the local library and builds an isolated Next.js 16.3.0 / React 19.2.8 consumer with Turbopack. These are the site's installed versions at the time this fixture was added. Its client component uses the default Worker URL, export progress and cancellation under `worker-src 'self'`. The temporary directory is printed and retained for browser checks with the printed `npm start` command. A build pass alone does not establish browser execution or cancellation; verify those separately. This check does not modify the website checkout or publish a package. CI runs the build as a separate job.

Tests use gifuct-js as an independent parser/LZW decoder, checking full pixel patches, dimensions, frame delays, long final holds, loop extension values, alpha composition and palette limits. Lifecycle tests cover pre-abort, abort/dispose during pending frame/finalization calls, late rejection, codec exceptions, tainted canvas, resize, empty exports, duplicate operations and exactly-once adapter disposal. Releasing references makes buffers eligible for garbage collection; tests do not claim a particular GC schedule.

A real browser export from `examples/gif.html` produced 121 frames at 800×450: 120 × 50 ms plus a 2000 ms final hold, repeat forever. The downloaded GIF was independently decoded again: 8000 ms total, distinct first/final pixels, 931,669 bytes. Encoding took approximately 4.2 seconds on the test machine. This is a synthetic flat-graphics sample, not the future AlgiViz BFS animation; its size does not guarantee the size or rendering time of other scenes.

The integration example `examples/gif-bfs.html` additionally imports the actual BFS generator, graph renderer and timeline from a sibling AlgiViz checkout without modifying it. Its 36 algorithm steps are sampled every 50 ms across 7000 ms, followed by one 2000 ms final frame. Browser output independently decoded to 141 frames, 800×560, 9000 ms and an infinite loop, at 1,597,694 bytes (about 1.60 MB). Encoding took about 5.7 seconds. Visual inspection of decoded initial/middle/final frames confirmed readable labels and distinct state colors. Final distances from A were A=0, B=C=1, D=2, E=3; F and G remained unreachable. This meets the intended 6–10 second, roughly 800 px and under 2–3 MB README target for this graph. The example saves a test copy to `canvastake-test.gif` in the local server's temporary directory.
