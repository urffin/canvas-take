# libwebp WASM backend proof

Status: backend-only prototype verified on 2026-11-12, following the
[candidate research](webp-backend-research.md). **This does not add a public WebP API,
package entry point, production dependency or new version.**

The prototype builds libwebp from source, fixes the final timestamp at the binding boundary,
configures actual loop metadata and releases native resources on success, errors and
cooperative cancellation. Two disclosed source guards retain animation metadata for a single
encoded frame. The compression implementation remains libwebp's.

The [saved results](webp-libwebp-backend-results.json) contain source/archive hashes, exact
compiler flags, the two build manifests, file hashes, independent decoder observations,
negative controls, allocation fault cases, memory samples and Worker lifecycle evidence.
Historical research results are preserved separately.

## Reproduction

The checked reference recipe supports **Windows x64** with Node development dependencies,
Windows `tar` for the source tarball, and the repository's Playwright browsers installed:

```sh
node scripts/build-webp-backend.mjs --prepare
node --expose-gc scripts/check-webp-libwebp.mjs
```

Later rebuilds reuse the verified tool archives:

```sh
node scripts/build-webp-backend.mjs
```

The initial download is 707,773,107 bytes. Portable tools, source trees, binaries, licenses,
media and raw observations stay under the ignored `benchmark-results/webp-libwebp` directory.
No global SDK installation, Docker service, root dependency install or user environment change
is performed. The recipe supplies its own `EM_CONFIG`, cache, Python and Node to child processes;
it does not depend on the system Python, which is Python 2 on the reference host.

Pinned inputs:

| Input | Reference |
| --- | --- |
| libwebp | Official 1.6.0 source archive; SHA-256 `e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564` |
| Emscripten | 4.0.20 release selector, archive commit `c387d7a7e9537d0041d2c3ae71b7538cc978104e`; compiler identifies `4.0.20-git (6913738ec5371a88c4af5a80db0ab42bad3de681)` |
| Python | Official Emscripten portable Python 3.13.3 archive |
| Node for compiler tools | Official Node 22.17.0 Windows x64 archive |

All four archive URLs and SHA-256 values are fixed in `scripts/webp-libwebp/toolchain.mjs`.
Downloads use a temporary file and are checked before installation. The small ZIP bootstrap
extractor accepts the required stored/deflated, hash-pinned archives, bounds paths to the
destination and rejects symlinks/encryption/unsupported layouts. It is not a general ZIP API.
SDK tests/documentation are excluded from extraction. An initial slow `tar` SDK extraction was
replaced with this parallel extractor; the tested recipe uses the latter.

Each build re-extracts pristine libwebp source into a separate directory, copies the binding,
applies the guarded changes once and compiles 123 codec translation units. It does not reuse
codec object files. Both builds use the same pinned SDK/system-library cache. Sorting, flags,
`SOURCE_DATE_EPOCH` and output basenames are fixed; debug information is stripped. This proves
byte identity for two source/object builds on this host, **not** independent-machine or
cross-platform reproducibility.

| Output, identical in both builds | Bytes | SHA-256 |
| --- | ---: | --- |
| `backend.mjs` | 9,448 | `3e5ba5d4bbc29f22c7940401162825be195c2840b26cc772da23c1c31b141081` |
| `backend.wasm` | 279,012 | `d2a07637ac449406304d3528869f1871773c8b81df03bfac20c516c5eeeb2e27` |

These are instrumented prototype sizes, not a production download/performance comparison.
The checked-in JSON also hashes the C binding, header and verification harness. The checker
rejects a cached binary whose copied binding source differs from the current source.

The build retains libwebp COPYING, PATENTS and AUTHORS under `licenses/`, with hashes in the
manifest. Emscripten's runtime/tool license is available in the pinned SDK. No generated
third-party binary is included in the repository/package; any later distribution needs the
actual codec/runtime notices alongside its assets.

