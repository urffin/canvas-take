# Private browser video receiver: OPFS catalogue prototype

Date: 2026-11-20. Baseline: `6bcb9815f74173bdae1acba1d882d941644ad820`, version 0.8.1.
Implementation: `src/internal/video-browser-catalog.ts`. **Private prototype**, no package entry
point, public API, version update or release. Existing controllers, codecs and MP4/WebM muxers
are reused unchanged. Node's filesystem receiver is not imported or required by browser export.

## What is created and replaced

The prototype writes actual byte files to the Origin Private File System (OPFS). Each attempt
owns a fresh UUID filename. The application-facing name, such as `movie.mp4`, is an **IndexedDB
catalogue entry pointing to an immutable OPFS version**, not a filename in the user's selected folder.
This distinction is explicit in the required `publication:'opfs-catalog'` option and result metadata.

`getFileHandle(name,{create:true})` returns an existing file too; it is not an exclusive-create
primitive. The File System Standard describes deferred write visibility at stream close, but that
does not by itself establish portable atomic named no-replace across arbitrary writers. See the
[handle lookup](https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-getfilehandle) and
[writable stream](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createwritable) algorithms.
Accordingly, `checkNativeBrowserFileDestination()` reports unsupported for unverified native-name
semantics instead of adapting them silently into the stricter [external contract](external-video-destination-contract.md).

For this prototype, an IndexedDB readwrite transaction checks/inserts or replaces the logical name
and records the attempt outcome together. Default `ifExists:'error'` allows exactly one publication
for that logical name; explicit replace switches the pointer to a complete new version. Other
cooperating tabs use the same transaction stores. A losing attempt never deletes the winner or
restores an old value. Earlier successful receipts still refer to their own immutable OPFS objects.
No move(), existence-check-then-overwrite, delete-and-copy fallback or user-directory atomicity
claim is used. Native move API availability was observed, but it is not relied on as proof.

## Provisioning and data path

The application explicitly provides a dedicated direct child of its OPFS root, an app-owned
database name with the `canvastake-browser-video-` prefix, and
`trust:'cooperating-origin-namespace'`. Provisioning opens/verifies the schema and stores the
directory handle in IndexedDB; a reopened connection must resolve to the same directory/scope.
No picker, permission prompt or user-selected-file mutation happens inside the receiver.

The owning origin must keep that private namespace under the protocol's control. Same-origin code
that edits/deletes arbitrary private objects, changes metadata/schema or removes the scope while
exports are live is outside this prototype's trust model. This is not a security boundary against
other scripts in the origin. Foreign names, scopes and unsupported configuration reject.

```text
canvas / prepared audio -> codecs -> MP4/WebM muxer
  -> controller-owned positioned sink -> OPFS WritableStream
  -> close the byte file -> atomic IndexedDB catalogue/outcome transaction
  -> original-version receipt with getFile()
```

`bind` allocates an attempt identity in memory; `checkSupport` uses only readonly metadata and scope
queries. It does not reserve a name, create an object, journal or writer. Acquisition reserves a
unique object ID in IndexedDB before creating the private file, then records the handle and opens
its writer. The default binding limit is 256 per open catalogue instance; it is not a persistent
storage quota. Logical-name collision is enforced at publication, not by a preliminary check.

The native writer is held through `getWriter()`; positioned write and truncate commands use that
writer, preserving stream pressure/serialization. The controller still owns borrowed snapshots,
extent limits, cancellation admission and physical-operation fencing. No whole-file Blob assembly
is added. Before logical publication, the complete stream is closed and the final extent sealed.

## Cancellation, errors and cleanup

- Before commit admission, cancellation prevents publication. Outstanding receiver work must settle
  before its native writer is aborted/released and the verified owned private file is removed.
  The old catalogue entry and earlier receipt are unchanged. Fresh exports use new attempt IDs.
- After commit admission, cancellation/dispose does not undo publication. The IDB transaction's
  outcome determines the result. It never deletes a newly published object as rollback.
- Failure before publication or an observed aborted publication transaction is known not-committed.
  Entry update and outcome update are rolled back together. The failed private object is removed.
- A thrown acknowledgement **after** the catalogue transaction completes makes the core report
  indeterminate; inspect/lookup can still find the committed version. Release preserves it, and no
  automatic second publication or destructive abort occurs.
- Cleanup rechecks revision, released state, known non-publication and ownership. It cannot delete
  a committed object; transaction tombstones prevent ID reuse. A cleanup token serializes concurrent
  recovery requests. A corrupt/unavailable database can leave an orphan for explicit reconciliation;
  there is no unsafe name-based sweep or TTL deletion.

Attempts and catalogue connections have separate lifetimes. `close()` refuses live export sessions,
waits for tracked database transactions, then closes its connection. Already returned receipts can
still read their original file after catalogue close/reopen. Database deletion/version change
invalidates the catalogue; it does not grant permission to delete published files.

## Actual browser verification

Final local verification: **391/391 Node tests**, including five new receiver guard/import tests;
**62 expected negative type cases**, including five new cases; build and installed tarball consumer
passed. All **14 public declaration files** match the baseline. The real browser matrix covers
**128 cases** and **84 independently decoded files**, including four native-download smoke cases.

