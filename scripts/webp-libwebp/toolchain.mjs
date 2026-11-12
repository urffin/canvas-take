import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extractZip } from './extract-zip.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const output = resolve(root, 'benchmark-results/webp-libwebp');
export const tools = resolve(output, 'toolchain');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const archives = [
    { name: 'emscripten.zip', target: 'sdk', url: 'https://storage.googleapis.com/webassembly/emscripten-releases-builds/win/c387d7a7e9537d0041d2c3ae71b7538cc978104e/wasm-binaries.zip', sha256: '388e9fab2bc9f94e85b1541e6ae0f1d9a5b9dfa9d756d89a0a3fc7acc052fbd5' },
    { name: 'python.zip', target: 'python', url: 'https://storage.googleapis.com/webassembly/emscripten-releases-builds/deps/python-3.13.3-0-win-amd64.zip', sha256: '6fe7a540c6b8b185780467cf7495e884ee62316ec4abb19e1c735b8a77c62465' },
    { name: 'node.zip', target: 'node', url: 'https://nodejs.org/dist/v22.17.0/node-v22.17.0-win-x64.zip', sha256: '721ab118a3aac8584348b132767eadf51379e0616f0db802cc1e66d7f0d98f85' },
    { name: 'libwebp.tar.gz', target: 'source', url: 'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz', sha256: 'e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564' }
];
async function fileHash(path) {
    const hash = createHash('sha256'); await pipeline(createReadStream(path), hash); return hash.digest('hex');
}
export async function prepare(install) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This pinned reference toolchain is Windows x64 only; no cross-platform reproducibility claim');
    await mkdir(tools, { recursive: true });
    const provenance = [];
    for (const asset of archives) {
        const path = resolve(tools, asset.name);
        let exists = false; try { exists = (await stat(path)).size > 0; } catch {}
        if (!exists) {
            if (!install) throw new Error('Missing toolchain archive; run node scripts/build-webp-backend.mjs --prepare');
            const response = await fetch(asset.url, { signal: AbortSignal.timeout(900000) });
            if (!response.ok) throw new Error('Toolchain HTTP ' + response.status);
            console.log('Downloading ' + asset.name + ': ' + response.headers.get('content-length') + ' bytes');
            await pipeline(Readable.fromWeb(response.body), createWriteStream(path + '.part'));
            assert.equal(await fileHash(path + '.part'), asset.sha256, 'download integrity');
            await rename(path + '.part', path);
        }
        assert.equal(await fileHash(path), asset.sha256, 'cached archive: ' + asset.name);
        provenance.push({ ...asset, bytes: (await stat(path)).size });
        const marker = resolve(tools, asset.target, '.canvastake-prepared');
        let prepared = false; try { prepared = (await readFile(marker, 'utf8')) === asset.sha256; } catch {}
        if (!prepared) {
            await mkdir(resolve(tools, asset.target), { recursive: true });
            console.log('Extracting ' + asset.name);
            if (asset.name.endsWith('.zip')) await extractZip(path, resolve(tools, asset.target), name => asset.target === 'sdk' && /\/emscripten\/(test|site|docs)\//.test(name));
            else execFileSync('tar', ['-xf', path, '-C', resolve(tools, asset.target)], { stdio: 'inherit', timeout: 180000 });
            await writeFile(marker, asset.sha256);
        }
    }
    return provenance;
}
