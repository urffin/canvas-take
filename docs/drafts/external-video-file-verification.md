# Private Node destination: D1–D20 verification

Date: 2026-11-20. Baseline: `6fa3bcf2b146252f7ec13496fddd1a1acf5ac7d0`, package version 0.8.1.
This implements a private candidate for the [refined destination contract](external-video-destination-contract.md)
and [D1–D20 gates](external-video-destination-compatibility.md). It is not a public package entry
or a universal filesystem adapter. The public factory proposal and all current Blob APIs stay unchanged.

## Selected profile

`src/internal/video-file-node.mjs` is a standalone Node module copied to `dist/internal` with
its `.d.mts` declaration. It never enters a browser bundle. It supports Node 22/24 on Windows/Linux
and requires an explicit `trust:'controlled-local-directory'` provisioning precondition. Other
runtime/platform profiles reject. Local execution here used Node 22 on Windows; Linux/Node 24
branches are supported candidates for subsequent CI verification, not local measurements.

The root must already exist, be canonical, and have stable directory identity. The application
controls its parent and the receiver's private subdirectory, and prevents uncoordinated mutation
of private artifacts. Other writers may create/replace/delete/modify regular target files; they
do not rename roots/mounts or race hostile symlink/reparse substitution against individual syscalls.
Observed scope changes, symlinks/non-regular targets and malformed names reject. This profile is
not a sandbox for a hostile directory owner: Node path-based checks are not atomic dirfd/handle
containment or conditional target-kind replacement. Such an environment is outside the profile
and must not be provisioned with the trust assertion. No network/removable-filesystem or arbitrary
volume atomicity certificate is inferred from a successful probe.

Provisioning explicitly creates one fresh private directory and probes distinct file identities,
positioned writes/truncate, hard-link no-replace and same-directory whole replacement using only
known private probe names. It removes those owned probe entries. `bind` creates a caller-known
versioned attempt key in memory; it does not open a writer or create the journal/target.

Preflight only reads scope identity, the active profile, current permission and target kind, then
checks format/policy/bounds. It does not reserve a name, acquire handles, probe publication, write
a journal, ask for permission or run a picker. Positive reports include scoped evidence and remain
compatible with the old core `Support` shape. Creation rechecks before claiming a fresh attempt.

## Journal, publication and recovery

Each attempt gets exclusive staging and journal files. Registered/prepared records precede media
work; sealing records the final extent. The complete publishing checkpoint is awaited before the
publication syscall. After success, an authoritative process-local witness is recorded before
acknowledgement fault points, followed by the committed journal checkpoint. Records contain the
attempt, target, policy, sequence, size and artifact identities. Expected journal bytes are retained
by the owning live receiver; recovery does not trust a rewritten record as new authoritative proof.

Create-new publishes with native exclusive hard link. Replace publishes with same-directory rename;
there is no exists-check fallback, copy-over/delete/append mode or restoration of old bytes over
another writer. Only a native no-replace collision is classified by its specific completed syscall;
an arbitrary injected `EEXIST` after a lost publication acknowledgement remains ambiguous.

Commit is admitted once and is non-cancellable. Errors before publication was issued have a known
negative outcome. Once issued, unconfirmed errors remain unknown. If publication is known to have
succeeded but commit throws during later journal/ack work, the exporter still truthfully reports
indeterminate; independent recovery can identify the historical committed operation after `closed`.
It does not change the original finish Promise or close report.

An original-version receipt uses a **separate file copy**, not a hard link to the mutable public
target. Retention copies/hashes in 64 KiB chunks and verifies the source identity/extent. A later
in-place write, rename or deletion at the target name cannot alter that retained version. `read()`
checks receipt identity, size and hash before returning bytes. A missing/corrupt original receipt
is unavailable even when publication is known historically committed; a later target's contents
are never substituted. A receipt path is a convenience for independent decoder tests; the controlled
private-namespace precondition applies to direct path use as well.
Invalidating the publication profile blocks new exports but does not invalidate already published
receipts or recovery; those separately recheck the physical scope/artifact identities.

Inspection separates historical outcome, current target relation, quiescence, staging and receipt
availability. Content hashes help observe the current value but do not prove a publication history.
Missing/corrupt journal, equal contents, absent target/staging or a publishing-only checkpoint cannot
resolve an unconfirmed operation. A live pending operation remains non-quiescent and cannot be cleaned
or declared not-committed merely because a caller stopped awaiting it.

Unknown release closes handles while preserving journal/version/staging evidence. Explicit recovery
cleanup rechecks its opaque revision, definitive outcome, physical quiescence, release state and
artifact identities at mutation time. It blocks stale/foreign/corrupt/unresolved state; it can remove
only obsolete owned staging and an uncommitted retained copy. Committed receipts and minimal journal
evidence survive cleanup. Cleanup never deletes/restores the target or repeats publication.

