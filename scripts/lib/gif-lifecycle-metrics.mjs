import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {parseGIF,decompressFrame} from 'gifuct-js';

export const median = values => {
    if (!values.length) return null;
    const sorted=[...values].sort((a,b)=>a-b), n=sorted.length;
    return (sorted[Math.floor((n-1)/2)]+sorted[Math.floor(n/2)])/2;
};
// Providers can emit allocator and process-total events separately. Count each PID once.
export function processMemory(events) {
    const processes=new Map();
    for(const event of events) {
        const totals=event.args?.dumps?.process_totals;
        if(!totals) continue;
        const read=key=>totals[key]===undefined?null:parseInt(totals[key],16);
        processes.set(event.pid,{pid:event.pid,privateFootprintBytes:read('private_footprint_bytes'),residentBytes:read('resident_set_bytes')});
    }
    assert.ok(processes.size,'Chromium returned no process memory totals');
    const rows=[...processes.values()];
    const sum=key=>rows.every(row=>Number.isFinite(row[key]))?rows.reduce((n,row)=>n+row[key],0):null;
    return{privateFootprintBytes:sum('privateFootprintBytes'),residentBytes:sum('residentBytes'),processes:rows};
}
export function validateResources(row) {
    const s=row.stats;
    assert.equal(s.created,1);assert.equal(s.disposed,1);
    assert.equal(s.listeners,0);assert.equal(s.abortListeners,0);assert.equal(row.timers,0);assert.equal(row.liveWorkers,0);assert.equal(row.cornerUnchanged,true);
    const worker=row.adapter==='worker';
    assert.equal(s.workersCreated,worker?1:0);assert.equal(s.terminateCalls,worker?1:0);assert.equal(s.transfers,s.detached);
    if(worker)assert.ok(s.transfers>0||row.mode==='prepare');
    assert.equal(s.finished,row.mode==='success'?1:0);
    assert.equal(row.outcome,row.mode==='success'?'finished':'aborted');
    assert.equal(row.state,row.outcome);
    if(row.mode!=='success'){
        const c=row.cancellation;
        for(const key of ['deliveryLagMs','settleAfterAbortMs','deadlineToSettleMs'])assert.ok(Number.isFinite(c[key])&&c[key]>=-0.5,key);
        assert.ok(c.abortAt>=c.armedAt);
    }
}
export function validateGif(bytes,{width,height,frames,fps}) {
    assert.equal(bytes.at(-1),0x3b,'GIF trailer');
    const parsed=parseGIF(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    assert.deepEqual([parsed.lsd.width,parsed.lsd.height],[width,height]);
    let count=0,durationMs=0;
    // Decode one frame at a time: do not retain seconds of RGBA patches in the Node harness.
    for(const frame of parsed.frames){
        if(!frame.image)continue;
        const decoded=decompressFrame(frame,parsed.gct,false);
        assert.deepEqual(decoded.dims,{top:0,left:0,width,height});
        assert.equal(decoded.pixels.length,width*height);
        assert.equal(decoded.delay,Math.round(1000/fps/10)*10);
        durationMs+=decoded.delay;count++;
    }
    assert.equal(count,frames);
    return{sha256:createHash('sha256').update(bytes).digest('hex'),decodedFrames:count,decodedDurationMs:durationMs};
}
export function slope(points) {
    const slopes=[];
    for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++)slopes.push((points[j]-points[i])/(j-i));
    return median(slopes);
}
export function summarize(rows) {
    const memory=[],cancellation=[],repeated=[];
    const groups=new Map();
    for(const row of rows){
        const key=[row.lane,row.adapter,row.width,row.height,row.frames,row.mode].join('/');
        if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
    }
    for(const group of groups.values()){
        const row=group[0],common={adapter:row.adapter,width:row.width,height:row.height,frames:row.frames,n:group.length};
        if(row.lane==='memory')memory.push({...common,seconds:row.frames/row.fps,
            peakPrivateDeltaBytes:median(group.map(r=>r.peakPrivateDeltaBytes)),peakPrivateBytes:median(group.map(r=>r.peakPrivateBytes)),
            heldPrivateDeltaBytes:median(group.map(r=>r.held.privateFootprintBytes-r.before.privateFootprintBytes)),
            releasedPrivateDeltaBytes:median(group.map(r=>r.after.privateFootprintBytes-r.before.privateFootprintBytes)),
            releasedHeapDeltaBytes:median(group.map(r=>r.after.heap.usedSize-r.before.heap.usedSize)),
            releasedBackingDeltaBytes:median(group.map(r=>r.after.heap.backingStorageSize-r.before.heap.backingStorageSize)),
            minSamples:Math.min(...group.map(r=>r.samples.length))});
        if(row.lane==='cancel')cancellation.push({...common,mode:row.mode,
            deliveryLagMs:median(group.map(r=>r.cancellation.deliveryLagMs)),settleAfterAbortMs:median(group.map(r=>r.cancellation.settleAfterAbortMs)),
            deadlineToSettleMs:median(group.map(r=>r.cancellation.deadlineToSettleMs)),
            rangeDeadlineToSettleMs:[Math.min(...group.map(r=>r.cancellation.deadlineToSettleMs)),Math.max(...group.map(r=>r.cancellation.deadlineToSettleMs))],
            framesAfterArm:median(group.map(r=>r.stats.accepted-r.cancellation.framesAtArm)),
            phaseAtAbort:group.map(r=>r.cancellation.phaseAtAbort)});
    }
    for(const adapter of ['sync','worker']){
        const group=rows.filter(r=>r.lane==='repeat'&&r.adapter===adapter);
        if(!group.length)continue;
        const metric=key=>group.map(r=>key(r.after));
        const describe=values=>({first:values[0],last:values.at(-1),range:[Math.min(...values),Math.max(...values)],theilSenBytesPerOperation:slope(values)});
        repeated.push({adapter,operations:group.length,successful:group.filter(r=>r.mode==='success').length,aborted:group.filter(r=>r.mode!=='success').length,
            privateFootprint:describe(metric(s=>s.privateFootprintBytes)),heap:describe(metric(s=>s.heap.usedSize)),backing:describe(metric(s=>s.heap.backingStorageSize))});
    }
    return{memory,cancellation,repeated};
}
export function markdownReport(data) {
    const {metadata,summary}=data,mb=bytes=>(bytes/2**20).toFixed(2),ms=value=>value.toFixed(2);
    const lines=['# GIF memory and cancellation benchmark','',`Status: ${data.status}. Started ${metadata.startedAt} (UTC).`,
        `${metadata.cpu}; ${metadata.os}; Chromium ${metadata.browser}; Node ${metadata.node}.`,
        `CanvasTake ${metadata.packageVersion}; commit ${metadata.commit}; dirty=${metadata.dirty}.`,
        `Settings: ${JSON.stringify(metadata.settings)}.`, '',
        'Private footprint is Chromium memory-infra summed once per process in this dedicated browser. It includes Worker/native allocations; it is not JS heap or a guaranteed physical-RAM/RSS reading.',
        'Peaks are sampled maxima, not exact allocation peaks. Each memory sample starts/ends a short trace to avoid accumulating trace buffers during an export. No forced GC during measured export/cancellation.',
        'Main-isolate JS heap/ArrayBuffer backing storage and forced-GC cleanup snapshots are separate, overlapping diagnostics, never added to the process total. Retained process memory can include allocator/JIT caches.', '',
        '| Resolution | GIF s | Adapter | n | Sampled peak Δ MiB | Peak total MiB | Held canvas/Blob Δ MiB (GC) | Released Δ MiB (GC) | Released JS Δ MiB | Released backing Δ MiB | Min samples |',
        '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |'];
    for(const r of summary.memory)lines.push(`| ${r.width}×${r.height} | ${r.seconds} | ${r.adapter} | ${r.n} | ${mb(r.peakPrivateDeltaBytes)} | ${mb(r.peakPrivateBytes)} | ${mb(r.heldPrivateDeltaBytes)} | ${mb(r.releasedPrivateDeltaBytes)} | ${mb(r.releasedHeapDeltaBytes)} | ${mb(r.releasedBackingDeltaBytes)} | ${r.minSamples} |`);
    lines.push('','Memory table values are medians across repeats, relative to each run\'s post-GC baseline. Instrumented export timings are not throughput benchmarks.','',
        '| Target phase | Resolution | Adapter | n | Delivery lag ms | Abort→settled ms | Deadline→settled ms | Deadline→settled range ms | Extra accepted frames |',
        '| --- | --- | --- | ---: | ---: | ---: | ---: | --- | ---: |');
    for(const r of summary.cancellation)lines.push(`| ${r.mode} | ${r.width}×${r.height} | ${r.adapter} | ${r.n} | ${ms(r.deliveryLagMs)} | ${ms(r.settleAfterAbortMs)} | ${ms(r.deadlineToSettleMs)} | ${r.rangeDeadlineToSettleMs.map(ms).join('–')} | ${r.framesAfterArm} |`);
    lines.push('','Cancellation runs have no memory sampling/tracing. Deadline is one millisecond after phase start, not when abort() finally executes. Sync work may complete before the timer can run. Worker encoding uses a marker immediately before the shipped codec handler. Prepare targets real full-frame getImageData/readback and the owned snapshot before the exporter yield. Blend observes the existing yield resolver immediately before compositing on an all-translucent gradient; it includes any subsequent work that blocks cancellation. The probe does not preempt JavaScript or add a yield inside the loop.','',
        '| Adapter | Operations (success/abort) | Post-GC private first→last MiB | JS first→last MiB | Backing first→last MiB | Backing slope bytes/op |',
        '| --- | --- | --- | --- | --- | ---: |');
    for(const r of summary.repeated)lines.push(`| ${r.adapter} | ${r.operations} (${r.successful}/${r.aborted}) | ${mb(r.privateFootprint.first)}→${mb(r.privateFootprint.last)} | ${mb(r.heap.first)}→${mb(r.heap.last)} | ${mb(r.backing.first)}→${mb(r.backing.last)} | ${r.backing.theilSenBytesPerOperation} |`);
    lines.push('','A finite repeated-session study cannot prove absence of leaks. Inspect raw checkpoints, ranges and slopes; process-cache retention alone is not evidence of an unreachable-buffer leak.',
        'Every completed GIF is independently LZW-decoded frame by frame, checked for count/durations/dimensions and compared by SHA-256 across adapters/repeats. Aborts must return AbortError/aborted state without a GIF. Every owned encoder is disposed once; Worker termination requests, actual destroyed targets, listener/timer cleanup and preserved source pixels are checked.',
        '',`32 MiB retention control: ${JSON.stringify(data.calibration)}.`,
        '',`Resource checks: ${data.rows.length} cases; browser errors: ${data.errors.length}.`,
        '',`Maximum memory-sample service time: ${ms(Math.max(0,...data.rows.flatMap(r=>(r.samples??[]).map(s=>s.sampleMs))))} ms. Sampling can perturb allocation/GC scheduling and miss short-lived buffers. No timing/memory thresholds are imposed in shared CI.`,
        '', 'Raw per-case checkpoints/samples are in results.json; scalar per-run results are in results.csv.');
    return lines.join('\n')+'\n';
}
