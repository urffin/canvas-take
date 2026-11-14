import {createOfflineVideoExporter} from '../../src/video.ts';
import {createMp4Muxer} from '../../src/video-mp4.ts';
import {createWebmMuxer} from '../../src/video-webm.ts';
export {createWebCodecsVideoEncoder} from '../../src/video-webcodecs.ts';
export {createPositionedReceiver} from './receiver.mjs';
export {createOfflineVideoExporter};
export function createStudyMuxer(kind,receiver) {
    const factory=kind==='mp4'?createMp4Muxer():createWebmMuxer();
    return {...factory,create(config,context){return factory.create(config,{...context,__prototypeReceiver:receiver});}};
}
