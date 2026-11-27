import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function syncDirectory(directory) {
  const fd=fs.openSync(directory,'r');
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}

/** Private replacement, acknowledged only after bytes and directory entries are durable.
 * A failed barrier is an error, including on filesystems without directory fsync.
 * Callers serialize writers and must not publish effects after a failed save.
 */
export function durableWrite(file, bytes, {mode=0o600,io}={}) {
  const writer=io??{openSync:(...args)=>fs.openSync(...args),closeSync:fd=>fs.closeSync(fd),
    writeAllSync:(fd,data)=>{fs.writeFileSync(fd,data);fs.fchmodSync(fd,mode);},fsyncSync:fd=>fs.fsyncSync(fd),
    renameSync:(...args)=>fs.renameSync(...args),unlinkSync:file=>fs.unlinkSync(file),fsyncDirectory:syncDirectory};
  const directory=path.dirname(path.resolve(file));
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp';
  let fd,ownsTemporary=false;
  try {
    fd=writer.openSync(temporary,'wx',mode);ownsTemporary=true;
    writer.writeAllSync(fd,bytes);writer.fsyncSync(fd);
    writer.closeSync(fd);fd=undefined;
    writer.renameSync(temporary,file);ownsTemporary=false;writer.fsyncDirectory(directory);
    // A caller may have created an ancestor before entering this helper (for
    // example, to acquire its lock). Existing does not mean durably linked.
    let parent=path.dirname(directory);
    for(;;){writer.fsyncDirectory(parent);if(parent===path.dirname(parent))break;parent=path.dirname(parent);}
  } catch(error) {
    if(fd!==undefined)try{writer.closeSync(fd);}catch{}
    if(ownsTemporary)try{writer.unlinkSync(temporary);}catch{}
    throw error;
  }
}

export function durableJson(file,value) {durableWrite(file,JSON.stringify(value));}

// The app keeps disk waits asynchronous so Pause/Off can fence an in-flight
// settings change. Both entrypoints acknowledge the same persistence barriers.
export async function durableWriteAsync(file,bytes,{mode=0o600,io=fs.promises,publish}={}) {
  const directory=path.dirname(path.resolve(file));
  const sync=async dir=>{const handle=await io.open(dir,'r');try{await handle.sync();}finally{await handle.close();}};
  await io.mkdir(directory,{recursive:true,mode:0o700});
  const temporary=file+'.'+randomUUID()+'.tmp';
  let handle,ownsTemporary=false;
  try {
    handle=await io.open(temporary,'wx',mode);ownsTemporary=true;
    await handle.writeFile(bytes);await handle.chmod(mode);await handle.sync();
    await handle.close();handle=null;
    // The guarded callback performs the replacement itself, before returning to
    // the event loop. Private-file preparation and durability waits stay async.
    if(publish)await publish(()=>(io.renameSync??fs.renameSync)(temporary,file));
    else await io.rename(temporary,file);
    ownsTemporary=false;await sync(directory);
    let parent=path.dirname(directory);
    for(;;){await sync(parent);if(parent===path.dirname(parent))break;parent=path.dirname(parent);}
  } catch(error) {
    if(handle)try{await handle.close();}catch{}
    if(ownsTemporary)try{await io.unlink(temporary);}catch{}
    throw error;
  }
}
export async function durableJsonAsync(file,value,options){await durableWriteAsync(file,JSON.stringify(value),options);}
