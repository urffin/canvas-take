# Private WebP Worker and libwebp integration

Date: 2026-11-13, after private-controller commit `f0bebc1cddcc94575d37f9797ed8d9abb9af6631`.
See the [contract](webp-export.md), [gates](webp-export-compatibility.md),
[controller tests](webp-controller-verification.md) and [saved observations](webp-worker-results.json).
Public exports/declarations, package dependencies and version **0.7.0** remain unchanged.

## Implementation

`src/internal/webp-worker.ts` supplies a synchronous encoder factory to the existing private
controller. Each invocation owns one module Worker. The calling thread imports no native codec.
The adapter captures codec options and independent Worker/WASM overrides; resolves URLs only on
acquisition; starts initialization immediately; and memoizes idle initialization failure until
the next call reaches it. An earlier controller input failure or cancellation can still win.

The dedicated `{format:'webp',version:1,id,action}` protocol supports init/frame/finish. Init checks
binding ABI 1 and `libwebp-batch-animation-v1`. Request IDs increase, one operation is reserved
before waiting for init, and each posted request has its own 30-second default timeout. Pending
state exists before postMessage, including synchronous replies/errors. Unknown/stale replies and
stale timeout callbacks cannot settle current work or reset deadlines. Matching malformed tags,
actions, handshake/error shapes, mixed success/error bodies or non-full-span output fail closed.

The runtime rejects wrong tags, duplicate/out-of-order/overlapping requests and validates options
before fetch. It rechecks fixed dimensions, full-span ordinary RGBA8 storage and every normalized
budget before retaining a frame. A frame acknowledgement means admission, not compression. Finish
enters the batch native encoder with accumulated timestamps and an explicit final timestamp, then
copies native output before freeing input/session/output allocations. The runtime transfers only
the exact output span, drops snapshots/module references and closes. The host terminates its handle
and clears handlers, abort listeners and pending request timers on every terminal outcome.

Cancellation uses hard Worker termination; an in-band message cannot preempt synchronous WASM.
The first locally observed reason wins. Late initialization, replies and failures cannot create
new progress/success. Transferred snapshots belong to the runtime; caller storage is never sent.
Input budgets count cumulative raw admission, not total peak JS/WASM/Blob memory. Output caps can
reject assembled output but do not prevent all peak native allocations.

## Verified native assets and loader correction

`scripts/build-webp-backend.mjs` still performs two pristine source/object builds using the pinned
Windows x64 toolchain and animation-retention guards. It now exports native ABI/profile tags and
explicitly includes `wasmBinary` in Emscripten's incoming API. Without this flag, `-sSTRICT=1`
silently ignored the supplied bytes and loaded neighboring `backend.wasm`; the original proof's
directory layout hid that behavior. Renaming/relocating the private assets exposed it. Current
tests load `webp-codec.wasm` explicitly, with no neighboring `backend.wasm`, and reject missing or
non-WASM explicit assets without fallback.

Both fresh builds were byte-identical:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `webp-codec.js` | 9,734 | `d677e819842a0f14f68bbae36405d9bbeb623678923efeddb743ac00b04368bb` |
| `webp-codec.wasm` | 279,050 | `5a115a11fc6451b043d19a74833cd931e05e119e70120a8a961e8ab7f7c09a98` |

`scripts/stage-webp-backend.mjs` validates both builds and binding sources, checks native tags and
stages assets plus libwebp COPYING/PATENTS/AUTHORS, Emscripten MIT/NCSA and linked musl/compiler-rt
notices in `vendor/webp`.
The manifest records archive pins, flags, patches, binding hashes and asset/notice hashes.
Git checkouts preserve the pinned vendor bytes through `.gitattributes`, including on Windows.
Normal package builds verify and copy these checked assets into `dist/internal`; they never download or
compile a codec. The existing `files: ['dist', ...]` includes the private assets, but the export map
blocks `/webp`, `/webp/worker` and internal subpaths. Installed asset hashes/notices are checked.
This adds approximately 289 KB of JS/WASM before compression; it creates no supported WebP entry.

## Protocol, cancellation and resources

