# External video destination: production contract refinement

Date: 2026-11-20. Baseline: `c6f7ef75a2d95ffdeed574b2310b752f814400a2`, version 0.8.1.
**Design only.** This refines the [proposed API](external-video-public-api.md) after
the [real private MP4/WebM checks](external-video-containers-verification.md). It adds no runtime
implementation, public entry, destination helper, controller option or release. The existing
private controller/transaction ABI and all current Blob contracts stay unchanged.

The [companion declarations](external-video-destination-contract.d.ts) and
[compile-only example](external-video-destination-types.ts) describe adapter/application diagnostics
and recovery. They are not new core-required methods or a proposed universal storage implementation.
A type assertion or `supported:true` cannot establish a filesystem guarantee.

The later [private Node candidate](external-video-file-verification.md) implements these mechanisms
under an explicit controlled-local-directory/process-lifetime profile. Its evidence and exclusions
are separate from the portable design below; it adds no public entry or restart-recovery guarantee.

## Selected boundary

The core continues to call `checkSupport(request) -> Support`, then `create(context)` and the
existing ready/writeAt/truncate/commit/abort/release methods. A supported destination promises
the full semantics for the **requested** format, policy, bounds and target scope. The core cannot
certify an arbitrary third-party implementation just by checking its method names.

For a receiver intended for actual use, the application also needs a backend-scoped attempt key
and an independent recovery service. The key is available **before starting the exporter** and
does not depend on `finish()` or an optional `commit.recovery` field. A thrown/rejected commit or
malformed outcome may leave that field absent; the current controller correctly reports
indeterminate publication but cannot reconstruct a backend token it never received.

The adapter chooses how to provision a profile, bind a target and create the attempt. No generic
`prepareDestination`, picker, Node/OPFS helper or mandatory recovery method on the transaction is
added. The illustrative binding contains `{key,destination,recovery}`; a new application retry
gets a fresh binding/key/transaction. Generic destination factories may still be reused, provided
each acquisition has an independent, externally discoverable attempt identity. A per-attempt
bound factory rejects a second acquisition rather than reusing staging or a commit operation.

## 1. Capability checks: evidence, availability and acquisition

These are three separate steps:

| Step | Permitted work | Meaning |
| --- | --- | --- |
| Provision a platform profile | Backend-specific conformance probes in explicitly provisioned scratch storage, or an authoritative service contract | Evidence for a particular backend/version/volume or storage namespace; performed outside export preflight |
| `checkSupport(request)` | Read existing profile/configuration, query current permission without prompting, validate policy/bounds/scope | Read-only decision for this exact request; neither reserves a name nor guarantees later acquisition |
| `create(context)` | Revalidate identity/profile/permission, register the attempt, acquire fresh private staging and owned handles | The first acquisition boundary; clean unreturned resources before rejecting |

A positive profile must cover all-or-reject positioned writes, exact truncate, isolated staging,
atomic requested publication and recovery after an ambiguous commit. It identifies the backend,
target scope and evidence revision. A profile for one volume, mount, browser implementation or
service configuration is not transferable merely because the API method names match.

`checkSupport` must not create a probe/temp/empty target, truncate or reserve a name, acquire a
writer/lock, run a picker, request permission or persist a new recovery journal. Numeric bounds
must be safe, supported by the backend, and compatible with the existing per-write limit.
Unknown/stale evidence, unsupported policy/I/O/limits or unavailable recovery fails closed.
Permission states requiring UI return unsupported with an actionable reason; the application
obtains permission separately and starts a fresh check. No core permission workflow is added.

The rich draft support report can include a scoped guarantee and diagnostic code; its projection
to the core's existing `Support` is sufficient. Extra diagnostics are for applications, not fields
the existing controller validates. Support is not a guarantee of free space, retained permission,
target absence or future network health. A later failure is an acquisition/I/O failure, not grounds
to silently switch the selected policy or storage primitive.

`create` revalidates the target binding and profile before any possible publication. If the parent
scope, mount or authorization changed, it rejects and cleans its own partial acquisition. It must
not resolve an untrusted path again into a different target as a fallback. Name rules, case aliases,
symlinks/reparse points, non-regular targets and scope escape require explicit platform policy;
unsupported/ambiguous identities reject. A scope label is not a substitute for backend enforcement.

## 2. Creation without replacement

