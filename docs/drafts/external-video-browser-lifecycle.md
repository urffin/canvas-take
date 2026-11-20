# Browser video result: saving, retention and recovery

Date: 2026-11-20. Baseline: `423b758fa36813fc53dd8745e6f27d74c607fd4e`, version 0.8.1.
**Design only:** [companion types](external-video-browser-lifecycle.d.ts),
[compile-only examples](external-video-browser-lifecycle-types.ts),
[acceptance gates B1–B32](external-video-browser-lifecycle-compatibility.md).
No runtime implementation, factory, package export, new version or release is added.

The statement above describes the original design stage. A subsequent
[private controlled-adapter implementation](external-video-browser-managed-verification.md)
implements the algorithm and checks B1–B28 without native browser adapters or public exports.

## Selected boundary

The [private v1 prototype](external-video-browser-prototype.md) writes actual OPFS files and
publishes logical names through IndexedDB. It retains all committed versions and hands out raw
receipts with `getFile()`. Those receipts have no release protocol. Deleting such versions behind
their owners would weaken the existing result contract, so **v1 remains unchanged**.

The proposed managed profile is a separate, freshly provisioned `opfs-managed-v2` namespace/schema,
with backend ID `canvastake-opfs-managed-v2`. It does not silently upgrade, adopt, sweep or delete
v1 objects. Reopen requires the existing exact scope/schema/directory identity; missing storage
must not be replaced with a new empty catalogue under the old scope ID. This design specifies the
companion boundary, not a final provisioning factory or public entry point.

The caller chooses managed storage explicitly. The existing exporter is reused with a destination
whose committed value is `BrowserResultReference`; its generic core ABI and all legacy Blob paths
remain unchanged. A reference is serializable metadata identifying **one attempt/version**. It is
not the current value of a mutable name, an OS path, writable file handle, retention guarantee or
security credential. Every input key is checked again at runtime.

Proposed persisted records (not a schema migration in this change):

- Scope: schema/backend ID, stable scope ID and exact private-directory handle.
- Attempt: caller-known key/owner-hold ID, publication fence, revision, registered/writing/
  bytes-closed/terminal phase, authoritative outcome and separate physical-settlement evidence.
- Version: immutable object identity/extent/format/name/publication sequence, selection, revision
  and present/deleting/deleted state. Original object IDs are never reused.
- Names: logical-name to version pointer; holds: known hold ID, version and active/released state.

An exporter owns an exclusive attempt lock from registration until all its issued native work and
release settle. A recovery operation uses that same lock name; readers/deleters use a distinct
per-version lock name. Encoded lock names include backend, scope and full attempt/version identity.
No `steal` option, clock lease, cross-context raw-handle transfer or implicit owner takeover is used.

## Ownership model

| Object | Owner and lifetime | Effect on deletion |
| --- | --- | --- |
| Logical name | Catalogue; atomically points to the newest committed version | Selected version cannot be deleted |
| Result reference | Application; can be saved for later lookup/recovery | Does not itself pin bytes |
| Commit-owner hold | Allocated in the binding before export; created atomically with successful publication | Keeps the original version until explicit release, including across reload |
| Additional hold | Application-known key allocated before asynchronous `retain` | Keeps bytes across connection/page lifetime until explicit release |
| File lease | Acquiring consumer; owns a shared version lock until `release()` | Blocks deletion while the consumer uses the File/streams |
| Prepared download | UI consumer; owns its own File lease and object URL until `dispose()` | Blocks deletion independently of other consumers |
| Outcome/tombstone | Catalogue; retained after byte deletion | Preserves historical publication and prevents identity reuse |

On success the owner hold, catalogue pointer, version metadata, monotonic publication sequence and
committed outcome are one IndexedDB transaction. The caller receives `key` and `ownerHold` from
`bind` synchronously, before exporter construction, and can persist them before starting work.
Failure to retain that information can leak a hold, but must not cause deletion or an implicit
second publication. A replacement creates its own owner hold and leaves earlier ones intact.
The transaction updates both old/new selection metadata and increments every affected version
revision. Hold and byte-state mutations also increment that version revision; reader protection
comes from the live lock, never an old metadata counter. A readonly recovery snapshot can return
the original registered owner-hold key; `inspectHold` must still determine its current state.

`makeHoldKey` allocates only an explicit hold identity in memory. Persist the key before `retain`.
Repeated retain with the same active key is idempotent. Release leaves a tombstone; a released key
cannot be reused to resurrect a hold. Release of an explicit key before a delayed retain retires
that key. Commit-owner release is blocked until the corresponding publication is definitive and
no publisher can still create its owner hold. A failed acknowledgement returns indeterminate with
the same key; `inspectHold`/repeating the idempotent operation resolves the observation without
allocating another key. No automatic expiration, unload cleanup, wall-clock age or TTL releases holds.

## Getting a File

1. `lookup(name)` is a readonly observation of the currently selected reference; it does not acquire
   a read lease. Saved references continue to identify their original version after replacement.
