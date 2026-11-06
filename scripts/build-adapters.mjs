import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { patchWebmMuxer } from './webm-muxer-patch.mjs';
// Inline internal preparation helpers; keep the public controller entry standalone and codec-free.
await build({ entryPoints: ['src/video.ts'], outfile: 'dist/video.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022' });
await build({ entryPoints: ['src/gif.ts'], outfile: 'dist/gif.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022' });
await build({ entryPoints: ['src/gif-worker.ts'], outfile: 'dist/gif-worker.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022' });
await build({ entryPoints: ['src/gif-worker-runtime.ts'], outfile: 'dist/gif-worker-runtime.js', bundle: true,
    external: ['./gifenc.js'], format: 'esm', platform: 'browser', target: 'es2022' });
await build({ entryPoints: ['src/gifenc.ts'], outfile: 'dist/gifenc.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    banner: { js: '/*! Includes gifenc (MIT). See gifenc-LICENSE.txt. */' } });
await copyFile('node_modules/gifenc/LICENSE.md', 'dist/gifenc-LICENSE.txt');
for (const name of await readdir('dist')) if (/^video-container-[A-Z0-9]+\.js(?:\.map)?$/.test(name)) await unlink(resolve('dist',name));
await build({ entryPoints: { 'video-mp4':'src/video-mp4.ts', 'video-webm':'src/video-webm.ts' }, outdir: 'dist', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true, splitting:true, chunkNames:'video-container-[hash]',
    plugins:[{name:'pinned-webm-muxer',setup(build){build.onLoad({filter:/[\\/]matroska[\\/]matroska-muxer\.js$/},async({path})=>({
        contents:patchWebmMuxer((await readFile(path,'utf8')).replaceAll('\r\n','\n').replace(/^\/\/# sourceMappingURL=.*$/gm,'')),loader:'js',resolveDir:dirname(path)
    }));}}],
    banner: { js: '/*! Includes Mediabunny 1.65.0 (MPL-2.0) with WebM integration changes. Source in video-container-*.js.map; see mediabunny-LICENSE.txt. */' } });
await copyFile('node_modules/mediabunny/LICENSE', 'dist/mediabunny-LICENSE.txt');
await mkdir('dist/webm-sources',{recursive:true});
await copyFile('scripts/webm-muxer-patch.mjs','dist/webm-sources/webm-muxer-patch.mjs');
await copyFile('node_modules/mediabunny/src/matroska/matroska-muxer.ts','dist/webm-sources/matroska-muxer.ts');
await copyFile('node_modules/mediabunny/dist/modules/src/matroska/matroska-muxer.js','dist/webm-sources/matroska-muxer.js');
await writeFile('dist/webm-PROVENANCE.md',`# WebM integration sources

Mediabunny 1.65.0, MPL-2.0: https://github.com/Vanilagy/mediabunny
Pinned npm source distribution: https://registry.npmjs.org/mediabunny/-/mediabunny-1.65.0.tgz

webm-sources/matroska-muxer.ts and .js are pristine upstream sources. The guarded
webm-sources/webm-muxer-patch.mjs transform is CanvasTake's preferred integration
source. It changes the WebM timebase to microseconds, adds final Opus DiscardPadding,
excludes codec delay/padding from presentation duration and limits staging bytes.
Normalize the pristine JS to LF, remove its sourceMappingURL comment and pass it
to patchWebmMuxer(source). The transformed module is bundled with esbuild 0.28.2.
The exact modified module and all other bundled modules are included in
video-container-*.js.map sourcesContent. See mediabunny-LICENSE.txt.
The CanvasTake transform is MIT; the transformed Mediabunny module remains MPL-2.0.
`);
await build({ entryPoints: ['src/video-aac-worker.ts'], outfile: 'dist/video-aac-worker.js', bundle: true,
    format:'esm',platform:'browser',target:'es2022',minify:true,sourcemap:true,
    plugins:[{name:'pinned-aac-wasm',setup(build){
        build.onResolve({filter:/^canvastake:aac-wasm$/},()=>({path:resolve('node_modules/@mediabunny/aac-encoder/dist/modules/build/aac.js'),namespace:'aac-wasm'}));
        build.onLoad({filter:/.*/,namespace:'aac-wasm'},async ({path})=>{
            const source=await readFile(path,'utf8');
            const marker='Object.defineProperty(exports, "__esModule", { value: true });';
            if (!source.includes(marker)||!source.includes('exports.default = Module;')) throw new Error('Pinned AAC WASM wrapper changed');
            return {contents:source.replace(marker,'').replace('exports.default = Module;','export default Module;'),loader:'js'};
        });
    }}],
    banner:{js:'/*! Includes @mediabunny/aac-encoder 1.65.0 WASM (MPL-2.0; FFmpeg LGPL-2.1-or-later). See aac-licenses and aac-PROVENANCE.md. */'} });
await mkdir('dist/aac-licenses',{recursive:true});
await copyFile('node_modules/@mediabunny/aac-encoder/LICENSE','dist/aac-licenses/MPL-2.0.txt');
for (const name of await readdir('node_modules/@mediabunny/aac-encoder/licenses/ffmpeg'))
    await copyFile('node_modules/@mediabunny/aac-encoder/licenses/ffmpeg/'+name,'dist/aac-licenses/'+name);
await copyFile('node_modules/@mediabunny/aac-encoder/README.md','dist/aac-PROVENANCE.md');
await copyFile('node_modules/@mediabunny/aac-encoder/src/bridge.c','dist/aac-licenses/bridge.c');
