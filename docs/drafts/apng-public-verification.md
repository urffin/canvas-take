# Public APNG entries: verification

Date: 2026-11-12. Baseline: `f1f732673df89ad18e6bd74e432b4d4b79733c4e`, the committed private
controller/backend/Worker integration. This report records local verification before commit/push.
The public API is implemented but unreleased; package/lock versions remain 0.6.1. The published
0.6.1 package is unchanged.

## Entry and compatibility boundaries

- `/apng`: `createApngExporter` and the eight controller/encoder types, re-exported from the existing
  controller without another async wrapper or state machine. Encoder selection remains required.
- `/apng/worker`: `createApngWorkerEncoder` and `ApngWorkerOptions`; calling-thread imports remain
  codec-free and safe during SSR/Node imports.
- `/apng/worker-runtime`: a standalone sibling module Worker asset with its source map, provenance,
  pristine sources, guarded transform and MIT/Zlib notices. Default Worker URL resolution now works
  from the public adapter's output directory.

No existing export key, declaration or runtime behavior is intentionally changed. Public aliases
preserve the existing snapshot, operation-admission, finish-Promise, terminal-reason and progress
contracts. Private build entries remain available for the existing contract/GC test harness; they
are not supported public import paths. There is no new synchronous supplied adapter or codec choice.

The [API guide](../apng-export.md), English/Russian README and standalone example now use public
package names. An import map connects those names to built assets in the unbundled HTML example.
Historical design, controller and backend reports retain their earlier evidence boundaries.

## Runtime bootstrap regression

The first public runtime wrapper used a bare import for initialization. esbuild correctly honored
the package's existing `sideEffects: false`, omitted that dependency and produced an empty runtime.
The installed-package browser check caught the resulting lack of acknowledgements. The runtime
now explicitly calls an internal `startApngWorker()` function. Both public/private runtime builds
and the test-only compression probe use that entry; no package-wide side-effect flag was relaxed.
A fast Node test executes the actual built Worker, requires its message handler and checks an
invalid-version error/close. Actual native Worker exports remain the integration gate.

## Checks

The public-entry tests exercise a custom third-party encoder, owned alpha snapshots, cached finish,
post-disposal Blob validity, absence from the root entry, SSR-safe imports and codec-free graphs.
The existing controller/transport/decode/GC suites continue to run.

The packed APNG consumer compiles strict public imports and negative type cases (required encoder,
numeric plays), resolves the public runtime asset in Node, and runs the existing actual
Chromium/Firefox matrix with installed public controller/adapter/runtime files. It independently
decodes captured RGBA and exact packet/frame timing, checks default/custom URLs and compression
cancellation, then retries. No test reaches into installed private modules.

The Next.js fixture imports the public package from an installed tarball in a real client component.
Its browser checks distinguish the default Next-emitted Worker, a package-entry `new URL(...)`, and
an explicitly copied Worker URL. They independently decode output, check cancellation and UI retry,
download/decode the three-frame UI file, serve licenses and smoke the import-map HTML example.
The normal Next CI build compiles this route; optional local `--apng-browser` checks exercise both
engines. These local results do not claim remote CI success for a later candidate SHA.

Final local results:

| Check | Result |
| --- | --- |
| `npm test` | Build and 164/164 tests pass, including three public-entry/bootstrap groups |
| Type compatibility | All eight public type shapes and create signature match the draft under strict TypeScript; missing encoder and string plays fail typed consumers as intended |
| `npm run test:package` | Public APNG imports/runtime resolution and the existing formats pass in the isolated installed consumer |
| `npm run test:apng:package` | Strict public typed/runtime consumer and eight actual Chromium/Firefox tests pass; installed runtime default/custom URLs, cancellation and retry checked |
| `npm run test:next -- --apng-browser --offline-install` | Complete pack/install, Next.js 16.3.0 production build and both-engine default/package/copied Worker verification pass in one invocation |
| Next native evidence | Eight independently decoded files / 30 frames, 14/14 Workers observed closed across the two engines |
| Existing compatibility | Ten old public declarations unchanged; 13 old public JS assets byte-identical to published 0.6.1; exactly three export keys added |
| Version/dependencies | Package/lockfile remain 0.6.1, lockfile and dependencies unchanged |

The first Next browser verification completed Chromium, then its path assertion rejected a
relative Worker URL reported by Firefox. The verifier now resolves against the page URL. The
corrected browser check first passed on the same installed production build without a runtime
change or skipped assertion. Before committing, the full Next command was then rerun successfully
with a fresh isolated install and production build, superseding the earlier split verification.

The [saved summary](apng-public-results.json) records checks and log hashes. Ignored evidence lives
under `benchmark-results/`: `apng-public-node-verified.log`, `apng-public-all-package.log`,
`apng-public-package-final.log`, `apng-public-next-complete.log` and
`apng-public-static.json`. Media/screenshots are under `apng-public-next/`. The full existing
86-case browser suite was not rerun in this slice: new public APNG browser/Next tests, all Node
contracts, existing packed consumers and byte-identical legacy JS establish the focused boundary.

Browser reads of root dist never overlap its rebuilds. Next browser checks use an isolated installed
production snapshot, so they cannot observe intermediate root tsc output.
Keep the existing maximum of two agent-opened browser tabs; these checks use one page at a time.

## Scope limits

The earlier full-frame SOURCE/BACKGROUND profile and independent-decoder/viewer limitations remain:
no certified OVER/PREVIOUS/rectangle optimization, no peak-RAM guarantee, and the observed Firefox
viewer rejection for unsigned-max plays. Production requires neither SharedArrayBuffer nor COOP/COEP;
only the instrumented compression test uses a shared flag. Exact file delays do not guarantee a
browser's display refresh timing.

Exact-candidate CI and publication are separate from this local snapshot. No version is published.
