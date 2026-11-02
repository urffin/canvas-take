// Pinned Mediabunny 1.65.0 integration changes, included in distributed sourcesContent.
// Keep node_modules pristine; fail the build if an upstream anchor changes.
export function patchWebmMuxer(source) {
    function once(from,to) {
        if(source.split(from).length!==2)throw new Error('Pinned WebM muxer anchor changed: '+from.slice(0,75));
        source=source.replace(from,to);
    }
    once('{ id: EBMLId.TimestampScale, data: 1e6 }','{ id: EBMLId.TimestampScale, data: 1000 }');
    once('Math.round(cue.timestamp * 1000)','Math.round(cue.timestamp * 1e6)');
    once('Math.round(1000 * chunk.timestamp)','Math.round(1e6 * chunk.timestamp)');
    once('1000 * (this.format._options.minimumClusterDuration ?? 1)','1e6 * (this.format._options.minimumClusterDuration ?? 1)');
    once('Math.round(1000 * chunk.duration));','Math.round(1e6 * chunk.duration));');
    once('Math.round(1000 * chunk.duration);','Math.round(1e6 * chunk.duration);');
    once('clusterMsTimestamp / 1000','clusterMsTimestamp / 1e6');
    once('trackData.chunkQueue.push(audioChunk);','audioChunk.canvastakeDiscardPaddingNs = packet.canvastakeDiscardPaddingNs ?? 0;\n            trackData.chunkQueue.push(audioChunk);');
    once('const needsBlockGroup = !!chunk.additions','const needsBlockGroup = !!chunk.canvastakeDiscardPaddingNs || !!chunk.additions');
    once('msDuration > 0 ? { id: EBMLId.BlockDuration, data: msDuration } : null,','msDuration > 0 ? { id: EBMLId.BlockDuration, data: msDuration } : null,\n                chunk.canvastakeDiscardPaddingNs ? { id: 0x75A2, data: new EBMLSignedInt(chunk.canvastakeDiscardPaddingNs) } : null,');
    once('this.endTimestamp = Math.max(this.endTimestamp, msTimestamp + Math.round(1e6 * chunk.duration));',
        'this.endTimestamp = Math.max(this.endTimestamp, Math.round(1e6 * (chunk.timestamp + chunk.duration - (trackData.type === "audio" ? trackData.info.codecDelay ?? 0 : 0) - (chunk.canvastakeDiscardPaddingNs ?? 0) / 1e9)));');
    once('createInternalChunk(data, timestamp, duration, type, additions = null) {',
        'createInternalChunk(data, timestamp, duration, type, additions = null) {\n        const cost = data.byteLength + (additions?.byteLength ?? 0) + 64;\n        if (cost > this.format.canvastakeMaxPendingBytes - (this.canvastakeQueuedBytes ?? 0)) throw new RangeError("WebM maxPendingBytes staging budget exceeded");\n        this.canvastakeQueuedBytes = (this.canvastakeQueuedBytes ?? 0) + cost;');
    once('this.ebmlWriter.writeEBML(cluster);\n        this.currentClusterBlocks = [];',
        'this.ebmlWriter.writeEBML(cluster);\n        this.canvastakeQueuedBytes -= this.currentClusterBlocks.reduce((sum, { chunk }) => sum + chunk.data.byteLength + (chunk.additions?.byteLength ?? 0) + 64, 0);\n        this.currentClusterBlocks = [];');
    return source;
}