`ifExists:'error'` remains the default. All media and headers are written to private staging;
the public name need not exist during export and must not be reserved by an empty placeholder.
The backend enforces absence **at the publication operation itself**, including competing
processes/factories, name aliases and an intervening creator. A preliminary exists check, a
process-local mutex or exclusive creation of only the temporary file does not establish this.

For competing create-new transactions, at most one publishes. A losing attempt does not delete,
truncate, restore, relink or otherwise modify the winner. A selected file handle/picker may already
refer to an existing target; permission to write that handle does not convert default create-new
into replace. No automatic rename to another filename is part of this policy.

The tested same-directory hard-link receiver is one platform experiment. Production acceptance
needs scoped evidence for the actual namespace and collision primitive, not a promise based on
an arbitrary filesystem error code or a method being present.

## 3. Explicit whole replacement

`ifExists:'replace'` means create if absent or atomically publish the entire new regular-file
value at the bound target. Old published contents remain untouched by this attempt until the
publication point. There is no append, copy-over, delete-then-rename, in-place truncation,
cross-device copy fallback, stale tail or restoration of a pre-export snapshot.

This is unconditional replacement, not compare-and-swap or a promise to retain the original inode,
permissions, metadata or open-handle behavior. A stricter version-checking backend may reject a
conflict; no generic revision option is added. A concurrent writer may legitimately change the
target. A not-committed outcome guarantees **this attempt** made no publication/target mutation;
it does not freeze unrelated writers or justify restoring stale old bytes over their result.

If whole replacement cannot be provided for the current target kind/scope/platform, preflight
rejects. If capability disappears later, acquisition/write/commit fails conservatively; the
adapter does not weaken the contract. The test receiver's same-directory rename is not a portable
atomicity or durability proof.

## 4. Attempts and the publication journal

The application knows a versioned `{backendId,scopeId,attemptId}` key before construction.
The backend records attempt identity, bound target, policy, staging identity, expected final size
and its publication evidence **before issuing publication**. A profile defines record ordering
and retention, and whether it survives process loss. At minimum, the recovery channel remains
usable after a commit exception and `exporter.closed`; it does not borrow codec/transaction handles.

Core preflight remains read-only. Allocating a caller-known ID/binding is not the controller
acquiring a transaction; any application-side preparation is outside that guarantee. The journal
must be established by acquisition before publication is possible. Resources acquired but not
returned after `create` failure remain the factory's responsibility.

Suggested backend record checkpoints are prepared, publication-attempted, confirmed-committed,
confirmed-not-committed and unresolved. Their exact storage format is backend-specific. A record
saying only publication-attempted is **not** proof of either outcome. Partial/invalid/missing records
are indeterminate unless independent authoritative evidence proves a result. A missing journal
must never be interpreted as absence of publication by default.

`commit()` has no cancellation signal. It returns committed only with a usable detached value,
not-committed only with proof of no publication, otherwise indeterminate. Timeout, disconnect,
unexpected error and malformed output are ambiguous until reconciled; the owner does not guess
from an error class. An exception at a documented pre-publication boundary may be classified by
the adapter as known not-committed, but an arbitrary caught filesystem error is not that proof.

Commit is invoked once by the exporter. It is not required to be a generally idempotent public
operation and is never automatically retried. A backend with idempotency keys may use them to
**query the same operation**; this does not authorize a second publication or a replacement under
a new key. The reconciliation channel has no generic commit/retry/rollback/delete-target method.

## 5. Reconciliation after indeterminate commit

Wait for `closed` before application recovery on a live session. After process loss, use the
persisted key and a separately documented crash-recovery profile; that stronger guarantee is not
implied by the portable contract. A server operation may outlive the client: closing a socket,
aborting fetch or expiration of a client timeout/lease does not prove it can no longer publish.
The backend must establish quiescence/fence late publication before claiming not-committed or
allowing cleanup. An unfenced in-flight attempt remains indeterminate.

`inspect(key)` is read-only, repeatable and never prompts or cleans up. Reject an unknown key
version/backend/scope without mutating storage. An inspection returns an observation revision,
quiescence, historical publication, current target relation, staging state, and a recovered receipt
only if the original publication is still accessible. The observation may be stale immediately;
it is not a lock or target ownership grant.

