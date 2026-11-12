import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const output = resolve(root, 'benchmark-results/webp-research');
export const codecDirectory = resolve(output, 'consumer/node_modules/wasm-webp/dist/esm');
export const sha256 = data => createHash('sha256').update(data).digest('hex');
const integrity = 'sha512-Z1Sop+mLKogzDK3vJzSPfSxRF1yj/zbmn+XJuU9+7fvarxcuGhGkeLBqJr5H8LdgWuAwEKuZelCzx7ujztfhVQ==';
const files = [
    ['webp-wasm.js', 'ea9023c6313b758105d1ab3d8adf27b504ec26d40ea59f4926ae4ae81fd1a32a'],
    ['webp-wasm.wasm', '4d438a73dfe550d608d6b89eee34ea9374d58d3ffa0355218766281fc9a76c22']
];
const sourceUrl = 'https://raw.githubusercontent.com/nieyuyao/webp-wasm/65e1ba32146adc2e14360c557a113c141d8058c9/webp/encode.cpp';
const sourceHash = '8917d7e54ff0a1a232a5558a2988ac313fa6bc7e690e9484bf02457b66f51eaf';

export async function prepare(install) {
    const consumer = resolve(output, 'consumer');
    if (install) {
        // Explicit opt-in; no root dependencies or lifecycle scripts are touched.
        await mkdir(consumer, { recursive: true });
        await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'wasm-webp': '0.1.0' } }, null, 2) + '\n');
        execFileSync(process.execPath, [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
            'install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumer, stdio: 'inherit', timeout: 180000 });
    }
    let lock;
    try { lock = JSON.parse(await readFile(resolve(consumer, 'package-lock.json'), 'utf8')); }
    catch (error) { throw new Error('Prepare isolated dependency first: node scripts/check-webp-backends.mjs --install', { cause: error }); }
    assert.equal(lock.packages['node_modules/wasm-webp'].version, '0.1.0');
    assert.equal(lock.packages['node_modules/wasm-webp'].integrity, integrity);
    const assets = [];
    for (const [name, hash] of files) {
        const bytes = await readFile(resolve(codecDirectory, name));
        assert.equal(sha256(bytes), hash, 'pinned generated asset: ' + name);
        assets.push({ name, bytes: bytes.length, sha256: hash });
    }
    const sourcePath = resolve(output, 'upstream/webp/encode.cpp');
    let source;
    try { source = await readFile(sourcePath); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Pinned source download failed: ' + response.status);
        source = Buffer.from(await response.arrayBuffer());
        assert.equal(sha256(source), sourceHash);
        await mkdir(dirname(sourcePath), { recursive: true }); await writeFile(sourcePath, source);
    }
    assert.equal(sha256(source), sourceHash, 'pinned wrapper source');
    await mkdir(resolve(output, 'files'), { recursive: true });
    return { package: 'wasm-webp', version: '0.1.0', integrity, assets,
        source: { url: sourceUrl, sha256: sourceHash }, libwebpSourcePin: '6c484cbf92e81a5673b24485ac02d211f69be5b7',
        mode: 'Unmodified native binary; direct generated ESM factory with supplied WASM bytes; Embind vector deleted by research harness' };
}
