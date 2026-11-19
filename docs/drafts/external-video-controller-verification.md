# Private external video controller: P1–P23 verification

Date: 2026-11-17. Baseline: `984cf580a483dec48cde41af835ac22b15c99a59`, version 0.8.1.
Implementation: `src/internal/video-external.ts` and `video-external-types.ts`.
These are private modules, not package entry points. The [public proposal](external-video-public-api.md)
and [P1–P28 criteria](external-video-public-compatibility.md) remain the contract reference.
No real MP4/WebM backend is connected in this stage and no public API/version is added.
The subsequent [real-container stage](external-video-containers-verification.md) connects
private MP4/WebM adapters and records actual-file/browser/decoder checks separately.

## Structure

The existing Blob controller in `src/video.ts` is unchanged. The private implementation retains
its validation, frame snapshot/compositing, codec-event protocol and PCM/timeline algorithms in an
isolated module. This temporary duplication avoids changing legacy lifecycle/Promise behavior while
proving the new ownership rules. It imports the existing pure RGBA helper; it introduces no shared
export lifecycle abstraction. Any later extraction needs its own compatibility evidence.

The new controller returns a synchronous frozen handle with stable ready/closed Promises. All
support checks run before acquisition. Acquisition results are registered even after cancellation;
late disposable resources are closed once and the lifetime fence observes that cleanup. Factories
remain responsible for resources never returned after their own construction failure.

Managed positioned writes own a base-Uint8Array copy before yielding, including exact subviews.
Detached/shared views reject; slice/species overrides cannot return aliases. One admitted write
drains readiness/physical completion; a logical abort can reject earlier, while closed still waits.
Closing admission after muxer finalize lets already accepted writes drain, then seals and validates
size/MIME/timeline before truncate and the last cancellation guard. Ignored write rejections are
internally observed and still fail the session without unhandled Promise rejections.

Commit admission changes the owner to non-cancellable publication and invokes commit in the same
turn. The destination work signal is separate from codec cancellation. Committed/not-committed/
indeterminate results follow the proposal, including false/null/undefined values. Untrusted result
fields are read before changing conservative publication classification; throwing getters cannot
accidentally select destructive abort. Session-owned writer objects are not accepted as result values.

Cleanup disposes codec/muxer resources before waiting, so disposal can unblock pending operations.
It then drains tracked operations/late acquisitions, aborts only known-uncommitted staging and
releases the destination with the owner's publication classification. Secondary issues are frozen
in closed, which never rejects. Committed values survive disposal/cleanup errors. A never-settling
or secretly untracked backend cannot be forcibly cleaned up; the fence does not promise that.

## Evidence and boundaries

The controlled tests are in `test/video-external.test.mjs` and `test/fixtures/video-external.mjs`.
The fixture uses private byte arrays and a shared in-memory namespace. Its publication operation
models atomic no-replace or explicit whole-value replacement. These bytes are deliberately test
container bytes, not playable MP4/WebM files. No filesystem atomicity, crash durability, native codec
behavior or independent decoding is claimed by this stage.

| Criteria | Controlled evidence |
| --- | --- |
| P1–P3 | Old Blob code/public declarations unchanged; internal package paths blocked; Blob/plain/invalid-mode factories rejected; concrete MP4/WebM/value types match the proposal |
| P4–P6 | Pre-abort including null/0, invalid input with no acquisition, asynchronous initialization after handle return, all support checks before writer creation, unsupported/malformed responses |
| P7–P8 | Gated late destination/muxer/video/audio acquisition; prompt ready rejection, delayed closed; single disposal, malformed/reused instances, responsible factory cleanup and caller-owned handles |
| P9–P11 | Frame/PCM/subview snapshots, overridden slice, shared/detached views, safe bounds, rewrites/empty writes, short/zero-progress fixture I/O, pressure and late/overlapping write rejection |
| P12 | Abort during ready/write/truncate with exact null/0/Error reasons; physical-operation fence before destination abort/release |
| P13–P14 | Shared-namespace collision/intervening creator, private replacement until commit, complete new extent and preservation of the previous value on abort/failure/refusal; native platform capability proof remains pending |
| P15 | Missing end, bad packet/timeline/MIME/size, finalize/truncate/write error, outstanding accepted writes; none can publish |
| P16–P17 | Final pre-commit cancellation, gated commit and synchronous observer cancellation/dispose; committed caller value remains usable, unfrozen and unclosed |
| P18–P20 | Exact refusal cause, abort/release failures, uncertain/thrown/malformed/getter outcomes, no destructive unknown rollback, post-publication cleanup issues |
| P21–P22 | Physical/late-acquire/dispose/abort/release fences, stable accepted finish/ready/closed, early/concurrent invalid calls without cancelling accepted work |
| P23 | Variable intervals/final hold, controlled audio priming/padding and exact sample counts, packet/payload counters, outputPhase cutoff and finished/outputBytes only after commit |

Type compatibility checks use [the private type fixture](external-video-controller-types.ts) and
[strict/noEmit config](external-video-controller-tsconfig.json). The private constructor is
assignable to the proposed declaration and vice versa. Positive value/MIME/extension inference and
negative public import/Blob/in-place/result-access cases are checked against emitted declarations.

Local verification completed:

- **71/71** focused controlled groups and **326/326** total Node tests passed (255 existing + 71 new),
  with no skips. Build passed.
- Strict/noEmit type checking passed, including 29 proposal and five implementation negative cases.
  Constructor/type assignments work in both directions between the proposal and implementation.
- All **14** existing public declarations match the baseline. The public `/video` runtime still
  exports only `createOfflineVideoExporter`; no external constructor is exposed there.
- Installed tarball types/imports/assets and five current package documents passed. Importing
  `/internal/video-external.js` or `/internal/video-external-types.js` through the package is blocked.
- Dependencies, exports, existing default values, old Blob source and version **0.8.1** are unchanged.
  One development test command and the installed-private-path guard were added.

The [compact results](external-video-controller-results.json) contain case names, source/test hashes
and the gate/coverage boundary. Raw logs live under ignored `benchmark-results/external-controller-*.log`.

```sh
npm run test:video:external
npm test
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-controller-tsconfig.json
npm run test:package
```

The next separately authorized stage is real destination-capable MP4/WebM integration, independent
decode and actual storage-policy/resource checks (P24–P26 and the platform portions of P13/P14),
followed by public entry points and installed/Next gates P27/P28. This private controller does not
implement the proposed public factory overloads, file picker or concrete storage adapter.
