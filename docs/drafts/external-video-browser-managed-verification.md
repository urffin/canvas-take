# Private managed browser result store: controlled-adapter verification

Date: 2026-11-20. Baseline `15d7a051c91d9722fb18e9893f9a735740d024e3`, version0.8.1.
Implements the [lifecycle project](external-video-browser-lifecycle.md) using private
[algorithm](../../src/internal/video-browser-results.ts),
[types](../../src/internal/video-browser-results-types.ts) and
[ports](../../src/internal/video-browser-results-ports.ts).
[B1–B32](external-video-browser-lifecycle-compatibility.md) remains the acceptance contract;
[results](external-video-browser-managed-results.json) maps B1–B28 to executed test names.

The subsequent [native browser verification](external-video-browser-managed-native-verification.md)
records the scope and results for OPFS, IndexedDB, Web Locks and browser downloads.

## Scope and data model

This stage provides the managed-store algorithm with explicit **testable ports**, not a native
OPFS/IndexedDB/Web Locks implementation. The test backend is memory storage with serial atomic
transactions, shared/exclusive non-waiting locks and a controlled download adapter. Two independent
connections share that backend; they model concurrency without claiming real cross-tab proof.
No Node filesystem, HTTP storage service, browser launcher, picker or global browser fallback is
imported by the implementation. Module imports are safe in Node/SSR.

`openBrowserResultStore` receives already provisioned ports and the exact managed-v2 scope. It
validates schema/identity/capabilities read-only; it never creates, migrates or adopts missing/v1
metadata. On success the store owns its dedicated metadata connection. If opening fails, the caller
still owns that supplied connection and closes it; no hidden connection is acquired by the store.
The test fixture follows that rule explicitly.

The metadata port runs synchronous callbacks over a transaction draft and distinguishes committed,
observed aborted and indeterminate acknowledgement. The algorithm never awaits file or lock work
inside a callback. Native IDB adaptation, indexed storage layout, bounded backend materialization
and actual isolation/durability proof remain future work. The controlled backend clones maps for
fault injection; it is not a video streaming-memory benchmark or a proposed production database.

The private types are now the single implementation contract. The original draft `.d.ts` forwards
the original names to those types, preserving all95 previous negative fixtures. Six new negative
cases and a positive actual-store/draft/core bridge verify factory inputs and diagnostics. There
is no public package entry or public factory; all14 existing public declarations remain unchanged.

## Implemented behavior

- Binding allocates caller-known attempt/owner-hold identities before asynchronous acquisition.
  Exact request policy, format and limits are captured before the first yield. Registration and
  object identity are checked before opening the writer; publication atomically updates original
  outcome, name, monotonic sequence, version and its default owner hold.
- Replacement preserves old results/holds. Read access owns a shared version lock, validates the
  original file and returns a named File wrapper. File release, prepared-download disposal and
  accepted close are explicit; a busy close does not poison the store. Active acquisitions also
  prevent premature connection close.
- Download preparation owns a separate lease/URL. Request is synchronous, one-shot and requires
  the injected document/activation capability; it returns requested/unobservable only. Disposal
  revokes before releasing the read lock. Failed revocation preserves protection until retry.
- Explicit holds are idempotent and cannot resurrect after release. Selected versions, active
  holds, readers, stale revisions, corrupt selection or unknown ownership block deletion. Metadata
  revisions are rechecked inside the deletion claim; the exact object is then removed outside the
  transaction, followed by a retained deleted/outcome tombstone. A failed or lost acknowledgement
  is reinspected and explicitly retried; absence without an owned claim is not a cleanup proof.
- Scans return default32/max128 records with scope-bound canonical cursors. The algorithm keeps at
  most limit+1 ordered candidates; backend metadata storage/query cost is not measured here. Scans
  are weak observations; a later hold or replacement invalidates an old deletion revision.
- Inspection is read-only and separates committed history, current selection, original availability
  and physical settlement. Recovery takes the abandoned attempt's lock without stealing and uses
  a transaction fence to reject stale later publication. An already created publication transaction
  serializes first. No encoding, automatic second commit or target rollback is performed.
- Loss of the owner lock does not mark I/O settled. A delayed write can still finish; its late
  publisher is fenced, while cleanup stays blocked until a positive close/abort marker exists.
  Missing metadata after connection invalidation leaves physical settlement unknown even if local
  resources later close; reopening cannot manufacture the missing persistent proof.
- Every normal/error path waits for owned work. Cleanup errors preserve the first error, hold
  unresolved resources conservatively and appear in private diagnostics. Unreturned acquisition
  resources or failed session/lock cleanup can be retried by explicit close; caller-owned active
  File/download handles must be released by their owner. No timer silently releases either kind.

The store's busy-close counts describe owning attempts/readers/downloads; a pending metadata or
acquisition operation can also make close busy before such an owner is handed off. Private
`stats.operations` and `cleanupIssues` explain that state; they are not new product API.

## Executed checks and limits

The [controlled suite](../../test/video-browser-results.test.mjs) uses
[fault/gate adapters](../../test/fixtures/video-browser-results.mjs). It checks publication races,
read/retain/delete races, callbacks before transaction creation versus already queued publication,
lost metadata/deletion/hold/recovery acknowledgements, native-operation simulations, quota/permission
errors, context-owner loss, invalidation/reopen and exact first-error/cancellation identity.
Each completed scenario closes its own connections/locks/writers/URLs/borrowed work, or verifies
that unsafe physical cleanup remains quarantined without an active local resource.

Current local verification: **452/452 Node tests (61 new controlled tests)**,
**101 expected negative type cases (95 prior +6 new)**, build and installed tarball consumer.
The package checks require all six private JS/declaration artifacts and block importing them via
package exports. The machine record contains gate/test mapping, counts and source hashes. Raw
logs are ignored under `benchmark-results/browser-managed-*`.

```sh
npm test
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-browser-managed-tsconfig.json
npm run test:package
# Focused suite after build:
node --test test/video-browser-results.test.mjs
```

This does **not** certify OPFS/IDB/Web Locks, actual tabs, browser user activation/downloads,
native process termination, OS resources, memory/GC, crash/power-loss/fsync or eviction behavior.
Test bytes/fake encoders are not real MP4/WebM decode evidence. B1–B28 results apply to the
algorithm and controlled port model; their native-platform obligations and B30/B31 are pending.
Existing v1 real-browser results and prior CI remain historical baseline evidence only.

No public API, version/dependency/export change, native browser adapter, release or npm publication
is added. Commit/push and existing CI regression checks are a separate delivery step; they verify
the controlled tests and existing library without certifying native managed-storage behavior.
Further native adapters and real-browser/decode tests require a separate request; public
installed/Next P27/P28 remains later work. The updated roadmap is kept outside the repository.
