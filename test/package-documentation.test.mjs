import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname,basename} from 'node:path';
import {verifyPackageDocumentation} from '../scripts/lib/package-documentation.mjs';

async function fixture(t) {
    const root=await mkdtemp(join(tmpdir(),'canvastake-package-docs-'));
    t.after(async()=>{const target=await realpath(root);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('canvastake-package-docs-'));await rm(target,{recursive:true,force:true});});
    const imports="import '@grundyjs/canvas-take/webp';\nimport '@grundyjs/canvas-take/webp/worker';\n";
    const upstream='# Codec sources\nHistorical unreleased 0.7.0 research.\n';
    const notice=upstream+'\n## Public runtime packaging\nPublic entries /webp, /webp/worker, /webp/worker-runtime and /webp/codec.wasm are included in CanvasTake 9.8.7.\n';
    for(const [path,text]of [
        ['package.json',JSON.stringify({version:'9.8.7'})],
        ['dist/internal/webp-notices/PROVENANCE.md',upstream],['dist/webp-notices/PROVENANCE.md',notice],
        ['README.md','## Animated WebP export (since 0.8.0)\n'+imports+'\n## Historical work\nAn unreleased 0.7.0 build.\n'],
        ['ru/README.md','## Экспорт animated WebP (с версии 0.8.0)\n'+imports],
        ['docs/webp-export.md','# WebP\nSince 0.8.0.\n'+imports],
        ['CHANGELOG.md','## 9.8.7 — today\nFix packaging.\n\n## 0.7.0\nOlder notes.\n'],
        ['docs/drafts/history.md','Unreleased repository build; package version remains 0.7.0.\n']
    ]){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),text);}
    return {root,notice,upstream};
}

test('packed documentation follows the installed version and preserves historical reports/feature versions',async t=>{
    const {root}=await fixture(t),checked=await verifyPackageDocumentation(root);
    assert.equal(checked.version,'9.8.7');assert.equal(checked.files.length,5);
    assert.match(await readFile(join(root,'docs/drafts/history.md'),'utf8'),/unreleased repository build/i);
});

for(const [name,change,expected]of [
    ['the original unreleased 0.7.0 notice',({upstream})=>upstream+'\n## Public runtime packaging\nPublic entries are available in this unreleased repository build; package version remains 0.7.0.\n',/installed package version/],
    ['a stale version in an otherwise current notice',({notice})=>notice.replace('9.8.7','9.8.6'),/installed package version/],
    ['unreleased status even alongside the correct version',({notice})=>notice+'This is an unreleased repository build.\n',/Stale WebP packaging status/]
])test('packed documentation rejects '+name,async t=>{
    const data=await fixture(t);await writeFile(join(data.root,'dist/webp-notices/PROVENANCE.md'),change(data));
    await assert.rejects(verifyPackageDocumentation(data.root),expected);
});

test('packed documentation rejects stale current consumer guides',async t=>{
    const {root}=await fixture(t);
    for(const [path,stale]of [['README.md','The version remains 0.7.0 until a separate release.'],['ru/README.md','новые точки входа ещё не опубликованы.'],['docs/webp-export.md','Unreleased repository build.']]){
        const file=join(root,path),before=await readFile(file,'utf8');
        // Insert inside the current section, rather than the historical README section.
        const newline=before.indexOf('\n');await writeFile(file,before.slice(0,newline+1)+stale+'\n'+before.slice(newline+1));
        await assert.rejects(verifyPackageDocumentation(root),/Stale WebP consumer documentation/);
        await writeFile(file,before);
    }
});