2. `acquireFile(key)` tries a shared Web Lock for that exact scope/version without waiting by default,
   then revalidates metadata, publication, deletion state, file identity and expected size. Contention
   returns blocked/busy. Pre-abort takes no lock; abort before handoff releases acquired resources.
3. It returns a `BrowserFileLease` containing a File with the logical filename and container MIME.
   Set metadata using a File wrapper around the native Blob; do not read the whole video into an
   ArrayBuffer or concatenate all bytes just to rename it. Resource/streaming behavior requires proof.
4. The application may read, stream or upload that File while it holds the lease. It must await its
   own consumers before release. Library code cannot track every external stream or structured clone.
   Another context acquires its own lease; handing a raw File/URL to an untracked context is outside
   this cooperative ownership contract.
5. `release()` is idempotent and `closed` settles after the read lock is released. It does not delete
   bytes or release persistent holds. No readability guarantee survives intentional lease release
   followed by an authorized deletion, browser eviction or external storage corruption.

The File API describes snapshot state and read failures; this design deliberately keeps the backing
version during registered use instead of assuming a raw File is a permanent independent disk copy.
See [File snapshot state](https://w3c.github.io/FileAPI/#file-section). No zero-copy or bound on
browser caches is inferred from the wrapper API.

`close()` reports busy while attempts, File leases or prepared downloads remain. A busy close keeps
the store usable. Once accepted, close stops admission, settles tracked tasks and closes its DB
connection. Persistent holds/outcomes remain. Another explicitly reopened store can use saved keys;
no global timer or garbage collector owns those application retention decisions.

## Explicit download flow

`prepareDownload(key,{fileName?,signal?})` asynchronously acquires **its own** File lease, obtains
the named File and creates one object URL in a document context. Failure/abort during preparation
revokes any partial URL and releases its lease; a pre-aborted request creates none. Workers/SSR
cannot silently trigger UI and report document-required/unsupported. No picker is called.

After preparation the app exposes a Download button. Its click handler calls `request()`
synchronously, with no awaited work before the anchor activation. The first valid call dispatches
an anchor download using the prepared URL; subsequent calls reject. The return value says only
`requested` and `completion:'unobservable'`. The library cannot certify a saved path, completion,
OS overwrite policy, browser blocking or the user's eventual choice through this page API.
The [HTML download algorithm](https://html.spec.whatwg.org/multipage/links.html#downloading-resources)
leaves parts of saving/filename handling to the browser. Test-driver download events are test
evidence, not a portable application callback.

The request checks that its document/handle is still usable and a user activation is available;
an invalid call throws before dispatch and does not pretend a request was completed. Cancellation
of the acquisition signal after a handle is handed off does not seize the caller's handle/lease;
subsequent lifetime changes use explicit release/dispose.

The suggested filename defaults to the logical name. Explicit filenames must be a bounded simple
leaf with the matching `.mp4`/`.webm` extension, no separators, controls, empty/dot names or traversal;
invalid names reject before URL allocation. No path or native target guarantee is exposed.

`dispose()` explicitly revokes that URL, releases the download's lease and settles `closed`.
It is idempotent, is not download cancellation confirmation and may interrupt a still-consuming
browser. The caller decides when the link is no longer needed; there is no guessed timeout, immediate
post-click revocation, automatic release on export finish or automatic OPFS deletion after request.
The [File API URL lifetime](https://w3c.github.io/FileAPI/#lifeTime) supports explicit revocation;
it does not make request acknowledgement a safe indication to delete the backing version.

The default owner hold remains until the application explicitly releases it. This costs disk but
allows another download if the first request was blocked/cancelled or its outcome is unknown.
The read lease is local to the live document. After that document terminates, lock release must
not be interpreted as confirmation that a browser-managed download finished. The persistent hold
still protects the source unless the application explicitly released it. Guaranteeing an ongoing
native consumer after both retention release and context loss is outside this managed profile.
Selected-directory/native-file export remains a separate capability profile and task.

## Deleting old versions

The first managed implementation should expose bounded inspection and **explicit per-version
deletion**, without background retention policy, force flag, directory sweep or current-name removal.
`scanVersions` is a weak, bounded metadata scan (default32/max128 per page), not a frozen catalogue.
Use publication sequence, not wall-clock age, to select old versions. A policy such as keeping
two previous results belongs to the caller; it can release only the holds it owns/knows.

`deleteVersion(key,{expectedRevision})` is admitted only for a committed superseded version with
zero persistent holds, no read/download leases, settled physical I/O and verified scope/object
ownership. Publication history stays committed. Selected, held, unknown, stale, legacy or busy
versions block rather than being forcibly invalidated. In-progress/uncommitted files use the
separate recovery cleanup path, not this method.

Deletion uses this resumable protocol:

1. Try an exclusive version lock without waiting. All managed readers use the shared lock; do not
   infer reader absence from a previous count or `navigator.locks.query()` snapshot.
2. In one short IDB transaction recheck scope, exact revision, current-name references, committed
   record, holds and physical-settlement marker. Mark `deleting` and bump the revision. Holds and
   acquisitions reject once this tombstone is present; do not keep an IDB transaction across FS I/O.
3. Resolve the stored handle and verify that the exact private leaf still belongs to it. Remove only
   that object. An already absent object is acceptable only after an authoritative owned deleting
   record; absence without the record is not permission for cleanup.
4. Mark bytes deleted in another transaction. Keep outcome, identity, hold tombstones and revision.
   If physical deletion or its acknowledgement fails, report indeterminate and retain the deleting
   record. Reinspect and explicitly retry using the new revision. Never restore a stale name/file.

Byte deletion frees only this owned version's storage. Outcome/hold tombstones intentionally remain;
bounded scanning is not a persistent quota or a bound on metadata history. Compaction, retention
quotas and whole-catalogue reset need separate contracts. Known IDs must never be recycled.

Transactions serialize hold insertion/release, replacement and deletion claims on overlapping stores.
Only version locks are held across external work. Attempt-owner and version locks are never nested;
no metadata transaction waits for a Web Lock. A managed version is written once before publication
and never reopened for writing; it cannot be selected again after being marked deleting.
See [Web Locks non-waiting acquisition](https://w3c.github.io/web-locks/#api-lockmanager-request).

## Recovering an uncertain commit

Recovery must keep these questions separate: did this attempt publish, what does the name select
now, are the original bytes available, can a late publisher still act, and has physical I/O settled?

| Observation | Publication decision | Allowed action |
| --- | --- | --- |
| Authoritative committed record, original bytes present | Historically committed | Acquire original reference; preserve its owner hold |
| Committed record, name replaced by another attempt | Still committed | Never substitute the new name's bytes for this result |
| Committed record, bytes intentionally deleted/evicted/missing | Still committed, receipt unavailable | Report deleted/missing; no re-export disguised as recovery |
| Authoritative not-committed record, no future publisher, I/O settled | Not committed | Explicit revision-checked staging cleanup, then fresh attempt if requested |
| Live/busy owner, unfinished late operation, incomplete/missing record, DB unavailable or foreign scope | Indeterminate | Preserve state; no deletion, rollback or automatic retry |

`recovery.inspect` is readonly. It may make a non-waiting temporary lock observation, but does not
create records, fence an epoch, republish, remove files or prompt. Snapshot revisions are not locks.
Missing record, equal bytes/hash, selected name, file absence, elapsed timeout, `exporter.closed`
alone, page unload or an absent Web Lock cannot establish a negative outcome.

Explicit `recover(key,{expectedRevision})` is a metadata operation. It tries the abandoned attempt's
exclusive owner lock without stealing. If busy it blocks. If a complete authoritative outcome is
already known it returns that observation. For a valid incomplete owned attempt it runs an IDB
transaction over the same publication stores, rechecks revision, increments the publication fence
and records non-publication. Every publisher must recheck that fence inside its publication
transaction. An already created transaction serializes before recovery and either commits its
outcome or aborts; a later stale publisher cannot pass the fence. No encoding resumes or second
publication is issued for that identity. A lost recovery acknowledgement is itself indeterminate;
inspect using the original key before considering another mutation.

**Publication fencing is not proof that old physical writes have ended.** Web Locks specifies
lock termination when the owning agent/document terminates; that mechanism is not a cross-API I/O
completion receipt. See [lock termination](https://w3c.github.io/web-locks/#termination-of-locks).
The managed journal needs a positive physical-settlement marker written only after native close
or abort has resolved and all issued operations have settled. Successful publication requires
`bytes-closed` evidence before its transaction. If a page disappears before that marker, logical
publication can be fenced, but `physicalIO:'unknown'` blocks file cleanup. Quarantine such remnants
until a separate native-fencing proof/profile is available; never replace the marker with a timer.

`quiescent` in the existing recovery snapshot means no future publication can occur for that
attempt. The additional `physicalIO` field controls cleanup independently. The generic recovery
service remains structurally compatible; `cleanup` additionally rechecks settled I/O and deletes
only definitively unpublished owned staging. It never deletes committed versions or evidence.

This is recovery from lost acknowledgement/context loss within a validated retained storage scope.
It is **not** a power-loss, process-crash, durable journal, OPFS+IDB atomic storage or eviction
guarantee. The [IndexedDB durability setting](https://www.w3.org/TR/IndexedDB-3/#durability-hint)
is a storage hint, not a transaction spanning OPFS. Missing/corrupt/recreated storage stays unknown.

## Compatibility and implementation boundary

The v2 owner hold preserves the default result lifetime: neither replacement nor exporter
dispose/closed nor store close deletes the original. Managed deletion becomes possible only after
explicit retention release and when no registered read is live. V1 raw receipts, Node receiver,
Blob exports, custom encoders/muxers, limits, audio handling, progress, errors and Promise identities
remain untouched. New managed coordination requires OPFS, IDB and Web Locks; unavailable capability
rejects rather than falling back to memory, native user-file overwrite or expiring leases.

The next separately requested implementation should prove B1–B28 with controlled storage/locks and
then B29–B32 against real browsers/decoders/package consumers as applicable. The current work checks
draft types and document consistency only. No new browser execution, runtime guarantee or public
installed/Next P27/P28 completion is implied. See the [verification record](external-video-browser-lifecycle-verification.md).
