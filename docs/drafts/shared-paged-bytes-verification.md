# Shared paged output bytes: implementation and verification

Status: M3 implemented locally after 0.6.0, 2026-11-06. Baseline:
`09cd09c16d874b22422bf7f938ff4a05f825f97c`. See the
[design](shared-export-mechanisms.md) and [compatibility gates](shared-export-compatibility.md).
Public API, package metadata/lockfile and version remain unchanged. M2 deferred helpers stay local.

## Scope and reason

[paged-bytes.ts](../../src/internal/paged-bytes.ts) replaces the two copies of page storage in
[MP4](../../src/video-mp4.ts) and [WebM](../../src/video-webm.ts). Both adapters already need the same
positioned copying, rewind handling and Blob parts. One implementation and its boundary tests reduce
the risk that output fixes diverge between containers. Both adapters were already bundled, so this
extraction does not require a new controller bundling step as the deferred proposal would.

The helper owns only:

- A map of 65,536-byte Uint8Array pages, allocated when writes reach them.
- Synchronous copying from the selected input view, last-write-wins overlaps and a high-water byte
  length. The write endpoint is calculated before copying, as in the former callbacks.
- Ordered views of used page portions; the last view is trimmed to the logical file length.
- Clearing page references and resetting its private length to zero.

`parts()` borrows the page buffers; it does not concatenate a second full-file Uint8Array. Adapters
construct their existing MIME-specific Blob and clear storage. Blob snapshots remain valid after
clearing/disposal. The helper adds no lifecycle, stream, signal, codec/container validation or public
deep import. It accepts the writer's current positions rather than inventing sparse-file semantics.

## Policies retained in adapters

| Policy | Preserved behavior |
| --- | --- |
| Limits | Early media-payload reservation plus actual output endpoint/header checks; inclusive `maxOutputBytes`, checked before allocating a rejected page |
| Rewrites | Bound the maximum written endpoint, not cumulative write traffic; rewinding does not shrink the file |
| First failure | Keep the existing MP4/WebM RangeError messages and first `outputError`; observer reports do not replace an earlier error |
| Late vendor writes | Ignore after abort/disposal/output failure so cleared pages cannot be repopulated; keep the owned WritableStream closable |
| Stream ownership | Preserve existing vendor start/finalize/cancel calls and signal listener registration/removal |
| Format/time | Keep MIME, codec profiles, color, track config/end validation, MP4 ticks/AAC edits and WebM CodecDelay/DiscardPadding in their adapters |

Target observers may swallow exceptions. The adapters still record budget errors and expose them
through their operation guards, rather than throwing from observers or poisoning stream closure.
No partial result, new output target, buffer pool or common session engine is introduced. Resetting
the helper's private size on clear is not a new public state: completed/failed/disposed adapter calls
remain governed by the same existing guards and vendor state.

## Before-extraction characterization

Before editing production source, the [storage harness](../../test/fixtures/muxer-storage.mjs) ran
the baseline adapters with the real pinned Mediabunny 1.65.0 writer and existing WebM build patch.
The wrapper observes the original WritableStream sink and returns its result directly; it adds no
second stream or asynchronous queue. Time/random metadata is fixed only inside that isolated VM.
Chunks are copied for test evidence, not for memory/throughput measurement.

The resulting [golden fixture](../../test/fixtures/muxer-write-traces.json) stores each actual writer
position, length and SHA-256 plus the final file hash. Payloads are deterministic **synthetic coded
packets** for testing the writer, not a claim of decodable video. Real-codec decoding is a separate
browser gate below. All four cases cross a page boundary and exercise rewinds:

| Profile | Final bytes | Sink writes | Rewound/overlapping writes |
| --- | ---: | ---: | ---: |
| MP4 video | 73,995 | 4 | 1 |
| MP4 with AAC | 74,585 | 5 | 1 |
| WebM video | 73,644 | 5 | 2 |
| WebM with Opus | 73,840 | 6 | 2 |

Sixteen adapter tests passed against the original storage before extraction. After extraction, the
same tests pass, including all four golden traces and final byte hashes. A separate contiguous test
oracle replays each trace and matches its final Blob. The frozen fixture is not regenerated when a
candidate differs. The capture driver/log remain under ignored `benchmark-results/`; only the small
trace metadata is versioned, rather than large generated files or duplicate adapter implementations.

## Mechanism, failures and reference retention

[Pure store tests](../../test/paged-bytes.test.mjs) cover empty writes, exact page boundaries, a
three-page odd-length output, cross-page overlaps, rewound headers, high-water retention, input
subarray ownership and immediate caller mutation. They verify `parts()` shares page buffers and
that Blob bytes survive later writes and clear/dispose. Full-file concatenation exists only in the
independent test oracle.

[Adapter storage tests](../../test/muxer-storage.test.mjs) use the real writer for golden traces and
a controlled vendor backend for deterministic failure cases. They check exact inclusive bounds,
startup/final header overflow, direct sink-budget checks, observer-reported errors, preserved first
error identity, abort/dispose, ignored late writes and successful owned stream closure. An isolated
Uint8Array constructor probe checks that an over-budget next-page write allocates no new storage
page. Independent-store tests also ensure interleaved exports cannot share pages, length or clearing.
These checks do not claim that all other codec/vendor allocations are zero.

The [GC subprocess](../../test/fixtures/paged-bytes-gc.mjs) retains eight adapter/harness objects:
MP4/WebM after success, output failure, abort and disposal. Their 16 owned pages **and ArrayBuffer
objects** become collectible after cleanup, while returned Blobs remain readable. This tests reference
retention, not exact RAM reclamation, all native caches or absence of every possible leak. No production
test hook or page-count option is added.

## Integration results

| Check | Result |
| --- | --- |
| Original adapter characterization | 16/16 pass before production changes |
| `npm test` (pre-commit recheck, 2026-11-12) | **119/119 pass**, no skips; includes the last independent-export test |
| Actual emitted public declarations | All ten entries exactly match the baseline |
| Runtime graph | One existing shared container chunk; helper source included in its map; no new required helper asset |
| Full Chromium/Firefox suite | **74 pass, 4 expected Firefox MediaRecorder MP4 skips** |
| `npm run test:package` | Build/prepack, isolated tarball installation, strict types/imports and shared source-map packaging pass at 0.6.0 |
| `npm run test:next` | Installed-tarball Next.js 16.3.0/Turbopack build passes; workspace `C:/Users/Grundy/AppData/Local/Temp/canvastake-next-HfvK5T` |

Browser verification uses the real codecs and independent demux/decode, checking MP4 H.264/AAC
and WebM VP8/Opus frame intervals, audio presentation samples/trims, final holds, A/V markers,
native playback, cancellation and fresh exports. The four skips are real-time MediaRecorder MP4
availability in Firefox; offline H.264/AAC succeeds. Unchanged GIF/Worker and recorder scenarios
also pass in this full run.

Local browser command, using the established workaround for instrumentation-sensitive Firefox
behavior recorded during M1:

```sh
node node_modules/@playwright/test/cli.js test --workers=1 --trace=off
```

Assertions, test timeouts and repository Playwright configuration are unchanged. Logs are saved as
ignored `benchmark-results/paged-bytes-*.log`; the committed fixture and tests provide repeatable
correctness checks. Existing build splitting inlines the helper into the shared container module;
controller/codec/Worker code, build configuration and public exports stay unchanged. Source maps,
licenses and the existing vendor patch remain packaged as before.

This is a compatibility refactor. It does not reduce the required whole-file output storage, add
external streaming, or establish a throughput/memory improvement. A new CI run, commit and release
are separate actions and are not claimed by these local results.
