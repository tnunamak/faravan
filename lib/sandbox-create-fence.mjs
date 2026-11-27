import fs from 'node:fs';
import path from 'node:path';
import {durableWrite} from './durable-write.mjs';

// Callers hold the record and name locks before publishing. The reservation is
// permanent: a timed-out daemon request can still land, but cannot reuse a name
// or acquire execution authority after its cleanup row has been released.
const valid=row=>/^[a-f0-9-]{36}$/.test(row?._cleanupId??'')&&/^wf-[a-f0-9]{16}$/.test(row?.sandbox_id??'')&&
  typeof row.owner_scope==='string'&&row.owner_scope.length>0&&typeof row.sbx_home==='string'&&path.isAbsolute(row.sbx_home)&&!/[\0\r\n]/.test(row.sbx_home);
const file=(directory,row)=>path.join(directory,row.sandbox_id+'.scope.reserved');
const matches=(saved,row)=>saved?.id===row._cleanupId&&saved.owner_scope===row.owner_scope&&saved.sbx_home===row.sbx_home&&
  (saved.sandbox_id===undefined||saved.sandbox_id===row.sandbox_id);
function read(directory,row) {
  const target=file(directory,row);
  try {
    if(fs.lstatSync(target).isSymbolicLink())throw Error('Unsafe sandbox name reservation.');
    return JSON.parse(fs.readFileSync(target,'utf8'));
  }catch(error){if(error.code==='ENOENT')return null;throw error;}
}
export function readAbandonedCreateFence(directory,row) {
  if(!valid(row))return null;
  const saved=read(directory,row);
  return matches(saved,row)&&(saved.abandoned_create===true||saved.retired_name===true)&&saved.sandbox_id===row.sandbox_id?saved:null;
}
export function persistAbandonedCreateFence(directory,row) {
  if(!valid(row))throw Error('Invalid abandoned sandbox binding.');
  const saved=read(directory,row);
  if(saved&&!matches(saved,row))throw Error('Sandbox name belongs to another create.');
  durableWrite(file(directory,row),JSON.stringify({...saved,id:row._cleanupId,owner_scope:row.owner_scope,sbx_home:row.sbx_home,
    sandbox_id:row.sandbox_id,abandoned_create:true}));
}
