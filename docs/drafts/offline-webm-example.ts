// Compile-only usage: explicit providers, caller-owned canvas and prepared 48 kHz narration.
import {createOfflineVideoExporter} from '@grundyjs/canvas-take/video';
import {createWebCodecsVideoEncoder} from '@grundyjs/canvas-take/video/webcodecs';
import {createWebCodecsAudioEncoder} from '@grundyjs/canvas-take/video/opus';
import {createWebmMuxer} from '@grundyjs/canvas-take/video/webm';
declare const canvas:HTMLCanvasElement;
declare const narration:Float32Array;
declare function drawFrame(index:number):void;
export async function exportWebm(signal:AbortSignal){
    const exporter=await createOfflineVideoExporter({
        video:{encoder:createWebCodecsVideoEncoder(),config:{codec:'vp8',bitstreamFormat:'vp8',width:1080,height:1920,bitrate:8_000_000}},
        audio:{encoder:createWebCodecsAudioEncoder(),config:{codec:'opus',bitstreamFormat:'opus',sampleRate:48000,numberOfChannels:1,bitrate:128000},source:{sampleRate:48000,channels:[narration]},endPolicy:'error'},
        muxer:createWebmMuxer(),signal,maxFrames:300,maxDurationUs:10_000_000,maxOutputBytes:64_000_000
    });
    try{
        const boundary=(i:number)=>Math.round(i*1e6/30);
        for(let i=0;i<300;i++){
            drawFrame(i);await exporter.addFrame(canvas,{timestampUs:boundary(i),durationUs:boundary(i+1)-boundary(i)});
        }
        return await exporter.finish();
    }finally{exporter.dispose();}
}