| Browser | Container | Cases | Independently decoded files |
| --- | --- | ---: | ---: |
| Chromium | MP4 H.264/AAC | 32 | 21 |
| Chromium | WebM VP8/Opus | 32 | 21 |
| Firefox | MP4 H.264/AAC | 32 | 21 |
| Firefox | WebM VP8/Opus | 32 | 21 |

The explicit browser-debugging permission for this task covers Playwright Chromium/Firefox after
the built-in browser failed twice before opening a tab (Windows sandbox startup error). Verification
uses fresh browser profiles and at most two agent-opened tabs. The only local HTTP server serves
static modules; media writes occur in the browser's OPFS, without a Node filesystem RPC receiver.

The [runner](../../scripts/verify-browser-video-receiver.mjs) and
[browser harness](../../scripts/browser-video-receiver/browser.mjs) check:

- Readonly support calls, exact container/limit validation and explicit unsupported native naming.
- Creation, collision and replacement using actual OPFS files and native IndexedDB transactions.
- Two tabs sharing a catalogue race to create a fresh logical name: exactly one wins, and the losing
  attempt removes only its private object. Old versions remain readable across replacements.
- H.264/AAC MP4 and VP8/Opus WebM, mono/stereo, input limits 1/2/default 4, one and 961 audio samples,
  and 30-second stereo exports with 121 video frames and a final hold.
- Cancellation during acquisition, readiness, writes and truncate; late cancellation during commit;
  write/truncate/close failures; actual IDB publication-transaction abort; lost acknowledgement;
  and a fresh successful export after each failure/cancellation.
- Exact file size, final extent and absence of failed objects. Explicit repeated cleanup, closed
  connections and preserved original receipts are verified before the harness deletes only its
  freshly owned test database/directory.

Native encoder/frame/AudioData/Worker/writer and database-connection counters are instrumented.
After each exporter closes, receiver sessions/borrowed writes and native codec/writer counters must
be zero; one explicitly owned catalogue connection remains until catalogue close. After namespace
teardown, all those counters, object URLs and connections are zero. This is an API-lifetime check,
not an OS descriptor/GC/RSS measurement or proof of immediate storage-engine cache release.

Files read **from the OPFS receipts** are independently demuxed/decoded with FFmpeg and
separate MP4/WebM readers. They verify frame timestamps/counts, final hold, AAC priming/tail edits,
Opus delay/padding and presentation sample count. Audio starts at zero, with zero lag at both ends.
For long recordings, decoded integer PTS/timebase is used: FFmpeg's textual `pts_time` has too few
significant digits to verify microsecond timing at tens of seconds. Short/tiny AAC/Opus normalization
uses the existing independently tested container-based rules, not a test-supplied sample count.

One native download per browser/container verifies the explicit download flow. Other files are
read from the actual receipt in bounded 64KiB chunks through the test driver; a SHA-256 comparison
checks that the decoder receives the exact browser bytes. An earlier run stalled waiting for a
Firefox download event after export, commit, hashing and resource checks had already succeeded.
This harness transport avoids depending on a long series of download UI events; it does not
certify bulk automatic downloads or establish the cause of that event timeout.

The harness hashes File contents and retains receipts to verify old versions. Those verification
allocations are not the receiver's streaming-memory behavior and must not be used as a memory
benchmark. Result counts, versions, source hashes and decoder/resource evidence are saved in
[the results record](external-video-browser-results.json); full logs/files are ignored under
`benchmark-results/browser-receiver-*` and `benchmark-results/browser-video-receiver/`.

## Limitations and next boundary

The subsequent [result-lifecycle project](external-video-browser-lifecycle.md) specifies a separate
managed profile for File leases, explicit downloads, retention/deletion and uncertain-commit recovery.
It is design-only; the v1 implementation and the verification results above are unchanged.

1. OPFS is origin-private storage. It is not the Downloads folder or a user-picked directory, and
   logical-name replacement is not native filename replacement. User-visible saving requires a
   separate explicit download/picker flow. Picker selection/permissions and their possible file
   effects are outside this prototype; see [File System Access](https://wicg.github.io/file-system-access/#api-showsavefilepicker).
2. OPFS and IndexedDB are separate storage systems. Bytes are closed before metadata publication,
   but there is no cross-system crash transaction, fsync contract, power-loss recovery or storage
   eviction guarantee. Pending/orphan records after interruption need a later recovery protocol.
3. Committed versions and tombstone metadata are retained intentionally. There is no public retention
   or garbage-collection API; the test harness deletes its entire owned namespace only after use.
   Reopening a catalogue does not impose a persistent disk quota or bound the full version history.
4. Cooperative same-origin access and stable private-directory/schema ownership are preconditions.
   The prototype does not certify arbitrary native file handles, hostile namespace mutation,
   cross-origin access or unavailable storage. Native permission/file-picker behavior is not tested.
5. Browser implementation can buffer/cache disk I/O internally. This stage verifies streaming calls,
   cleanup and long-file correctness, not a bound on total process memory or storage latency.

```sh
npm test
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-browser-tsconfig.json
npm run test:package
# Requires explicit browser-debugging authorization under AGENTS.md:
npm run test:video:browser-receiver
```

Review this profile and choose the intended user-visible save/retention scenario before exposing
public external API or attempting native-file guarantees. Public installed/Next P27/P28 and a
release remain separately authorized stages. This prototype adds no public API or version bump;
commit/push and existing CI verification are a separate delivery step.
