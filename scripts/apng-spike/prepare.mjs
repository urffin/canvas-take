import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { patchUpng } from './upng-patch.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const output = resolve(root, 'benchmark-results/apng-backend-spike');
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const sources = [
    ['UPNG.js', 'https://raw.githubusercontent.com/photopea/UPNG.js/88f504b6577b726975f593caa38ba85d327c7c1f/UPNG.js', '39213412bc9945002588f5e12adfc555c63d314874bba1dbed5be802b1c86ed2'],
    ['UPNG-LICENSE', 'https://raw.githubusercontent.com/photopea/UPNG.js/88f504b6577b726975f593caa38ba85d327c7c1f/LICENSE', 'c1fb8861eca211bf5aea574358aba7039396c0c1824c2a1477cc126d398efd89'],
    ['pako-deflate.cjs', 'https://raw.githubusercontent.com/nodeca/pako/2.1.0/dist/pako_deflate.min.js', '9429785d1e7f805d46640c4155957fd0f286144dec05cea09f6f2eaa646adb21'],
    ['pako-LICENSE', 'https://raw.githubusercontent.com/nodeca/pako/2.1.0/LICENSE', 'a04665b3b2de56c66730c1f720f528175739e4104f79073614aa611da1e85539'],
    ['pako-zlib-README', 'https://raw.githubusercontent.com/nodeca/pako/2.1.0/lib/zlib/README', 'd8b499598e43d755ea8918448128259ff01820c50d94d5a48c8883d0a594ddb1']
];

export async function prepare() {
    const vendor = resolve(output, 'vendor'); await mkdir(vendor, { recursive: true });
    for (const [name, url, hash] of sources) {
        const path = resolve(vendor, name);
        let bytes;
        try { bytes = await readFile(path); }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
            if (!response.ok) throw new Error('Source download failed: ' + response.status + ' ' + url);
            bytes = Buffer.from(await response.arrayBuffer());
            if (sha256(bytes) !== hash) throw new Error('Source integrity mismatch: ' + name);
            await writeFile(path, bytes);
        }
        if (sha256(bytes) !== hash) throw new Error('Cached source integrity mismatch: ' + name);
    }
    const pristine = (await readFile(resolve(vendor, 'UPNG.js'), 'utf8')).replaceAll('\r\n', '\n');
    const patched = patchUpng(pristine);
    // Reject drift/reapplication. Neither candidate nor oracle calls UPNG's decoder.
    for (const candidate of [pristine.replace('nimg.frames.length>1', 'nimg.frames.length>2'), patched]) {
        let rejected = false; try { patchUpng(candidate); } catch { rejected = true; }
        if (!rejected) throw new Error('UPNG transform accepted drift/reapplication');
    }
    await writeFile(resolve(output, 'UPNG-patched.js'), patched);
    const plugin = { name: 'isolated-apng-spike', setup(b) {
        b.onResolve({ filter: /^spike:upng$/ }, () => ({ path: 'upng', namespace: 'spike' }));
        b.onLoad({ filter: /.*/, namespace: 'spike' }, () => ({
            contents: `import originalPako from ${JSON.stringify(resolve(vendor, 'pako-deflate.cjs'))};
let probe, inside = false; export function setCompressionProbe(value) { probe = value; }
const originalOnData = originalPako.Deflate.prototype.onData;
originalPako.Deflate.prototype.onData = function(chunk) {
    if (probe && !inside) { inside = true; probe('enter'); }
    return originalOnData.call(this, chunk);
};
const pako = { deflate(...args) { inside = false; try { return originalPako.deflate(...args); } finally { probe?.('exit'); } } };
${patched}\nexport default UPNG;`, loader: 'js', resolveDir: root
        }));
    } };
    await build({ entryPoints: { backend: resolve(root, 'scripts/apng-spike/backend.mjs'), worker: resolve(root, 'scripts/apng-spike/browser-worker.mjs'), client: resolve(root, 'scripts/apng-spike/browser-client.mjs') },
        outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', sourcemap: true,
        plugins: [plugin], banner: { js: '/*! EXPERIMENT ONLY. UPNG MIT; Pako MIT/Zlib. Pristine sources/licenses in vendor/. */' } });
    const provenance = { sources: sources.map(([name, url, sha256]) => ({ name, url, sha256 })), patchedUpngSha256: sha256(patched),
        backendSha256: sha256(await readFile(resolve(output, 'backend.mjs'))), compression: 'Pako 2.1.0 default level, PNG filter 0, full RGBA8 frames',
        patch: ['Always emit animation for nonempty input', 'Use deflate rather than level-0 storage in encodeLL', 'Select Pako explicitly, without window.UZIP fallback'],
        cancellationProbe: 'First Pako.Deflate.onData callback inside the actual synchronous deflate call; flag cleared in finally when deflate returns' };
    await writeFile(resolve(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
    return provenance;
}
