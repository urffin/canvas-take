# Public WebP entries: package and Next.js verification

Date: 2026-11-13. Work after private-integration commit
`f0c629dbbe8a3535caa50c77cb3dc3cea122538d`. The repository now exposes public WebP entries;
**the version is still 0.7.0 and no new release/npm publication was made**. Published 0.7.0 does
not include these additions. See the [API guide](../webp-export.md), [example](../../examples/webp.html),
[saved observations](webp-public-results.json), [private Worker evidence](webp-worker-verification.md)
and [original contract](webp-export.md).

## Public surface and packaging

- `/webp`: `createWebpExporter` and nine controller/encoder types, including normalized limits.
- `/webp/worker`: `createWebpWorkerEncoder`, `WebpWorkerOptions`.
- `/webp/worker-runtime`: dedicated module Worker asset.
- `/webp/codec.wasm`: separate matching WASM asset.

The root/GIF/APNG/video entries are unchanged; internal controller/Worker subpaths remain blocked.
The controller still requires a caller-selected synchronous encoder factory. The supplied adapter
is optional. Controller and adapter imports do not import the codec and are Node/SSR safe. Acquiring
the supplied encoder without browser Worker support fails explicitly. The public name follows
`createApngExporter`; it delegates to the same validated controller implementation.

TypeScript declarations expose the existing runtime contracts. Strict/exactOptional checks compare
public/private/draft shapes and factory signatures. An isolated installed consumer checks all ten
public type names, positive factory/options usage and expected errors for missing encoder, string
plays/method and a private implementation import. The packed consumer resolves runtime/WASM assets,
checks their files plus all pinned loader/WASM/notice hashes, and exercises Node imports.

The immutable libwebp WASM and vendor bytes are unchanged. Public runtime JS includes a guarded
browser-only adaptation of the pinned Emscripten loader. It disables its Node-only environment
branch and removes Node builtin acquisition. Drift/reapplication guards fail the build; the
standalone runtime source map contains the modified loader, and the preferred transform is copied
to `webp-notices/browser-loader.mjs`. The pristine loader remains as `webp-codec.js` for audit. The
public runtime does not depend on it at execution time. All libwebp/Emscripten/libc/compiler-rt
notices and provenance are shipped; the normal build does not download or compile native code.

## Problems caught by installed/Next checks

| Trigger | Observed before correction | Change and verified behavior |
| --- | --- | --- |
| Building an asset from a bare side-effect import with package `sideEffects:false` | The startup import could be removed, leaving an empty Worker | Explicit named startup call, shared by public/private runtime builds |
| Turbopack emits the Worker runtime as a standalone URL asset | Its adjacent `webp-codec.js` import requested a missing `_next/static/media/webp-codec.js`; export failed | Inline the browser-only loader in public runtime JS; only WASM stays external |
| Static `new URL` rewritten to Turbopack's relative-URL shim | Init reached the runtime with a relative wasmUrl and failed `new URL` validation | Normalize dynamically against the acquisition-time browser base before posting init; SSR import still does no URL resolution or acquisition |

The URL-shim failure has a deterministic regression test. The loader transform is guarded against
source drift/reapplication, its modified source is present in the map, and the WASM bytes are
compared directly against the verified vendor binary. This does not alter codec settings, input
timeline/ownership policies, default budgets, progress or cancellation semantics.

## Installed tarball and browser example

`scripts/test-webp-package.mjs` builds a tarball, installs it offline into a separate temporary
project, checks public types/Node behavior/assets/notices, and optionally serves those installed
files and the packaged example for browser checks. The repository dist is not served as a substitute. The guide and EN/RU
README distinguish this unreleased repository surface from registry 0.7.0.

Chromium and Firefox each check normal export, one frame/plays 1, short delays/infinite plays and
independently relocated runtime/WASM. Every result is parsed and decoded independently by FFmpeg
payload/presentation checks and native ImageDecoder: alpha, holds, plays, dimensions, accepted
progress trace and cached finish identity. A cancelled export preserves its original local reason,
then a new export succeeds. The public example exports/downloads a 320×180 file, cancels while
clearing the old result, and exports again. Its native preview loads. All **9/9 observed Workers
per engine** close before browser shutdown; no unexpected page error is accepted.

## Installed Next.js production application

The existing Next fixture now includes a client `/webp` route with public imports, cancellation,
preview and download. The packed package is installed with the site's existing pins: Next 16.3.0,
React/react-dom 19.2.8. Production Turbopack compilation and static pre-render complete without
Worker/browser globals during SSR. The following real client modes are checked:

1. Default adapter URLs emitted by the bundler.
2. Explicit package-runtime and WASM URLs via the new asset export paths.
3. Runtime/WASM/notices copied to the application's `public/canvastake-webp` directory.

Both browsers independently decode all modes. Worker URLs for emitted/package modes start with
`/_next/`; copied mode uses the expected public path. Emitted and copied WASM requests are present,
and a fresh HTTP GET checks 200 plus `application/wasm` for each distinct asset URL. Network-level
304 cache responses are recorded separately rather than treated as failed export. Firefox can
report a relative Worker target URL; the verifier resolves that metadata against the page URL.

The client checks signal cancellation after admission, successful retry, UI cancellation with no
stale download, a decoded UI download and the copied static example. Copied notices/manifest are
HTTP-accessible. All **8/8 observed Workers per engine** close and final inventories are empty.
No global cache is cleared and no user browser profile/tab is attached.

## Commands, results and scope

```sh
npm test
npm run test:package
npm run test:webp:package -- --browser
npm run test:next -- --offline-install --webp-browser
```

The browser flags are opt-in; default Node checks/builds do not start external browsers. These
Chromium/Firefox launches were explicitly authorized for installed-package/Next verification
after another built-in-browser startup failure. Fresh browser profiles ran sequentially with
one agent-owned page at a time and were closed, as were test HTTP/Next servers.

Build + **217/217 Node tests** passed, including existing recording/video/GIF/APNG and WebP
protocol/native/resource cases. The full packed consumer, dedicated public consumer/types and
Next/browser checks passed. Temporary Next output was retained under the OS temp directory for
review; media/raw logs/results are ignored under `benchmark-results/webp-public-*`.

The earlier generic Firefox failure from private testing remains a dated observation, not a
claimed fix; the public package and Next runs here passed without success-masking retries or
longer request timeouts. The separate independent-decoder limits (FFmpeg ALPH discrepancy, native
partial-alpha RGB rounding, Firefox short-delay clamping) remain documented. These local checks
are not a new CI run or a promise covering all bundlers/browser versions. No commit, push, version
bump, tag, GitHub Release or npm publication was part of this implementation request.
