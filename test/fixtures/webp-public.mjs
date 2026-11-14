import { createWebpExporter } from '@grundyjs/canvas-take/webp';
import { createWebpWorkerEncoder } from '@grundyjs/canvas-take/webp/worker';
export async function exportWebpCase(options = {}) {
    const width = 7, height = 3, delays = options.delays ?? [55, 70, 2000], plays = options.plays ?? 3;
    const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
    const frames = [], events = [];
    const exporter = createWebpExporter({ encoder: createWebpWorkerEncoder({ workerUrl: options.workerUrl, wasmUrl: options.wasmUrl }), plays, signal: options.signal,
        maxInputBytes: options.maxInputBytes ?? 4096, maxOutputBytes: options.maxOutputBytes ?? 1048576,
        onProgress(p) { events.push(p); options.onProgress?.(p); } });
    try {
        for (let i = 0; i < delays.length; i++) {
            context.clearRect(0, 0, width, height); context.fillStyle = ['red','rgba(0,255,0,.5)','rgba(0,0,255,0)'][i % 3]; context.fillRect(0, 0, width, height);
            frames.push({ duration: delays[i], data: [...context.getImageData(0, 0, width, height, { colorSpace: 'srgb' }).data] });
            const pending = exporter.addFrame(canvas, delays[i]); context.clearRect(0, 0, width, height); await pending;
        }
        const pending = exporter.finish(), same = pending === exporter.finish(), blob = await pending; exporter.dispose();
        const bytes = [...new Uint8Array(await blob.arrayBuffer())];
        return { width, height, delays, plays, type: blob.type, same, frames, events, bytes, decoded: await decodeWebp(bytes) };
    } catch(error) { if(options.signal?.aborted && error===options.signal.reason) throw error; throw new Error(error.message + ' / ' + error.cause?.message, {cause:error});
    } finally { exporter.dispose(); }
}
export async function decodeWebp(bytes) {
    const decoder = new ImageDecoder({data:Uint8Array.from(bytes),type:'image/webp',preferAnimation:true});
    try {
        await decoder.tracks.ready; const track = decoder.tracks.selectedTrack, frames=[];
        for(let i=0;i<track.frameCount;i++) {
            const {image} = await decoder.decode({frameIndex:i});
            try { const rgba=new Uint8Array(image.allocationSize({format:'RGBA'})); await image.copyTo(rgba,{format:'RGBA'}); frames.push({timestamp:image.timestamp,duration:image.duration,width:image.displayWidth,height:image.displayHeight,rgba:[...rgba]}); }
            finally {image.close();}
        }
        return {count:track.frameCount,repetitions:String(track.repetitionCount),frames};
    } finally {decoder.close();}
}
