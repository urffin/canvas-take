import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openBrowserVideoCatalog,checkNativeBrowserFileDestination} from '../dist/internal/video-browser-catalog.js';

test('browser receiver imports safely without browser storage and does not advertise native filename guarantees',()=>{
 assert.equal(typeof openBrowserVideoCatalog,'function');const result=checkNativeBrowserFileDestination();assert.equal(result.supported,false);assert.match(result.reason,/logical OPFS/);
});
test('browser receiver requires explicit catalogue semantics and cooperative namespace before storage access',async()=>{
 const base={directory:{kind:'directory'},databaseName:'canvastake-browser-video-test',publication:'opfs-catalog',trust:'cooperating-origin-namespace'};
 for(const extra of [{databaseName:'foreign-database'},{publication:'native-file'},{trust:undefined}])await assert.rejects(openBrowserVideoCatalog({...base,...extra}),TypeError);
});
test('browser receiver rejects invalid handle/retention shapes before provisioning',async()=>{
 const base={directory:{kind:'directory'},databaseName:'canvastake-browser-video-test',publication:'opfs-catalog',trust:'cooperating-origin-namespace'};
 await assert.rejects(openBrowserVideoCatalog({...base,directory:{kind:'file'}}),TypeError);
 for(const maxAttempts of [0,-1,1.5,Number.POSITIVE_INFINITY])await assert.rejects(openBrowserVideoCatalog({...base,maxAttempts}),RangeError);
});
test('browser receiver reports unavailable storage instead of falling back to Node or an in-memory output',async()=>{
 await assert.rejects(openBrowserVideoCatalog({directory:{kind:'directory'},databaseName:'canvastake-browser-video-test',publication:'opfs-catalog',trust:'cooperating-origin-namespace'}),e=>e.name==='NotSupportedError');
});
test('browser receiver and declarations have no package entry point',async()=>{
 for(const path of ['internal/video-browser-catalog.js','internal/video-browser-catalog.d.ts'])await assert.rejects(import('@grundyjs/canvas-take/'+path),e=>e.code==='ERR_PACKAGE_PATH_NOT_EXPORTED');
});
