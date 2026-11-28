import fs from 'node:fs';
import {dirname,join} from 'node:path';
import {configHome,saveJsonFile} from '../local-state.mjs';
import {acquireProcessLockSync,profileWriterLockPath} from './lock.mjs';

export function residentQuit(home=configHome()) {
  try {return JSON.parse(fs.readFileSync(join(home,'v1','resident-intent.json'),'utf8')).quit!==false;}
  catch(error){if(error.code==='ENOENT')return false;return true;}
}
export function setResidentQuit(quit,home=configHome()) {
  // Clearing Quit is how every start begins. Uninstall holds the profile gate from its stop read-back to the last
  // deletion, so a start that meets it ends here with a message instead of running under the removal.
  let release;
  if(quit===false) {
    const lock = profileWriterLockPath(home);
    const deadline = performance.now() + 2000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!release) {
      try {release=acquireProcessLockSync(lock,{durable:false});}
      catch(error) {
        if(error.code!=='lock_busy')throw error;
        const remaining = deadline - performance.now();
        if(remaining <= 0)throw Object.assign(new Error('Faravan is being removed or changed right now, so it was not started. Wait a minute, then try again.'),{code:'device_busy'});
        Atomics.wait(sleeper, 0, 0, Math.min(25, remaining));
      }
    }
  }
  try {saveJsonFile(join(home,'v1','resident-intent.json'),{version:1,quit},{base:dirname(home)});}
  finally {release?.();}
}