Seventeen deterministic Worker/native test groups cover handshake, reservations, URL resolution,
ack shapes, stale IDs/timers, all request deadlines, transport/scheduler failures, reentrant
constructor/listener abort, output spans/budgets, runtime ordering, invalid/late loads and cleanup.
Six real-integration groups run the emitted adapter/runtime and native WASM in Node Worker threads.
A test-only bridge supplies browser Worker/fetch/close shapes; production code contains no Node
bridge and remains a module-Worker implementation. The matrix checks actual buffer detachment,
caller preservation, finish identity, progress and actual thread exit, rather than inferring exit
from terminate's return.

Allocation-denial and output-limit failures return tracked native allocations to zero and permit
deterministic fresh-Worker retries. Twelve repeated exports in one native module return tracked
bytes, allocations and allocator-used bytes to zero. A retained-transport WeakRef/GC probe checks
owned frame release after abort/post failure while keeping the encoders and promises alive.

Hard cancellation is checked during loading and while a real `WebPPicture.progress_hook` is paused
inside native compression. The latter uses a test-only shared barrier; the phase remains inside
the callback when the thread exits, no Blob succeeds, and a new Worker exports again. This is not
proof of interruption at every instruction of a callback-free hot loop, execution of all C
destructors after termination, immediate RSS recovery or constant cancellation latency. Production
encoding needs neither SharedArrayBuffer nor cross-origin isolation.

## Independent complete-file decoding

