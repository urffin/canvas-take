import {managedBrowserResultNamespace, openNativeBrowserResultPorts, openNativeBrowserResultStore} from '/dist/internal/video-browser-results-native.js';
import {openBrowserResultStore} from '/dist/internal/video-browser-results.js';
import {createExternalVideoExporter} from '/dist/internal/video-external.js';
import {createExternalMp4Muxer} from '/dist/internal/video-external-mp4.js';
import {createExternalWebmMuxer} from '/dist/internal/video-external-webm.js';
import {createWebCodecsVideoEncoder} from '/dist/video-webcodecs.js';
import {createWebCodecsAudioEncoder} from '/dist/video-opus.js';
import {createAacAudioEncoder} from '/dist/video-aac.js';
import {makeOfflinePcm} from '/pcm.mjs';

const live = {workers: 0, videoEncoders: 0, videoFrames: 0, audioEncoders: 0, audioData: 0,
    writers: 0, locks: 0, connections: 0, urls: 0};
for (const [name, key] of [['Worker','workers'], ['VideoEncoder','videoEncoders'], ['VideoFrame','videoFrames'],
    ['AudioEncoder','audioEncoders'], ['AudioData','audioData']]) {
    if (!globalThis[name]) continue;
    globalThis[name] = new Proxy(globalThis[name], {construct(Target, args) {
        const object = Reflect.construct(Target, args, Target);
        const method = name === 'Worker' ? 'terminate' : 'close';
        const close = object[method].bind(object);
        let closed = false;
        live[key]++;
        object[method] = () => { if (!closed) { live[key]--; closed = true; } return close(); };
        return object;
    }});
}

let store, scopeId, current, fileLease, download, abandoned;
const reason = new Error('Injected browser verification fault');
const cancellation = new Error('Requested cancellation');
const encode = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const hash = async file => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
    byte => byte.toString(16).padStart(2, '0')).join('');

// In fault cases abort the actual IDB transaction after its catalogue put request succeeds.
// The adapter must wait for the transaction event, not treat request success as commit.
let abortCataloguePut = false;
const nativePut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (...args) {
    const request = nativePut.apply(this, args);
    if (abortCataloguePut && this.name === 'catalogue' && args[1] === 'state') {
        abortCataloguePut = false;
        request.addEventListener('success', () => this.transaction.abort(), {once: true});
    }
    return request;
};

async function open(id, mode) {
    if (store) throw new Error('Store already open');
    const ports = await openNativeBrowserResultPorts(id, mode);
    const metadata = ports.metadata;
    const objects = ports.objects;
    const locks = ports.locks;
    const ui = ports.download;
    live.connections++;
    try {
        store = await openBrowserResultStore({...ports,
            metadata: {...metadata,
                async transact(label, body) {
                    const scenario = current?.scenario;
                    const outcome = await metadata.transact(label, state => {
                        const value = body(state);
                        if ((label === 'attempt.publish' && scenario === 'abort-publication') ||
                            (label === 'version.deleted' && scenario === 'abort-delete-marker')) abortCataloguePut = true;
                        return value;
                    });
                    if (label === 'attempt.publish' && scenario === 'lost-ack' && outcome.status === 'committed') {
                        return {status: 'indeterminate', reason};
                    }
                    return outcome;
                },
                async close() { await metadata.close(); live.connections--; }
            },
            objects: {...objects, async create(...args) {
                const writer = await objects.create(...args);
                live.writers++;
                let closed = false;
                const finished = () => { if (!closed) { live.writers--; closed = true; } };
                return {...writer,
                    async writeAt(...values) {
                        await writer.writeAt(...values);
                        const job = current;
                        if (job?.scenario === 'cancel-write' && !job.gated) {
                            job.gated = true;
                            await job.gate;
                        }
                    },
                    async close() { await writer.close(); finished(); },
                    async abort(error) { await writer.abort(error); finished(); }
                };
            }},
            locks: {...locks, async tryAcquire(...args) {
                const lease = await locks.tryAcquire(...args);
                if (!lease) return;
                live.locks++;
                let released = false;
                return {async release() {
                    await lease.release();
                    if (!released) { live.locks--; released = true; }
                }};
            }},
            download: {...ui,
                createURL(file) { const url = ui.createURL(file); live.urls++; return url; },
                revokeURL(url) { ui.revokeURL(url); live.urls--; }
            }
        });
        scopeId = id;
        return store.checkSupport();
    } catch (error) { await metadata.close(); live.connections--; throw error; }
}

