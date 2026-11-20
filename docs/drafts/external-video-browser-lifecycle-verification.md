# Browser result lifecycle: design verification

Date: 2026-11-20. Baseline `423b758fa36813fc53dd8745e6f27d74c607fd4e`, version0.8.1.
See [project](external-video-browser-lifecycle.md), [draft types](external-video-browser-lifecycle.d.ts),
[B1–B32 gates](external-video-browser-lifecycle-compatibility.md) and
[machine-readable record](external-video-browser-lifecycle-results.json).

This is the historical design-stage record. The subsequent
[managed-store verification](external-video-browser-managed-verification.md) documents the private
algorithm, reused types and controlled B1–B28 proofs; native browser implementation remains pending.

## What this change verifies

- Strict noEmit compilation includes all previous external/public/controller/destination/file/browser
  fixtures and the new lifecycle fixture. **95 expected negative cases: 62 previous +33 new**.
  Each expected-error call must fail for compilation to pass; unused directives are errors.
- Positive examples compose the managed reference destination with the actual private MP4 controller,
  preserve its generic result, and assign the recovery service to the earlier companion interface.
  File access/release, prepared button request/disposal, hold release before deletion and historical
  recovery all compile. These examples are not executed or packaged as a runtime entry point.
- Baseline runtime sources, build scripts, tests, workflows, metadata, dependencies, lockfile,
  exports and version remain byte-identical in Git. All14 public declarations match the baseline.
- Build and installed tarball consumer are checked. New project/type/criteria/record files are
  documentation under the existing packed docs/drafts directory. Existing private-path import
  guards remain in force; no managed result factory, public declaration or JS entry is emitted.
- Local Markdown links, B1–B32 uniqueness/coverage, strict configuration and changed-file boundaries
  are checked. The results record stores hashes of the authored inputs except itself.

Commands:

```sh
npm run build
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-browser-lifecycle-tsconfig.json
npm run test:package
```

## What remains implementation work

No v2 OPFS, hold, read lease, download helper, deletion, fencing or restart behavior is implemented
or tested at runtime by this change. B1–B32 describe required future observable behavior; draft type
checks cannot prove storage ordering, lock ownership, physical quiescence or download success.
No managed-v2 browser or Next.js execution, memory measurement, native user-folder support or
release is claimed by this design-stage evidence. Commit/push and existing CI regression checks
are separate delivery steps; they do not certify the proposed lifecycle at runtime.

Historical baseline evidence is separate: v1 has391 passing Node tests,128 local browser cases,
84 independently decoded MP4/WebM files and
[successful existing CI6/6](https://github.com/urffin/canvas-take/actions/runs/44643680664).
Its local OPFS browser runner was not included in that CI's browser jobs. Runtime code is unchanged,
so those tests are not rerun or relabelled as proof of the proposed lifecycle.

The next separately authorized task should implement the managed profile privately with controlled
storage/lock adapters and prove retention/deletion/fencing under faults and races. Real-browser
storage/decode/download and bounded CI follow as needed; public package/Next P27/P28 remains gated.
The roadmap stays outside the repository; this file records the current design verification only.
