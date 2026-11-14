import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

// Check current consumer documentation, leaving dated research/verification reports intact.
export async function verifyPackageDocumentation(root) {
    const read=path=>readFile(join(root,path),'utf8');
    const pkg=JSON.parse(await read('package.json'));
    const provenance=await read('dist/webp-notices/PROVENANCE.md');
    const upstream=await read('dist/internal/webp-notices/PROVENANCE.md');
    assert.ok(provenance.startsWith(upstream),'WebP notice must retain the pinned upstream provenance');
    const marker='## Public runtime packaging',start=provenance.indexOf(marker);
    assert.ok(start>=0,'Missing public WebP packaging provenance');
    const packaging=provenance.slice(start);
    assert.ok(packaging.includes(`included in CanvasTake ${pkg.version}.`),'WebP packaging provenance must identify the installed package version');
    assert.doesNotMatch(packaging,/\bunreleased\b|package version remains/i,'Stale WebP packaging status');
    for(const path of ['/webp','/webp/worker','/webp/worker-runtime','/webp/codec.wasm'])assert.ok(packaging.includes(path),'Missing documented WebP entry: '+path);

    const files=['dist/webp-notices/PROVENANCE.md'];
    for(const [path,heading]of [['README.md','## Animated WebP export'],['ru/README.md','## Экспорт animated WebP'],['docs/webp-export.md',null]]){
        const text=await read(path);let section=text;
        if(heading){const start=text.indexOf(heading);assert.ok(start>=0,'Missing WebP section: '+path);const end=text.indexOf('\n## ',start+heading.length);section=text.slice(start,end<0?undefined:end);}
        for(const entry of ['@grundyjs/canvas-take/webp','@grundyjs/canvas-take/webp/worker'])assert.ok(section.includes(entry),'Missing public WebP import in '+path);
        assert.doesNotMatch(section,/\bunreleased\b|version remains|ещё не выпущен|точки входа ещё не опубликованы|Версия остаётся[^\n]*до[^\n]*релиза/i,'Stale WebP consumer documentation: '+path);
        files.push(path);
    }
    const changelog=await read('CHANGELOG.md');
    assert.ok(changelog.split(/\r?\n/).some(line=>line===`## ${pkg.version}`||line.startsWith(`## ${pkg.version} `)),'Missing installed version in CHANGELOG');
    files.push('CHANGELOG.md');
    return {version:pkg.version,files};
}
