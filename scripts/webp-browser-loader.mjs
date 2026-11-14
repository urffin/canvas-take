// Guarded browser-only adaptation of the pinned Emscripten loader; WASM is unchanged.
import assert from 'node:assert/strict';
export function browserWebpLoader(source) {
    const guard='var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";';
    const acquire='if(ENVIRONMENT_IS_NODE){const{createRequire}=await import("module");var require=createRequire(import.meta.url)}';
    for(const text of [guard,acquire])assert.equal(source.split(text).length-1,1,'Pinned WebP browser-loader guard changed');
    return source.replace(guard,'var ENVIRONMENT_IS_NODE=false;').replace(acquire,'var require;');
}