function begin({kind, scenario, name = `movie.${kind}`, ifExists = 'error', samples = 108001, channels = 2}) {
    if (current) throw new Error('Previous operation retained');
    const binding = store.bind(name);
    const signal = new AbortController();
    const durationUs = Math.round(samples * 1e6 / 48000);
    const boundaries = [0, 33333, 100000, durationUs];
    const timings = boundaries.slice(0, -1).map((timestampUs, i) => ({timestampUs, durationUs: boundaries[i+1] - timestampUs}));
    let ungate;
    const gate = new Promise(resolve => { ungate = resolve; });
    const job = {scenario, gate, ungate, signal, gated: false, closed: false};
    current = job;
    const mp4 = kind === 'mp4';
    const exporter = createExternalVideoExporter({
        video: {encoder: createWebCodecsVideoEncoder(), config: {codec: mp4 ? 'avc1.42E01F' : 'vp8',
            bitstreamFormat: mp4 ? 'avc' : 'vp8', width: 90, height: 160, bitrate: 500000}},
        audio: {
            encoder: mp4 ? createAacAudioEncoder({workerUrl: new URL('/dist/video-aac-worker.js', location.href)}) : createWebCodecsAudioEncoder(),
            config: {codec: mp4 ? 'mp4a.40.2' : 'opus', bitstreamFormat: mp4 ? 'aac' : 'opus', sampleRate: 48000,
                numberOfChannels: channels, bitrate: channels === 1 ? 128000 : 192000},
            source: {sampleRate: 48000, channels: makeOfflinePcm(48000, channels, samples)}, endPolicy: 'error'
        },
        muxer: mp4 ? createExternalMp4Muxer() : createExternalWebmMuxer(),
        destination: binding.destination, ifExists, signal: signal.signal, maxPendingInputs: 2
    });
    job.exporter = exporter;
    void exporter.closed.then(() => { job.closed = true; });
    job.work = (async () => {
        let output, error, report;
        try {
            await exporter.ready;
            const canvas = new OffscreenCanvas(90, 160);
            const context = canvas.getContext('2d');
            for (const [i, timing] of timings.entries()) {
                context.fillStyle = ['red', 'green', 'blue'][i];
                context.fillRect(0, 0, canvas.width, canvas.height);
                await exporter.addFrame(canvas, timing);
            }
            output = await exporter.finish();
        } catch (e) { error = e; }
        finally { exporter.dispose(); report = await exporter.closed; }
        const observation = await store.recovery.inspect(binding.key);
        current = undefined;
        return {key: binding.key, ownerHold: binding.ownerHold, kind, samples, channels, timings, durationUs,
            success: !!output, message: String(error), exactCancellation: error === cancellation,
            publication: report.publication, cleanupIssues: report.cleanupIssues.map(issue => String(issue.reason)),
            historical: observation.publication.status, physicalIO: observation.physicalIO, staging: observation.staging,
            live: {...live}};
    })();
    // The driver may fetch this promise after the operation has already settled.
    void job.work.catch(() => {});
    lastWork = job.work;
    return {key: binding.key, ownerHold: binding.ownerHold};
}
let lastWork;
const stats = () => ({...live, store: store?.stats, gated: current?.gated, closed: current?.closed});
async function close() {
    const result = await store.close();
    if (result.status === 'closed') store = undefined;
    return result;
}
async function removeNamespace(id) {
    if (id !== scopeId || store) throw new Error('Open or foreign test namespace');
    const name = managedBrowserResultNamespace(id);
    await new Promise((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('Test indexedDB connections leaked'));
    });
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(name);
    if (JSON.stringify(await root.resolve(directory)) !== JSON.stringify([name])) throw new Error('Foreign root');
    await root.removeEntry(name, {recursive: true});
}

