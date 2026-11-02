import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
await build({ entryPoints: ['src/gifenc.ts'], outfile: 'dist/gifenc.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    banner: { js: '/*! Includes gifenc (MIT). See gifenc-LICENSE.txt. */' } });
await copyFile('node_modules/gifenc/LICENSE.md', 'dist/gifenc-LICENSE.txt');
await build({ entryPoints: ['src/video-mp4.ts'], outfile: 'dist/video-mp4.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true,
    banner: { js: '/*! Includes Mediabunny 1.65.0 (MPL-2.0). Source in video-mp4.js.map; see mediabunny-LICENSE.txt. */' } });
await copyFile('node_modules/mediabunny/LICENSE', 'dist/mediabunny-LICENSE.txt');
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
