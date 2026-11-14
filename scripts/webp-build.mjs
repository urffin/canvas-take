import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {browserWebpLoader} from './webp-browser-loader.mjs';
export async function buildPrivateWebp(build) {
    const {version}=JSON.parse(await readFile('package.json','utf8'));
    const source = resolve('vendor/webp'), manifest = JSON.parse(await readFile(resolve(source, 'manifest.json'), 'utf8'));
    assert.equal(manifest.bindingAbi, 1); assert.equal(manifest.profile, 'libwebp-batch-animation-v1');
    for (const file of manifest.files) {
        const bytes = await readFile(resolve(source, file.file)); assert.equal(bytes.length, file.bytes);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, 'WebP pinned asset ' + file.file);
    }
    await mkdir('dist/internal/webp-notices', { recursive: true });
    for (const file of manifest.files) await copyFile(resolve(source, file.file), resolve('dist/internal', file.file.startsWith('webp-codec.') ? file.file : 'webp-notices/' + file.file));
    for (const name of ['PROVENANCE.md', 'manifest.json']) await copyFile(resolve(source, name), resolve('dist/internal/webp-notices', name));
    await build({ entryPoints: ['src/internal/webp-worker.ts'], outdir: 'dist/internal', bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
    await build({ entryPoints: ['src/internal/webp-worker-core.ts'], outfile: 'dist/internal/webp-worker-core.js', bundle: true,
        format: 'esm', platform: 'browser', target: 'es2022' });
    await build({ entryPoints: ['src/webp-worker-runtime.ts'], outfile: 'dist/internal/webp-worker-runtime.js', bundle: true,
        format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true, external: ['./webp-codec.js'],
        banner: { js: '/*! Private libwebp integration. See webp-notices/PROVENANCE.md and notices. */' } });
    await mkdir('dist/webp-notices', { recursive: true });
    for (const file of manifest.files) await copyFile(resolve(source, file.file), resolve('dist', file.file.startsWith('webp-codec.') ? file.file : 'webp-notices/' + file.file));
    for (const name of ['PROVENANCE.md', 'manifest.json']) await copyFile(resolve(source, name), resolve('dist/webp-notices', name));
    await build({ entryPoints: ['src/webp.ts', 'src/webp-worker.ts'], outdir: 'dist', bundle: true, format: 'esm', platform: 'browser', target: 'es2022' });
    await copyFile('scripts/webp-browser-loader.mjs','dist/webp-notices/browser-loader.mjs');
    await writeFile('dist/webp-notices/PROVENANCE.md',(await readFile(resolve(source,'PROVENANCE.md'),'utf8'))+`\n## Public runtime packaging\n\nThe public runtime inlines a guarded browser-only version of the pinned Emscripten\nloader, so asset emitters need no adjacent JS dependency or Node builtin resolution.\nwebp-codec.js remains the pristine loader source/reference; WASM bytes are unchanged.\nThe preferred guarded transform is browser-loader.mjs alongside this notice. The\nmodified loader source is included in webp-worker-runtime.js.map sourcesContent.\nPublic entries /webp, /webp/worker, /webp/worker-runtime and /webp/codec.wasm are\nincluded in CanvasTake ${version}.\n`);
    await build({ entryPoints: ['src/webp-worker-runtime.ts'], outfile: 'dist/webp-worker-runtime.js', bundle: true,
        format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true,
        plugins:[{name:'webp-browser-loader',setup(b){
            b.onResolve({filter:/^\.\/webp-codec\.js$/},()=>({path:resolve(source,'webp-codec.js'),namespace:'webp-browser'}));
            b.onLoad({filter:/.*/,namespace:'webp-browser'},async({path})=>({contents:browserWebpLoader(await readFile(path,'utf8')),loader:'js'}));
        }}],
        banner: { js: '/*! Includes libwebp (BSD-3-Clause), Emscripten and linked runtime support. See webp-notices/. */' } });
}
