# APNG backend feasibility: results

Status: prototype verified locally, 2026-11-12, baseline
`4cc479b3178b77c1f945ec9371f656b5bb495187` plus the local APNG design documents.
The [saved machine-readable results](apng-backend-spike-results.json) record source hashes,
files/packet timing, controls, cancellations and the harness snapshot. The
[tools](../../scripts/apng-spike/README.md) are opt-in experiments, outside production builds,
package exports and the default test suite. Public API, package metadata/lockfile and version 0.6.0
remain unchanged. No commit, push, release or npm publication is part of this task.

## Decision

The proposed APNG subset is feasible with a pinned UPNG/Pako backend using full-frame RGBA8,
SOURCE replacement and BACKGROUND disposal. Select this **patched candidate as the baseline for
the next implementation slice**, not as a published/production-ready adapter. Keep rectangle,
OVER/PREVIOUS and palette optimization out until separately validated.

Use UPNG revision `88f504b6577b726975f593caa38ba85d327c7c1f` with Pako 2.1.0's deflate-only bundle.
The [source manifest](../../scripts/apng-spike/prepare.mjs) pins exact SHA-256 for both sources
and their license notices; downloads/cache verification precedes execution. See
[upstream UPNG](https://github.com/photopea/UPNG.js/tree/88f504b6577b726975f593caa38ba85d327c7c1f)
and [Pako](https://github.com/nodeca/pako/tree/2.1.0).
No npm dependencies were added, and this does not select the different published `upng-js@2.1.0`.

The [guarded transform](../../scripts/apng-spike/upng-patch.mjs) makes three explicit changes:

1. Emit animation metadata for every nonempty input, including one frame.
2. Use real deflate compression in the full-frame `encodeLL` path instead of level-0 storage.
3. Use pinned Pako directly, without the optional `window.UZIP` branch that is unsuitable in a Worker.

It does not implement a new PNG compressor or handwritten animation writer. UPNG still writes the
container, delays, loop metadata and CRCs. Drift/reapplication controls reject altered patch sites.
The pristine cached sources remain unchanged. The patched UPNG SHA-256 is
`2975aae8ca08870432136c89c76b3510b2e94599d9dc46e6dff1119ae4da4075`.
UPNG MIT and Pako MIT/Zlib notices are retained beside private generated bundles/maps.

## Correctness matrix

Environment: Windows x64, Node 22.17.0, existing Playwright Chromium/Firefox and
`ffmpeg-static@5.3.0` providing FFmpeg 6.1.1. The exact tool/runtime strings and hashes are in JSON.

| Checks | Result |
| --- | --- |
| Fixture profiles | 14, each in direct Node and real Chromium/Firefox module Workers |
| Normal exports | 42/42 independently decoded |
| Fresh Worker retries after cancellation | 12/12 independently decoded |
| Total | **54 files, 111 decoded frames, 87,465 full-resolution pixels** |
| Worker/direct equivalence | Every browser/retry output matches its Node fixture SHA-256 |
| Negative file controls | 9/9 detected |
| Invalid backend inputs | 13/13 rejected; exact inclusive input/output bounds accepted |
| Cancelled requests | 12/12 preserve the original rejection reason and return no output |
| Worker lifecycle | **52/52 observed closed** |

Fixtures cover opaque/transparent frames, alpha 0/1/127/128/254/255, partial-alpha gradients, an
opaque object followed by a fully transparent frame, repeated identical frames, noise, odd sizes
and 1x1. Single-frame animations are checked for plays 0, 1, 3 and 4,294,967,295; multi-frame fixtures
cover the same play counts. Delays include 1, 14, 15, 50, 54, 55, 800, 2000 and 65535 ms.
Neither identical frames nor one-frame animation lose their count/delay metadata.

The [independent oracle](../../scripts/apng-spike/oracle.mjs) checks chunk bounds, CRCs, frame/data
sequence, dimensions, frame count, total plays, exact rational delays and the selected full-frame
strategy. FFmpeg separately demuxes packets and decodes every full RGBA image; the writer's decoder
is never called. Exact alpha and exact RGB at nonzero alpha match the synthetic input, without a
color tolerance. RGB under zero alpha is ignored as specified by the draft.

FFmpeg packet PTS and durations match cumulative input milliseconds exactly on its observed
1/100000 timebase, including the final hold and one-frame endpoint. Looping is explicitly ignored
for this decode; play counts are independently read from the file. This does not claim that a
browser displayed billions of plays or honored a 1 ms screen refresh.

The fixture's source buffers survive transfer of separate owned copies. Direct encoding checks
source SHA-256 before/after; browser transport checks source lengths/fingerprints. Output files,
including negative controls, remain in ignored `benchmark-results/apng-backend-spike/files`.

## Negative controls and decoder limitation

Detected controls include corrupt CRC, missing frame control, wrong plays and delay with repaired
CRCs, duplicate sequence, truncated IEND, static-only single-frame output, a non-SOURCE strategy,
and wrong transparent pixels in an otherwise structurally valid SOURCE file. The last pixel control
is rejected by the independent FFmpeg comparison, not by a self-decoder or expected hash alone.

An initial diagnostic changed a full-frame erase case to NONE disposal followed by OVER blending.
The installed FFmpeg returned the original SOURCE-like pixels and did **not** distinguish this
metadata mutation. That observation is saved under `limitations`; it is not counted as successful
generic APNG blend verification. The candidate is accepted only with the independently enforced
full-frame SOURCE/BACKGROUND profile. Native viewer and optimized blend/dispose semantics remain
outside the certified scope. No tolerance was widened and the transparent-pixel control still fails.

Backend validation rejects five invalid delays (zero, 65536, fractional, NaN, infinity), four invalid
play counts, empty input, zero width and one-byte-over input/output budgets. These are backend
checks; no canvas admission, public progress or controller validation order is implemented yet.

## Actual Worker interruption and cleanup

Each engine cancels one request before the ready acknowledgement and three during compression.
Compression input is three 2048x1280 noisy frames: 31,457,280 raw bytes. The caller transfers owned
copies; original source storage remains usable. Input budgets account logical frame bytes, not
codec/native heap peaks.

A prototype-only hook runs on Pako's first real `Deflate.onData` callback, after compressed data is
produced inside its synchronous call. A shared atomic flag remains set until deflate returns.
The parent observes that flag at cancellation, rejects the pending request with the original Error,
removes transport handlers and terminates the actual Worker. There is no artificial blocking gate
or sleep that keeps compression running. Cancellation is not merely a message waiting behind it.

| Engine | Closed Workers | Rejection after cancellation, three compression trials | Additional evidence |
| --- | --- | --- | --- |
| Node | 8/8 | 0.118–0.128 ms | Exit observed 9.29–11.50 ms after cancellation; compression flag still active after exit |
| Chromium | 22/22 | 0.060–0.075 ms | Native Worker close observed through Playwright |
| Firefox | 22/22 | 0.100–0.140 ms | Native Worker close observed through Playwright |

These small samples describe promise settlement after delivered cancellation, not scheduling delay
to deliver it, browser Worker exit latency or a public performance guarantee. No native-memory
tracing or GC benchmark was used. Pending transport promises settle, copied input references are
dropped, handlers are removed, and actual exit/close is observed. This finite check is not proof
of immediate physical-memory reclamation or absence of every leak.

A fresh Worker exports and independently decodes an APNG after every cancellation, on the same page
for browser runs. Each browser uses one isolated page; all created pages/browsers close, user tabs
are untouched. This satisfies the agent tab limit without changing existing browser CI settings.

## Reproduction, scope and next step

```sh
node scripts/check-apng-backend.mjs
node scripts/apng-spike/save-report.mjs
```

The first invocation needs upstream access if the verified ignored source cache is absent. Missing
codecs/browsers fail explicitly. `--node-only` is a separate focused run and is not accepted as a
complete browser result by the save command. Large artifacts/dependencies stay ignored; tools,
compact JSON evidence and this report are saved in the repository workspace for review.

The full matrix was rerun after refining the compression probe from a call-boundary notification
to the internal compressed-data callback. The frozen JSON describes that final run. New tools are
not wired into default CI, npm scripts, build entries or package dependencies. Existing production
tests/browser/packed/Next suites were not rerun because no production source/build changed; their
last committed CI remains on 4cc479b. This prototype has no new commit/CI result.

Next, only on request: implement the APNG controller with fake encoders against the draft's admission,
ownership, limit, progress, promise-identity and cancellation contracts. Integrate a supplied backend
only after adapting this pinned candidate into production packaging/licenses/Worker checks. Canvas
readback/color handling, native playback, full A1–A8, controller retention and packed/Next integration
remain pending. No new public API or version is introduced by the spike.
