# Shared deferred primitive: evaluation

Status: M2 evaluated, extraction deferred, 2026-11-06. Baseline:
`9a65316cfe37e69bd35af0a489ca46e79387c09b`; package version remains 0.6.0.
See the [mechanisms design](shared-export-mechanisms.md) and
[compatibility gates](shared-export-compatibility.md#m2-promises-and-observation).
Production source/build/package files are unchanged. The candidate exists only in ignored local
experiment artifacts; `src/internal/deferred.ts` has not been added.

## Decision and benefit

Keep the two current local helpers for now. A plain shared helper is feasible in the tested cases,
but removes very little duplication while introducing a new build obligation for the recorder entry.
This follows the design's explicit option to skip extraction when its cost exceeds the benefit.

| Observation at the baseline | Consequence |
| --- | --- |
| Recorder helper is 8 lines including its comment; video helper is 6 lines | Only one small implementation is duplicated; a shared file/imports/build step yield little net reduction |
| After TypeScript/whitespace normalization the implementations match | There is no divergent behavior or known defect to fix by extraction |
| Recorder has three creation sites; video has four | They share promise plumbing, but use it for different admission, event, cancellation and queue policies |
| `index.js` is currently emitted by TypeScript without runtime imports | A helper import requires adding recorder bundling to preserve the standalone entry contract |
| Entries must remain independently deployable | Inlining would still put a copy in each entry, so sharing source does not imply sharing runtime bytes or instances |

M1 removed a duplicate pixel algorithm used by multiple frame paths. M2 is a small binding utility;
moving it does not simplify either controller's lifecycle, first-error policy or queue. The durable
result here is a documented decision and missing public-contract coverage, rather than a production
abstraction. Reconsider when the recorder already needs internal bundling for another justified
change, another compatible consumer appears, or repeated fixes show meaningful maintenance drift.
No performance, memory or user-visible feature improvement is claimed.

## Current behavior that must remain local

Both helpers create one native Promise, capture its native resolve/reject functions, attach an
ignored rejection handler, and return the **original** promise. The candidate used the video helper
verbatim as an exported internal function:

```ts
export function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    return { promise, resolve, reject };
}
```

The ignored catch prevents an early rejection being reported before the caller attaches a handler;
it does not change the original promise's value/reason. Returning the catch's child instead would
turn a rejection into fulfillment with undefined and alter reaction ordering. Do not add `async`,
wrapped resolver functions or extra jobs to this primitive. It does not decide the winning error,
state transitions, flushing, adapter ownership, or whether an operation is repeatable.

| Public behavior | Required distinction |
| --- | --- |
| `recorder.finished` | Stable result promise, available before start; observing it does not initiate capture or stopping |
| `recorder.start()` | One accepted start, settles from the native event; the public state remains idle while that event is pending |
| Pending `pause()` / `resume()` | Repeating the same pending action returns the same promise; the opposite action rejects without cancelling it; state changes synchronously in the matching event handler |
| `recorder.stop()` | Caches its own promise chaining pending start to stopping; this promise differs from `finished`, although both deliver the same result object |
| `video.finish()` | Caches the completion promise before reporting finalization; reentrant/repeated calls in finalizing/finished see the same object |
| Video failed/aborted/disposed calls | Keep their existing fresh rejection/state behavior; they must not be normalized to successful-finish caching |
| Errors | Recorder forwards the original native error; video cancellation forwards its reason and component failures retain their existing wrapper/cause. Cleanup and late work do not replace the primary outcome |

These policies are implemented in [index.ts](../../src/index.ts) and [video.ts](../../src/video.ts).
A common primitive could preserve them, but a common `finishOnce`/session helper would be a separate
design and is not justified by identical `deferred()` functions.

## Permanent characterization tests

Five tests were added using existing controller fixtures:

- [Recorder](../../test/recorder.test.mjs): stable `finished`/cached `stop`, distinct promise identity,
  stop requested during pending start, event-before-reaction ordering and last-chunk completion.
- Recorder: repeated pending pause/resume identity, conflict rejection, synchronous event state
  transitions and asynchronous reactions.
- Recorder: the same original error object reaches pending start, stop and finished, survives disposal
  and late native events, and preserves its cause and track cleanup.
- [Offline video](../../test/offline-video.test.mjs): reentrant finish from progress, cached identity,
  synchronous finalizing state, deferred flush, blocked-input rejection, finalize/progress/reaction order.
- Offline video: abort reason or encoder error/cause survives cleanup exceptions, repeated terminal
  calls, later failures and a delayed flush rejection; created adapters are disposed once.

Run all existing and new tests for these two controllers:

```sh
node --test test/recorder.test.mjs test/offline-video.test.mjs
# Only the five characterization tests:
node --test --test-name-pattern=deferred test/recorder.test.mjs test/offline-video.test.mjs
```

Results on Node 22.17.0: **41/41 controller tests pass**, including **5/5 new tests**, no skips.
These test observable public contracts, not the spelling/location of a private helper. Runtime
source and build files did not change, so unrelated codec/browser/package suites were not rerun.

## Isolated extraction experiment

Final local artifacts: `benchmark-results/deferred-evaluation-2026-11-06T08-50-58-302Z/`.
They include results.json, source/module hashes, candidate/baseline bundles, copied test harnesses,
TAP results and negative-control results. The local driver is
`benchmark-results/evaluate-deferred.mjs`; these experiment files are ignored, not shipped runtime.

The driver verifies the exact baseline and unchanged production files. It extracts both function
AST nodes, normalizes TypeScript without renaming identifiers, and confirms identical behavior text.
It then removes only the local declarations in memory, imports the candidate virtual module and
bundles both controllers with the same esbuild options. No source helper is installed in `src/`, no
real build configuration is edited, and `dist/` is not replaced by candidate files.

| Experiment | Result |
| --- | --- |
| Virtual candidate typecheck with the repository's TypeScript configuration | Pass |
| Ten emitted public declaration entries vs actual baseline declarations | Exact matches |
| Candidate standalone bundles | Pass, no external runtime imports |
| Same five controller tests with imports redirected to candidate bundles | 5/5 pass |
| Primitive checks for recorder helper, video helper and candidate | 15 groups pass, five groups per implementation |
| Strict early-rejection subprocess | Pass with `--unhandled-rejections=strict`, original rejection still observable |

The five primitive groups cover constructor promise/native resolver identity, synchronous resolution
with asynchronous FIFO reactions, thenable adoption and locked first settlement, exact rejection
identity (including undefined/null/false/zero/string/error), and rejection before caller attachment.
These are Node/fake-controller checks, not a claim that a candidate production migration has passed
all browser, installed-package or Next.js gates.

### Controls and bundle cost

The same public tests were also run against deliberately incorrect candidates:

| Negative control | Expected detection |
| --- | --- |
| Return the child from `promise.catch(() => {})` | 3 of 5 public tests fail: swallowed rejection and/or changed event/reaction ordering |
| Queue resolve/reject through an extra microtask | 1 of 5 public tests fails: recorder start/stop/checkpoint ordering changes |

Both controls compile and execute the five tests; a syntax/import failure is not counted as detection.
They are confined to local experiment bundles. The first comparison attempt used identifier
minification, which assigned different short names to equivalent code; normalization was corrected
to preserve names before drawing conclusions. A quoted CLI name filter initially selected zero tests;
the reported runs explicitly require five executed tests and use the unquoted filter above.

Controlled unminified esbuild output sizes:

| Entry | Local helper | Virtual shared helper | Source inputs before → after |
| --- | ---: | ---: | ---: |
| Recorder | 9,728 bytes | 9,749 bytes | 1 → 2 |
| Offline video | 24,665 bytes | 24,692 bytes | 2 → 3 |

These tiny byte differences include module headers/formatting and are not a performance result or
a comparison with published tarballs. Both candidate bundles contain their own inlined helper.
The important cost is the new recorder bundling requirement and additional module to maintain;
the byte counts alone are not the reason to defer.

## Scope and next step

Keep `deferred()` local in both controllers. Preserve the characterization tests and revisit this
decision when its conditions change. Any future actual extraction still requires the applicable
K1/K5/K6/K9/K10 packaging, error, order, ownership and browser checks; successful prototype checks
do not waive those gates. M3 paged-byte storage remains a separate future task. Public API,
package metadata and version remain unchanged by this evaluation.
