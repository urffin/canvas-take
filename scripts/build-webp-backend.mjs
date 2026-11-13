// Opt-in, pinned Windows-x64 reference build. Does not alter the production package build.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, output, tools, sha256, prepare } from './webp-libwebp/toolchain.mjs';
import { patchSingleFrame } from './webp-libwebp/single-frame-patch.mjs';

const provenance = await prepare(process.argv.includes('--prepare'));
const python = resolve(tools, 'python/python.exe'), compiler = resolve(tools, 'sdk/install/emscripten/emcc.py');
const node = resolve(tools, 'node/node-v22.17.0-win-x64/node.exe');
const config = resolve(output, 'emscripten-config.py');
const asPath = path => path.replaceAll('\\', '/');
await writeFile(config, `LLVM_ROOT = ${JSON.stringify(asPath(resolve(tools, 'sdk/install/bin')))}\nBINARYEN_ROOT = ${JSON.stringify(asPath(resolve(tools, 'sdk/install')))}\nNODE_JS = [${JSON.stringify(asPath(node))}]\nCACHE = ${JSON.stringify(asPath(resolve(output, 'emscripten-cache')))}\n`);
const env = { ...process.env, EM_CONFIG: config, EM_CACHE: resolve(output, 'emscripten-cache'), EMSDK_PYTHON: python, EMSDK_NODE: node,
    EMCC_CORES: '4', SOURCE_DATE_EPOCH: '1751241600', TZ: 'UTC' };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
env[pathKey] = [dirname(python), dirname(node), resolve(tools, 'sdk/install/bin'), env[pathKey]].join(';');
const emcc = args => execFileSync(python, [compiler, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
const versions = { emscripten: emcc(['--version']).split(/\r?\n/)[0], python: execFileSync(python, ['--version'], { encoding: 'utf8' }).trim(), node: execFileSync(node, ['--version'], { encoding: 'utf8' }).trim() };
assert.match(versions.emscripten, /4\.0\.20/); assert.equal(versions.node, 'v22.17.0'); assert.equal(versions.python, 'Python 3.13.3');
const exports = ['ct_malloc', 'ct_free', 'ct_open', 'ct_add', 'ct_finish', 'ct_close', 'ct_data', 'ct_size', 'ct_error', 'ct_version', 'ct_binding_abi', 'ct_profile',
    'ct_live_bytes', 'ct_live_allocations', 'ct_peak_bytes', 'ct_allocation_calls', 'ct_allocator_used', 'ct_fail_after', 'ct_reset_peak'].map(name => '_' + name);
const flags = ['-O2', '-std=c11', '-DNDEBUG', '-DCANVASTAKE_KEEP_ANIMATION=1', '-Dmalloc=ct_malloc', '-Dcalloc=ct_calloc', '-Drealloc=ct_realloc', '-Dfree=ct_free',
    '-include', 'tracking.h', '-I.', '-Ilibwebp-1.6.0', '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker,node', '-sFILESYSTEM=0',
    '-sSTRICT=1', '-sINCOMING_MODULE_JS_API=["wasmBinary"]', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=16777216', '-sMAXIMUM_MEMORY=268435456', '-sSTACK_SIZE=1048576', '-sABORTING_MALLOC=0',
    '-sEXPORTED_FUNCTIONS=' + JSON.stringify(exports), '-sEXPORTED_RUNTIME_METHODS=["HEAPU8"]', '-Wl,--strip-debug'];
const builds = [];
for (const name of ['build-a', 'build-b']) {
    const cwd = resolve(output, name); await mkdir(cwd, { recursive: true });
    // Re-extract pristine source for each build; no codec object files are reused.
    execFileSync('tar', ['-xf', resolve(tools, 'libwebp.tar.gz'), '-C', cwd], { timeout: 180000 });
    for (const file of ['backend.c', 'tracking.h']) await copyFile(resolve(root, 'scripts/webp-libwebp', file), resolve(cwd, file));
    const patches = [];
    for (const file of ['muxedit.c', 'anim_encode.c']) {
        const path = resolve(cwd, 'libwebp-1.6.0/src/mux', file), original = await readFile(path, 'utf8'), patched = patchSingleFrame(file, original);
        assert.throws(() => patchSingleFrame(file, patched));
        assert.throws(() => patchSingleFrame(file, original.replace(file === 'muxedit.c' ? 'if (num_frames == 1) {' : 'if (enc->out_frame_count == 1) {', 'if (0) {')));
        await writeFile(path, patched); patches.push({ file, originalSha256: sha256(original), patchedSha256: sha256(patched) });
    }
    const sources = [];
    for (const dir of ['src/dec', 'src/dsp', 'src/enc', 'src/mux', 'src/utils', 'sharpyuv']) {
        for (const file of (await readdir(resolve(cwd, 'libwebp-1.6.0', dir))).sort()) if (file.endsWith('.c')) sources.push('libwebp-1.6.0/' + dir + '/' + file);
    }
    const args = [...flags, ...sources, 'backend.c', '-o', 'backend.mjs'];
    console.log(name + ': compiling ' + sources.length + ' codec files');
    try { const log = execFileSync(python, [compiler, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 }); await writeFile(resolve(cwd, 'compile.log'), log); }
    catch (error) { await writeFile(resolve(cwd, 'compile.log'), error.stderr?.toString() ?? String(error)); throw new Error('Build failed; see ' + relative(root, resolve(cwd, 'compile.log'))); }
    const assets = [];
    for (const file of ['backend.mjs', 'backend.wasm']) { const bytes = await readFile(resolve(cwd, file)); assets.push({ file, bytes: bytes.length, sha256: sha256(bytes) }); }
    builds.push({ name, flags, sources, patches, assets });
}
assert.deepEqual(builds[0].assets, builds[1].assets, 'Two independent source builds must produce identical JS and WASM');
const licenses = resolve(output, 'licenses'); await mkdir(licenses, { recursive: true });
const notices = [];
for (const file of ['COPYING', 'PATENTS', 'AUTHORS']) {
    const bytes = await readFile(resolve(output, 'build-a/libwebp-1.6.0', file));
    await writeFile(resolve(licenses, file), bytes); notices.push({ file, sha256: sha256(bytes) });
}
const result = { date: new Date().toISOString(), host: { platform: process.platform, arch: process.arch }, versions, archives: provenance, builds, notices,
    reproducible: true, scope: 'Two independent source/object builds on Windows x64 using the same pinned toolchain; no cross-platform byte identity claim' };
await writeFile(resolve(output, 'build-results.json'), JSON.stringify(result, null, 2) + '\n');
console.log('Two identical JS/WASM builds verified; licenses and build manifest saved');
