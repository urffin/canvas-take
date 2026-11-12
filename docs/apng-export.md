# APNG export

Status: implemented in the working tree, **not yet released**. npm 0.6.1 does not contain these
public entries. This guide applies to a built checkout or its locally packed tarball.

```js
import { createApngExporter } from '@grundyjs/canvas-take/apng';
import { createApngWorkerEncoder } from '@grundyjs/canvas-take/apng/worker';

const controller = new AbortController();
const exporter = createApngExporter({
    encoder: createApngWorkerEncoder(),
    plays: 3,
    signal: controller.signal,
    totalFrames: 2,
    onProgress(p) { console.log(p.phase, p.framesAccepted, p.durationMs); }
});
try {
    // Draw your first complete image on canvas.
    await exporter.addFrame(canvas, 55);
    // Draw the next complete image; transparent regions erase the previous image.
    await exporter.addFrame(canvas, 2000);
    const blob = await exporter.finish(); // image/apng, suggested extension .apng
    const url = URL.createObjectURL(blob);
    // Use url in an image/download link; revoke it when no longer needed.
} finally {
    exporter.dispose();
}
// To cancel pending work from a UI handler: controller.abort().
```

The library does not draw or run your animation. Each frame is a full independent snapshot from an
origin-clean HTMLCanvasElement or OffscreenCanvas with a 2D context. Bitmap dimensions stay fixed
after the first accepted frame; CSS scaling does not affect output dimensions. The owned sRGB
straight-alpha RGBA8 snapshot is captured synchronously before the first yield, so an immediate
redraw cannot alter submitted pixels. The caller's canvas/readback storage is never transferred.
Transparency is preserved; there is no background flattening or GIF palette conversion.

## Public entries

| Entry | Exports/use |
| --- | --- |
| `@grundyjs/canvas-take/apng` | `createApngExporter` and the eight `Apng*` controller/encoder types |
| `@grundyjs/canvas-take/apng/worker` | `createApngWorkerEncoder`, `ApngWorkerOptions` |
| `@grundyjs/canvas-take/apng/worker-runtime` | Dedicated module Worker asset; resolve its URL, do not import it on the calling thread |

Root/GIF/video entries do not re-export APNG. Controller and Worker-adapter imports are safe during
SSR and in Node and contain no codec. Creating the supplied encoder requires browser Worker support;
load/protocol/capability failures reject export without silently changing format or codec.

## Options, timing and limits

| Option | Meaning |
| --- | --- |
| `encoder` | Required synchronous factory returning a fresh encoder; no hardcoded controller codec |
| `plays` | Total plays, 0 infinite (default), 1 once, maximum 4,294,967,295; differs from GIF repeat count |
| `signal` | Optional AbortSignal; a pre-aborted signal rejects before encoder acquisition |
| `totalFrames` | Optional positive safe-integer progress hint; does not impose a limit |
| `maxFramePixels` | Optional inclusive positive safe-integer `width * height` limit |
| `maxFrames` | Optional inclusive positive safe-integer accepted-frame limit |
| `maxDurationMs` | Optional inclusive positive safe-integer sum of submitted delays |
| `maxInputBytes` | Default 64 MiB; inclusive cumulative admitted RGBA bytes, including a pending frame |
| `maxOutputBytes` | Optional inclusive positive safe-integer complete-file limit |
| `onProgress` | Optional synchronous observer of frozen snapshots |

`addFrame(canvas, durationMs)` accepts an integer delay in **1..65535 ms**. The file concatenates
those exact delays, including a long final hold, independently of rendering speed. No fps inference,
frame insertion/merging or GIF rounding is performed. A single frame keeps animation metadata and
its delay; empty finish fails. Browser playback may clamp short delays or reject very large play
counts: the pinned Firefox viewer rejects unsigned-max plays while independent decoding succeeds.
Use 0 for continuous playback or 1 for a single play when portability matters.

Limits, fixed size and delay validity are checked before frame readback. Budget errors produce no
partial file and release owned resources. Raw-input and output bounds are logical budgets, **not
peak-memory guarantees**. The batch encoder retains inputs until finish; scratch, compressed output,
the controller's validation copy and Blob copies are additional allocations. Native canvas limits
also apply. A whole-file codec may allocate output before checking its final size.

## Lifecycle and progress

