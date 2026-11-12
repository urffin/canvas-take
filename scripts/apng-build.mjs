import { createHash } from 'node:crypto';
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { patchUpng } from './apng-upng-patch.mjs';

export const apngSources = [
    ['UPNG.js', '39213412bc9945002588f5e12adfc555c63d314874bba1dbed5be802b1c86ed2'],
    ['UPNG-LICENSE', 'c1fb8861eca211bf5aea574358aba7039396c0c1824c2a1477cc126d398efd89'],
    ['pako-deflate.cjs', '9429785d1e7f805d46640c4155957fd0f286144dec05cea09f6f2eaa646adb21'],
    ['pako-LICENSE', 'a04665b3b2de56c66730c1f720f528175739e4104f79073614aa611da1e85539'],
    ['pako-zlib-README', 'd8b499598e43d755ea8918448128259ff01820c50d94d5a48c8883d0a594ddb1']
];
export async function apngPlugin({ probe = false } = {}) {
    for (const [name, hash] of apngSources) {
        const bytes = await readFile('vendor/apng/' + name);
        if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Pinned APNG source changed: ' + name);
    }
    const patched = patchUpng(await readFile('vendor/apng/UPNG.js', 'utf8'));
    return { name: 'pinned-apng', setup(build) {
        build.onResolve({ filter: /^canvastake:apng-codec$/ }, () => ({ path: 'codec', namespace: 'apng' }));
        build.onLoad({ filter: /.*/, namespace: 'apng' }, () => ({ contents:
            `import pako from ${JSON.stringify(resolve('vendor/apng/pako-deflate.cjs'))};\n` +
            (probe ? `let probeStatus;
self.addEventListener('message', event => { if (event.data.probeBuffer) probeStatus = new Int32Array(event.data.probeBuffer); });
const original = pako.Deflate.prototype.onData, deflate = pako.deflate;
pako.Deflate.prototype.onData = function(chunk) {
    if (!globalThis.__apngCompressionEntered) {
        globalThis.__apngCompressionEntered = true;
        if (probeStatus) Atomics.store(probeStatus, 0, 1);
        self.postMessage({ compressionProbe: true });
    }
    return original.call(this, chunk);
};
pako.deflate = function(...args) { try { return deflate(...args); } finally { if (probeStatus) Atomics.store(probeStatus, 0, 2); } };\n` : '') + patched + '\nexport default UPNG;', loader: 'js', resolveDir: resolve('.') }));
    } };
}
export async function copyApngNotices() {
    await mkdir('dist/internal/apng-sources', { recursive: true });
    for (const [name] of apngSources) await copyFile('vendor/apng/' + name, 'dist/internal/apng-sources/' + name);
    await copyFile('scripts/apng-upng-patch.mjs', 'dist/internal/apng-sources/upng-patch.mjs');
    await writeFile('dist/internal/apng-PROVENANCE.md', `# Private APNG integration sources

UPNG revision 88f504b6577b726975f593caa38ba85d327c7c1f, MIT:
https://github.com/photopea/UPNG.js/tree/88f504b6577b726975f593caa38ba85d327c7c1f
Pako 2.1.0 deflate bundle, MIT/Zlib: https://github.com/nodeca/pako/tree/2.1.0

Pristine sources and complete notices are in apng-sources/. The guarded upng-patch.mjs
enables single-frame animation, real encodeLL deflate and explicit Pako selection.
The full-frame RGBA8 SOURCE/BACKGROUND profile disables rectangle/palette optimization.
Source hashes are checked by scripts/apng-build.mjs before every build, without network access.
The bundled modified source is included in apng-worker-runtime.js.map sourcesContent.
This integration has no public package entry yet.
`);
}
