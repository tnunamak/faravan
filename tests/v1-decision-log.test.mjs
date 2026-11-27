import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createDecisionLog} from '../lib/v1/decision-log.mjs';
import {acquireProcessLock} from '../lib/v1/lock.mjs';

test('decision receipts retain the deciding identity, policy and time across restart',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'faravan-decisions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=createDecisionLog(dir),row={id:'review-1',kind:'job',decision:'accept',at:1234,circle:'friends',jobDigest:'sha256:'+'a'.repeat(64),
    decider:{deviceKey:'sha256:'+'b'.repeat(64),deviceName:'Laptop',person:'Sam'},source:'manual',configVersion:4};
  await log.record(row);
  row.decider.person='Changed';
  assert.equal((await createDecisionLog(dir).snapshot()).events[0].decider.person,'Sam');
  assert.equal((await log.snapshot()).events[0].at,1234);
  assert.equal((await log.snapshot()).events[0].configVersion,4);
  await log.record({...row,decision:'skip'});
  assert.equal((await log.snapshot()).events.length,1,'retry of same decision id preserves original receipt');
  assert.equal((await log.snapshot()).events[0].decision,'accept');
  assert.match(await readFile(join(dir,'decisions.json'),'utf8'),/Laptop/);
});

test('independent writers preserve receipts and explicit skips never become declines',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'faravan-decisions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const rows=['accept','decline','skip'].map((decision,i)=>({id:'decision-'+i,kind:'job',decision,at:i,circle:'c',source:'manual',decider:{deviceKey:'key',person:null,deviceName:'PC'}}));
  await Promise.all(rows.map(row=>createDecisionLog(dir).record(row)));
  assert.deepEqual((await createDecisionLog(dir).snapshot()).events.map(e=>e.decision).sort(),['accept','decline','skip']);
});

test('a writer waits out a holder that is still syncing instead of losing its receipt',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'faravan-decisions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  // Another writer holds the lock longer than the old 250 ms default wait, as a slow fsync does.
  const release=await acquireProcessLock(join(dir,'decisions.lock'));
  const held=setTimeout(release,600);t.after(()=>clearTimeout(held));
  const row={id:'decision-slow',kind:'job',decision:'accept',at:1,circle:'c',source:'manual',decider:{deviceKey:'key',person:null,deviceName:'PC'}};
  assert.equal(await createDecisionLog(dir).record(row),true);
  assert.deepEqual((await createDecisionLog(dir).snapshot()).events.map(e=>e.id),['decision-slow']);
});

test('an oversized receipt is refused instead of reporting success after evicting itself',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'faravan-decisions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const log=createDecisionLog(dir);
  await assert.rejects(log.record({id:'huge',kind:'standing_rule',decision:'create',at:1,decider:{deviceKey:'key'},rule:{id:'x'.repeat(4*1024*1024)}}));
  assert.equal((await log.snapshot()).events.length,0);
});

test('explicit lending mode choices have receipts even without a standing rule',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'faravan-decisions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const row={id:'ask-choice',kind:'lending_mode',decision:'update',at:1,circle:'friends',source:'manual',surface:'local-api',decider:{deviceKey:'key'},rule:{id:'lending-mode',mode:'ask'}};
  await createDecisionLog(dir).record(row);
  assert.deepEqual((await createDecisionLog(dir).snapshot()).events,[row]);
});
