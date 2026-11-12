# Private APNG Worker/backend integration

Date: 2026-11-12, local changes after released `0.6.1` (`b9bb4d9`). Continuation of the
[private controller](apng-controller-verification.md) and [backend feasibility study](apng-backend-spike.md).
This report records local verification before commit/push. No public APNG entry, version bump or
publication is included; remote CI must be assessed on the eventual committed candidate SHA.

## Implementation

The controller now drives a real pinned UPNG/Pako batch backend through a dedicated module Worker.
`src/internal/apng-worker.ts` provides a private `createApngWorkerEncoder({ workerUrl?, timeoutMs? })`
factory, with a default 30-second per-request timeout. The default asset is the sibling
`apng-worker-runtime.js`; a caller may override it when copying assets. Imports remain safe without
browser globals, while factory acquisition fails when Worker is unavailable.

Each encoder owns a new Worker. A versioned APNG-only init/frame/finish protocol acknowledges
accepted transferred snapshots and returns complete transferred bytes. A batch frame remains in
the Worker until finish or termination. Fixed dimensions, frame delay, ownership and cumulative
input/output budgets are checked again inside the backend. The runtime retains no frames after
completion/error, closes after its terminal reply, and never reuses GIF or AAC Worker protocols.

The adapter observes the controller's signal, rejects pending requests with the first reason,
clears timeouts/handlers, removes its listener and terminates once. It rejects malformed live
acknowledgements, invalid output, Worker load/message errors, timeouts and posting failures. Stale
replies cannot acknowledge new work. Transfer parameters and pending frame references are cleared
after handoff/settlement so preserved transport errors cannot retain an input snapshot.

A bounded `--expose-gc` test retains two adapter handles and their rejected promises after init
abort and native-like posting failure. WeakRefs to frame objects, RGBA arrays and backing buffers
clear. This supplements the controller's five-mode retention test; it is finite JavaScript
reference-release evidence, not a measurement of native Worker RAM.

The internal synchronous batch implementation is codec plumbing, not a public synchronous adapter.
Its compression is non-preemptible on its own thread. The supplied Worker path achieves cancellation
by termination; a cancellation message behind synchronous compression would not interrupt it.
Main-thread canvas readback/copy remains synchronous. No peak-RAM or universal latency guarantee is added.

## Sources and distribution

Pristine UPNG revision `88f504b6577b726975f593caa38ba85d327c7c1f`, Pako 2.1.0 deflate and their
complete MIT/Zlib notices are vendored with [source URLs and SHA-256](../../vendor/apng/README.md).
Git attributes preserve exact bytes across platforms. Every build verifies all five pinned files;
it needs no upstream download and adds no runtime npm dependency.

The production transform applies the same three guarded changes as the spike and is tested for
equivalence, drift and reapplication. UPNG still writes PNG/APNG and Pako compresses it. The chosen
profile stays full-frame RGBA8 SOURCE/BACKGROUND, including single-frame animation; no palette,
rectangle, OVER/PREVIOUS optimization or self-decoder is introduced.

Only private codec/runtime assets contain the codec. Root/GIF/video public entry JavaScript and
public declaration files are compared with released 0.6.1. Private runtime/source maps, pristine
sources, guarded transform, licenses and provenance text are included in packed dist. Controller
and calling-thread Worker adapter remain codec-free. Package exports and dependencies are unchanged;
the only package-script addition is `test:apng:package`.

The final static comparison finds **13 byte-identical public JavaScript assets** (including the
shared container chunk) and **ten unchanged public declaration files** against the downloaded
published 0.6.1 package/source baseline.

## Independent verification

Node tests encode one/multiple identical partial-alpha frames, 1/14/55/2,000/65,535 ms delays and
plays 0/1/3/unsigned-max. The independent chunk oracle checks all CRCs, dimensions, sequences,
profile, count, plays and exact delay fractions. FFmpeg separately decodes all frames to full RGBA
and reads packet PTS/durations, including final holds. Hidden RGB at zero alpha is ignored; alpha
and visible RGB match exactly, without a widened tolerance.

Real Chromium/Firefox tests use HTMLCanvasElement and OffscreenCanvas, partial-alpha gradients,
transparent erasure, an immediate redraw after submission, one-frame animation and default/custom
Worker URLs. Expected pixels come from explicit sRGB readback after the browser's own canvas round
trip. Per engine the final correctness suite independently decodes seven files/eighteen frames,
including fresh exports after cancellation and errors. A separate development-example test covers
export, cancellation, stale-result cleanup and retry.

