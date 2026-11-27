import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {DockerSbxBackend} from '../lib/docker-backend.mjs';
import {withCleanCredentialScope} from './helpers/sbx-clean-scope.mjs';

const job={job_id:'r3-journal-durability',image:'wf-faravan-guest@sha256:0000000000000000000000000000000000000000000000000000000000000000',entrypoint:'true',
  execution_scope:'owner',
  resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:60,output_bytes:1024,network_bytes:1024,max_processes:16},
  inputs:[],output_manifest:[],egress:'internet',provider_hosts:['**.openai.com']};
const empty=withCleanCredentialScope(async args=>({code:0,stdout:args[0]==='ls'?'[]':'{"rules":[]}'}));

test('R3 the inherited durable writer syncs the cleanup record and directory before sandbox creation',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'r3-journal-order-')),directory=join(root,'journal'),events=[],fds=new Map();
  const open=fs.openSync,sync=fs.fsyncSync,rename=fs.renameSync;
  t.mock.method(fs,'openSync',(file,...args)=>{const fd=open(file,...args);fds.set(fd,String(file));return fd;});
  t.mock.method(fs,'fsyncSync',fd=>{events.push(['sync',fds.get(fd)]);return sync(fd);});
  t.mock.method(fs,'renameSync',(from,to)=>{events.push(['rename',String(to)]);return rename(from,to);});
  const backend=new DockerSbxBackend({cleanupDirectory:directory,runCommand:async args=>{if(args[0]==='create')events.push(['effect']);return empty(args);}});
  backend._configureEgress=async()=>{};
  const handle=await backend.prepare(job);
  const published=events.findIndex(row=>row[0]==='rename'&&row[1].startsWith(directory+'/')&&row[1].endsWith('.json'));
  const synced=events.findIndex(row=>row[0]==='sync'&&row[1]?.startsWith(directory+'/')&&row[1].endsWith('.tmp'));
  const directorySync=events.findIndex((row,index)=>index>published&&row[0]==='sync'&&row[1]===directory);
  assert.ok(synced>=0&&synced<published&&published<directorySync&&directorySync<events.findIndex(row=>row[0]==='effect'));
  await backend.destroy(handle);
});

test('R3 a failed record directory barrier dispatches no sandbox effect',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'r3-journal-fail-')),directory=join(root,'journal'),fds=new Map();let published=false,effects=0;
  const open=fs.openSync,sync=fs.fsyncSync,rename=fs.renameSync;
  t.mock.method(fs,'openSync',(file,...args)=>{const fd=open(file,...args);fds.set(fd,String(file));return fd;});
  t.mock.method(fs,'renameSync',(from,to)=>{const result=rename(from,to);if(String(to).startsWith(directory+'/')&&String(to).endsWith('.json'))published=true;return result;});
  t.mock.method(fs,'fsyncSync',fd=>{if(published&&fds.get(fd)===directory)throw Error('injected directory barrier failure');return sync(fd);});
  const backend=new DockerSbxBackend({cleanupDirectory:directory,runCommand:async args=>{if(args[0]==='run')effects++;return empty(args);}});
  await assert.rejects(backend.prepare(job),/directory barrier failure/);
  assert.equal(effects,0);assert.equal(backend.cleanupStatus().data_cleanup_pending,1);
});

test('R3 SIGKILL after record barriers leaves an owned obligation before the effect',{timeout:15000},async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'r3-journal-kill-')),directory=join(root,'journal');
  const child=spawn(process.execPath,['--input-type=module','-e',`
    import fs from 'node:fs';
    import {DockerSbxBackend} from ${JSON.stringify(new URL('../lib/docker-backend.mjs',import.meta.url).href)};
    import {withCleanCredentialScope} from ${JSON.stringify(new URL('./helpers/sbx-clean-scope.mjs',import.meta.url).href)};
    const directory=process.argv[1],fds=new Map(),open=fs.openSync,sync=fs.fsyncSync,rename=fs.renameSync;let published=false;
    fs.openSync=(file,...args)=>{const fd=open(file,...args);fds.set(fd,String(file));return fd;};
    fs.renameSync=(from,to)=>{const result=rename(from,to);if(String(to).startsWith(directory+'/')&&String(to).endsWith('.json'))published=true;return result;};
    fs.fsyncSync=fd=>{const result=sync(fd);if(published&&[directory,fs.realpathSync(directory)].includes(fds.get(fd))){process.send('record-durable');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return result;};
    const backend=new DockerSbxBackend({cleanupDirectory:directory,runCommand:withCleanCredentialScope(async()=>{throw Error('effect before barrier');})});
    await backend.prepare(${JSON.stringify(job)});
  `,directory],{stdio:['ignore','ignore','pipe','ipc']});
  const ended=once(child,'exit');t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;});
  await once(child,'message');child.kill('SIGKILL');await ended;
  const [name]=fs.readdirSync(directory).filter(name=>name.endsWith('.json'));
  const record=JSON.parse(fs.readFileSync(join(directory,name),'utf8'));
  assert.equal(fs.existsSync(record.scratch_dir),false);
  const next=new DockerSbxBackend({cleanupDirectory:directory,runCommand:empty});
  assert.equal(next.cleanupStatus().data_cleanup_pending,1);
  await next.reapCleanup();assert.equal(next.cleanupStatus().state,'clear');
});