| Available evidence | Historical outcome | Allowed action |
| --- | --- | --- |
| Authoritative completed-operation record/version proves this attempt published | committed | Return an original-version receipt if available; never assume the current path still names it |
| Backend proves operation never published and is unable to publish later | not-committed | Explicit cleanup of owned remnants may be requested; a fresh export uses a new key |
| Target equals expected bytes/size/hash, without attempt provenance | indeterminate | Keep recovery state; identical exports can have identical contents |
| Target absent/different, staging absent, missing journal or only publication-attempted checkpoint | indeterminate | These observations alone cannot prove that publication never occurred |
| Operation might still publish, inspection fails, conflicting evidence or stale binding | indeterminate | Retain journal/staging; retry only the read-only inspection when appropriate |

A later writer may replace/delete a successfully published value. Historical committed and
current-target relation are separate fields. Reconciliation must not label the earlier attempt
not-committed merely because the target now differs. If the original value cannot be retrieved,
the committed observation carries an unavailable receipt/reason; it must not return a handle/path
to the later writer's bytes as if those were this attempt's result. Falsy recovered values remain
valid if their type permits them. No recovery result retroactively resolves a rejected finish
Promise or changes the original immutable close report.

## 6. Release, explicit cleanup and ownership

The existing core still calls abort only for known not-committed and always attempts release once.
After indeterminate, release closes session handles/listeners but preserves the journal and any
private data needed for reconciliation. Those retained artifacts are documented recovery state,
not a successful export or proof of a leak. Quotas/retention require an explicit backend policy;
age-based deletion of unresolved records is not a safe default.

`recovery.cleanup(key,{expectedRevision})` is a separate **explicit** application operation. The
backend rechecks record revision, quiescence, definitive outcome and artifact identity at the
mutation boundary, not just against the earlier inspection. Stale revision, foreign/replaced
staging, unknown outcome or an operation still able to publish blocks cleanup. It can remove only
owned private remnants no longer needed for reconciliation or for any returned usable receipt.
It never deletes/restores/truncates the target or a published version. A receipt backed solely by
a retained staging object needs an independent surviving reference, otherwise cleanup must block.

For a leftover create-new staging hard link, removing the verified owned directory entry may be
safe after definitive reconciliation; deleting the target path is never a rollback. A backend
unable to revalidate staging ownership/generation under its concurrency model refuses cleanup.
No recursive directory sweep, guessed filename, content hash alone or expired timestamp grants
ownership. Repeating cleanup yields already-clean or blocked without repeating publication.

The recovery service retains the minimal evidence required by its documented retention contract;
cleanup must not turn a formerly resolved attempt into an apparent new/unattempted operation.
Recovery transport/cleanup failures are reported independently of the exporter's primary error.
They do not erase evidence or rewrite a known publication outcome.

## Platform decisions and source boundaries

- Node documents link creation and rename; its callback rename description permits overwriting,
  and its access documentation warns about check/use races. These are primitives to assess, not
  a universal CanvasTake publication certificate. See [Node 22 filesystem documentation](https://nodejs.org/docs/latest-v22.x/api/fs.html).
- The File System Standard describes deferred writable-stream visibility and per-entry locks.
  Those facts alone do not establish this contract's atomic **named create-new** policy under
  all external writers. See [createWritable](https://fs.spec.whatwg.org/#api-filesystemfilehandle-createwritable).
- Permission query and permission request are distinct operations; the application handles UI
  before export preflight. See [File System Access permission queries](https://wicg.github.io/file-system-access/#api-filesystemhandle-querypermission).

The eligibility conclusions here are CanvasTake design decisions, not claims that those sources
implement the new transaction/recovery protocol. No stock Node, File System Access or OPFS
production adapter is approved by this document. The previous test receiver lacks an independent
pre-known attempt journal/service and therefore is **not** a production implementation of this
refined contract, even though its scoped file-policy tests passed.

## Compatibility and next gate

The core ABI, public proposal function signatures, existing private runtime/types, Blob behavior,
exports, dependencies, limits and version 0.8.1 stay unchanged. New diagnostic/recovery types are
adapter/application design artifacts. Type checking proves shape/narrowing only, never platform
capabilities, journal ordering or race safety. The [acceptance matrix](external-video-destination-compatibility.md)
defines the next required implementation proof; the [verification record](external-video-destination-verification.md)
states exactly which design checks ran now.

Next, separately authorize a private candidate receiver with scoped profile checks, caller-known
attempt keys, journal/reconciliation and explicit cleanup, plus fault/race injection at publication
boundaries. After those gates pass, public entries and installed/Next P27/P28 can be considered.
This document does not authorize implementation, commit/push, public API changes or a release.
