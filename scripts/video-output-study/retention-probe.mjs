import assert from 'node:assert/strict';
import {createPositionedReceiver} from './receiver.mjs';
if(!global.gc)throw Error('Run with --expose-gc');
const references=[];
const sink=createPositionedReceiver({writeAt(position,data){references.push(new WeakRef(data.buffer));},truncate(){},commit(){return 'retained';},abort(){}},{maxOutputBytes:2*1024*1024,maxWriteBytes:1024*1024});
const input=new Uint8Array(1024*1024);
for(let i=0;i<128;i++)await sink.writeAt(0,input);
async function collect(){for(let i=0;i<6;i++){global.gc();await new Promise(r=>setTimeout(r,0));}return references.filter(r=>r.deref()).length;}
const whileReady=await collect();await sink.finish('video/mp4');const afterCommit=await collect();
assert.equal(sink.stats.ownedBytes,0);assert.equal(sink.state,'committed');
console.log(JSON.stringify({writes:128,ownedBufferBytes:1024*1024,retainedReceiver:true,whileReady,afterCommit}));
assert.equal(whileReady,0);assert.equal(afterCommit,0);
