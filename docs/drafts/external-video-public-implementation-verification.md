# Public external video export verification

Implementation against `1103c4e`, verified locally on Windows with Node 22.17.0. The package
under test was the local `@grundyjs/canvas-take@0.8.1` tarball.

## Public entry points

- `/video` exports the external controller and its contracts for application-provided destinations.
- `/video/mp4` and `/video/webm` accept `{output: 'external'}` for positioned output. The same
  factories without options continue to return the Blob muxers, including through `ReturnType`.
  Both modes load the shared Mediabunny build on demand, so importing the factories during SSR
  does not initialize the vendor module.
- `/video/browser` opens the managed OPFS catalogue. Importing this entry on a server is safe.
- `/video/node` provisions a controlled local directory. The package makes this entry available
  through the `node` export condition. The standalone browser bundle rejects this import.

The [package guide](../external-video.md) covers commit and recovery, `File` leases, holds,
download, deletion and the same-origin AAC Worker URL for Next.js.

## P27 and P28 checks

`npm run build` and all 454 Node tests passed. The declaration checks cover the five public entry
points, existing Blob calls, custom destinations and invalid calls. `npm run test:package` passed
against an installed tarball, including documentation, source maps, licenses, runtime imports,
Node positioned writes, publication and recovery.

Run `npm run test:next:video` for the two browser consumers. The script builds an
independent browser bundle and a production Next.js application from the same installed tarball.
The server-rendered route imports both platform adapters, renders a marker and serves an AAC Worker
whose bytes must match the installed asset. Each browser exercise cancels after a positioned write,
checks that staging was removed and no result selected, repeats the export, closes and reopens the
catalogue, acquires and releases a `File` lease, and decodes the result with FFmpeg. Container and
PCM checks cover the final frame duration, timestamps, exact presented audio sample count and
sample-aligned audio. Raw results and the production server log go to
`benchmark-results/video-public-next/`.

GitHub Actions runs the same command in the `public-video-next` job. The
`public-video-next-results` artifact includes the console log, results JSON, Next.js server log
and media files produced before the run ended.

Chromium 156.0.8078.4 and Firefox 157.0 passed all eight cases. Each independently decoded
file presented three frames across 1,000,021 µs and 48,001 audio samples at 48 kHz. Audio lag
was zero samples in the first and last measured windows. The minimum correlation and file sizes
matched across the standalone and Next.js consumers for each browser and format.

| Browser | Container | Bytes per file | Minimum audio correlation |
| --- | --- | ---: | ---: |
| Chromium | MP4 with H.264/AAC | 18,302 | 0.988655 |
| Chromium | WebM with VP8/Opus | 18,882 | 0.988178 |
| Firefox | MP4 with H.264/AAC | 18,492 | 0.988655 |
| Firefox | WebM with VP8/Opus | 17,730 | 0.986758 |

Each MP4 consumer started and terminated one AAC Worker for the cancelled attempt and one for
the successful retry. Next.js returned HTTP 200 for the SSR route and the installed Worker asset.
The browser console and production server log contained no duplicate Mediabunny warning.

The local Next.js production run reused an installed dependency closure for Next 16.3.0 and React
19.2.8 after a registry cache miss in the fresh install. CanvasTake in that consumer came from the
tarball with SHA-1 `fa0b3fb50e1b2775ed9d81a85cf7c7cee0fe72c6`. The subsequent guide-only edit
removed links to draft documents outside the archive.
