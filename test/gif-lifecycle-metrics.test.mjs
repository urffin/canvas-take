import {test} from 'node:test';
import assert from 'node:assert/strict';
import {processMemory,validateResources,validateGif,summarize} from '../scripts/lib/gif-lifecycle-metrics.mjs';
import {createGifencEncoder} from '../dist/gifenc.js';

test('process memory counts split providers once per PID and never substitutes zero for missing RSS',()=>{
    const event=(pid,totals)=>({pid,args:{dumps:{process_totals:totals}}});
    const result=processMemory([event(1,{private_footprint_bytes:'1000'}),{pid:1,args:{dumps:{allocators:{}}}},event(2,{private_footprint_bytes:'2000'}),event(1,{private_footprint_bytes:'1000'})]);
    assert.equal(result.privateFootprintBytes,12288);assert.equal(result.processes.length,2);assert.equal(result.residentBytes,null);
    assert.throws(()=>processMemory([]),/no process memory/);
    assert.equal(processMemory([event(1,{resident_set_bytes:'ff'})]).privateFootprintBytes,null);
});
test('cleanup checks detect an unterminated Worker, detached-buffer failure and leftover abort listener',()=>{
    const row={adapter:'worker',mode:'success',outcome:'finished',state:'finished',timers:0,liveWorkers:0,cornerUnchanged:true,
        stats:{created:1,disposed:1,listeners:0,abortListeners:0,workersCreated:1,terminateCalls:1,transfers:2,detached:2,finished:1}};
    validateResources(row);
    for(const change of[{terminateCalls:0},{detached:1},{abortListeners:1},{disposed:2}])assert.throws(()=>validateResources({...row,stats:{...row.stats,...change}}));
    assert.throws(()=>validateResources({...row,liveWorkers:1}));
});
test('independent decoding rejects a truncated file and wrong durations/counts; summaries retain growth',()=>{
    const encoder=createGifencEncoder({maxColors:4})({repeat:0});
    for(let i=0;i<2;i++)encoder.addFrame({width:2,height:2,durationMs:50,data:new Uint8ClampedArray(16).fill(255)});
    const bytes=encoder.finish();encoder.dispose();
    const options={width:2,height:2,frames:2,fps:20};assert.equal(validateGif(bytes,options).decodedDurationMs,100);
    assert.throws(()=>validateGif(bytes.subarray(0,-1),options),/trailer/);
    assert.throws(()=>validateGif(bytes,{...options,frames:3}));assert.throws(()=>validateGif(bytes,{...options,fps:10}));
    const rows=[0,1,2,3].map(cycle=>({lane:'repeat',adapter:'sync',mode:cycle%2?'encode':'success',after:{privateFootprintBytes:100+cycle*10,heap:{usedSize:40,backingStorageSize:cycle*1024}}}));
    const summary=summarize(rows).repeated[0];assert.equal(summary.backing.theilSenBytesPerOperation,1024);assert.equal(summary.successful,2);assert.equal(summary.aborted,2);
});
