const {parentPort}=require('node:worker_threads');
const file='/synthetic/slow.jsonl';
parentPort.postMessage({type:'progress',file,metadata:{provider:'claude',account:'claude'}});
parentPort.on('message',message=>{
  if(message.type==='started') parentPort.postMessage({type:'fileChunk',provisional:true,file,
    log:{provider:'claude',account:'claude',source:file,parsed:{usage:[{message_id:'partial'}],malformedLines:0}}});
});
