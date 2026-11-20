import {createExternalVideoExporter} from '@grundyjs/canvas-take/video';
import {openBrowserVideoResultStore} from '@grundyjs/canvas-take/video/browser';
import {createMp4Muxer} from '@grundyjs/canvas-take/video/mp4';
import {createWebmMuxer} from '@grundyjs/canvas-take/video/webm';
import {createAacAudioEncoder} from '@grundyjs/canvas-take/video/aac';
import {createWebCodecsAudioEncoder} from '@grundyjs/canvas-take/video/opus';
import {createWebCodecsVideoEncoder} from '@grundyjs/canvas-take/video/webcodecs';
import {makeOfflinePcm} from './offline-audio-input.mjs';

export function attachExternalVideoFixture(workerUrl) {
    const NativeWorker = window.Worker;
    const workers = {opened: 0, closed: 0};
    window.Worker = class extends NativeWorker {
        #closed = false;
        constructor(url, options) {
            if (new URL(url, window.location.href).href !== workerUrl.href) throw Error('Unexpected AAC Worker URL');
            super(url, options);
            workers.opened++;
        }
        terminate() {
            if (!this.#closed) { workers.closed++; this.#closed = true; }
            super.terminate();
        }
    };
    window.runPublicExternalVideo = async kind => {
        const stage = step => { window.externalVideoStage = `${kind}: ${step}`; };
        const clock = [0, 33_333, 100_000];
        const samples = 48_001;
        const durationUs = Math.round(samples * 1e6 / 48000);
        const timings = clock.map((timestampUs, i) => ({timestampUs, durationUs: (clock[i + 1] ?? durationUs) - timestampUs}));
        const mp4 = kind === 'mp4';
        const scopeId = crypto.randomUUID();
        stage('open store');
        let store = await openBrowserVideoResultStore({scopeId, mode: 'create'});
        const name = `movie.${kind}`;

        async function exportAttempt(cancel) {
            const attempt = cancel ? 'cancel' : 'retry';
            const binding = store.bind(name);
            const source = new AbortController();
            const reason = new Error('Cancel during the first positioned write');
            const adapter = binding.destination;
            let ready = false;
            const destination = cancel ? {...adapter, async create(context) {
                const transaction = await adapter.create(context);
                return {...transaction, async writeAt(position, bytes, signal) {
                    await transaction.writeAt(position, bytes, signal);
                    if (ready) source.abort(reason);
                }};
            }} : adapter;
            const exporter = createExternalVideoExporter({
                video: {encoder: createWebCodecsVideoEncoder(), config: {codec: mp4 ? 'avc1.42E01F' : 'vp8',
                    bitstreamFormat: mp4 ? 'avc' : 'vp8', width: 90, height: 160, bitrate: 500_000}},
                audio: {encoder: mp4 ? createAacAudioEncoder({workerUrl}) : createWebCodecsAudioEncoder(),
                    config: {codec: mp4 ? 'mp4a.40.2' : 'opus', bitstreamFormat: mp4 ? 'aac' : 'opus',
                        sampleRate: 48000, numberOfChannels: 1, bitrate: 128_000},
                    source: {sampleRate: 48000, channels: makeOfflinePcm(48000, 1, samples)}, endPolicy: 'error'},
                muxer: mp4 ? createMp4Muxer({output: 'external'}) : createWebmMuxer({output: 'external'}),
                destination, signal: source.signal, maxPendingInputs: 2
            });
            let outcome, error;
            try {
                stage(`${attempt}: ready`);
                await exporter.ready;
                ready = true;
                const canvas = new OffscreenCanvas(90, 160);
                const ctx = canvas.getContext('2d');
                for (const [i, timing] of timings.entries()) {
                    stage(`${attempt}: frame ${i}`);
                    ctx.fillStyle = ['#ff0000', '#00ff00', '#0000ff'][i];
                    ctx.fillRect(0, 0, 90, 160);
                    await exporter.addFrame(canvas, timing);
                }
                stage(`${attempt}: finish`);
                outcome = await exporter.finish();
            } catch (caught) { error = caught; }
            finally { exporter.dispose(); }
            stage(`${attempt}: closed`);
            const closed = await exporter.closed;
            stage(`${attempt}: inspect`);
            const recovered = await store.recovery.inspect(binding.key);
            if (closed.cleanupIssues.length) throw Error(`Cleanup issue: ${String(closed.cleanupIssues[0].reason)}`);
            if (!cancel && error) throw error;
            if (cancel && (error !== reason || outcome || closed.publication !== 'not-committed' || recovered.staging !== 'absent')) {
                throw Error(`Expected write cancellation: ${String(error)} (${closed.publication}, ${recovered.staging})`);
            }
            return {outcome, publication: closed.publication, recovered: recovered.publication.status};
        }

        try {
            const cancelled = await exportAttempt(true);
            if (await store.lookup(name)) throw Error('Cancellation published a result');
            const retry = await exportAttempt(false);
            const value = retry.outcome.output.value;
            stage('reopen store');
            if ((await store.close()).status !== 'closed') throw Error('Connections remained busy after export');
            store = await openBrowserVideoResultStore({scopeId, mode: 'reopen'});
            if ((await store.lookup(name))?.key.attemptId !== value.key.attemptId) throw Error('Committed selection was lost');
            const lease = await store.acquireFile(value.key);
            if (lease.status !== 'available') throw Error('Reopened File lease unavailable');
            try {
                stage('read file');
                const file = lease.value.file;
                if (file.name !== name || file.type !== `video/${kind}` || file.size !== value.size) throw Error('Wrong File metadata');
                const data = new Uint8Array(await file.arrayBuffer());
                return {kind, timings, samples, durationUs, bytes: Array.from(data),
                    cancelled: cancelled.publication, publication: retry.publication, recovered: retry.recovered, workers: {...workers}};
            } finally { await lease.value.release(); }
        } finally { if ((await store.close()).status !== 'closed') throw Error('File lease remained open'); }
    };
}
