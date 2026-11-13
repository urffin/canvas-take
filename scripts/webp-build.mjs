import assert from 'node:assert/strict';
import { readFile, mkdir, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
export async function buildPrivateWebp(build) {
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
    await build({ entryPoints: ['src/internal/webp-worker-entry.ts'], outfile: 'dist/internal/webp-worker-runtime.js', bundle: true,
        format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true, external: ['./webp-codec.js'],
        banner: { js: '/*! Private libwebp integration. See webp-notices/PROVENANCE.md and notices. */' } });
}
