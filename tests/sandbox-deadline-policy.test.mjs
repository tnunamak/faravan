import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policy from '../lib/sandbox-deadline.mjs';
import {createSandboxCleanupJournal} from '../lib/sandbox-cleanup-journal.mjs';

const clock={wall:10_000,boot_id:'boot-one',boot_ms:4000};
const deadline={deadline_at:70_000,deadline_clock:{version:1,boot_id:'boot-one',boot_at:64_000}};

test('deadline clocks cap rollback, suspend, boundaries and a different boot',()=>{
  assert.equal(typeof policy.sandboxDeadlineRemaining,'function');
  for(const [observed,left] of [
    [clock,60_000],
    [{...clock,wall:5000,boot_ms:14_000},50_000],
    [{...clock,wall:80_000},60_000],
    [{...clock,boot_ms:64_000},0],
    [{...clock,boot_ms:100_000},0],
    [{...clock,boot_id:'another-boot'},0],
  ])assert.equal(policy.sandboxDeadlineRemaining(deadline,observed),left);
});

function journal(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'deadline-policy-'));
  const directory=path.join(root,'journal'),scratchRoot=path.join(root,'scratch');
  fs.mkdirSync(scratchRoot);
  const home=path.join(root,'sbx-home');
  const store=createSandboxCleanupJournal({directory,scratchRoot:()=>scratchRoot,home:()=>home,destroy:async()=>({removed:false})});
  const handle=()=>({job_id:'job',sandbox_id:'wf-1111111111111111',sbx_home:home,
    scratch_dir:path.join(scratchRoot,'wf-job-wf-1111111111111111-data'),...structuredClone(deadline)});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root,directory,store,handle};
}

test('malformed deadline metadata cannot create a durable reservation',t=>{
  const {store,handle}=journal(t);
  for(const change of [
    {deadline_at:NaN},
    {deadline_clock:{version:2,boot_id:'boot-one',boot_at:64_000}},
    {deadline_clock:{version:1,boot_id:null,boot_at:64_000}},
    {deadline_clock:{version:1,boot_id:'boot-one',boot_at:-1}},
  ])assert.throws(()=>store.register({...handle(),...change}),/deadline/i);
});

test('a durable deadline cannot be refreshed by later record updates',t=>{
  const {store,handle}=journal(t),h=handle();store.register(h);
  assert.throws(()=>store.mark(h,{deadline_at:h.deadline_at+1000}),/immutable/i);
  assert.throws(()=>store.mark(h,{deadline_clock:{...h.deadline_clock,boot_at:h.deadline_clock.boot_at+1000}}),/immutable/i);
  assert.equal(store.authority(h).deadline_at,h.deadline_at);
});

test('an old action can never target a reused physical sandbox name',t=>{
  const {store,handle}=journal(t),first=handle();
  store.register(first);store.mark(first,{create:'dispatched',compute_created:true,create_settled:true});
  store.finish(first,{removed:true,sbx_home:first.sbx_home,scratch_removed:true,policy_removed:true});
  assert.equal(store.closed(first),true);
  assert.throws(()=>store.register({...handle(),job_id:'next-job'}),/name.*reserved|name.*used/i);
});

test('unfinished cleanup updates fsync the record and its directory',t=>{
  const {directory,store,handle}=journal(t),h=handle();store.register(h);
  const open=fs.openSync,sync=fs.fsyncSync,opened=new Map(),synced=[];
  t.mock.method(fs,'openSync',(...args)=>{const fd=open(...args);opened.set(fd,String(args[0]));return fd;});
  t.mock.method(fs,'fsyncSync',fd=>{synced.push(opened.get(fd));return sync(fd);});
  store.finish(h,{removed:false,scratch_removed:false,policy_removed:false});
  assert.ok(synced.includes(path.join(directory,h._cleanupId+'.json')));
  assert.ok(synced.includes(directory));
});

for(const failure of ['write','file sync','directory sync'])test('reservation '+failure+' failure dispatches no compute',t=>{
  const {directory,store,handle}=journal(t),h=handle();
  if(failure==='write')t.mock.method(fs,'writeFileSync',()=>{throw Error('injected write failure');});
  else {
    const open=fs.openSync,sync=fs.fsyncSync,opened=new Map();
    t.mock.method(fs,'openSync',(...args)=>{const fd=open(...args);opened.set(fd,String(args[0]));return fd;});
    t.mock.method(fs,'fsyncSync',fd=>{
      const file=opened.get(fd);
      if(failure==='file sync'?file?.endsWith('.json'):file===directory)throw Error('injected sync failure');
      return sync(fd);
    });
  }
  assert.throws(()=>store.register(h),/injected/);
  assert.equal(h._cleanupId,undefined);
});

test('failed removal-directory sync cannot permit name reuse',t=>{
  const {directory,store,handle}=journal(t),h=handle();store.register(h);
  const open=fs.openSync,sync=fs.fsyncSync,opened=new Map();
  t.mock.method(fs,'openSync',(...args)=>{const fd=open(...args);opened.set(fd,String(args[0]));return fd;});
  t.mock.method(fs,'fsyncSync',fd=>{if(opened.get(fd)===directory)throw Error('injected removal sync failure');return sync(fd);});
  assert.throws(()=>store.finish(h,{removed:true,sbx_home:h.sbx_home,scratch_removed:true,policy_removed:true}),/injected/);
  t.mock.restoreAll();
  assert.throws(()=>store.register({...handle(),job_id:'replacement'}),/name.*reserved/i);
});
