# Animated WebP export

Available since **0.8.0** through the public `/webp`, `/webp/worker`, `/webp/worker-runtime`
and `/webp/codec.wasm` entries.

```js
import { createWebpExporter } from '@grundyjs/canvas-take/webp';
import { createWebpWorkerEncoder } from '@grundyjs/canvas-take/webp/worker';

const abort = new AbortController();
const exporter = createWebpExporter({
    encoder: createWebpWorkerEncoder({ lossless: true, quality: 100, method: 4 }),
    plays: 3,
    signal: abort.signal,
    totalFrames: 2,
    onProgress(p) { console.log(p.phase, p.framesAccepted, p.durationMs); }
});
try {
    // Draw each complete image yourself, then await admission.
    await exporter.addFrame(canvas, 55);
    // Draw the next image, including any transparent erasure.
    await exporter.addFrame(canvas, 2000);
    const blob = await exporter.finish(); // image/webp, suggested extension .webp
    // Create a preview/download URL and revoke it when no longer needed.
} finally { exporter.dispose(); }
// From a UI handler: abort.abort().
```

## Entries and assets

| Entry | Purpose |
| --- | --- |
| `@grundyjs/canvas-take/webp` | `createWebpExporter` and nine `Webp*` controller/encoder types |
| `@grundyjs/canvas-take/webp/worker` | `createWebpWorkerEncoder`, `WebpWorkerOptions` |
| `@grundyjs/canvas-take/webp/worker-runtime` | Module Worker asset; resolve a URL, do not import on the calling thread |
| `@grundyjs/canvas-take/webp/codec.wasm` | Matching WASM asset; resolve/copy as a file, not a JavaScript module |

Root/GIF/APNG/video imports do not re-export WebP. The controller and adapter are safe to import
in Node/SSR and contain no codec. Acquiring the supplied encoder requires a browser module Worker;
unsupported execution, load, protocol and codec failures reject without changing format or encoder.

The supplied defaults use module-relative Worker and WASM URLs. `workerUrl` and `wasmUrl` are
independent overrides, resolved on encoder acquisition against document.baseURI or the calling
Worker's location. Changing only workerUrl does not relocate WASM. The public runtime inlines its
browser-only loader, so it needs no adjacent JavaScript dependency. Keep matching files from the same build:
`webp-worker-runtime.js`, its map, `webp-codec.wasm` and the complete `webp-notices/` directory.
The packaged `webp-codec.js` is the pristine upstream loader reference. Serve JS as JavaScript and
WASM as `application/wasm`; CORS/CSP must permit Worker loading,
module imports, WASM fetch and WebAssembly compilation. There is no CDN or legacy fallback.

For static deployment, pass both URLs explicitly:

```js
const encoder = createWebpWorkerEncoder({
    workerUrl: '/assets/webp/webp-worker-runtime.js',
    wasmUrl: '/assets/webp/webp-codec.wasm'
});
```

Next.js/bundler use, installed-package checks and their limits are recorded in the
[public integration report](drafts/webp-public-verification.md). The
[example](../examples/webp.html) uses public imports through an import map.

In Next.js use the controller from a client event handler; imports remain SSR-safe. The default
adapter emits its runtime and WASM through the bundler's static URL handling. Explicit package URLs
are also supported by the checked Turbopack build:

```js
const encoder = createWebpWorkerEncoder({
    workerUrl: new URL('@grundyjs/canvas-take/webp/worker-runtime', import.meta.url),
    wasmUrl: new URL('@grundyjs/canvas-take/webp/codec.wasm', import.meta.url)
});
```

The adapter converts emitted relative URL shims to an absolute WASM URL on acquisition before
posting init. Static copies in `public` use the two explicit string overrides shown above. Keep
the runtime map/notices with copied assets; browser-only loader adaptation is included in the
runtime source map and `webp-notices/browser-loader.mjs`.

## Input, timing and budgets

Each origin-clean HTMLCanvasElement/OffscreenCanvas must provide a 2D context. Bitmap size stays
fixed; CSS size is irrelevant. The exporter captures its own nonshared straight-alpha sRGB RGBA8
snapshot synchronously before yielding. Immediate redraw cannot change submitted pixels, caller
storage is never transferred, and alpha is preserved without GIF quantization/background mixing.

Await every add before another add or finish; there is no queue. Delays are exact integer
milliseconds in **1..16,777,215**, dimensions **1..16,383**. Plays is total presentations, **0** infinite
(default), **1** once, maximum **65,535**. A single image retains animation metadata and its hold;
empty finish fails. libwebp can merge identical inputs or split long holds, so encoded packet count
can differ from accepted-frame count. The sum of file holds remains exact, including the last one.
Viewers can clamp short holds; the checked Firefox version exposes 1/10 ms as 100 ms.

