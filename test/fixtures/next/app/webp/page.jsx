'use client';
import { useEffect, useRef, useState } from 'react';
import { createWebpExporter } from '@grundyjs/canvas-take/webp';
import { createWebpWorkerEncoder } from '@grundyjs/canvas-take/webp/worker';
import { exportWebpCase } from '../webp-fixture.js';
export default function Page() {
    const controller = useRef(null), canvas = useRef(null), currentUrl = useRef(null);
    const [status, setStatus] = useState('Ready'), [busy, setBusy] = useState(false), [url, setUrl] = useState(null);
    useEffect(() => {
        window.runNextWebpCase = options => exportWebpCase(options?.workerMode === 'package' ? {
            ...options, workerUrl: new URL('@grundyjs/canvas-take/webp/worker-runtime', import.meta.url), wasmUrl: new URL('@grundyjs/canvas-take/webp/codec.wasm', import.meta.url)
        } : options);
        return () => { delete window.runNextWebpCase; controller.current?.abort(); if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); };
    }, []);
    function clearResult() { if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); currentUrl.current = null; setUrl(null); }
    async function run(untilCancelled) {
        clearResult(); setBusy(true); controller.current = new AbortController(); let exporter;
        try {
            exporter = createWebpExporter({ encoder: createWebpWorkerEncoder(), plays: 3, signal: controller.current.signal, onProgress:p => setStatus(`${p.phase}: ${p.framesAccepted} frames, ${p.durationMs} ms`) });
            const ctx = canvas.current.getContext('2d');
            for (let i = 0; untilCancelled || i < 3; i++) {
                ctx.clearRect(0,0,7,3); ctx.fillStyle = ['red','rgba(0,255,0,.5)','transparent'][i % 3]; ctx.fillRect(0,0,7,3);
                await exporter.addFrame(canvas.current, !untilCancelled && i === 2 ? 2000 : 55);
            }
            const blob = await exporter.finish(); currentUrl.current = URL.createObjectURL(blob); setUrl(currentUrl.current); setStatus(`finished: 3 frames, 2110 ms, ${blob.size} bytes`);
        } catch(error) { clearResult(); setStatus(`${error.name}: ${error.message}`); }
        finally { exporter?.dispose(); controller.current = null; setBusy(false); }
    }
    return <main><h1>CanvasTake WebP · public Next.js imports</h1>
        <button disabled={busy} onClick={() => run(false)}>Export WebP</button>
        <button disabled={busy} onClick={() => run(true)}>Export until cancelled</button>
        <button disabled={!busy} onClick={() => controller.current?.abort()}>Cancel</button>
        <pre role="status">{status}</pre><canvas ref={canvas} width={7} height={3}/>
        {url && <p><a href={url} download="animation.webp">Download WebP</a><br/><img src={url} alt="Exported WebP"/></p>}
    </main>;
}
