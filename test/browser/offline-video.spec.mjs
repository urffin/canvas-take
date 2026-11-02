import { test, expect } from '@playwright/test';

test('offline controller snapshots a real canvas and releases injected adapters', async ({ page }) => {
    await page.goto('/');
    const result = await page.evaluate(async () => {
        const { createOfflineVideoExporter } = await import('/dist/video.js');
        const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 1;
        const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgba(255,0,0,0.5)'; ctx.fillRect(0,0,2,1);
        const resources = [], frames = [], events = [], progress = [];
        const config = { codec:'fixture', bitstreamFormat:'fixture', width:2, height:1, bitrate:1000 };
        const exporter = await createOfflineVideoExporter({ video:{ config, encoder:{
            checkSupport:async()=>({supported:true}), create(c, context) {
                const r={disposed:0,dispose(){this.disposed++;}}; resources.push(r);
                return {...r,dispose(){r.dispose();},async encodeFrame(frame){
                    frames.push([...frame.data]);
                    await context.output.write({type:'config',track:'video',config:{...c,color:{primaries:'bt709',transfer:'srgb',matrix:'rgb',fullRange:true}}});
                    await context.output.write({type:'packet',packet:{track:'video',timestampUs:frame.timestampUs,decodeTimestampUs:frame.timestampUs,durationUs:frame.durationUs,type:'key',data:new Uint8Array([1])}});
                },async flush(){await context.output.write({type:'end',track:'video'});}};
            }
        }}, muxer:{format:{mimeType:'video/x-test',extension:'test'},checkSupport:async()=>({supported:true}),create(){
            const r={disposed:0,dispose(){this.disposed++;}}; resources.push(r);
            return {dispose(){r.dispose();},async write(e){events.push(e);},async finalize(timeline){return new Blob([JSON.stringify(timeline)],{type:'video/x-test'});}};
        }}, onProgress:p=>progress.push(p),maxFramePixels:2,maxFrames:1,maxDurationUs:1000 });
        const pending=exporter.addFrame(canvas,{timestampUs:0,durationUs:1000}); ctx.clearRect(0,0,2,1);
        await pending; const output=await exporter.finish(); exporter.dispose();
        return {frames,events:events.map(e=>e.type),disposed:resources.map(r=>r.disposed),timeline:JSON.parse(await output.blob.text()),progress:progress.at(-1)};
    });
    // Browser canvas alpha storage can quantize 0.5 to 128/255.
    expect(result.frames[0][0]).toBe(255); expect(result.frames[0][3]).toBe(255);
    expect(result.frames[0][1]).toBeGreaterThanOrEqual(127); expect(result.frames[0][1]).toBeLessThanOrEqual(128);
    expect(result.disposed).toEqual([1,1]); expect(result.events).toEqual(['config','packet','end']);
    expect(result.timeline).toEqual({durationUs:1000,videoFrames:1}); expect(result.progress.phase).toBe('finished');
});
