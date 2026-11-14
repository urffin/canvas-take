# Public WebP browser CI verification

Date: 2026-11-14. Package version: **0.7.0**, unchanged. Public WebP remains unreleased.

## CI coverage

The existing Ubuntu browser job runs `npm run test:webp:package:browser` before the general
video/GIF/APNG suite. The Next.js job now installs Chromium/Firefox and runs `npm run test:next:webp`:
the existing isolated tarball consumer and production build followed by real browser checks.
The four Node 22/24 × Ubuntu/Windows jobs are unchanged. Both browser engines are required;
no retries, skips or `continue-on-error` were introduced.

Both commands create a fresh package archive and install it outside the checkout. The dedicated
package check also validates strict consumer types, runtime imports, assets/notices and blocked
internal exports. Its version assertion compares the installed package with the checkout rather
than pinning the current version. Next.js tests the production Turbopack output through `next start`,
including emitted/default, package-entry and explicitly copied Worker/WASM paths, HTTP MIME and
notices. The existing public [verification report](webp-public-verification.md) describes the
underlying integration cases; this change makes them mandatory in CI.

After a real Worker accepts one frame, the test aborts with a specific Error. It requires the
same rejection object, no returned result and exactly `collecting → aborted` progress. It waits
for the Worker close event and an empty inventory before retrying. The retry must create one
fresh Worker and encode **70/90/2100 ms, one play, 2260 ms total**, distinct from the earlier input.
Both FFmpeg payload decoding/composition and native browser decoding check its output, alpha,
timing and plays. The retry bytes are saved separately. UI cancellation must remove the download;
the subsequent UI export, downloaded output and packaged example are checked as well.

## Failure evidence

The installed-package `browser-results` and separate `next-webp-results` artifacts retain the
command logs, result summaries, encoded WebP files and screenshots for seven days. Per-browser
failure JSON records the active phase, console/page errors, network URLs and observed Worker
counts. Next.js also saves its server log. The command log covers failures before browser launch
or build completion. Summaries start as `running` and only become `passed` after both engines finish.

The logged commands explicitly select `shell: bash`, which GitHub executes with `-e -o pipefail`;
this preserves an npm failure across `| tee`. This differs from the unspecified Linux shell's
default invocation. See [GitHub's shell documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
Artifact upload uses `!cancelled()` so a failed test still uploads available diagnostics.

Download/event waiters and the action triggering them are awaited together using `Promise.all`,
so a timeout is handled by the browser diagnostic catch rather than becoming an unhandled
rejection while a click remains pending. No timeout was increased to make an export pass.

## Local verification and limits

The [result snapshot](webp-ci-results.json) records both Chromium 156.0.8078.4 and Firefox 157.0:

| Consumer | Chromium | Firefox |
| --- | --- | --- |
| Installed tarball + packaged example | Passed, 9/9 Workers closed | Passed, 9/9 Workers closed |
| Production Next.js + copied example | Passed, 8/8 Workers closed | Passed, 8/8 Workers closed |

All four final inventories are empty: **34/34 observed Workers closed**. Each engine/consumer
passed the original cases, cancellation reason/progress checks and independently decoded
one-play 2260 ms retry. The full installed-package command passed, including a fresh tarball,
isolated offline install and strict consumer types. The Next.js command installed 24 packages
offline and passed its fresh production build; after changing preview synchronization, the
browser helper was rerun against that same installed tarball and production output. No runtime
or fixture source changed between the build and that final browser run.

Earlier local Firefox runs timed out on the HTML example navigation once and on download events
in both consumers. They reached successful exports with closed Workers and no page errors.
Minimal download probes with/without an animated preview passed. Both consumer checks now wait
for the preview's decoded dimensions before clicking Download, and await action/event together;
the final checks passed without internal retries or increased export/event timeouts. This is
evidence for the final test sequence, not proof of the earlier stalls' root cause or universal
Firefox stability. Earlier failure JSON/logs are retained in ignored local output; the final
`results.json` status and completion time identify the successful run.

An intentional broken-Worker probe in a separate copied distribution rejected as expected and
saved `failed` status, `export-1` phase, runtime request diagnostics and a failure screenshot.
It did not overwrite the positive consumer results. The workflow YAML was parsed and its
commands, browser installation and upload paths checked; the legacy Node matrix is unchanged.
A real Bash pipeline with an intentional exit code 23 returned 23 with `-o pipefail` and 0
without it. Syntax and whitespace checks passed, as did 88 local links in the edited guides.

These are local checks, separate from a GitHub Actions run: this implementation request did
not commit or push the workflow. Default Node tests were not repeated because runtime code
did not change; the previous 217-test baseline is recorded in the public verification report.

The previous [independent-decoder limitations](webp-worker-verification.md) remain applicable:
FFmpeg's ALPH discrepancy, native partial-alpha RGB rounding and Firefox short-hold clamping.
Worker close events and empty inventories do not establish immediate OS memory reclamation.
No public API, runtime implementation, dependency, package version, tag or release changes are
part of this CI stage.
