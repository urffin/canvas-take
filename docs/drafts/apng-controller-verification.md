# Private APNG controller: contract verification

Date: 2026-11-12. Local implementation after the separate `0.6.1` release
(`b9bb4d9e662208a8b77c8bf5025371b17669e02d`). This slice implements the controller in
`src/internal/apng-controller.ts`, with internal types and a container-envelope validator.
It does not add `/apng`, install a codec, integrate the production Worker backend or change the
package version. See the [design](apng-export.md), [acceptance gates](apng-export-compatibility.md)
and the earlier, separately verified [backend spike](apng-backend-spike.md).

## Implemented behavior

- Require a synchronous injected encoder factory; snapshot/validate options and pre-abort before
  acquisition. Supply an owned AbortSignal and frozen factory options/context. Acquire one encoder
  and dispose it once, including reentrant factory cancellation and malformed partial instances.
- Admit one operation at a time. Validate delay, dimensions, fixed size and inclusive pixel/frame/
  duration/raw-byte limits before readback. Capture an owned straight-alpha RGBA snapshot using
  explicit sRGB readback before yielding. Transferring that snapshot cannot detach caller storage.
- Commit accepted frame/duration/byte counters after encoder acknowledgement and an activity check.
  Progress is synchronous, fresh, shallow frozen and lazy without an observer. Optional fields stay
  absent when unset. Observers may throw, reenter, abort or dispose without replacing primary errors.
- Cache the original finish promise before invoking an observer. Preserve its identity during
  finalization and after success. A successful Blob remains usable after disposal, while new calls
  after disposal reject. An empty export fails without producing a static PNG.
- Reject empty/shared/non-byte output and enforce the output budget before copying. Own a copy
  before yielding, then check PNG signature, bounds, IHDR profile/dimensions, animation count/plays,
  exact rational delays, frame bounds, chunk sequence, all chunk CRCs and complete IEND. Yield after
  every 65,536 scanned type/payload bytes. This validates the envelope, not decompressed image pixels.
- Preserve the first terminal reason. Factory/add/finish errors retain their exact cause, including
  `undefined`, null and falsy primitives. Cancellation uses the supplied reason with a nullish
  AbortError fallback. Remove external listeners, cancel scheduled tasks, clear controller references
  and release the encoder. Ignore late successes/rejections and cleanup exceptions.

The 64 MiB default input limit counts cumulative accepted and pending raw RGBA, not peak memory.
Encoder scratch, compressed output, the controller's output copy and Blob storage are additional.
The synchronous canvas readback/copy and a synchronous custom codec remain non-preemptible. A real
batch encoder must release its own retained inputs in `dispose`; the controller cannot free a
third-party backend's references by itself.

## Tests and findings

`test/apng-controller.test.mjs` adds **34 test groups**. Its fixture compiles the actual emitted
controller into a controlled VM and injects fake canvases/encoders and a deterministic timer queue.
A small test-only APNG writer uses Node zlib and a separate bitwise CRC implementation; no compressor
is added to production controller code. Tests cover one/multiple frames, alpha handoff, exact delays
including 1/65,535 ms, finite/infinite/max plays, equivalent delay fractions, limits at and above each
boundary, invalid readback, overlap, progress tuples, reentrancy and finish identity. Mutated metadata,
sequence, bounds, chunk/payload CRCs and incomplete/static-only output must fail.

Additional tests cover invalid asynchronous factories, transfer, late replies, listener removal,
output-buffer mutation during yielded validation and error-cause identity. Async factories remain
unsupported; observing and disposing a late result is defensive cleanup, not asynchronous acquisition.
The eight internal type shapes and create-function signature are checked against the draft with
strict TypeScript compilation. Importing the controller requires no browser globals or codec, and
bundling its graph yields only its private APNG modules. Public `/apng` resolution still fails.

Two controlled regressions failed before the final activity checks and pass afterwards:

| Controlled boundary | Observed before correction | Correction and verified result |
| --- | --- | --- |
| Encoder acknowledgement to outer continuation | Abort at microtask offset 2 was followed by `collecting` | Recheck before counter commit and before success; sweep 13 offsets for add and finish, with no post-abort progress or successful Blob after committed cancellation |
| CRC checkpoint to validator continuation | Abort at offset 2 left one newly scheduled timer after cleanup | Recheck on validator resume and before scheduling; sweep 13 offsets with zero pending tasks after cancellation |

The sweeps are explicit Promise continuations, not elapsed-time sleeps. They test delivered
cancellation and first-terminal-wins behavior; they do not establish a universal cancellation latency.

The separate `--expose-gc` fixture retains **five controllers and backend handles**, plus the successful
Blob, through yield-abort, input-abort, encoder failure, finish-abort and success. WeakRefs to owned
RGBA arrays/backing buffers and caller canvas/readback objects become unreachable within the bounded
GC experiment. During development, a preserved error stack retained the invocation's input closures;
clearing the owned snapshot and canvas parameter in `finally` fixed this without replacing the
original error/cause. Caller storage remains usable before its test-owned reference is dropped.
This is finite V8 reference-release evidence, not a physical-RAM or native-worker leak guarantee.

## Controller-only verification snapshot

| Command/check | Result |
| --- | --- |
| `npm test` | Build succeeds; 153/153 Node tests pass: 119 existing and 34 new APNG groups |
| `npm run test:package` | Rebuild, pack, isolated install, runtime imports and typed consumer pass |
| Public declaration comparison | All ten emitted public declaration files match the released `v0.6.1` source baseline |
| Metadata/build boundary | Package/lockfile, exports, dependencies, existing runtime sources, adapter build and CI workflows unchanged; version remains 0.6.1 |
| Documentation | Relative links and `git diff --check` pass |

Local logs are ignored under `benchmark-results/`: `apng-controller-node-verified.log`,
`apng-controller-package-verified.log`, `apng-controller-ordering-before.log` and
`apng-controller-ordering-after.log`. The released commit has its own successful
[six-job CI run](https://github.com/urffin/canvas-take/actions/runs/43172720409). The table records local
controller-only verification before commit/push, not a remote CI result for the APNG implementation.

## Remaining acceptance

This closes the private controller/fake-adapter slice of A1 and controller portions of A2–A7.
The later [Worker integration report](apng-integration-verification.md) adds actual canvas/Worker
exports, independent decoding and private packed/Next deployment. Those checks have separate
evidence and do not change this earlier controller-only snapshot or the historical spike results.
Public APNG entries and their typed/packed/bundler acceptance remain pending. Keep this development
separate from the already published 0.6.1 release.