The opt-in checker exports **20 animations** through controller → adapter → real Node Worker →
WASM, then decodes the complete files with **Pillow 12.0.0 / native libwebp 1.6.0** in a separate
Python process. This is independent of the encoder WASM binary, while sharing the underlying
libwebp codec family. The wheel is SHA-256 pinned and extracted into an ignored verification
directory using the existing isolated Python; no global/root package dependency is installed.
The [Pillow WebP API](https://pillow.readthedocs.io/en/stable/handbook/image-file-formats.html#webp)
provides frame seeking, timestamps, durations and loop metadata.

Every encoded presentation interval is compared with all overlapping input intervals. Lossless
visible RGB and all alpha bytes match exactly; hidden RGB at alpha zero is excluded. Lossy cases
require exact alpha and RGB mean absolute error at most 100 over channels with alpha >=128. This
is a declared fixture check, not a general quality recommendation. Counts may differ after merging
or splitting. All file/native timestamps, final holds, plays and dimensions match.

The matrix covers 1/10/11 ms delays, 55+2000 ms final holds, plays 0/1/3/65535, a single animated
frame, fully transparent odd-size input, alpha 0/1/127/128/254/255, transparent erasure, duplicate
middle frames, identical holds crossing uint24 and lossy partial-alpha/erasure. The uint24 case
retains its 16,777,270 ms total using multiple encoded frames without fake input snapshots.

Four valid negative controls are rejected by the independent oracle: total-preserving wrong holds,
wrong plays, wrong pixels and a blending ghost. The first deliberately passes the controller's
total-only envelope checker, demonstrating why independent interval decoding remains necessary.
The saved matrix observes all 20 Worker exits, zero final live native bytes/allocations and exact
input snapshot transfers.

FFmpeg 6.1.1 independently verifies diagnostic payloads/presentation for 19 cases. The new lossy
alpha ramp exposes its ALPH decoding discrepancy: 254/255 become 253/254 in six pixels per frame.
Full-file Pillow retains the exact alpha. The shared strict FFmpeg oracle still rejects that ramp;
no tolerance was added to hide the discrepancy. FFmpeg full-animation demux is not claimed.

## Reproduction and scope

```sh
npm test
npm run test:package
node scripts/check-webp-integration.mjs --prepare-pillow
# Separately authorized local browser verification:
node scripts/check-webp-browser.mjs --repeat=2
```

The first two commands require only checked-in assets and existing npm dependencies. The Node
integration command is an opt-in Windows CPython 3.13 reference check, using the portable Python
already prepared by the earlier backend recipe; `--prepare-pillow` permits fetching only its
hash-pinned verification wheel. Subsequent runs can omit that flag. The browser command uses the
installed Playwright Chromium/Firefox binaries and does not need Python/Pillow. To rebuild/stage
native assets:

```sh
node scripts/build-webp-backend.mjs --prepare
node scripts/stage-webp-backend.mjs
npm run build
```

Local build + **215/215 Node tests**, strict/exactOptional draft/controller/Worker type comparison,
draft examples and the packed Node consumer passed. Raw files/results/logs remain under ignored
`benchmark-results/webp-integration` and `benchmark-results/webp-worker-*.log`.

The built-in browser initially failed three times before opening tabs, including the requested
retry after waiting. The user subsequently explicitly authorized Playwright Chromium/Firefox for
this WebP check; the observations below were obtained only after that permission. No commit, push,
new CI run, version or publication is part of this task.

## Authorized browser verification

The final combined run completed one matrix plus two repeat matrices per engine, with identical
file hashes and repeated native-decode checks:

| Engine | Positive exports verified | Observed Worker targets opened/closed |
| --- | ---: | ---: |
| Chromium 156.0.8078.4 | 72 | 92 / 92 |
| Firefox 157.0 | 72 | 93 / 93 |

All 185 observed targets closed before page/browser shutdown. A before-init Worker object can be
terminated before its target is observed, so object and target totals need not be identical.

The opt-in `scripts/check-webp-browser.mjs` starts fresh Chromium/Firefox profiles sequentially,
with one agent-owned page at a time, and preserves user browser sessions. It uses ordinary module
Workers and the actual built private controller/adapter/runtime/assets. The
[saved browser observations](webp-browser-results.json) are separate from the earlier Node/native
oracle snapshot. Nothing in the normal package build or Node tests starts a browser.

Each engine exports and independently decodes **24 positive cases**: the existing 20-file matrix,
real OffscreenCanvas, both assets relocated to different directories, a Worker-only URL override
and a WASM-only override. The normal page is explicitly not cross-origin isolated. Each real canvas
is redrawn immediately after `addFrame` returns its Promise; output still matches the captured
pixels. Caller ImageData/readback storage stays attached, owned snapshots are actually transferred,
finish Promise identity and Blob lifetime after disposal are checked.

Native ImageDecoder verifies frames, dimensions, file presentation intervals, plays, final holds
and exact alpha, including the lossy ramp. Visible opaque lossless RGB is exact; differences from
native premultiplication/unpremultiplication at partial alpha are recorded rather than mislabeled
as encoder errors. FFmpeg independently verifies the lossless captured straight RGB and the other
supported payload profiles. Its previously recorded ALPH discrepancy remains excluded from an
exact-FFmpeg claim. Firefox reports 1/10 ms holds as 100 ms; Chromium reports the exact file holds.
Native timestamps use those measured viewer durations; file timestamps remain unchanged. Four
valid negative controls are rejected by the native presentation oracle in both engines.

Real module-Worker failures cover missing Worker/WASM assets, HTML served as WASM, incompatible
profile acknowledgement, denied cross-origin WASM fetch, Worker response `connect-src 'none'` and
document `worker-src 'none'`. Default/relocated assets are served through explicit local maps; a
Worker override does not move its default WASM URL. No CDN/static-encoder fallback succeeds.

Cancellation covers before initialization, an actually entered/paused WASM fetch, a captured frame
waiting for its scheduled handoff, and the finalizing observer. Each case preserves its exact local
reason and permits a fresh export. The fetch barrier is reset per engine; server assertions require
each browser to enter its own fetch and close the paused response. A separate isolated page uses
the existing test-only native-progress barrier. Playwright awaits actual target closure; the shared
phase still indicates the callback was active after closure, with no cancelled Blob. Three fresh
native-probe retries per engine finish with zero tracked native bytes/allocations. Handler counts
and final Worker inventories are zero. This remains a paused-callback test, not arbitrary hot-loop
preemption or RSS certification.

One exploratory combined run failed in Firefox with a generic `encoder.addFrame` error before
the harness retained its nested cause or case name. No production-code fix is claimed for it.
Diagnostic case/cause/console/request capture and additional deterministic repeat matrices were
added; later results are recorded separately in the browser JSON. The original cause is unknown
and remains a reliability observation for follow-up if it recurs. The repeated file hashes/native
decodes, handler inventories and target-close checks must all pass; the harness has no retry that
turns a failed export into a success and request timeouts were not increased.

Installed public WebP assets/types/Next bundling and public entries remain future stages. The
local browser evidence is not a new CI result or a general browser/version support guarantee.
