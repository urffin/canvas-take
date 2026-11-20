// Compile-only bridge: actual private implementation, original draft shape, existing generic core.
import {openBrowserResultStore} from '../../dist/internal/video-browser-results.js';
import type {BrowserResultStoreOptions} from '../../dist/internal/video-browser-results-ports.js';
import type {BrowserResultStoreDraft} from './external-video-browser-lifecycle.js';
// @ts-expect-error private managed store is not a public video export
import {openBrowserResultStore as publicFactory} from '@grundyjs/canvas-take/video';
declare const options:BrowserResultStoreOptions;
const existingContract:Promise<BrowserResultStoreDraft>=openBrowserResultStore(options);
const {trust,...withoutTrust}=options;
// @ts-expect-error managed namespace cooperation is explicit
openBrowserResultStore(withoutTrust);
// @ts-expect-error v1 schema cannot opt into automatic managed migration
openBrowserResultStore({...options,scope:{...options.scope,schema:1}});
// @ts-expect-error a fake lock port without an owning release handle cannot coordinate deletion
openBrowserResultStore({...options,locks:{sharedExclusive:true,tryAcquire:async()=>({})}});
// @ts-expect-error arbitrary native folder handles are not accepted by this controlled-port factory
openBrowserResultStore({...options,directoryHandle:{}});
export async function actual(){
 const store=await openBrowserResultStore(options);
 // @ts-expect-error diagnostics cannot overwrite live accounting
 store.stats.readers=0;
 const saved:BrowserResultStoreDraft=store;const binding=saved.bind('movie.mp4');
 const owner=saved.inspectHold(binding.ownerHold);void owner;return saved;
}
void existingContract;void trust;