This is **process-lifetime recovery through the same receiver instance**. The journal is not fsynced,
authenticated for reopening, adopted after restart or backed by a persistent late-operation fence.
A new process does not acquire another receiver's recovery key. There is no crash-durability or
power-loss claim. Unknown native outcomes without an authoritative witness intentionally remain
unresolved. A durable/restart-capable profile requires a separately designed storage protocol.

## Resources and costs

Creation failure closes unreturned handles and removes only verified owned staging. Normal abort,
release and recovery cleanup serialize against physical operations. A logical controller abort can
reject early; `closed` still fences readiness/write/truncate completion and closes owned handles.
Filesystem interference can block artifact removal; the factory preserves the primary failure and
counts secondary cleanup failures instead of deleting foreign entries. An invalidated/moved scope
requires the application to restore/rebind the scope before safe cleanup is possible.

Receipt and journal files are intentional retained results/recovery artifacts, not open writer
resources. There is no automatic TTL sweep. The receiver retains at most 1024 attempt bindings by
default, refuses further binding at the configured quota, and does not recycle an old key. Journal
growth is bounded by one acquisition, one seal and one commit attempt, not the number of frames.
All observed explicit handle, positioned-I/O and borrowed-buffer counters return to zero in the tests.
This does not claim GC/RSS/OS-cache release or constant total memory for the encoder/muxer pipeline.

The independent version adds another complete file on disk and an O(output size) copy/hash pass.
The normal successful target plus retained version therefore need roughly twice the output storage.
Only explicitly calling receipt.read() loads the complete retained file into application memory.
The private module exposes test-only fault/publication/short-write injection; those hooks must not
be used as production backend customization or as evidence for an arbitrary publication primitive.

## Checks performed

- **386/386** total Node tests passed, including **40** new receiver/media groups; no skips.
- Real file publication races include two transactions and another Node process. Case alias handling
  follows the observed filesystem behavior. Directory/junction/symlink targets, root rebinding,
  permission-required/denied/revoked fault states, malformed bounds/views and acquisition failures reject.
- Faults before/after journal checkpoints, publication and acknowledgement verify outcome classification,
  journal ordering, preserved falsy reasons, missing/corrupt records and conservative reconciliation.
- Controller cancellation during ready/write/truncate, late cancel/dispose after admission, and a
  delayed publisher verify quiescence and cleanup fences. Inspection is read-only; stale/foreign
  cleanup and mutation at the cleanup boundary block without affecting the target/receipt.
- Four real-controller H.264/MP4 and VP8/WebM cases decode independently with FFmpeg and separate
  container readers: three frames at 0/300000/800000 microseconds, total/final hold 1500000 microseconds.
  Commit-ack failure recovery and fresh replacement export decode; in-place target overwrite leaves
  the retained version decodable. These new cases are silent video; existing AAC/Opus tests remain
  regression evidence, not a new browser/audio matrix for this receiver.
- Build and strict/noEmit private type compatibility passed: **57** expected negative cases, including
  five new actual-receiver checks. All **14** public declarations match the baseline. Existing private
  controller/muxer/encoder sources, public exports, dependencies, lockfile and defaults stay unchanged.
- Installed tarball/consumer checks verify both private Node artifacts are present and package imports
  of them are blocked. No Node built-in is introduced into the public browser entry graphs.

Permission transitions are fault-injected around the actual native permission query; this is not a
cross-platform ACL or browser permission-prompt test. No local browser debugging or new crash-recovery
test was needed or performed. The [evidence matrix/results](external-video-file-results.json) map each
D gate to concrete case names and preserve hashes/verification boundaries. Raw logs are ignored under
`benchmark-results/file-receiver-*.log`.

CI follow-up (2026-11-20): [the first committed run](https://github.com/urffin/canvas-take/actions/runs/44634951418)
passed the Linux jobs but rejected noncanonical Windows temporary paths in all new fixtures.
Fixtures now resolve their newly created directory with realpath before provisioning, matching the
receiver's existing canonical-root precondition. Runtime scope validation is unchanged. A separate
correction commit and exact-SHA CI verification are recorded in the external roadmap.

```sh
npm run test:video:file
npm test
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-file-tsconfig.json
npm run test:package
```

## Next stage

This is a private scoped candidate, not a newly published production adapter. Broader filesystem
trust models, restart/crash recovery and a browser destination need separate implementation/proofs.
Review the current profile and D1–D20 evidence before exposing any external public factory or
entry point. New public installed/Next gates P27/P28 remain pending. No commit/push, public API,
version update, release or npm publication is part of this stage.