| Controller option | Default / meaning |
| --- | --- |
| `encoder` | Required synchronous factory returning a fresh owned encoder |
| `signal` | Optional AbortSignal; pre-abort precedes acquisition |
| `totalFrames` | Optional positive safe-integer progress hint, not a limit |
| `maxFramePixels` | 4,194,304 pixels per frame |
| `maxFrames` | 1,000 accepted frames |
| `maxDurationMs` | 2,147,483,647 ms total |
| `maxInputBytes` | 67,108,864 cumulative admitted/pending raw RGBA bytes |
| `maxOutputBytes` | 33,554,432 complete output bytes |
| `onProgress` | Optional synchronous observer of fresh shallow-frozen snapshots |

All five limits are inclusive integers in 1..2,147,483,647. Input budgets, delays and fixed size
are checked before readback. A pending add reserves its budget; counters commit only after encoder
acknowledgement and an activity check. Raw/output budgets do not bound peak memory: batch snapshots,
codec scratch, compressed output, validation copy and Blob storage are additional. Native assembly
can allocate before enforcing its final output cap.

## Progress, cancellation and custom encoders

Phases are collecting, finalizing, finished, failed, aborted or disposed. Snapshots report
`framesAccepted`, `durationMs`, `inputBytesAccepted`, optional `totalFrames`, and `outputBytes` only
on success. Acceptance is not compression percentage. Finalizing includes compression, assembly,
envelope validation and Blob creation. Observer throws are ignored; reentrant abort/dispose is
checked before further work. Finish returns the same Promise while finalizing/finished; a successful
Blob survives disposal. Later calls after disposal reject.

The supplied adapter uses a fresh dedicated Worker per encoder, validates ABI/profile, and closes
its owned handle on success/error/abort/dispose. `timeoutMs` defaults to 30,000 per posted init/frame/
finish request, not the whole export. `lossless` defaults true, `quality` 100 (finite 0..100),
`method` 4 (integer 0..6). Lossy RGB is approximate; alpha remains exact in the verified profile.
Initialization starts on acquisition and failures are reported by the next call reaching the
adapter. There is no asynchronous factory, idle watchdog, pool or retry.

Hard cancellation terminates the Worker; an in-band message cannot preempt synchronous WASM. The
local reason is preserved; transported errors preserve name/message. Canvas readback/copies, Blob
construction and custom synchronous encoders remain non-preemptible. Promise settlement is not
proof of physical thread teardown or immediate RSS return. No production SharedArrayBuffer or
cross-origin isolation is required.

```ts
import type { WebpEncoderFactory } from '@grundyjs/canvas-take/webp';
const encoder: WebpEncoderFactory = ({ plays }, { signal, limits }) => ({
    addFrame(frame) {
        // Exclusive full-span owned RGBA8. May transfer its buffer; never caller storage.
        // Preserve complete-image semantics, exact durationMs and plays; charge limits.
    },
    async finish() { return completeAnimatedWebpBytes; },
    dispose() { /* Settle pending work and release all retained frames/native/Worker resources. */ }
});
```

Each factory call owns a fresh encoder. Methods run sequentially and dispose is invoked once.
The controller copies final ordinary-buffer Uint8Array output before yielding and validates RIFF
bounds/padding, dimensions, animation structure, plays and total duration. It does not decompress
pixels or prove individual merged presentation intervals; encoder compatibility requires independent
decoding. The supplied libwebp build, notices, native oracle, viewer differences and one earlier
unreproduced Firefox failure remain documented in the [Worker report](drafts/webp-worker-verification.md).

## Browser checks in CI

After `npm ci` and `npx playwright install --with-deps chromium firefox`, run:

```sh
npm run test:webp:package:browser
npm run test:next:webp
```

The first command packs and installs a fresh tarball in an isolated consumer, checks strict
types/imports/assets/notices, then uses its actual Worker/WASM and packaged HTML example. The
second packs and installs the library in a separate Next.js consumer, builds production output,
starts `next start` and checks bundled, package-entry and copied Worker/WASM URLs.
The original `test:webp:package -- --browser` and `test:next -- --webp-browser` flags still work.

Both `test:package` and `test:webp:package` validate documentation from the installed tarball:
the generated public WebP PROVENANCE must retain the upstream notice and identify the installed
package version. They also check current English/Russian WebP README sections, this guide and
the versioned changelog. Dated research reports and the original feature-introduction version
remain historical records.

Both commands run Chromium and Firefox. They abort after the first accepted frame, check the
original rejection reason and `collecting → aborted` progress, and wait for the cancelled Worker
to close before retrying with a fresh Worker. The retry has different holds and plays: 70/90/2100 ms,
one play, 2260 ms total. FFmpeg payload decoding plus native browser decoding verify the new output,
including transparency, timing and plays. UI cancellation hides the stale download; UI export and
preview are also checked. Worker inventories must be empty after each completed session.

CI uploads `browser-results` (installed consumer) and `next-webp-results` (Next.js), retained for
seven days. They contain `results.json`, WebP files, screenshots and console logs; browser failures
also record phase, requests, page errors and Worker counts. Next.js adds `server.log`. Setup/build
failures remain in the command log even if no browser starts. See the [CI report](drafts/webp-ci-verification.md)
for verification evidence and decoder limitations. These checks do not change the public API.
