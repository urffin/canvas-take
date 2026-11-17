# Public external video design: verification record

Design verified: 2026-11-16; pre-commit type checks repeated: 2026-11-17.
Baseline: `efc5f66f8d03168a7f99945ccb4f2d1f2062a25c`, version 0.8.1.
This checks a proposed API, not a runtime implementation or released feature.

The [declarations](external-video-public-api.d.ts), [usage example](external-video-public-example.ts)
and [type fixtures](external-video-public-types.ts) pass TypeScript 6 with strict checking,
exactOptionalPropertyTypes, noUncheckedIndexedAccess and skipLibCheck disabled. The
[checked-in config](external-video-public-tsconfig.json) sets noEmit: no JavaScript or public
declarations are generated. Canonical existing contracts are imported from the current package.

The fixtures check legacy Blob use, external handle/id inference, exact MP4/WebM MIME/extension,
correlated result unions, synchronous construction and ready/closed types. Expected type errors
cover missing/wrong destination, mixing Blob/external muxers and results, invalid overwrite/mode,
read-only metadata, uncertain publication narrowing, missing release/value, signalling commit and
granting publication/cleanup access to a muxer. Null/false/undefined committed values remain valid
when their explicit generic type allows them. Unused @ts-expect-error directives fail the check.

Reproduce from the repository root after installing its existing development dependencies/build:

```sh
node node_modules/typescript/bin/tsc -p docs/drafts/external-video-public-tsconfig.json
```

The implementation boundary was checked against the baseline: runtime source, scripts, tests,
dependencies, exports, version and CI configuration remain unchanged. All 14 existing public
entry-point declarations still match the baseline. The 29 expected negative type cases,
27 relative document links and documentation-only diff were checked.

The [P1–P28 criteria](external-video-public-compatibility.md) record future runtime acceptance
tests. In particular, commit admission winning over later cancellation, transactional no-replace,
indeterminate publication, late acquisition and physical cleanup fences are **not implemented or
runtime-verified** by these declarations. The older receiver prototype has a different commit
cancellation policy. Existing repository CI checks regressions in the unchanged package; it does
not validate this proposed lifecycle. New media/installed/Next acceptance tests remain gates for
subsequent implementation.
