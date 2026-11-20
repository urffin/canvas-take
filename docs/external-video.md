# External MP4 and WebM export

Available in CanvasTake 0.9.0 and later. `createExternalVideoExporter` sends positioned writes to a
destination as encoding proceeds. The destination publishes a completed result after the codecs and
container finish. External output avoids assembling a final video Blob in memory. Prepared PCM,
encoder buffers and container metadata still use memory. For Blob output, use
`createOfflineVideoExporter` with `createMp4Muxer()` or `createWebmMuxer()`.

| Import suffix | Export |
| --- | --- |
| `/video` | `createExternalVideoExporter` and the external output contracts |
| `/video/mp4` | `createMp4Muxer({output: 'external'})` for H.264 and optional AAC |
| `/video/webm` | `createWebmMuxer({output: 'external'})` for VP8 and optional Opus |
| `/video/browser` | `openBrowserVideoResultStore` for origin-private storage |
| `/video/node` | `provisionNodeVideoDestination` for a controlled local directory in Node |

## Write a file in browser storage

The browser store needs a secure context with OPFS, IndexedDB and Web Locks. Generate a UUID with
`crypto.randomUUID()` and keep it in application storage. Open that scope with `mode: 'create'`
the first time and `mode: 'reopen'` for later sessions. The scope is private to the current origin.
The example writes one H.264 frame held for one second and reads the committed `File` while its
lease is active.

```ts
import {createExternalVideoExporter} from '@grundyjs/canvas-take/video';
import {openBrowserVideoResultStore, type BrowserVideoResultStoreOptions, type BrowserManagedAttempt}
    from '@grundyjs/canvas-take/video/browser';
import {createMp4Muxer} from '@grundyjs/canvas-take/video/mp4';
import {createWebCodecsVideoEncoder} from '@grundyjs/canvas-take/video/webcodecs';

async function saveCanvasFrame(
    canvas: HTMLCanvasElement,
    storeOptions: BrowserVideoResultStoreOptions,
    rememberAttempt: (attempt: Pick<BrowserManagedAttempt, 'key' | 'ownerHold'>) => Promise<void>,
    consumeFile: (file: File) => Promise<void>,
    signal?: AbortSignal
) {
    const store = await openBrowserVideoResultStore(storeOptions);
    try {
        const {key, ownerHold, destination} = store.bind('movie.mp4');
        await rememberAttempt({key, ownerHold});
        const exporter = createExternalVideoExporter({
            video: {encoder: createWebCodecsVideoEncoder(), config: {
                codec: 'avc1.42E01F', bitstreamFormat: 'avc', width: canvas.width, height: canvas.height,
                bitrate: 2_000_000
            }},
            muxer: createMp4Muxer({output: 'external'}),
            destination,
            ifExists: 'error',
            ...(signal ? {signal} : {})
        });
        try {
            await exporter.ready;
            await exporter.addFrame(canvas, {timestampUs: 0, durationUs: 1_000_000});
            const {output} = await exporter.finish();
            const access = await store.acquireFile(output.value.key);
            if (access.status !== 'available') throw new Error(`File access: ${access.status}`);
            try { await consumeFile(access.value.file); }
            finally { await access.value.release(); }
        } finally {
            exporter.dispose();
            await exporter.closed;
        }
    } finally {
        await store.close();
    }
}
```

For video with more frames, call `addFrame` sequentially. Pass a contiguous timeline from zero in
integer microseconds. The optional `audio` option takes the same prepared PCM source and audio
encoder as Blob export. See the [AAC guide](offline-aac.md) and [WebM guide](offline-webm.md).

## Read, download and retire browser results

Names are logical catalogue entries within the scope. `lookup(name)` finds the current version and
`acquireFile(key)` pins a specific version until release. Use `prepareDownload(key)` before a user
click, then call the prepared handle's `request()` synchronously in the click handler. Dispose the
handle when the application no longer needs its object URL. A successful request acknowledges
dispatch. The browser controls completion and the native filename.

Each committed version has an owner hold. To delete an old version, release its owner hold and
any application holds, let readers and download handles finish, and pass an inspected revision to
`deleteVersion`. Current versions remain protected. A scope admits up to 256 attempts and 512
additional hold records. Publication history still counts after file bytes have been deleted.

## Publication, cancellation and recovery

`ifExists: 'error'` is the default. It creates a new name and rejects collisions. Use `'replace'`
to create a missing name or switch an existing name to the new completed version.

Wait for `ready` before submitting frames. To cancel before commit, abort the supplied signal or
call `dispose()`. Wait for `closed` before retrying with a fresh `bind()` and exporter. Once commit
starts, the destination determines the outcome. `closed` reports `publication` and `cleanupIssues`.
A successful `finish()` returns the destination's receipt in `result.output.value`. Disposing the
exporter releases session resources while the committed result remains available.

Keep the attempt key and browser owner hold before export. If `closed.publication` is
`'indeterminate'`, inspect the saved attempt with `store.recovery.inspect(key)` or the Node binding's
`recovery.inspect(key)`. In the browser, reopen the original scope if needed. The selected version
and the outcome of a specific attempt are separate observations. Check recovery before retrying a
write to the same name. Staging cleanup requires confirmation that physical I/O settled.

## Node destination

Import `/video/node` only from Node code. Pass an existing canonical directory with
`{trust: 'controlled-local-directory'}` on Node 22 or 24 under Linux or Windows. The receiver
assumes the application controls the directory and cooperating callers. Commit returns a receipt
with a `path` and a `read()` method for the original version. Recovery is scoped to the live
receiver. Reuse the receiver to bind new attempts and supply encoders that work in your Node process.

```ts
import {provisionNodeVideoDestination} from '@grundyjs/canvas-take/video/node';

async function bindFile(directory: string) {
    const receiver = await provisionNodeVideoDestination(directory, {trust: 'controlled-local-directory'});
    return receiver.bind('movie.webm'); // Pass the binding's destination to createExternalVideoExporter.
}
```

To use another backend, supply an `ExternalVideoDestination<Value>`. Its `checkSupport` is
read-only. Each `create()` returns a fresh isolated transaction with positioned writes, truncation,
commit and cleanup. A write borrows its byte view until the operation settles. Choose the receipt
type `Value` to expose the committed result to the caller.

## Next.js and the AAC Worker

Use browser storage and WebCodecs in a Client Component after hydration. The core and browser
adapter can be imported during SSR. Keep `/video/node` in server code running on the Node runtime.

For AAC, copy the installed Worker into `public/` before building. An example script at
`scripts/copy-video-worker.mjs` can resolve the asset through the installed package export.

```js
import {copyFile, mkdir} from 'node:fs/promises';

const assets = new URL('../public/canvastake/', import.meta.url);
await mkdir(assets, {recursive: true});
await copyFile(new URL(import.meta.resolve('@grundyjs/canvas-take/video/aac-worker')),
    new URL('video-aac-worker.js', assets));
```

On the client, pass the same-origin URL to `createAacAudioEncoder`. Adjust the URL if the Next.js
app uses a base path.

```ts
import {createAacAudioEncoder} from '@grundyjs/canvas-take/video/aac';

function createBrowserAacEncoder() {
    return createAacAudioEncoder({
        workerUrl: new URL('/canvastake/video-aac-worker.js', window.location.origin)
    });
}
```

Call the helper after hydration and pass its result as `audio.encoder` in the exporter options.
See the [AAC guide](offline-aac.md) for PCM configuration, Worker requirements and CSP.
