'use client';
import { useEffect, useRef, useState } from 'react';
import { createApngExporter } from '@grundyjs/canvas-take/apng';
import { createApngWorkerEncoder } from '@grundyjs/canvas-take/apng/worker';
import { exportCase } from '../apng-fixture.js';

export default function Page() {
    const canvas = useRef(null), controller = useRef(null), currentUrl = useRef(null);
    const [status, setStatus] = useState('Ready'), [busy, setBusy] = useState(false), [url, setUrl] = useState(null);
    useEffect(() => {
        window.runNextApngCase = options => exportCase(options?.workerMode === 'package'
            ? { ...options, workerUrl: new URL('@grundyjs/canvas-take/apng/worker-runtime', import.meta.url) } : options);
        return () => { delete window.runNextApngCase; controller.current?.abort(); if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); };
    }, []);
    function clearResult() { if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); currentUrl.current = null; setUrl(null); }
    async function run(untilCancelled) {
        clearResult(); setBusy(true); controller.current = new AbortController(); let exporter;
        try {
            exporter = createApngExporter({ encoder: createApngWorkerEncoder(), plays: 3, signal: controller.current.signal,
                onProgress: p => setStatus(`${p.phase}: ${p.framesAccepted} frames, ${p.durationMs} ms`) });
            const ctx = canvas.current.getContext('2d');
            for (let i = 0; untilCancelled || i < 3; i++) {
                ctx.clearRect(0, 0, 7, 3); ctx.fillStyle = ['#ff0000', '#00ff00', '#0000ff'][i % 3]; ctx.fillRect(0, 0, 7, 3);
                await exporter.addFrame(canvas.current, !untilCancelled && i === 2 ? 2000 : 55);
            }
            const blob = await exporter.finish(); currentUrl.current = URL.createObjectURL(blob); setUrl(currentUrl.current);
            setStatus('finished: 3 frames, 2110 ms');
        } catch (error) { clearResult(); setStatus(`${error.name}: ${error.message}`); }
        finally { exporter?.dispose(); controller.current = null; setBusy(false); }
    }
    return <main><h1>CanvasTake APNG · public Next.js imports</h1>
        <button disabled={busy} onClick={() => run(false)}>Export APNG</button>
        <button disabled={busy} onClick={() => run(true)}>Export until cancelled</button>
        <button disabled={!busy} onClick={() => controller.current?.abort()}>Cancel</button>
        <pre role="status">{status}</pre><canvas ref={canvas} width={7} height={3}/>
        {url && <p><a href={url} download="worker.apng">Download APNG</a><br/><img src={url} alt="Exported APNG"/></p>}
    </main>;
}
