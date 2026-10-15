const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const projects = path.resolve(__dirname, '../..');
const port = Number(process.env.PORT || 3012);
http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'POST' && pathname === '/test-output') {
        if (req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
        const extension = req.headers['content-type'] === 'image/gif' ? 'gif'
            : req.headers['content-type']?.startsWith('video/mp4') ? 'mp4' : 'webm';
        const chunks = []; let size = 0;
        req.on('data', chunk => { size += chunk.length; if (size > 50_000_000) req.destroy(); else chunks.push(chunk); });
        req.on('end', () => { fs.writeFileSync(path.join(os.tmpdir(), `canvastake-test.${extension}`), Buffer.concat(chunks)); res.end('saved'); });
        return;
    }
    const file = path.resolve(projects, '.' + decodeURIComponent(pathname));
    const allowed = ['canvas-take', 'algiviz'].some(project => file.startsWith(path.join(projects, project) + path.sep));
    if (!allowed || req.method !== 'GET') { res.writeHead(403).end(); return; }
    fs.readFile(file, (error, data) => {
        if (error) { res.writeHead(404).end(); return; }
        res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : /\.m?js$/.test(file) ? 'text/javascript' : 'text/plain'); res.end(data);
    });
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/canvas-take/examples/index.html`));
