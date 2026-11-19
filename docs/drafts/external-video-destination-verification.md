# Destination contract refinement: verification record

Date: 2026-11-20. Baseline: `c6f7ef75a2d95ffdeed574b2310b752f814400a2`, version 0.8.1.
Scope: [production destination design](external-video-destination-contract.md),
[companion declarations](external-video-destination-contract.d.ts),
[compile-only fixture](external-video-destination-types.ts) and [D1–D20 gates](external-video-destination-compatibility.md).
No receiver, journal, recovery service or new public API is implemented in this stage.

## Decisions saved

- Read-only exact-request capability preflight is separate from profile provisioning and resource
  acquisition. Positive support does not reserve the target, prevent later revocation or certify
  arbitrary filesystems. Acquisition revalidates identity/profile/permission; unsupported policy
  never falls back to a weaker primitive.
- Default create-new enforces no-replace at publication. Explicit replace is a whole-value atomic
  replacement, not compare-and-swap or restoration of stale old data after a race.
- Caller-known backend/scope/attempt identity and a separate recovery channel exist before the
  exporter starts. This covers commit throw/malformed return where the optional recovery hint is absent.
- Reconciliation separates historical publication, current target, backend quiescence and readable
  original receipt. Equal bytes, absent files and missing journals are not proof of an outcome.
- Indeterminate retains recovery state. Explicit cleanup requires a fresh revision and ownership
  proof; it never republishes, deletes the target, destroys an available receipt or erases required evidence.

These are selected CanvasTake requirements, not implementation facts inferred from Node or browser
API availability. Primary sources and their limited implications are linked in the contract.

## Checks

- Build passed with TypeScript 6.0.3 and the existing pinned adapter build.
- Strict/noEmit passed with `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and
  `skipLibCheck:false`: **52** expected negative cases, including **16** new destination cases.
- Positive checks cover concrete policy reports projected to existing `Support`, a binding consumed
  by the existing destination contract, discriminated historical outcomes/available receipts,
  falsy recovered values and application inspection after a close report with no recovery hint.
- The proposal/private-controller assignments still work in both directions. Existing core proposal
  declaration syntax is unchanged apart from comments. All **14** actual public declarations
  match the baseline. The public `/video` runtime still exports only `createOfflineVideoExporter`.
- Runtime source, existing tests/scripts, package metadata/exports/dependencies/lock/defaults,
  CI and version 0.8.1 are unchanged. Only draft documentation/type fixtures are edited.
- Local document links and conformance-gate references are checked; compact evidence and source
  hashes are saved in [the results record](external-video-destination-results.json).

```sh
npm run build
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-destination-tsconfig.json
```

No new Node media, browser, decoder, filesystem atomicity or crash-recovery tests ran for this
design-only change. The previous 346 Node / 92 browser / 64 byte-comparison results remain historical
evidence for the private container integration; they do not prove the new receiver requirements.
No external-browser debugging is needed for these design/type checks.

## Remaining proof

D1–D19 receiver behavior needs a separately authorized private candidate implementation and fault/race
tests. D20's no-change/type boundary is checked here; it is not certification of a production backend.
The old file receiver has no independent caller-known journal/recovery service and is not promoted
to production by its existing tests. Crash persistence requires an explicit stronger profile and
its own storage/fencing proofs. Public external entries and installed/Next P27/P28 remain later work.

The roadmap is updated outside the repository. No commit/push, public API or release is performed.
