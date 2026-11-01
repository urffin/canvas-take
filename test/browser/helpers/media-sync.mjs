import ffmpeg from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';

const execute = promisify(execFile);
export async function delayAudio(path, output, milliseconds) {
    await execute(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-copyts', '-i', path,
        '-itsoffset', String(milliseconds / 1000), '-i', path, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', output],
    { maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
}
export async function decodeMarkers(path) {
    const run = args => execute(ffmpeg, ['-hide_banner', '-nostdin', '-copyts', '-i', path, ...args],
        { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    const [video, audio] = await Promise.all([
        run(['-map', '0:v:0', '-vf', 'scale=1:1,format=gray,showinfo', '-vsync', '0', '-f', 'rawvideo', 'pipe:1']),
        run(['-map', '0:a:0', '-af', 'aresample=48000,aformat=sample_fmts=flt:channel_layouts=mono,ashowinfo',
            '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'])
    ]);
    const videoFrames = video.stderr.toString().split('\n').filter(line => line.includes('Parsed_showinfo') && line.includes('pts_time:'))
        .map(line => Number(line.match(/pts_time:([\d.e+-]+)/)[1]) * 1000);
    assert.equal(videoFrames.length, video.stdout.length, 'Expected one gray byte per decoded video frame');
    const videoMarkersMs = [];
    let wasWhite = false;
    for (let i = 0; i < videoFrames.length; i++) {
        const white = video.stdout[i] > 200;
        if (white && !wasWhite) videoMarkersMs.push(videoFrames[i]);
        wasWhite = white;
    }
    let sampleOffset = 0;
    const audioFrames = audio.stderr.toString().split('\n').filter(line => line.includes('Parsed_ashowinfo') && line.includes('pts_time:'))
        .map(line => {
            const ptsMs = Number(line.match(/pts_time:([\d.e+-]+)/)[1]) * 1000;
            const count = Number(line.match(/nb_samples:(\d+)/)[1]);
            const frame = { sampleOffset, count, ptsMs }; sampleOffset += count; return frame;
        });
    assert.equal(sampleOffset * 4, audio.stdout.length, 'Expected one float32 per decoded mono sample');
    assert.ok(videoFrames.length > 0 && audioFrames.length > 0);
    const audioMarkersMs = [], step = 240; // 5 ms at the explicitly resampled 48 kHz.
    let wasLoud = false, frameIndex = 0;
    for (let i = 0; i + step <= sampleOffset; i += step) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += audio.stdout.readFloatLE((i + j) * 4) ** 2;
        const loud = Math.sqrt(sum / step) > 0.05;
        if (loud && !wasLoud) {
            while (frameIndex + 1 < audioFrames.length && audioFrames[frameIndex + 1].sampleOffset <= i) frameIndex++;
            const frame = audioFrames[frameIndex];
            audioMarkersMs.push(frame.ptsMs + (i - frame.sampleOffset) / 48);
        }
        wasLoud = loud;
    }
    const lastAudio = audioFrames.at(-1);
    return { audioMarkersMs, videoMarkersMs,
        videoCodec: video.stderr.toString().match(/Video:\s*(\w+)/)?.[1],
        audioCodec: audio.stderr.toString().match(/Audio:\s*(\w+)/)?.[1],
        audioStartMs: audioFrames[0].ptsMs, videoStartMs: videoFrames[0],
        audioEndMs: lastAudio.ptsMs + lastAudio.count / 48, videoLastFrameMs: videoFrames.at(-1),
        decodedVideoFrames: videoFrames.length, decodedAudioSamples: sampleOffset };
}
