import { build } from 'esbuild';
import { copyFile } from 'node:fs/promises';
await build({ entryPoints: ['src/gifenc.ts'], outfile: 'dist/gifenc.js', bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    banner: { js: '/*! Includes gifenc (MIT). See gifenc-LICENSE.txt. */' } });
await copyFile('node_modules/gifenc/LICENSE.md', 'dist/gifenc-LICENSE.txt');
