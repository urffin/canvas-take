import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Only test page and shipped modules are served; no directory traversal or project files.
const routes = new Map([
    ['/', new URL('./fixture.html', import.meta.url)],
    ...['gif.js', 'gif-worker.js', 'gif-worker-runtime.js', 'gifenc.js'].map(name =>
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
            'Content-Type': path === '/' ? 'text/html; charset=utf-8' : 'text/javascript',
            'Content-Security-Policy': "worker-src 'self'",
            'Cache-Control': 'no-store'
        });
        res.end(body);
    } catch { res.writeHead(500).end(); }
}).listen(3187, '127.0.0.1');
