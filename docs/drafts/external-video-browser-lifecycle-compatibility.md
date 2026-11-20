# Browser result lifecycle: acceptance criteria B1–B32

Date: 2026-11-20. Baseline `423b758`, version0.8.1. **Design gates, not runtime certification.**
See the [project](external-video-browser-lifecycle.md), [types](external-video-browser-lifecycle.d.ts),
[compile-only fixture](external-video-browser-lifecycle-types.ts) and
[verification record](external-video-browser-lifecycle-verification.md).
These supplement [P1–P28](external-video-public-compatibility.md) and
[D1–D20](external-video-destination-compatibility.md); their existing runtime evidence is unchanged.

| Gate | Required future observable proof | Evidence now |
| --- | --- | --- |
| B1 | V1 catalogue/raw receipts retain existing lifetime; v2 never auto-upgrades/adopts/sweeps v1 files, schema or namespace | Separate backend/profile types and project; runtime pending |
| B2 | Explicit scoped OPFS+IDB+Web Locks capability; repeated support is readonly, with zero locks, writers, new DBs/directories, probes or prompts; missing feature rejects | Support literals and project; runtime pending |
| B3 | Binding/key/commit-owner hold identity available before exporter construction; persistable; publication atomically creates owner hold, outcome, reference, sequence and name; default owner lifetime survives replacement/close | Managed binding and generic destination fixture; runtime pending |
| B4 | Original version/key/name/size/MIME match actual bytes; no native path/writer/Blob fallback or substitution from current mutable name | Reference types and negative checks; runtime pending |
| B5 | File acquisition takes a shared version lock before revalidation; exact original File metadata/bytes, no whole-file ArrayBuffer concatenation; missing/deleted/changed branches explicit | Lease/access types; real-browser and allocation proof pending |
| B6 | Active File/stream blocks concurrent deletion; caller completes consumers before idempotent release; closed settles after lock release; another context owns its own lease | Ownership contract and positive fixture; real cross-tab proof pending |
| B7 | Store close reports busy for active attempts/leases/downloads without poisoning them; accepted close settles work/connection; persistent holds survive reopen | Close union; runtime pending |
| B8 | Pre-abort takes zero resources; abort/failure before lease/download handoff releases partial locks/URLs; storage/permission/quota errors never fabricate a File | Access/signal shapes; fault injection pending |
| B9 | Async download preparation owns a distinct lease and one object URL; releasing another lease does not invalidate it | Download lifetime project; runtime pending |
| B10 | Request is synchronous and one-shot from app user gesture; returned status requested/unobservable never means saved/completed or exposes OS path | Download return type and negative fixture; UI behavior pending |
| B11 | No immediate/timed revoke, implicit post-finish deletion or saved-state mutation; dispose explicitly revokes owned URL/releases lease once and may interrupt consumption | Contract; instrumented URL/download tests pending |
| B12 | Invalid/traversal/control/wrong-extension filenames reject before URL creation; SSR/Worker UI unsupported; browser-chosen names/overwrite not guaranteed | Project and block codes; runtime pending |
| B13 | Selected version and every active persistent hold protect bytes; each replacement adds its own owner hold, never releases an earlier one | Hold/key types; runtime pending |
| B14 | Caller-known explicit hold ID before retain; duplicate retain/release and lost acknowledgements safe; release tombstone prevents late resurrection; owner hold cannot release before terminal fenced outcome | Distinct hold kinds and fixture; IDB race/fault tests pending |
| B15 | Delete requires exact current revision, committed superseded version, zero holds, no readers and settled I/O; selected/held/busy/unknown rejects; no force, TTL or native target deletion | Required revision and blocked/delete union; runtime pending |
| B16 | Exclusive version lock + short IDB deleting claim, exact owned OPFS removal, deleted marker; no IDB tx held over FS await; crash/fault between each boundary stays resumable/conservative | Deletion protocol; fault injection pending |
| B17 | Two-tab read/delete and retain/delete races: a valid hold/read wins protection, or a deleting claim blocks new use; no stale-count decision or lock stealing/deadlock | Lock order specified; cross-tab proof pending |
| B18 | Scan bounded default32/max128 with scope-bound cursor; concurrent replacement/hold changes invalidate old deletion revisions; partial per-version deletion never reported as an atomic batch | Scan/page types; runtime bounds/scan race pending |
| B19 | Inspect remains readonly and preserves three outcomes; missing/corrupt DB, record, owner evidence or unknown scope never becomes not-committed from filename/hash/absence/time alone | Existing recovery union preserved; false-proof faults pending |
| B20 | Lost commit ack followed by replacement recovers historical original outcome/reference and owner hold, never the later name's content; no automatic publication retry | Independent attempt key/service; actual integration pending |
| B21 | Purged/missing original bytes do not change committed history; unavailable receipt distinguished from non-publication; intentional deletion keeps identity/outcome tombstones | Narrowed generic recovery fixture; runtime pending |
| B22 | Active owner or possible late publisher remains unresolved; timeout, page death, closed report and lock absence alone never authorize cleanup or takeover | Explicit recovery/physicalIO contract; native termination proof pending |
| B23 | Recover revalidates expected revision and epoch in overlapping IDB stores; already queued publication commits first or aborts; later stale epoch cannot publish; lost recover ack reinspects same key | Recovery request/outcome types; controlled scheduling proof pending |
| B24 | Physical-settlement marker follows all issued I/O + successful native close/abort; absent marker quarantines bytes even after logical publication fence; no timer or Web Lock absence substitutes | physicalIO independent field; native late-I/O fault tests pending |
| B25 | Exact schema/scope/directory reopen preserves holds/history; missing storage never silently recreates old identity; no storage-eviction/power-loss/fsync guarantee | Project boundary; reopen/failure tests pending |
| B26 | Foreign/malformed/unsupported-version keys, hold kinds, cursors, revisions and mismatched handles reject before mutation; string casts are not capability proof | Opaque revision/cursor and key types; runtime validation pending |
| B27 | Lost deletion ack and absent file after a valid owned deleting claim resume idempotently; absent file without such ownership blocks; committed tombstones/released holds never resurrect | Delete/hold outcomes and protocol; fault replay pending |
| B28 | IDB blocked/versionchange/quota errors and native lock/write/remove failures preserve first error/indeterminate evidence; every local lock/URL/connection cleanup observed; no metadata sweep | Project and failure unions; resource/fault suite pending |
| B29 | Legacy Blob/private core/controller/codecs/muxers and all14 public d.ts unchanged, including Promise identities/limits/progress/error/cancellation cutoff | Baseline/source/type checks in this design stage; runtime behavior unchanged |
| B30 | Real MP4 H.264/AAC and WebM VP8/Opus saved/read/downloaded with independent decode: frames/timeline/final hold/audio sample count/priming/padding; old pinned versions stable through replacements | Prior v1 evidence is baseline only; v2 implementation proof pending |
| B31 | Real Chromium/Firefox two-tab creation/read/delete races, cancel/fail/recover/fresh retry; zero tracked readers/URLs/writers/Workers/DB connections after explicit teardown; add bounded repeatable CI stage separately | Existing v1 local runner retained; new v2/CI runtime pending |
| B32 | No public entry/runtime/version in design; later installed tarball and SSR/Next.js P27/P28 preserve imports/assets/ownership; worker download unsupported explicitly | NoEmit/package boundary checks now; public implementation/integration pending |

Passing draft type checks proves shape/narrowing/legacy generic assignability only. None of these
rows claims v2 storage, deletion, Web Locks, reload, native downloads, crash recovery or memory
behavior has been executed. V1's 128 cases and existing successful CI remain separate evidence.
