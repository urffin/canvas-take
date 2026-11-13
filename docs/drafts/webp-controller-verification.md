# Private WebP controller: contract verification

Date: 2026-11-13. Implementation after design commit
`676f618677e01d5f42f7cdc00bb6eeaadd1f15c9`. See the [design](webp-export.md),
[draft declarations](webp-export-api.d.ts) and [acceptance gates](webp-export-compatibility.md).
This slice implements `src/internal/webp-controller.ts`, internal types and a RIFF envelope checker.
Package exports, public declarations, dependencies, build configuration and version **0.7.0** are
unchanged. The earlier [libwebp proof](webp-libwebp-backend.md) is separate evidence; this controller
does not yet connect to its WASM backend or implement the proposed Worker transport.

## Implemented behavior

- Acquire one synchronous injected encoder with frozen options and normalized limits. Check
  pre-abort before acquisition, preserve component error causes, dispose malformed/late instances
  defensively and release the owned encoder exactly once.
- Admit one operation at a time without a queue. Validate integer delays 1..16,777,215 ms,
  dimensions 1..16,383, fixed size and all input budgets before canvas readback. Request sRGB RGBA8,
  copy ordinary nonshared pixels synchronously before the first yield and hand off an exclusive,
  full-span snapshot. Transferring it cannot detach caller storage. Preserve alpha without mixing.
- Default limits: 4,194,304 pixels/frame, 1,000 frames, 2,147,483,647 ms, 64 MiB cumulative raw
  input and 32 MiB output. Configurable limits are integers 1..2,147,483,647 and inclusive. The active
  add reserves its budget; publish counters only after acknowledgement and a fresh activity check.
- Deliver fresh, shallow-frozen progress synchronously: collecting, finalizing and one terminal
  event. Frames/duration/raw bytes describe accepted inputs, independent of encoded packet count.
  `totalFrames` is a hint; unset optional keys stay absent. With no observer, allocate no progress
  snapshots. Ignore observer exceptions; guard reentrant abort/dispose before further work.
- Reserve and cache the original finish Promise before the finalizing observer. Copy ordinary
  nonshared Uint8Array output after enforcing its size limit, then validate the copy and produce
  an `image/webp` Blob. Successful results remain usable after disposal. Empty exports fail.
- Preserve the first terminal reason and exact local causes, including falsy primitives. Cancel
  scheduled work, detach external abort listeners, release owned references and ignore late
  settlements/cleanup errors. Observe unexpected cleanup thenables without awaiting them.

The envelope checker verifies RIFF/WEBP size, printable FourCCs, chunk bounds and zero padding,
VP8X profile/dimensions, ANIM order/plays, bounded ANMF rectangles/flags and positive delays with
the exact total duration. It requires image payload structure, matches metadata feature flags,
rejects static-only output and permits bounded unknown chunks. It yields after every 256 parsed
top-level/frame subchunks, checking cancellation before scheduling, on resumption and before success.

This is **not a bitstream decoder or a per-input presentation oracle**. A merged/split encoder may
return a different encoded frame count. Invalid pixel payloads or wrong holds preserving the total
can pass the envelope check; negative controls explicitly demonstrate both limits.

## Tests and resource evidence

`test/webp-controller.test.mjs` adds **28 test groups**. Its fixture bundles the emitted controller
into a VM with deterministic task scheduling, fake canvas readback and injected encoder barriers.
The test-only RIFF writer uses deliberately stubbed image payloads: its outputs are not evidence
of decodable WebP. A separate Buffer-based inspector checks holds and plays.

Coverage includes one/multiple frames, alpha handoff, exact 1/10/11/55/16,777,215 ms holds,
infinite/finite/max plays, `A:50,B:70,B:90,C:200` merging and uint24 splitting, signed duration
overflow, each inclusive budget boundary and first excess, pending admission, output cap/subviews,
missing/tainted/resized canvas, shared/detached/mistyped pixels/output and scheduler failures.
Twenty malformed-container controls exercise signature/length/truncation/trailing bytes, metadata,
ordering, frame bounds/flags/delays, padding and image subchunk failures.

Progress tests assert complete 55/2055 ms and 4/8 byte traces, hint behavior, lazy allocation,
reentrancy, overlap and finish identity. Cancellation covers pre-abort, factory acquisition,
dimensions/readback/copy, scheduled handoff, pending add/finish, observers and yielded validation.
Two 12-offset microtask sweeps check acknowledgement/commit and validation-resumption races with
zero residual timers. Tests retain first-reason identity, late success/rejection safety and cleanup
reentrancy. Three rounds of success/failure/disposal retain previous exporters while creating fresh
ones; listener/timer inventories and encoder-owned frame lists are empty after each terminal outcome.

The transfer probe actually detaches the owned snapshot with `structuredClone`; it creates no real
Worker. The separate `--expose-gc` child retains five exporters/backends after capture-yield abort,
pending-input abort, codec failure, pending-finish abort and success. WeakRefs to five 512×512 RGBA
snapshots, their buffers and caller canvas/readback objects clear within a finite GC probe while the
successful Blob remains usable. This establishes these reference-release cases, not RSS recovery,
native allocation behavior or a latency guarantee for arbitrary third-party encoders.

## Verification and remaining work

| Command/check | Result |
| --- | --- |
| `npm test` | Build and 192/192 Node tests passed, including all 28 new groups |
| `node node_modules/typescript/bin/tsc -p test/fixtures/webp-controller-types.json` | Strict/exactOptional types and function signature match the draft |
| `node node_modules/typescript/bin/tsc -p docs/drafts/tsconfig.webp.json` | Draft examples and four expected type errors pass |
| `npm run test:package` | Existing packed Node consumer and public type/runtime checks passed |
| Codec-free dependency graph and package resolution | Only controller/envelope runtime modules; `/webp`, `/webp/worker` and private subpath imports remain unexported |

Local logs are ignored under `benchmark-results/webp-controller-*.log`. Public sources, entry keys,
manifest/lock, build scripts and version remain unchanged. No browser/debugger, new CI run,
WASM rebuild, benchmark, independent decoder run, commit, push or publication was part of this slice.

The next separately authorized step is the supplied Worker adapter/runtime with ABI-tagged libwebp
integration and assets, protocol/resource fault tests and independent animation decoding. Native
merged uint24 splitting and lossy partial-alpha composition still need integration evidence.
Public entry points, installed WebP assets/Next checks and release remain later stages.
