import {spawnSbxChild} from './docker-backend.mjs';
import {restoreSbxRuntime,nonSbxCommand} from './sbx-runtime.mjs';
// The parent writes and fsyncs this process's identity before it sends start.
// execve keeps the PID and start identity when the actual writer takes over.
process.on('disconnect', () => process.exit(1));
process.on('message', message => {
  if (typeof process.execve !== 'function') process.exit(1);
  if(message?.start===true){
    const runtime=restoreSbxRuntime(message.runtime,{env:process.env,cleanup:message.runtime.purpose==='cleanup'});
    spawnSbxChild(runtime,process.argv.slice(3),{mode:'execve',env:process.env});
    process.exit(1);
  }
  if(message!=='start')process.exit(1);
  nonSbxCommand(process.argv[2]);
  process.execve('/usr/bin/env', ['/usr/bin/env', ...process.argv.slice(2)], process.env);
});