window.managed = {
    open, close, begin, wait: () => lastWork, stats, removeNamespace,
    async factoryLookup(name) {
        const reopened = await openNativeBrowserResultStore(scopeId, 'reopen');
        try { return await reopened.lookup(name); }
        finally { await reopened.close(); }
    },
    async hasObject(key) {
        const root = await navigator.storage.getDirectory();
        const directory = await root.getDirectoryHandle(managedBrowserResultNamespace(scopeId));
        for await (const name of directory.keys()) {
            if (name.startsWith('video-') && /\.(mp4|webm)$/.test(name) && name.split('.').at(-2) === key.attemptId) return true;
        }
        return false;
    },
    cancel() { current.signal.abort(cancellation); current.exporter.dispose(); },
    ungate() { current.ungate(); },
    lookup: name => store.lookup(name), inspect: key => store.inspectVersion(key),
    recover: async key => {
        const attempt = await store.recovery.inspect(key);
        const outcome = await store.recovery.recover(key, {expectedRevision: attempt.revision});
        return {status: outcome.status, code: outcome.code, publication: outcome.snapshot?.publication.status,
            physicalIO: outcome.snapshot?.physicalIO};
    },
    observe: async key => {
        const attempt = await store.recovery.inspect(key);
        return {publication: attempt.publication.status, receipt: attempt.publication.receipt?.status,
            current: attempt.currentTarget, physicalIO: attempt.physicalIO, staging: attempt.staging};
    },
    cleanup: async key => {
        const attempt = await store.recovery.inspect(key);
        const result = await store.recovery.cleanup(key, {expectedRevision: attempt.revision});
        return {status: result.status, code: result.reason?.code};
    },
    releaseHold: key => store.releaseHold(key),
    retain: key => store.retain(store.makeHoldKey(key)),
    async delete({key, revision, fault}) {
        if (fault) current = {scenario: 'abort-delete-marker'};
        try { return await store.deleteVersion(key, {expectedRevision: revision ?? (await store.inspectVersion(key)).revision}); }
        finally { current = undefined; }
    },
    async read(key) {
        if (fileLease) throw new Error('Previous file lease retained');
        const result = await store.acquireFile(key);
        if (result.status !== 'available') return {status: result.status, code: result.code};
        fileLease = result.value;
        try {
            const file = fileLease.file;
            return {status: 'available', size: file.size, name: file.name, type: file.type, hash: await hash(file)};
        } catch (error) { await fileLease.release(); fileLease = undefined; throw error; }
    },
    async chunk({offset, length}) { return encode(new Uint8Array(await fileLease.file.slice(offset, offset + length).arrayBuffer())); },
    async release() { await fileLease?.release(); fileLease = undefined; },
    async prepareDownload(key) {
        const result = await store.prepareDownload(key);
        if (result.status !== 'available') return {status: result.status, code: result.code};
        download = result.value;
        const button = document.querySelector('button');
        button.disabled = false;
        button.onclick = () => { window.managed.requested = download.request(); };
        return {status: result.status, name: download.fileName};
    },
    async disposeDownload() {
        const button = document.querySelector('button');
        button.onclick = null;
        button.disabled = true;
        await download?.dispose(); download = undefined;
    },
    async abandon(name) {
        const binding = store.bind(name);
        const signal = new AbortController().signal;
        const extension = name.split('.').at(-1);
        const context = {format: {extension, mimeType: `video/${extension}`}, ifExists: 'error', maxWriteBytes: 1024, signal};
        abandoned = await binding.destination.create(context);
        await abandoned.writeAt(0, new Uint8Array([1, 2, 3]), signal);
        return binding.key;
    }
};
