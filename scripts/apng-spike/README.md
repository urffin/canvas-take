# APNG backend feasibility spike

Experimental tools only; none is imported by `src`, the build or the default test suite. They do not
implement the draft public controller or add a package entry/dependency. See the
[report](../../docs/drafts/apng-backend-spike.md) and [design](../../docs/drafts/apng-export.md).

From the repository root, with existing development dependencies and Playwright Chromium/Firefox:

```sh
node scripts/check-apng-backend.mjs
node scripts/apng-spike/save-report.mjs
```

The first command verifies source/license hashes, builds private bundles, independently decodes the
matrix with existing FFmpeg, validates negative controls/input failures, interrupts actual Workers
and retries on the same browser page. It uses one isolated page at a time and touches no user tabs.
It fails instead of silently skipping an unavailable browser/decoder. `--node-only` is a focused
debug command; its separate result is not accepted by `save-report.mjs` as full browser evidence.

On the first run `prepare.mjs` fetches five hash-pinned files from the upstream repositories, including
license notices, into ignored `benchmark-results/apng-backend-spike/vendor`. Later runs use that
verified cache; altered cached/downloaded bytes fail. No `npm install` or manifest/lock changes.
Pristine sources, the transformed UPNG source, generated bundles/maps, APNG files and JSON results
remain under that ignored directory. Versioned tools store no copied codec implementation.

`upng-patch.mjs` has three exact-match edits for the pinned source: nonempty input always animates;
full-frame encoding uses actual deflate rather than level-0 storage; optional window/UZIP selection
is replaced by the explicitly pinned Pako implementation. Guard checks reject drift/reapplication.
`prepare.mjs` adds an experiment-only probe at the first real `Pako.Deflate.onData` callback and
clears its atomic flag when deflate returns. The flag proves the synchronous compression call is
active at cancellation, after it has produced data; no artificial blocking gate keeps it running.

`oracle.mjs` contains an independent structural/CRC reader and invokes FFmpeg. It never calls UPNG
decode. Full-frame SOURCE/BACKGROUND is a required candidate profile. Arbitrary optimized rectangles
and OVER/PREVIOUS behavior are not certified by this experiment. Cancellation measurements are a
small diagnostic sample, not a benchmark threshold or an immediate physical-memory-release claim.

`save-report.mjs` only freezes a successful full run matching the present generated backend/hash
and unchanged production/package files. It records all fixture/decoder/cancellation results and
the experimental harness source hashes. Rerunning it intentionally replaces the saved local report;
do not use it to mask a failed run or to regenerate production compatibility expectations.
