# Managed browser results with native storage

Date 2026-11-20. Baseline `dbd4fc6b6d8427f1302963bd60ee8b610c150883`. Package version `0.8.1`.

The private [browser adapter](../../src/internal/video-browser-results-native.ts) connects the
managed result store to OPFS, IndexedDB, Web Locks and document downloads. The caller supplies
a fresh UUID on creation and saves it for reopening. A managed namespace has its own database
and direct OPFS child directory. The database contains a structured-cloned directory handle
and a random directory marker. Reopen checks this identity and the exact schema. It aborts
creation of a missing database and refuses upgrades or adoption of an existing namespace.

An attempt reserves its object identity before OPFS opens its writer. The private filename
contains the attempt and owner identities. The adapter records a file handle before handing
out the writer. Reads and deletion check the recorded owner and the handle. The store waits
for the writer to close before publishing a version through IndexedDB. Write positioning,
truncate and backpressure use the native stream. A catalogue mutation resolves on the
transaction's `complete` or `abort` event. Individual request success does not confirm a
commit. See the [File System Standard](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createwritable)
and [IndexedDB transaction scheduling](https://www.w3.org/TR/IndexedDB-3/#transaction-scheduling).

Shared Web Locks protect live reads and downloads. An exclusive lock coordinates deletion
or attempt recovery. The adapter requests each lock with `ifAvailable` and holds it until
release. Download preparation creates an object URL under a read lock. A user gesture initiates
the download, and explicit disposal revokes the URL. The page API reports a request only.
See [Web Locks](https://w3c.github.io/web-locks/#api-lockmanager-request) and
[HTML downloads](https://html.spec.whatwg.org/multipage/links.html#downloading-resources).

The initial profile limits persisted history to 256 attempts and 512 further hold records
per namespace, including tombstones. The catalogue is one bounded IndexedDB state record.
It is read and written as a unit to update selection, publication and holds atomically. This
profile has no compaction. File bytes go directly to OPFS, outside the metadata record. Recovery
stores bounded diagnostic reasons, while in-process operations preserve their original errors.

## Verified behavior

Run build and the [verification driver](../../scripts/verify-browser-video-managed.mjs).
The driver launches fresh profiles, opens at most two tabs, and serves compiled modules and
a deterministic audio generator on loopback. The app writes video entirely within the browser.
The driver extracts files for independent verification and deletes only its own test namespaces
and profiles. The [results record](external-video-browser-managed-native-results.json) stores
browser versions, scenario groups, source hashes and decoder measurements.

The final run passed 34 named checks across Chromium and Firefox and decoded 12 files. Four
arrived through a native download and eight through a leased `File`. The lowest measured audio
correlation was 0.97615. The full Node suite passed 454 tests, the strict managed type fixtures
passed, and the installed tarball verified that both native adapter artifacts stay private.
All 14 public declarations and the package metadata match the baseline.

- In Chromium and Firefox, both MP4 and WebM exercised cross-tab create-new races, replacement,
  File leases, persistent holds, stale deletion revisions and idempotent deletion. OPFS enumeration
  confirmed that rejected or deleted attempts lost their own staged objects.
- Each browser and format checked a gesture-triggered download and two direct reads. FFmpeg and
  the independent container readers verified byte hashes, three frame timestamps and durations,
  the final frame hold, AAC priming and tail padding or Opus pre-skip and discard padding, exact
  presentation sample counts and zero-sample audio lag at the beginning and end.
- A simulated lost acknowledgement follows a successful native publication transaction.
  A second tab recovers the committed original through persisted metadata. The native transaction
  abort cases interrupt the IndexedDB transaction after a successful `put` request, both during
  publication and while persisting the final deletion marker. Publication preserves the previous
  selection after the abort. The deletion retry can finish from the persisted deleting state.
- Cancellation delays the test wrapper after a real OPFS write so the controller still owns
  the operation. It preserves the cancellation reason, drains, and keeps the previous result.
  A fresh export then produces a valid file. This exercises the controller's cancellation fence
  without claiming a particular native write latency.
- Close/reopen preserves selection, and the two connections see the same holds. Closing a tab
  with an unsealed writer frees its Web Lock. Recovery fences that publication and leaves its
  bytes quarantined because the old writer's physical settlement was never recorded. Tests check
  native lock state, catalogue deletion and zero tracked active resources after orderly close.

```sh
npm run build
node scripts/verify-browser-video-managed.mjs
npm test
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-browser-managed-tsconfig.json
npm run test:package
```

The verified scope is a cooperating origin with generated names for a private OPFS namespace.
The adapter does not write a user-selected path. Handle and marker checks cannot establish
identity against another script deliberately recreating a path and reproducing ownership data.
An interruption between OPFS creation and recording a handle can leave a quarantined object.
The two storage systems do not supply one crash-durable transaction. This work does not measure
memory, establish power-loss durability or certify eviction recovery.

The [CI workflow](../../.github/workflows/ci.yml) includes a dedicated managed-storage job on
Ubuntu 24.04. It runs the same driver for Chromium and Firefox in sequence, using at most two
tabs at a time. The job has a 12-minute limit, with seven minutes for the build and browser
checks. On completion or failure, the `browser-managed-native-results` artifact retains the
log and any generated JSON for seven days. The workflow logs build and test output while
preserving the command's failure status. Local checks parsed the workflow and confirmed that
both a build failure and a browser-test failure preserve their exit codes while writing the log.
The browser evidence above is from the local Windows run. The first Ubuntu CI run is pending
delivery of the workflow. Public package entry points and Next.js integration remain a subsequent
stage.
