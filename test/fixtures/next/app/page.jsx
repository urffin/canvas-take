'use client';
import { useRef, useState, useEffect } from 'react';
import { createGifExporter } from '@grundyjs/canvas-take/gif';
import { createGifWorkerEncoder } from '@grundyjs/canvas-take/gif/worker';

export default function Page() {
    const canvas = useRef(null), controller = useRef(null), currentUrl = useRef(null);
    const [status, setStatus] = useState('Ready'), [busy, setBusy] = useState(false), [url, setUrl] = useState(null);
    useEffect(() => () => { controller.current?.abort(); if (currentUrl.current) URL.revokeObjectURL(currentUrl.current); }, []);
    async function run() {
        setBusy(true);
        controller.current = new AbortController();
        let gif;
        try {
            gif = createGifExporter({ encoder: createGifWorkerEncoder(), signal: controller.current.signal,
                totalFrames: 121, onProgress: p => setStatus(`${p.phase}: ${p.framesEncoded}/${p.totalFrames}, ${p.durationMs} ms`) });
            const ctx = canvas.current.getContext('2d');
            for (let i = 0; i < 121; i++) {
                ctx.fillStyle = '#102030'; ctx.fillRect(0, 0, 800, 450);
                ctx.fillStyle = '#44ddaa'; ctx.fillRect(i * 5, 150, 100, 100);
                await gif.addFrame(canvas.current, i === 120 ? 2000 : 50);
            }
            const blob = await gif.finish();
            if (currentUrl.current) URL.revokeObjectURL(currentUrl.current);
            currentUrl.current = URL.createObjectURL(blob); setUrl(currentUrl.current);
            setStatus(`finished: 121 frames, 8000 ms, ${blob.size} bytes`);
        } catch (error) { setStatus(`${error.name}: ${error.message}`); }
        finally { gif?.dispose(); controller.current = null; setBusy(false); }
    }
    return <main><h1>CanvasTake · Next.js Worker integration</h1>
        <button disabled={busy} onClick={run}>Export GIF</button>
        <button disabled={!busy} onClick={() => controller.current?.abort()}>Cancel</button>
        <pre>{status}</pre><canvas ref={canvas} width={800} height={450}/>
        {url && <p><a href={url} download="worker.gif">Download GIF</a></p>}
    </main>;
}
