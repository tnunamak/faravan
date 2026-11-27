import fs from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {barrier} from './crash-process.mjs';
const [root,phase]=process.argv.slice(2),file=join(root,'mac-lock');
// Platform identity injection: the replacement PID is alive, with a different start.
Object.defineProperty(process,'platform',{value:'darwin'});
const read=fs.readFileSync,link=fs.readlinkSync;
fs.readFileSync=(file,...args)=>{if(String(file).startsWith('/proc/'))throw Object.assign(new Error('no proc'),{code:'ENOENT'});return read(file,...args);};
fs.readlinkSync=(file,...args)=>{if(String(file).startsWith('/proc/'))throw Object.assign(new Error('no proc'),{code:'ENOENT'});return link(file,...args);};
childProcess.execFileSync=(bin)=>bin==='/usr/sbin/sysctl'?'{ sec = 100, usec = 0 }':'Tue Oct 27 12:00:00 2026';
syncBuiltinESMExports();
if(phase==='create') {
  const token=randomUUID(),directory=file+'.owners-v1';fs.mkdirSync(directory);
  // Use the still-live test parent as a reused PID. Recovery must not signal it.
  const record={version:1,host:hostname(),namespace:null,pid:process.ppid,boot:'darwin:100',start:'1',token};
  fs.symlinkSync(JSON.stringify(record),join(directory,token+'.choosing'));
  fs.symlinkSync(JSON.stringify({...record,ticket:'1'}),join(directory,token+'.ticket'));
  await barrier('lock-published','lock-published');
} else {
  const {acquireProcessLockSync}=await import('../../lib/v1/lock.mjs');
  const release=acquireProcessLockSync(file);
  fs.writeFileSync(join(root,'lock-recovered'),'ok');release();
  await barrier('lock-recovered','lock-recovered');
}