For compression cancellation, a test-only bundle instruments Pako's first real Deflate.onData call.
A SharedArrayBuffer flag is set while the deflate call is active and cleared when it returns. The
main thread observes active compression, aborts, gets the exact original error and sees the actual
Worker close while the flag remains active. No artificial blocking gate or fixed sleep creates
the cancellation window. Both engines then export and independently decode a fresh result on the
same page. Probe instrumentation is absent from normal generated assets/source maps.

Pre-start input failure and early abort can terminate native Workers before Playwright reports
their startup. Those cases assert all constructor/terminate pairs; all Workers actually observed
by Playwright must emit close. Do not conflate these two forms of lifecycle evidence.

### Firefox viewer limitation

The pinned Firefox viewer reports `Invalid encoded image data.` for total plays `4294967295`.
A matching plays=3 control previews normally; after masking only the acTL plays field and its CRC,
the two encoded files are byte-identical. Both files pass structural checks and independent RGBA/
packet decoding. Chromium previews both. The integration preserves the requested unsigned count
rather than silently changing it. The development example recommends 0 or 1 for portable playback.
This is an observed viewer limitation, not a claim that every valid APNG plays in every browser.
The spike's separate FFmpeg OVER metadata limitation also remains; no optimized blend profile is certified.

## Commands and acceptance boundary

Final local verification, Windows x64 / Node 22.17.0 / Playwright 1.64.1:

| Check | Result |
| --- | --- |
| `npm test` | Build and 161/161 tests pass: 119 existing, 34 controller and eight real-backend/transport groups |
| `npm run test:package` | Existing isolated packed/runtime/TypeScript consumer passes |
| `npm run test:apng:package` | Installed private APNG declarations and eight Chromium/Firefox browser tests pass |
| `npm run test:next -- --apng-browser --offline-install` | Next.js 16.3.0 production build, installed static assets/notices, independent decoding and both-engine preview pass; 4/4 observed Workers close |
| `npm run test:browser -- --workers=1` | 82 pass, four capability skips for Firefox MP4 MediaRecorder; all eight APNG tests run |
| Public compatibility | Ten declaration files unchanged; 13 public JS assets byte-identical to published 0.6.1 |
| Sources/documentation | All five vendor hashes, patch guards/equivalence, source maps/notices, relative links and whitespace checks pass |

An earlier run overlapped a dist rebuild with browser reads: a WebM test briefly loaded the
intermediate unbundled module and failed to resolve `mediabunny`. A GIF GC subprocess also timed
out under concurrent load. The isolated WebM suite passed 8/8 and the resource subset passed 14/14.
A subsequent two-browser-worker run hit the GIF example's existing one-minute timeout on this
machine and was stopped. Final checks above run builds before browser reads, with one browser
worker for the complete local suite; no test timeout, assertion or production GIF/video code was
relaxed. The CI configuration retains its existing two-browser-worker setting.

Raw final logs: `benchmark-results/apng-final-node.log`, `apng-final-package.log`,
`apng-final-apng-package.log`, `apng-final-next.log` and `apng-final-browser-serial.log`.
The [saved verification summary](apng-integration-results.json) records command results and source
hashes; large generated media and screenshots remain ignored.

Run `npm test`, `npm run test:browser -- --workers=1`, `npm run test:package`,
`npm run test:apng:package` and `npm run test:next -- --apng-browser`.
The APNG package command packs/installs into an isolated consumer, checks private declarations,
and runs the real two-engine browser matrix using installed controller/adapter/runtime assets.
Its compression probe is built from local pinned sources; ordinary exports use the installed runtime.

The Next command copies private assets from the installed tarball into its public directory. The
optional browser check verifies same-origin Worker CSP, independently decodes a four-frame export
in each engine, runs the example and observes 2/2 Workers closed per engine. This is a tested static-
copy deployment; it does not establish public APNG exports or automatic bundler URL rewriting.
Screenshots, logs and local checks are retained under ignored `benchmark-results/apng-*`.

For the development preview run `npm run build`, then `node examples/server.cjs` and open
`http://127.0.0.1:3012/canvas-take/examples/apng.html`. Serve it over HTTP so the module Worker can
load; the example intentionally uses private development paths rather than a published import.

The existing Node/browser CI jobs include the new tests; the browser job additionally runs the
private packed APNG command before the full suite. The Next build includes the private copied-assets
fixture. These recorded local results do not claim remote CI success for a later candidate SHA.

Next: review and expose public controller/Worker entries, promote API documentation and test public
typed imports, packed consumers and bundler deployment. Remote CI and any new release are checked
separately. Existing APNG design/spike results remain historical evidence and are not rewritten.
