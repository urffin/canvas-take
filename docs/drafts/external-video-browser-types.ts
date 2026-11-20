// Compile-only private prototype. No browser package entry point is introduced.
import {openBrowserVideoCatalog} from '../../dist/internal/video-browser-catalog.js';
import {createExternalVideoExporter} from '../../dist/internal/video-external.js';
import {createExternalMp4Muxer} from '../../dist/internal/video-external-mp4.js';
import type {OfflineVideoOptions} from '@grundyjs/canvas-take/video';
// @ts-expect-error private browser receiver is not a public package import
import {openBrowserVideoCatalog as publicCatalog} from '@grundyjs/canvas-take/video/browser';
declare const directory:FileSystemDirectoryHandle,video:OfflineVideoOptions['video'];
// @ts-expect-error native filename publication cannot silently select catalogue semantics
openBrowserVideoCatalog({directory,databaseName:'canvastake-browser-video-test',publication:'native-file',trust:'cooperating-origin-namespace'});
// @ts-expect-error cooperation of the private origin namespace is an explicit precondition
openBrowserVideoCatalog({directory,databaseName:'canvastake-browser-video-test',publication:'opfs-catalog'});
export async function example(){
 const catalog=await openBrowserVideoCatalog({directory,databaseName:'canvastake-browser-video-test',publication:'opfs-catalog',trust:'cooperating-origin-namespace'});
 const mode:'opfs-catalog'=catalog.publication,binding=catalog.bind('movie.mp4');
 const exporter=createExternalVideoExporter({video,muxer:createExternalMp4Muxer(),destination:binding.destination});await exporter.ready;
 const result=await exporter.finish(),file:File=await result.output.value.getFile();
 // @ts-expect-error OPFS read-only receipts do not expose a Node filesystem path
 result.output.value.path;
 // @ts-expect-error immutable original-version receipt metadata
 result.output.value.objectName='other';
 const selected=await catalog.lookup('movie.mp4');if(selected){const copy:File=await selected.getFile();void copy;}
 void mode;void file;
}
