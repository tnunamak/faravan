import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join,dirname} from 'node:path';
import {barrier} from './crash-process.mjs';

const [directory]=process.argv.slice(2),events=[],fds=new Map();
const open=fs.openSync,sync=fs.fsyncSync,rename=fs.renameSync;
fs.openSync=(file,...args)=>{const fd=open(file,...args);fds.set(fd,String(file));return fd;};
fs.fsyncSync=fd=>{events.push(['sync',fds.get(fd)]);return sync(fd);};
fs.renameSync=(from,to)=>{events.push(['rename',String(from),String(to)]);return rename(from,to);};
syncBuiltinESMExports();
const {createOwnerSettings}=await import('../../lib/v1/owner-settings.mjs');
createOwnerSettings({directory}).set({by:'owner',reason:'lower limit',now:1,maxJobUsd:1});
// Evidence is outside the authoritative writer under test. SIGKILL happens after its acknowledgement.
fs.writeFileSync(join(dirname(directory),'cap-events.json'),JSON.stringify(events));
await barrier('cap-ack','cap-ack');
