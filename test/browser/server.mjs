import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';

// Only test page and shipped modules are served; no directory traversal or project files.
const routes = new Map([
    ['/', new URL('./fixture.html', import.meta.url)],
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
    const file = routes.get(path);
    if (!file) { res.writeHead(404).end(); return; }
    try {
        const body = await readFile(file);
        res.writeHead(200, {
            'Content-Type': path === '/' || path.startsWith('/examples/') ? 'text/html; charset=utf-8' : 'text/javascript',
            'Content-Security-Policy': "worker-src 'self'",
            'Cache-Control': 'no-store'
        });
        res.end(body);
    } catch { res.writeHead(500).end(); }
}).listen(3187, '127.0.0.1');
