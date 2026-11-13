# Private libwebp build

libwebp 1.6.0 (BSD-3-Clause), with CanvasTake's animation-retention source guards and
ABI 1 / libwebp-batch-animation-v1 binding. Emscripten 4.0.20 runtime (MIT/NCSA);
linked libc/compiler support notices are in MUSL-COPYRIGHT.txt and COMPILER-RT-LICENSE.txt.
The SDK's dlmalloc 2.8.6 by Doug Lea is public-domain/CC0. Retain COPYING, PATENTS,
AUTHORS, EMSCRIPTEN-LICENSE.txt, MUSL-COPYRIGHT.txt and COMPILER-RT-LICENSE.txt with assets.

Reproduce from the pinned archives with node scripts/build-webp-backend.mjs --prepare,
then node scripts/stage-webp-backend.mjs. Existing tools: omit --prepare.
Two source/object builds must be byte-identical before staging. manifest.json records
archive hashes, flags, patches, binding hashes and every staged asset/notice hash.
This is same-host Windows x64 reproducibility, not a cross-platform build claim.
Preferred binding and patch sources: scripts/webp-libwebp/backend.c, tracking.h and
single-frame-patch.mjs in https://github.com/urffin/canvas-take . Runtime codec selection
stays inside the Worker. Native allocation accounting is retained for verification.

No public WebP entry point or new package version is introduced.
