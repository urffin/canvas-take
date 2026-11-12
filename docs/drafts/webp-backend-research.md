# Animated WebP backend research

Status: feasibility research, 2026-11-12, after the 0.7.0 APNG release. **No WebP public
entry point, production adapter, API change or new release is included.**

The practical recommendation is a small, reproducibly built WASM binding around the official
libwebp encoder and animation/mux APIs. This means reusing the existing codec, not implementing
a codec in CanvasTake. The readily available animation wrapper tested below is unsuitable
unchanged: it estimates the final frame duration, cannot configure loop count and has native
cleanup gaps. The proposed replacement has **not** been compiled or certified by this research.

The [machine-readable observations](webp-backend-research-results.json) preserve the source
commit, binary hashes, browser versions, file hashes, timing, decoded pixels and Worker counts.
The [candidate snapshot](../../scripts/webp-spike/candidates.json) records exact npm versions,
archive integrity, source references and declared licenses. These are dated observations,
not a claim that the listed versions will always be the latest.

## Candidates

| Candidate | Evidence and fit | Decision for the next prototype |
| --- | --- | --- |
| `wasm-webp@0.1.0` | Real animation API, MIT wrapper; runtime reports libwebp 1.3.2. Selected ESM glue/WASM are 147,067 + 482,273 bytes; complete npm package is 1,276,911 bytes. Real Node and browser Worker encodes were tested. | Reject the unchanged wrapper; retain it as a reproducible negative baseline. |
| `@jsquash/webp@1.5.0` | Apache-2.0 wrapper with separate codec notices; 914,811 unpacked bytes across encoder/decoder assets. Published `encode.js` and codec declarations expose still-image encoding, not animation. | Possible still codec plus a separate muxer. Not a complete animation backend; animation execution was not tested. |
| `node-webpmux@3.2.1` | Declared LGPL-3.0-or-later; 537,883 unpacked bytes. Provides JS container handling and a WASM still codec, but uses CommonJS/Buffer and a `typeof window === 'undefined'` branch that loads Node filesystem modules. That branch also matches browser Workers. | Needs a browser port and separate distribution/license review; not selected as the supplied browser adapter. No actual browser port was tested. |
| `@ffmpeg/core@0.12.10` | This exact package declares GPL-2.0-or-later and has 64,689,644 unpacked bytes. General media runtime rather than a narrow image encoder. | Too broad for the default adapter under consideration; no install/encoding comparison was performed. A caller-provided implementation remains a possible later integration. |
| Thin binding to pinned official libwebp | Native APIs already provide still compression, frame optimization, animation parameters and muxing. Codec licensing includes BSD-style COPYING and PATENTS, which must accompany the distributed assets as applicable. | Preferred direction, conditional on a reproducible build and independent acceptance tests. Not yet implemented. |

Unpacked sizes are registry package sizes, **not** measured compressed downloads, browser load
costs or memory consumption. License values are package declarations; the exact wrapper,
codec, toolchain and distributed notices must be inventoried separately before integration.
The `wasm-webp` npm file list contains its MIT license but does not provide an obvious complete
libwebp COPYING/PATENTS inventory. Do not simply relabel its embedded binary as MIT.

For jSquash, the packaged codec README and an animated-build backup file provide differing
historical source clues. This research does not identify its actual binary codec version from
the README alone. A reproducible source-to-binary mapping would be required before selection.