Primary build references: [official libwebp sources](https://github.com/webmproject/libwebp/tree/v1.6.0),
[pinned SDK release mapping](https://github.com/emscripten-core/emsdk/blob/4.0.20/emscripten-releases-tags.json),
[Emscripten build guidance](https://emscripten.org/docs/compiling/Building-Projects.html).
Version pins identify tested inputs and are not claims about the latest upstream versions.

## Encoding decisions

The private C ABI owns a `WebPAnimEncoder` session. Each complete straight-RGBA input is
imported into a temporary `WebPPicture`, added at its accumulated start time, then freed.
An input buffer is reused after each synchronous add. Finish explicitly calls
`WebPAnimEncoderAdd(encoder, NULL, finalTimestamp, NULL)` before assembly. Output is copied to
an independent JS array before native output/session storage is released.

Lossless/lossy mode, quality, method and plays are supplied to the binding. A full-keyframe
policy (`kmax = 1`, mixed compression disabled) makes the initial transparency profile
reviewable. Identical adjacent snapshots can still merge. The contract tested here preserves
presentation over every input interval; it does not require packet count to equal input count.
Generic partial-alpha delta blending is outside this proof.

For a single encoded frame, unmodified libwebp can remove animation metadata in both mux
cleanup and animation assembly. `single-frame-patch.mjs` adds a compile-time guard to exactly
one condition in `src/mux/muxedit.c` and one in `src/mux/anim_encode.c`. The reference build sets
`CANVASTAKE_KEEP_ANIMATION=1`. It rejects source drift and patch reapplication, records pristine
and changed hashes, and does not insert hidden/fake frames or repair output bytes afterward.
This is a maintained source difference from upstream; a production adapter must decide
explicitly whether to keep this policy.

See the official [animation API](https://github.com/webmproject/libwebp/blob/v1.6.0/src/webp/mux.h),
[single-frame mux cleanup](https://github.com/webmproject/libwebp/blob/v1.6.0/src/mux/muxedit.c)
and [animation assembly](https://github.com/webmproject/libwebp/blob/v1.6.0/src/mux/anim_encode.c).

## Independent decoding and timeline

Seventeen fixtures were encoded in Node and real module Workers. Each Worker result and
post-cancellation retry matched the corresponding Node file hash. Native Chromium 156.0.8078.4
and Firefox 157.0 ImageDecoder each decoded all 17 complete files, checking dimensions, alpha,
timestamps, durations and repetition metadata independently of this WASM encoder.

| Case | Verified result |
| --- | --- |
| Long last hold | 55 + 2000 ms, total 2055 ms; no estimated final delay |
| Alpha ramp | 70/90/130 ms; alpha 0/1/127/128/254/255 retained |
| Transparent erasure | Opaque → transparent → partial alpha, 50/75/100 ms; no ghost |
| Identical inputs | One encoded frame holding 2055 ms with animation/plays metadata retained |
| Duplicate middle | Encoded delays 50/160/200 ms; equivalent to input 50/70/90/200 ms |
| One frame | 2000 ms, including finite plays and infinite repetition |
| Entirely transparent one frame | Canvas 3×5, 999 ms, one play |
| Plays | File values 0/1/3/65535; both native decoders report Infinity/0/2/65534 repetitions, including one-frame files |
| Maximum frame delay | 16,777,215 ms followed by 55 ms, exact file/native timing |
| Lossy quality 40/90 | Both decode; final holds are 175 ms; no exact lossy-RGB quality claim |

For delays 1/10/11/100 ms, the file and Chromium expose those exact values. Firefox exposes
100/100/11/100 ms. This known viewer clamp is asserted explicitly, with the resulting viewer
timestamps, rather than silently changing the encoded timeline. Exact file timing does not
promise identical playback behavior in every viewer.

The main matrix contains 33 encoded payloads and 35 input-interval comparisons. Native RGBA
extraction can round/premultiply partial-alpha RGB, so it is not used to certify exact straight
RGB at low alpha. All native alpha bytes are checked; raw RGB differences remain in the JSON.

Separately, native FFmpeg 6.1.1 decodes the existing VP8/VP8L payloads after diagnostic static
RIFF wrapping. It verifies 29 small lossless payloads exactly at alpha > 0, plus a 1024×1024
lossless frame. All alpha values are exact; hidden RGB at alpha 0 is excluded. Four lossy
payloads are decoded and checked for alpha, without an exact-RGB assertion. Full-animation
FFmpeg demuxing is not claimed; its ANIM/ANMF limitation was established in the earlier research.
The encoder's own decoder is never the independent oracle.

The payload oracle handles replacement plus opaque/fully transparent OVER frames and the
tested disposal/canvas placement. It refuses generic partial-alpha OVER. Native decoders
independently check the complete file. Valid negative-control files with a wrong delay,
wrong plays, wrong pixels and a blending ghost are detected by both native decoders/comparisons;
the RIFF reader also rejects an incorrect file length. These controls distinguish successful
opening from correct animation semantics.

## Cancellation and resources

Allocation calls in the libwebp translation units are remapped to a tracking allocator.
The binding uses that allocator explicitly; system allocator calls remain unchanged. Every
temporary picture, input, encoded output and session is released through native cleanup paths.
A JS exception in the progress callback is converted into native abort, then rethrown after
native cleanup, preserving the original exception. It is not allowed to unwind past live C
resources. Pre-abort and between-frame abort preserve the original reason as well.

The test rejects 21 invalid input configurations before any native allocation, checks native
configuration/frame/empty-finish guards, and exercises output-limit cleanup. In 130 deterministic
allocation-fault cases, 129 deny allocations from the selected position onward and fail cleanly;
the terminal control succeeds. Live tracked bytes/allocation counts and `mallinfo` used bytes
return to zero. This is sampled failure-path coverage, not exhaustive OOM/fuzz certification.

Cancellation instrumentation pauses in the actual `WebPPicture.progress_hook` after positive
native progress (`percent >= 1`), using an external shared barrier. Cooperative cancellation
returns false from that callback, unwinds through libwebp cleanup, produces no result and
successfully retries in the **same Worker/module**. Two hard-cancel runs terminate while the
shared phase flag still proves execution inside the callback. Fresh retries match the original
output. A before-ready cancellation is checked separately. The hard-cancel probe holds an
imported callback; it does not independently certify interruption at an arbitrary instruction
in a callback-free WASM hot loop.

Node opened seven Worker threads and awaited all seven exits, with listeners removed. Each
browser created/terminated 25 Worker objects and cleared handlers; Playwright observed 24
started targets and all 24 close events. The before-ready object is terminated before target
observation. Final live Worker inventories are empty. Actual browser target closure is awaited,
not inferred from the return of `terminate()`.

The Chromium observation required about 1.59 seconds of final target-close draining, while
Firefox had already closed its targets. The recorded sub-millisecond browser promise-settlement
times are **not** measurements of physical reclamation or full Worker teardown. The finite shared
barrier and debugger instrumentation also make these cancellation probes unsuitable as a
production latency benchmark. SAB/COOP/COEP are test instrumentation; this does not add those
requirements to CanvasTake's public API.

Memory observations:

- Fifty repeated small exports in one Node module and twelve in one persistent Worker per
  browser retain zero tracked native bytes/allocations after every export; recorded
  allocator-used samples are also zero.
- Three successful 1024×1024 exports in one Node module are byte-identical; FFmpeg verifies the
  decoded frame independently. The generated opaque texture is deterministic, not a claim of
  worst-case entropy. Each file is 58,862 bytes.
- Those large exports peak at 51,193,372 **requested tracked bytes**, excluding allocator headers
  and JS/browser storage. All tracked/allocator-used bytes return to zero; WASM capacity remains
  60,424,192 bytes and is stable across all three runs.
- Cooperative cancellation of a megapixel job releases 23,071,532 peak requested bytes;
  the same module retains its 24,248,320-byte WASM capacity for reuse and can export again.

Free allocation counts do not imply a shrinking WASM buffer or immediate RSS reduction.
Process RSS samples are recorded with explicit GC, but are not a pass threshold or proof that
all operating-system pages are returned. Browser/JS/native-system allocations are outside the
tracking allocator. Hard termination proves thread/target shutdown, not per-allocation C
destructor execution inside the terminated isolate.

## Limits and remaining scope

The private harness validates integer dimensions 1..16383, positive delays up to uint24,
plays 0..65535, finite quality, method, exact RGBA lengths and signed-int timestamp sums.
Default budgets are 4,194,304 pixels/frame, 1000 frames, 64 MiB raw input and 32 MiB output.
The output cap is checked after native assembly; it is not a peak-memory bound. The instrumented
WASM heap starts at 16 MiB and can grow up to 256 MiB. These are prototype settings, not new
public CanvasTake defaults.

The source builds, complete backend suite, 13 JavaScript syntax checks and existing
`npm test` build + 164 regression tests pass. Root package/lockfile, production source/build,
exports, CI and version 0.7.0 are unchanged. Before committing on 2026-11-13, `npm test` again
passed all 164 tests. Both cached build artifacts, notices and binding-source hashes were
checked; all 17 actual Node/FFmpeg exports and seven Node Worker exits with cancellation/retry
were repeated successfully. The complete browser observations remain the dated 2026-11-12
snapshot; no local browser run was repeated for this commit. WebP checks remain opt-in.

The next stage is a separate review/design of the WebP controller and injected encoder/Worker
adapter: accepted-input progress, cancellation ownership, default/custom asset URLs and limits.
Production asset licensing, other build hosts, installed-package types/runtime imports,
Next.js and public entries must be checked before a WebP release. This prototype alone does
not authorize starting that integration or publishing a version.
