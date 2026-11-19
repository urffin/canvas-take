# Private external MP4/WebM integration

Date: 2026-11-18. Baseline: `f4fe7f7d4406ceb702d5e832a26e8e67539c8173`; version 0.8.1.
This follows the [private controller](external-video-controller-verification.md) and the
[P1–P28 criteria](external-video-public-compatibility.md). There are no new public entries,
factory overloads, dependencies or release. The [public API](external-video-public-api.md)
remains a proposal.

## Implementation

`src/internal/video-external-mp4.ts` and `video-external-webm.ts` connect the existing pinned
Mediabunny 1.65.0 writers to the private external controller. They preserve the legacy packet,
codec, timing and AAC/Opus discard rules. Their private factories return concrete MP4/WebM
types and metadata, never a Blob. Existing public Blob adapter/controller sources are unchanged.
Keeping this integration separate avoids changing legacy lifecycle behavior while proving it.
Any later consolidation needs its own compatibility checks; the duplication is intentional here.

The shared private `video-external-target.ts` bridge streams positioned writes into the
controller-owned sink. Vendor flush chunks are split sequentially at `maxPendingBytes`, without
parallel sink admission or whole-file retention. The controller still owns snapshots, readiness,
physical I/O fences, high-water size, truncate, commit and transaction cleanup. The bridge
preserves the first error and leaves its owned WritableStream closable after failure. An observer
exception is not used to signal failure, because vendor event observers swallow exceptions.

Disposal stops new bridge writes, waits for admitted adapter operations and any finalization,
then awaits vendor cancellation. Normal finalize closes/drains the writer before returning
container size to the controller. There is no publication or destination abort inside a muxer.
MP4 sample tables/WebM cues and vendor staging remain: this does not claim constant total memory.

## Cancellation race found and corrected

The real AAC flush cancellation test initially produced an unhandled
`Cannot write to a CLOSED writable stream` rejection. Mediabunny's `MediaSource.close()`
started `onTrackClose()` work without returning or awaiting it; cancellation could close the
writer before that work finished.

Only the private bundles apply the guarded
`scripts/external-video-containers/media-source-patch.mjs` transform. It returns the existing
closing Promise and awaits `onTrackClose()`. The adapters await track close and register each
write before starting it, so disposal observes all admitted writer work. Public bundles and
`node_modules` remain unchanged. A regression checks transform anchors, pristine upstream,
the private sourcemap, and absence of this transform from the public container bundles.

The preferred transform, pristine upstream MediaSource TS/JS, MPL license reference, provenance
and exact modified sourcesContent are shipped with the private artifacts. The existing WebM
timebase/DiscardPadding/staging patch is applied to those bundles as well.

## Actual file policy checks

`test/fixtures/video-external-file.mjs` is a **test receiver**, not a public filesystem adapter.
It stages a fresh same-directory file, loops over short writes and publishes create-new via
an exclusive hard link; replace uses same-directory rename. It closes owned handles and removes
only private staging on known abort. Release never deletes the published target; unknown
publication is not rolled back. Support is asserted only by this controlled test environment.

On the tested local Windows filesystem, both container paths verify:

- Existing create-new collision and an intervening creator preserve the winner; two concurrent
  create-new transactions produce exactly one publication, using the filesystem operation itself.
- Replace preserves old content until commit, replaces the entire extent and leaves no stale tail.
- Positioned header rewrites and 17-byte short writes produce decodable files with expected sizes.
- Cancel during ready/write/truncate rejects logically before physical completion; closed waits,
  and abort/release do not race the outstanding operation. Fresh exports then decode successfully.
- Write failures preserve old content and remove staging. An injected post-publication exception
  is indeterminate, gives no successful receipt, and never deletes the newly published result.
  For create-new, its recovery staging hard link survives release; explicit test-side removal of
  that staging link leaves the published file decodable before a fresh replacement export.
- Dispose after success leaves the committed file readable. Handles, borrowed bytes and physical
  I/O return to zero; release runs once and expected staging entries disappear.

These tests do not prove arbitrary filesystem atomicity, crash durability, remote receiver
semantics, or browser File System Access/OPFS atomic publication. The old OPFS experiment's
create/truncate protocol is not substituted for the proposed transaction contract.

## Real browser/decoder matrix

`scripts/verify-external-video-containers.mjs` serves the private built modules to explicitly
authorized Playwright Chromium/Firefox. Native WebCodecs encode H.264/VP8 and Opus; AAC uses
the existing real Worker/WASM encoder. A local test-only HTTP transport delegates positioned
transactions to the same actual-file receiver. Physical requests are not aborted with fetch:
closed must wait for the actual server operation, not merely an aborted network request.

The matrix covers silent video, mono/stereo audio, limits 1/2/default 4, slow ready/write/commit,
one and 961 audio samples, partial PCM, 30-second stereo audio, create-new collision,
cancel during ready/write/codec flush, post-admission cancellation, write/truncate failures,
unknown publication, and a fresh successful export after each pre-commit failure/unknown outcome.
Native queue/unacknowledged input peaks must respect 1/2/4 without raising defaults.

Successful sessions replay the **same coded events** into the existing Blob muxer and compare
the whole file byte-for-byte. Only container Date/Math.random are fixed; native codec scheduling
and performance clocks remain real. This comparison is verification-only retained data, not a
memory benchmark. Native encoder/frame/AudioData/Worker and dequeue-listener counters, plus
file handles/physical I/O/borrowed-byte counters, must be zero after closed. Page errors,
unhandled late rejections and cleanup issues fail the run.

Independent FFmpeg demux/decode plus separate MP4/WebM readers check video frame count, variable
timestamps, final hold/end, AAC priming/edit/tail and Opus CodecDelay/DiscardPadding. Decoded
presentation samples equal the input count; first audio PTS and correlation lag at both ends
are zero. Existing FFmpeg AAC-tail and single-Opus-packet normalization uses container metadata,
never an expected test count. AAC decoder overlap samples are not claimed as presentation.

## Reproduction and remaining work

- **346/346** Node tests passed, including **20** new real-container/filesystem groups.
- **92/92** Chromium/Firefox cases passed; **64** successful sessions matched Blob bytes exactly.
- Strict/noEmit passed with **36** expected negative type cases. All **14** public declarations
  match the baseline; the installed package blocks all five private external-controller paths.
- Every final native/file resource counter is zero and cleanup issues are empty. Maximum physical
  writes in flight: **1**; maximum borrowed bytes: **747,558**. Native input peaks respect each
  selected 1/2/4 limit; minimum measured audio correlation is **0.9770**, with zero sample lag.
- Build and installed tarball/types/imports/assets/current-document checks passed for **0.8.1**.

```sh
npm test
npm run test:video:external:containers
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-controller-tsconfig.json
npm run test:package
# Requires explicit external-browser debugging permission under AGENTS.md:
npm run test:video:external:browser
```

The [compact verification results](external-video-containers-results.json) record the final
counts, hashes, decoder summaries and compatibility evidence. Full logs/media remain under
ignored `benchmark-results/external-containers-*` and `benchmark-results/external-video-containers/`.

P24–P26 and filesystem portions of P13/P14 are verified for this private integration/test
receiver on the tested platform. Production destination capability negotiation and recovery
semantics remain separate work. P27/P28 for a **new public API** are still pending; current
installed-package checks protect the existing API, not unimplemented external public imports.
No commit/push, public API, version change or release is part of this stage.

The later [production destination refinement](external-video-destination-contract.md) selects
caller-known attempt identity and an independent journal/reconciliation service. This test receiver
does not implement those additions; its passing file-policy checks do not certify production recovery.
