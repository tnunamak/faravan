import {spawn} from 'node:child_process';

// The parent, not an exception inside the worker, kills the process at an IPC barrier.
export function crashProcess(t, script, args, boundary) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--trace-sigint',script,...args],{stdio:['ignore','pipe','pipe','ipc']});
    let stderr='',hit=false;
    child.stderr.on('data',chunk=>stderr+=chunk);
    child.stdout.on('data',()=>{});
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Crash barrier timed out: '+boundary+'\n'+stderr));},20000);
    t.after(()=>{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
    child.on('error',reject);
    child.on('message',message=>{
      if(message.boundary===boundary){hit=true;child.kill('SIGKILL');}
    });
    child.on('exit',(code,signal)=>{
      clearTimeout(timer);
      if(hit&&signal==='SIGKILL')resolve({signal});
      else reject(new Error(`Worker exited ${code}/${signal} before ${boundary}\n${stderr}`));
    });
  });
}

export async function barrier(name, selected) {
  if(name!==selected)return;
  process.channel.ref();
  // Freeze instead of parking: the old await-never left the event loop
  // live, so in-flight async work could advance past this boundary before
  // the parent's SIGKILL arrived. The send callback fires once the boundary
  // is flushed; Atomics.wait then blocks the main thread, so no further
  // event-loop turn runs before the kill. SIGKILL still ends the process.
  await new Promise(resolve=>{
    process.send({boundary:name},()=>{
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      resolve();
    });
  });
}
