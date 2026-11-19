# External video public API: acceptance criteria

Status: design-only criteria, verified 2026-11-16 / baseline `efc5f66` / version 0.8.1.
See the [selected API](external-video-public-api.md), [draft types](external-video-public-api.d.ts)
and [compile-only checks](external-video-public-types.ts). The type checks validate the proposal;
they do not establish any new runtime behavior. Existing receiver/Opus experiments are baselines.
The later [private-controller verification](external-video-controller-verification.md) covers
controller obligations using test destinations/muxers. Actual storage capability proofs and
real container/package integration are not implied by those controlled tests.
The later [private real-container verification](external-video-containers-verification.md)
adds P24–P26 and actual-file evidence scoped to a test receiver/platform. Public external
entry points and their installed/Next checks P27/P28 are still pending.
The [production destination D1–D20 gates](external-video-destination-compatibility.md) refine
capability evidence, target identity and recovery requirements before a candidate storage receiver
can be approved for actual use. They do not change the core ABI or certify existing test receivers.

## Before implementing the controller

| Gate | Required case and observable result | Design/type evidence now |
| --- | --- | --- |
| P1 | Existing Blob constructor, custom muxers, results, states, defaults and Promise identities unchanged | Canonical imports and positive/negative legacy fixtures |
| P2 | Explicit external muxer marker, format and destination required; Blob/plain stream/append/in-place rejected before acquisition | Negative fixture calls; runtime validation still required |
| P3 | Concrete MP4/WebM and opaque result value infer precisely; no optional/fake Blob | Concrete handle/id and MIME/extension fixture assignments |
| P4 | Synchronous validation/pre-abort owns zero external resources; no picker/support/acquisition callback | Lifecycle ordering selected in the project |
| P5 | Handle exists before first asynchronous initialization; ready/closed are stable Promises | Synchronous return and readonly properties in the draft |
| P6 | All read-only support checks precede writer creation; unsupported format/policy causes no target mutation | Destination request and capability contract |
| P7 | Abort during acquisition rejects ready promptly; late transaction/muxer/encoder is cleaned exactly once, closed waits | Required future controlled-acquisition tests |
| P8 | Factory throwing after partial acquisition cleans unreturned resources; caller's target/directory handles are never seized | Factory/transaction ownership contract |

## Positioned I/O, publication and ownership

| Gate | Required future controlled test |
| --- | --- |
| P9 | Exact subview snapshot before first yield; immediate caller mutation has no effect; no alias to unrelated backing bytes |
| P10 | Safe integer positions/endpoints, inclusive per-write/output limits, rewinds, overlaps, empty writes, high-water size and short/zero-progress backend writes |
| P11 | One admitted sink operation; pressure and bounded snapshots; late/overlapping calls fail without starting I/O; no unbounded callback queue |
| P12 | Abort during ready/write/truncate rejects logically with the first exact reason (including null/0); snapshot retained until physical completion; no abort/release vs I/O race |
| P13 | Two create-new transactions or an external intervening creator: only one publication, existing winner unchanged; preliminary existence checks are insufficient |
| P14 | Explicit replace preserves old published content until commit, replaces entire extent on success, leaves no stale tail; no silent in-place/append fallback |
| P15 | Drain track ends/writer/I/O, seal, validate MIME/size/timeline and truncate before commit; failure at any step calls abort/release, never commit |
| P16 | Cancellation immediately before admission wins; after admission, including synchronous observer/dispose calls, commit outcome wins; work signal never aborted after admission |
| P17 | Committed result remains usable after dispose/release; null/false/undefined values are valid when their generic type permits them; caller alone owns later deletion/closing |
| P18 | Known not-committed preserves the published target, rejects with original reason and aborts only private staging; release attempted even when abort throws |
| P19 | Indeterminate/throw/malformed commit outcome gives no receipt or rollback claim; release receives indeterminate classification and preserves recovery state; no destructive abort or automatic publication retry |
| P20 | Release failure after successful commit is a cleanup issue, not a failed finish; committed value survives and is also present in closed |
| P21 | Initialization failure, cancelled input, failed finish and successful finish each settle closed only after tracked work/late acquisition/cleanup attempts; cleanup errors never replace primary failure |
| P22 | ready/closed and accepted finish identity; early/concurrent invalid calls are rejected without cancelling the valid operation; before-ready calls are not queued |
| P23 | Progress counters keep timeline/packet meaning, committing uses finalizing, finished/outputBytes only follow definitive publication; outputPhase exposes the cancellation cutoff |

For P13/P14, a backend must demonstrate its policy on the actual platform/filesystem. An exclusive
temporary file plus an overwriting rename is not a create-new proof. File-handle/picker permission
is not an atomic publication capability. Do not claim universal rollback or crash durability.

## After connecting real adapters

| Gate | Required verification |
| --- | --- |
| P24 | MP4/WebM with the same coded input match current regular-container bytes; actual files independently decode with exact timeline/final hold and AAC/Opus trimming |
| P25 | Slow ready/write/close at input limits 1/2/4, partial PCM and native flush; reuse E10 Opus cancellation/resource regressions without increasing limits |
| P26 | Cancel/fail/unknown publication then backend-appropriate recovery and fresh export; no leaked writers/Workers/owned snapshots or unhandled late rejections |
| P27 | Installed tarball: legacy and external positive/negative types, entry points, runtime imports, licenses/assets; real browser destination/cancel/retry/decoded results |
| P28 | SSR/Next.js imports remain safe; concrete platform adapters loaded separately; committed result ownership and selected URL/asset paths work in the production consumer |

The first implementation stage should prove P1–P23 with controlled destinations and test muxers.
Real MP4/WebM integration and P24–P28 follow separately. The current project does not authorize
either implementation stage, storage helpers, a commit/push or a release.
