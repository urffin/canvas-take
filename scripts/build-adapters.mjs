import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({ entryPoints: ['src/gifenc.ts'], outfile: 'dist/gifenc.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    banner: { js: '/*! Includes gifenc (MIT). See gifenc-LICENSE.txt. */' } });
await copyFile('node_modules/gifenc/LICENSE.md', 'dist/gifenc-LICENSE.txt');
await build({ entryPoints: ['src/video-mp4.ts'], outfile: 'dist/video-mp4.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true, sourcemap: true,
    banner: { js: '/*! Includes Mediabunny 1.65.0 (MPL-2.0). Source in video-mp4.js.map; see mediabunny-LICENSE.txt. */' } });
await copyFile('node_modules/mediabunny/LICENSE', 'dist/mediabunny-LICENSE.txt');