Primary sources: [wasm-webp](https://github.com/nieyuyao/webp-wasm),
[jSquash](https://github.com/jamsinclair/jSquash),
[node-webpmux](https://github.com/ApeironTsuka/node-webpmux),
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm),
[official libwebp](https://github.com/webmproject/libwebp),
[COPYING](https://github.com/webmproject/libwebp/blob/v1.6.0/COPYING) and
[PATENTS](https://github.com/webmproject/libwebp/blob/v1.6.0/PATENTS).

## Reproduction and boundaries

With the repository development dependencies and Playwright Chromium/Firefox installed:

```sh
node scripts/check-webp-backends.mjs --install
# Later runs reuse the checked isolated dependency:
node scripts/check-webp-backends.mjs
```

`--install` explicitly installs only `wasm-webp@0.1.0` in
`benchmark-results/webp-research/consumer`, with lifecycle scripts disabled. The root manifest,
lockfile, build, runtime dependencies and exports are untouched. Without that flag, a missing
isolated dependency fails with setup instructions. The script verifies npm lock integrity and
the exact SHA-256 of the generated JS/WASM. It downloads the pinned wrapper source if absent,
checks its hash and retains it under the ignored results directory. No binary or vendored
third-party source is committed.

The experiment calls the package's **unmodified generated ESM factory**, supplies WASM bytes,
and explicitly deletes its Embind frame vector. It bypasses the package's extensionless ESM
wrapper import. Consequently this is codec feasibility evidence, not certification of the
published package's top-level imports or its Next.js/bundler integration. The native encoder
is unchanged; no RIFF duration repair, extra sentinel image or hidden frame insertion is used.

Outputs, full decoded RGBA, logs and media remain under `benchmark-results/webp-research`.
The checked-in JSON is a dated snapshot; rerunning does not overwrite it automatically.
One headless browser page is used at a time, with sequential Chromium/Firefox sessions.

**Exit 0 means the experiment reproduced the observations and its oracle controls passed. It
does not mean this rejected backend passed production acceptance.** A pinned behavior changing
unexpectedly, a Worker mismatch, a payload pixel error or a failed control makes the run fail.

## Actual encoding and independent decoding

Nine fixtures cover partial alpha values 0/1/127/128/254/255, transparent erasure, a long last
hold, repeated snapshots, a single frame, very short delays and two lossy quality settings.
Each was encoded in Node and real module Workers in Chromium 156.0.8078.4 and Firefox 157.0.
The Worker output was byte-identical to Node for all fixtures and for three post-cancellation
retries in each browser. Input bytes remained unchanged during the direct Node calls.

| Fixture | Input delays, ms | Actual ANMF delays, ms | Result |
| --- | --- | --- | --- |
| Final hold | 55, 2000 | 55, 55 | 2055 ms requested, 110 ms encoded |
| Alpha ramp | 70, 90, 130 | 70, 90, 80 | Final duration estimated |
| Transparent erasure | 50, 75, 100 | 50, 75, 62 | Alpha survives; final duration estimated |
| Identical snapshots | 55, 2000 | No ANMF | Static VP8L; no animation timing/loop metadata |
| Duplicate middle | 50, 70, 90, 200 | 50, 160, 70 | Middle snapshots merged correctly; final hold wrong |
| Single frame | 2000 | No ANMF | Static VP8L; no animation timing/loop metadata |
| Short delays | 1, 10, 11, 100 | 1, 10, 11, 7 | Final duration wrong; viewer clamping also differs |
| Lossy quality 40 | 75, 175 | 75, 75 | Valid lossy payload; final duration wrong |
| Lossy quality 90 | 75, 175 | 75, 75 | Valid lossy payload; final duration wrong |

Both browsers decoded all nine files through their native `ImageDecoder`, independently of
the candidate's WASM decoder. All decoded alpha bytes matched the fixtures. Both reported
infinite repetition for actual animations, consistent with ANIM loop count 0. Finite loop
counts cannot be requested through this wrapper, so they are **not** certified.

Native RGBA extraction is not a reliable exact straight-RGB oracle at partial alpha here:
Chromium rounds some low-alpha colors; Firefox output contains premultiplied-looking RGB.
For example the final-hold second pixel is `[0,255,0,128]` from Chromium and `[0,128,0,128]`
from Firefox. The observations retain both without silently normalizing them into a pass.

To separate this from a codec error, a second oracle copies each existing full-frame VP8L
payload into a diagnostic static RIFF envelope and decodes it with the installed native
FFmpeg 6.1.1. **All 17 lossless payload frames** matched alpha exactly and RGB exactly wherever
alpha is nonzero, including the alpha ramp and opaque-to-transparent erasure. Hidden RGB
under alpha 0 is deliberately outside this assertion. This extraction neither re-encodes
the payload nor certifies arbitrary subrectangle/blend/dispose composition. Alpha-bearing
animation fixtures here use full-canvas NO_BLEND replacement; the tested blending frames are
opaque. Generic delta-rectangle optimization remains unverified.

The same FFmpeg executable **fails to demux the complete animated WebP**, reporting unsupported
ANIM/ANMF chunks. It is therefore used only for the extracted-payload pixel check, while native
browser decoders validate the complete animation and the bounded RIFF reader checks metadata.
The encoder's own decoder is never used as independent evidence.

Short delays are a separate viewer issue: Chromium's ImageDecoder returns 1/10/11/7 ms for
the short-delay output; Firefox returns 100/100/11/100 ms. Static repetition reporting also
differs (Chromium 0, Firefox Infinity). File metadata must be checked independently of those
viewer choices. No claim of identical visual playback across viewers is made.

The lossy files are 358 bytes at quality 40 and 586 bytes at quality 90 for this small gradient.
They decode, but this is not a rate/distortion benchmark or a recommendation for a default
quality. No exact lossy RGB guarantee or performance comparison with GIF/APNG follows.

Negative controls detect truncated RIFF, a wrong RIFF length, a valid file with a changed first
duration and a valid file with wrong first-frame RGB. Both native decoders observe the duration
mutation and the pixel oracle detects the wrong colors; FFmpeg independently detects the
wrong-pixel extracted payload as well.

## Why the final hold is wrong

Pinned wrapper commit: `65e1ba32146adc2e14360c557a113c141d8058c9`.
Its libwebp submodule is `6c484cbf92e81a5673b24485ac02d211f69be5b7`; the tested binary reports 1.3.2.

The wrapper adds images at accumulated start times, increments the final timestamp, then
assembles without calling `WebPAnimEncoderAdd` with a null image and that final timestamp.
The official API explicitly requires that final call to set the last duration; without it,
assembly estimates the hold. This explains the measured timing failures. The source also
does not expose `anim_params.loop_count`, omits per-frame picture/result-data cleanup and
has early-return paths without disposing the encoder. Assembly/import failures are not
consistently checked. These are source findings, not measured persistent-heap leak totals.
The public JS wrapper creates fresh module instances, while this experiment deletes its own
vector and terminates each browser Worker after a job; neither proves those native paths safe.
Invalid/OOM native-input fuzzing is outside this probe.

See [pinned wrapper implementation](https://github.com/nieyuyao/webp-wasm/blob/65e1ba32146adc2e14360c557a113c141d8058c9/webp/encode.cpp)
and the [official animation API](https://github.com/webmproject/libwebp/blob/v1.6.0/src/webp/mux.h).

Identical-frame merging and static single-frame output should **not** be attributed only to
this wrapper defect. Official libwebp optimizes frames, and even its lower-level muxer's
`MuxCleanup` removes animation metadata for one full-canvas frame. Merely switching to
`WebPMuxAssemble` does not establish APNG-like single-frame behavior. See the
[official mux implementation](https://github.com/webmproject/libwebp/blob/v1.6.0/src/mux/muxedit.c).

## Worker cancellation and ownership

Each browser opened and terminated 15 actual Workers: nine normal jobs, three cancellation
probes and three successful fresh retries. Every handler was cleared. Fourteen jobs per
browser transferred the input buffers; the before-ready cancellation transferred none.
Cancelled jobs produced no accepted output. All retries produced the original byte hash.

One probe terminates before initialization completes; two terminate on a message emitted
immediately before the synchronous native encode call. This proves dispatch/termination and
fresh-session retry behavior **at that boundary**, not that a probe ran inside compression.
The wrapper exposes no native progress/abort hook. A normal cancellation message cannot
interrupt synchronous WASM while its Worker event loop is blocked. A later adapter can use
Worker termination for hard cancellation; any stronger in-codec claim needs instrumentation.

The experiment checks owned handles and buffer transfer, not physical RSS reclamation, peak
memory or absence of native leaks in a persistent module. Holding all frames in an Embind
vector introduces copies; a streaming add-frame binding is worth evaluating separately.
Progress should represent accepted/encoded frames and explicit final assembly, with no
invented per-compression percentage unless a real native hook supplies it.

## Contract decisions before a production controller

These are design constraints to resolve in the next backend prototype, **not new public API**:

1. Use complete straight-RGBA snapshots and a lossless baseline. Preserve alpha, including
   transparent replacement. Configure lossy/quality in the injected encoder rather than
   hard-coding those choices in the controller. Decide whether hidden RGB requires `exact`.
2. Preserve the presentation timeline, including the final hold. Allowing identical adjacent
   images to merge can be valid, but accepted input count and encoded frame count must be
   distinguished. Verification must compare presentation over intervals, not require one
   encoded frame per submitted frame by accident.
3. Decide single-frame semantics explicitly. An animation API cannot silently lose requested
   duration/finite plays while claiming the APNG contract. Options are a verified animated
   container profile that preserves metadata or an explicitly documented static fallback.
   Neither option is selected/certified here; do not insert fake changed pixels or hidden
   sentinel frames. A mux cleanup change would need its own review and independent tests.
4. Keep logical plays separate from a decoder's repetition property. Validate actual finite
   metadata at 1, 3 and 65535, plus 0/infinite, in a corrected backend. Check native playback
   behavior separately, particularly for static results and very short delays.
5. Validate buffer lengths, integer dimensions, positive delays, quality, pixel/frame/raw/output
   budgets and timestamp sums **before** entering native code. The RIFF duration field is
   uint24 milliseconds and loop count uint16; the high-level native API takes signed-int
   timestamps. Its encoder dimension limit is 16383, smaller than the container canvas fields.
   Pick conservative enforceable limits; do not advertise the whole container range as usable.
6. Make native ownership explicit: free imported pictures, output data, encoder/mux objects
   and temporary input copies on success, failure and cancellation. Check every native return.
   Choose per-export Worker lifetime initially; persistent pooling needs repeated-export
   memory/error tests. Raw input budget must not be presented as a bound on native peak memory.
7. Keep the optional encoder/WASM assets outside default imports, inject the backend, preserve
   existing GIF/APNG/video behavior and prove installed-package/Worker URL integration before
   adding public entries. No generic controller extraction is justified by this spike alone.

Format references: [WebP RIFF specification](https://developers.google.com/speed/webp/docs/riff_container),
[encoder dimension/progress interface](https://github.com/webmproject/libwebp/blob/v1.6.0/src/webp/encode.h).
The v1.6.0 links pin inspected API semantics; they do not claim it is the latest release.

## Verification of this research change

Both the cached run and the documented `--install` run completed with exit 0 on Windows,
Node 22.17.0. Seven new JavaScript modules passed `node --check`; the saved harness hashes,
fixture/Worker counts and 65 local documentation links were verified. `git diff --check`
passed for the README edits. Production source, manifests, lockfile, build configuration,
public exports and version 0.7.0 are unchanged. Before committing, the cached WebP check was
repeated successfully and `npm test` passed the build and all 164 regression tests. The dated
research snapshot remains unchanged; release verification remains separate.

## Next bounded step

Build a **backend-only** proof using a pinned, reviewed official libwebp release and pinned
toolchain. Expose correct final timestamp, animation parameters and deterministic cleanup;
resolve single-frame/static behavior before adapting a controller. Preserve source hashes,
build flags and codec notices alongside the binary. No Emscripten/CMake toolchain was available
in this environment, and this research did not install one or fabricate replacement evidence.

Acceptance must include independent full-animation decoding, exact lossless payload pixels,
long final holds, merged-frame presentation equivalence, alpha erasure, finite plays,
single-frame policy, malformed inputs/errors, actual in-codec cancellation evidence if claimed,
repeated sessions and memory measurements. Then assess a controller/API separately.
Publication and a version bump remain separate user decisions.
