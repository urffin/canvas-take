import {provisionNodeVideoDestination} from '../../dist/internal/video-file-node.mjs';
const [root,name]=process.argv.slice(2),receiver=await provisionNodeVideoDestination(root,{trust:'controlled-local-directory'}),binding=receiver.bind(name);
const request={format:{mimeType:'video/mp4',extension:'mp4'},ifExists:'error',maxWriteBytes:4096,signal:new AbortController().signal};
const tx=await binding.destination.create(request);await tx.writeAt(0,new Uint8Array([7,7,7]),request.signal);await tx.truncate(3,request.signal);process.send({ready:true});
process.once('message',async()=>{try{const outcome=await tx.commit();if(outcome.status==='not-committed')await tx.abort(outcome.reason);await tx.release({publication:outcome.status});process.send({status:outcome.status,live:receiver.stats.liveHandles});process.disconnect();}catch(e){process.send({error:String(e)});process.disconnect();}});
