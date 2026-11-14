import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {browserWebpLoader} from '../scripts/webp-browser-loader.mjs';
test('public WebP runtime is standalone JS with a guarded browser loader and unchanged WASM',async()=>{
    const source=await readFile('vendor/webp/webp-codec.js','utf8'),patched=browserWebpLoader(source);
    assert.ok(!patched.includes('import("module")'));assert.ok(patched.includes('var ENVIRONMENT_IS_NODE=false;'));
    assert.throws(()=>browserWebpLoader(patched),/guard/);assert.throws(()=>browserWebpLoader(source.replace('var ENVIRONMENT_IS_NODE=','const ENVIRONMENT_IS_NODE=')),/guard/);
    const runtime=await readFile('dist/webp-worker-runtime.js','utf8'),map=JSON.parse(await readFile('dist/webp-worker-runtime.js.map','utf8'));
    assert.ok(!/\bimport\s*(?:\(|.*?from)\s*['"](?:module|\.\/webp-codec\.js)['"]/.test(runtime));
    assert.ok(map.sourcesContent.some(s=>s.includes('var ENVIRONMENT_IS_NODE=false;')));
    assert.deepEqual(await readFile('dist/webp-codec.wasm'),await readFile('vendor/webp/webp-codec.wasm'));
});
