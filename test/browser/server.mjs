import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { apngPlugin } from '../../scripts/apng-build.mjs';
import { pathToFileURL } from 'node:url';
const packedDist = process.env.CANVASTAKE_APNG_DIST;
const dist = packedDist ? pathToFileURL(packedDist.replace(/[\\/]$/, '') + '/') : new URL('../../dist/', import.meta.url);
const probe = await build({ entryPoints: ['src/internal/apng-worker-runtime.ts'], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', plugins: [await apngPlugin({ probe: true })] });

// Only test page and shipped modules are served; no directory traversal or project files.
const routes = new Map([
    ['/', new URL('./fixture.html', import.meta.url)],
    ['/apng-helper.js', new URL('./helpers/apng.mjs', import.meta.url)],
    ['/examples/apng.html', new URL('../../examples/apng.html', import.meta.url)],
    ['/custom-apng-worker.js', new URL('internal/apng-worker-runtime.js', dist)],
    ...['apng-controller.js', 'apng-worker.js', 'apng-worker-runtime.js'].map(name => ['/dist/internal/' + name, new URL('internal/' + name, dist)]),
    ['/examples/gif.html', new URL('../../examples/gif.html', import.meta.url)],
    ['/examples/video.html', new URL('../../examples/video.html', import.meta.url)],
    ['/examples/offline-video.html', new URL('../../examples/offline-video.html', import.meta.url)],
    ['/test-audio.js', new URL('./helpers/audio.mjs', import.meta.url)],
    ['/offline-audio-input.js', new URL('./helpers/offline-audio-input.mjs', import.meta.url)],
    ...['gif-worker-legacy-runtime.mjs','gif-worker-legacy-adapter.mjs','gif-worker-unknown-version.mjs','gif-worker-raw-probe.mjs'].map(name =>
        ['/fixtures/'+name,new URL('../fixtures/'+name,import.meta.url)]),
    ...['index.js', 'video.js', 'video-webcodecs.js', 'video-mp4.js', 'video-webm.js', 'video-opus.js', 'video-aac.js', 'video-aac-worker.js', 'gif.js', 'gif-worker.js', 'gif-worker-runtime.js', 'gifenc.js',
        ...(await readdir(new URL('../../dist/',import.meta.url))).filter(name=>/^video-container-[A-Z0-9]+\.js$/.test(name))].map(name =>
        [`/dist/${name}`, new URL(`../../dist/${name}`, import.meta.url)])
]);
createServer(async (req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (path === '/fixtures/apng-probe.js' || path === '/fixtures/apng-invalid.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cross-Origin-Embedder-Policy': 'require-corp' });
        res.end(path.includes('probe') ? probe.outputFiles[0].text : `self.onmessage=({data})=>self.postMessage({id:data.id,version:99,action:data.action});`); return;
    }
    const file = routes.get(path);
    if (!file) { res.writeHead(404).end(); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, {
            'Content-Type': path === '/' || path.startsWith('/examples/') ? 'text/html; charset=utf-8' : 'text/javascript',
            'Content-Security-Policy': "worker-src 'self'",
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
            'Cache-Control': 'no-store'
        });
        res.end(body);
    } catch { res.writeHead(500).end(); }
}).listen(3187, '127.0.0.1');
