// Explicit reference-build staging; never downloads or invokes a compiler implicitly.
import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, output, tools, sha256 } from './webp-libwebp/toolchain.mjs';
const build = JSON.parse(await readFile(resolve(output, 'build-results.json'), 'utf8'));
assert.equal(build.reproducible, true); assert.deepEqual(build.builds[0].assets, build.builds[1].assets);
for (const entry of build.builds) {
    for (const asset of entry.assets) assert.equal(sha256(await readFile(resolve(output, entry.name, asset.file))), asset.sha256);
    for (const name of ['backend.c', 'tracking.h']) assert.equal(sha256(await readFile(resolve(output, entry.name, name))), sha256(await readFile(resolve(root, 'scripts/webp-libwebp', name))));
}
const source = resolve(output, 'build-a'), dest = resolve(root, 'vendor/webp'); await mkdir(dest, { recursive: true });
const factoryPath = resolve(source, 'backend.mjs');
const { default: factory } = await import((await import('node:url')).pathToFileURL(factoryPath));
const module = await factory({ wasmBinary: await readFile(resolve(source, 'backend.wasm')) });
assert.equal(module._ct_binding_abi(), 1); assert.equal(module._ct_profile(), 1); assert.equal(module._ct_version(), 0x010600);
const files = [];
for (const [from, name] of [[factoryPath, 'webp-codec.js'], [resolve(source, 'backend.wasm'), 'webp-codec.wasm'],
    ...['COPYING', 'PATENTS', 'AUTHORS'].map(name => [resolve(output, 'licenses', name), name]),
    [resolve(tools, 'sdk/install/emscripten/LICENSE'), 'EMSCRIPTEN-LICENSE.txt'],
    [resolve(tools, 'sdk/install/emscripten/system/lib/libc/musl/COPYRIGHT'), 'MUSL-COPYRIGHT.txt'],
    [resolve(tools, 'sdk/install/emscripten/system/lib/compiler-rt/LICENSE.TXT'), 'COMPILER-RT-LICENSE.txt']]) {
    const bytes = await readFile(from); await copyFile(from, resolve(dest, name)); files.push({ file: name, bytes: bytes.length, sha256: sha256(bytes) });
}
const manifest = { bindingAbi: 1, profile: 'libwebp-batch-animation-v1', codecVersion: '1.6.0', reproducible: build.reproducible,
    versions: build.versions, archives: build.archives, flags: build.builds[0].flags, patches: build.builds[0].patches,
    bindingSources: await Promise.all(['backend.c', 'tracking.h'].map(async file => ({ file, sha256: sha256(await readFile(resolve(root, 'scripts/webp-libwebp', file))) }))), files };
await writeFile(resolve(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(resolve(dest, 'PROVENANCE.md'), `# Private libwebp build\n\nlibwebp 1.6.0 (BSD-3-Clause), with CanvasTake's animation-retention source guards and\nABI 1 / libwebp-batch-animation-v1 binding. Emscripten 4.0.20 runtime (MIT/NCSA);\nlinked libc/compiler support notices are in MUSL-COPYRIGHT.txt and COMPILER-RT-LICENSE.txt.\nThe SDK's dlmalloc 2.8.6 by Doug Lea is public-domain/CC0. Retain COPYING, PATENTS,\nAUTHORS, EMSCRIPTEN-LICENSE.txt, MUSL-COPYRIGHT.txt and COMPILER-RT-LICENSE.txt with assets.\n\nReproduce from the pinned archives with node scripts/build-webp-backend.mjs --prepare,\nthen node scripts/stage-webp-backend.mjs. Existing tools: omit --prepare.\nTwo source/object builds must be byte-identical before staging. manifest.json records\narchive hashes, flags, patches, binding hashes and every staged asset/notice hash.\nThis is same-host Windows x64 reproducibility, not a cross-platform build claim.\nPreferred binding and patch sources: scripts/webp-libwebp/backend.c, tracking.h and\nsingle-frame-patch.mjs in https://github.com/urffin/canvas-take . Runtime codec selection\nstays inside the Worker. Native allocation accounting is retained for verification.\n\nNo public WebP entry point or new package version is introduced.\n`);
console.log('Staged verified ABI/profile-tagged JS/WASM and notices in vendor/webp');