Await each add before another add or finish. Overlapping calls reject without cancelling the
accepted operation. States: `ready`, `adding`, `finalizing`, `finished`, `failed`, `aborted`, `disposed`.
Repeated finish during finalization or after success returns the original Promise. Disposal after
success cannot invalidate that Promise or Blob; a new finish call after disposal rejects.
Create a fresh exporter for retry.

Progress phases are `collecting`, `finalizing`, `finished`, `failed`, `aborted`, `disposed`.
`framesAccepted`, `durationMs` and `inputBytesAccepted` advance after encoder acknowledgement,
which means accepted, not compressed. `totalFrames` is absent when unset; `outputBytes` appears only
on success. There is no initialization notification or compression percentage. Snapshots are fresh,
shallow frozen and allocated lazily. Observer exceptions are ignored; observer abort after counter
commit may reject an add without rolling counters back. Disposing from the finished observer cannot
retract success.

The first terminal reason wins. Encoder factory/add/finish errors retain the exact `cause` in a
component-specific Error; input/readback/limit errors retain their identity. Cleanup exceptions and
late replies cannot replace the result. Cancellation preserves the external reason with a nullish
AbortError fallback. `dispose()` is idempotent and cancels unfinished work. The controller validates
the returned animation envelope, exact metadata and all chunk CRCs, yielding cooperatively during
large scans. Pixel correctness remains the encoder's responsibility.

## Worker deployment

The default adapter creates a fresh module Worker per exporter with
`new Worker(new URL('./apng-worker-runtime.js', import.meta.url), { type: 'module' })`.
Bundlers that support this expression can emit the sibling runtime automatically. Next.js/Turbopack
is checked using public imports from an installed tarball. Keep `worker-src 'self'` compatible with
the deployed asset origin. No SharedArrayBuffer or cross-origin isolation is required by production
export; the compression-cancellation test alone uses a shared probe.

For a bundler-specific asset URL, use its documented URL mechanism, for example:

```js
const encoder = createApngWorkerEncoder({
    workerUrl: new URL('@grundyjs/canvas-take/apng/worker-runtime', import.meta.url),
    timeoutMs: 60_000
});
```

Support for package-specifier `new URL` depends on the bundler. An explicit static-copy alternative is:

```js
const encoder = createApngWorkerEncoder({ workerUrl: '/assets/apng-worker-runtime.js' });
```

Copy `dist/apng-worker-runtime.js`, its `.map`, `apng-PROVENANCE.md` and `apng-sources/` from the
installed package into that directory, preserving licenses and source references. The runtime is
self-contained and needs no codec CDN or runtime npm dependency. `timeoutMs` defaults to 30,000 ms
per init/frame/finish request; accepted values are finite numbers in `(0, 2147483647]`.

Termination interrupts synchronous compression inside the Worker and releases its retained inputs.
Main-thread canvas readback/copy and a custom synchronous codec cannot be preempted. No universal
cancellation-latency or immediate physical-memory-reclamation promise is made.

## Custom encoders

Implement `ApngEncoderFactory`: synchronously return a fresh instance with `addFrame`, `finish` and
idempotent `dispose`. Each frame supplies fixed width/height, owned full-frame RGBA data and its exact
delay. The encoder may retain or transfer that data; it owns cleanup until termination. There is no
retry after handoff. `finish` returns a complete nonshared Uint8Array APNG, not a static PNG. Context
contains the owned AbortSignal and byte budgets. Do not confuse accepted progress with compression.
See the public TypeScript declarations for the full signatures.

The supplied backend uses pinned UPNG/Pako and full-frame RGBA8 SOURCE/BACKGROUND. It retains
single/identical frames and transparent erasure. Palette, frame-rectangle and OVER/PREVIOUS
optimization are excluded. Full sources, guarded modifications and MIT/Zlib notices are shipped
beside the runtime; see `dist/apng-PROVENANCE.md`.

## Example and verification

Run `npm run build`, then `node examples/server.cjs` and open
`http://127.0.0.1:3012/canvas-take/examples/apng.html`. The [example](../examples/apng.html) uses public
package names with an import map for an unbundled checkout. Revoke old result URLs on new exports,
errors and page teardown, and dispose in finally.

`npm test` checks contracts and public isolation. `npm run test:package` checks public types/runtime
imports; `npm run test:apng:package` installs the tarball and verifies actual Chromium/Firefox exports,
independent RGBA/timing decoding, cancellation and retry. `npm run test:next -- --apng-browser`
checks a packed Next.js consumer with emitted/default and copied/explicit Worker URLs.
