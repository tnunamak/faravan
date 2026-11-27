import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateService } from '../lib/v1/update-service.mjs';

test('manual check only checks and shares one in-flight request', async () => {
  let calls=0, finish;
  const pending=new Promise(resolve=>finish=resolve);
  const service=createUpdateService({currentVersion:'1.0.0',owner:'faravan',updater:{check:async()=>{calls++;await pending;return {current:'1.0.0',manifest:{version:'1.1.0',notes:'Fix reconnects\nKeep sessions\nImprove device access\nMore'}};}},now:()=>0});
  const a=service.check(), b=service.check();
  assert.equal(service.status().state,'checking');finish();await Promise.all([a,b]);
  assert.equal(calls,1);assert.equal(service.status().candidate,'1.1.0');
  assert.deepEqual(service.status().notes,['Fix reconnects','Keep sessions','Improve device access']);
  assert.equal(service.status().checkedAt,'1970-01-01T00:00:00.000Z');
});
test('package ownership is explicit and never contacts the release server', async()=>{
  const service=createUpdateService({owner:'apt',currentVersion:'1.0.0'});
  assert.equal((await service.check()).owner,'apt');assert.equal(service.status().automatic,false);
  assert.equal(service.status().state,'managed');
});
test('failed check keeps known candidate and never exposes raw error text', async()=>{
  let fail=false;
  const service=createUpdateService({owner:'faravan',updater:{check:async()=>{if(fail)throw new Error('/private/path secret');return {current:'1.0.0',manifest:{version:'1.1.0'}};}}});
  await service.check();fail=true;await service.check();
  assert.equal(service.status().candidate,'1.1.0');assert.equal(service.status().state,'failed');
  assert.doesNotMatch(JSON.stringify(service.status()),/private|secret/);
});
test('scheduled outcome names the blocking person and restart emits a candidate',async()=>{
  const service=createUpdateService({owner:'faravan',busy:()=>({person:'Ana'}),updater:{check:async()=>({current:'1.0.0',manifest:{version:'1.1.0'}}),tick:async()=> 'staged',intervalMs:1000},now:()=>0});
  await service.check();await service.tick({idle:false});
  assert.equal(service.status().waitingFor,'Ana');assert.equal(service.status().state,'staged');
  assert.equal(service.status().nextCheckAt,'1970-01-01T00:00:01.000Z');
});

test('a version that rolled back is explained rather than promised another automatic install',async()=>{
 const service=createUpdateService({owner:'faravan',updater:{tick:async()=> 'skipped-failed-version'}});
 await service.tick({idle:true});assert.equal(service.status().state,'rolled_back');assert.match(service.status().error,/did not start/);
});

test('after an update applied, the saved candidate this install has reached is not shown as available',async()=>{
 const saved={checkedAt:'2026-11-01T00:00:00.000Z',candidate:'0.9.2',notes:['Fix'],notesUrl:null};
 const service=createUpdateService({owner:'faravan',currentVersion:'0.9.2',updater:{status:async()=>saved}});
 const view=await service.restore();
 assert.equal(view.state,'idle');assert.equal(view.candidate,null);assert.deepEqual(view.notes,[]);
 const older=createUpdateService({owner:'faravan',currentVersion:'0.9.1',updater:{status:async()=>saved}});
 assert.equal((await older.restore()).state,'available');assert.equal(older.status().candidate,'0.9.2');
});

test('automatic legacy exposure refusal uses only fixed copy and clears after a fresh result', async () => {
  let outcome='failed', automaticFailure='legacy_exposure_pending';
  const service=createUpdateService({owner:'faravan',currentVersion:'1.0.0',updater:{
    tick:async()=>outcome,
    status:async()=>({candidate:'1.1.0',automaticFailure}),
  }});
  const copy='Review the saved legacy exposure before trying the update again. Your current version keeps running.';
  assert.equal(await service.tick({idle:true}),'failed');
  assert.equal(service.status().error,copy);
  assert.equal(service.status().state,'failed');
  assert.equal(service.status().currentVersion,'1.0.0');
  assert.equal(service.status().automaticFailure,undefined);
  outcome='too-soon';
  assert.equal(await service.tick({idle:true}),'too-soon');
  assert.equal(service.status().error,copy);
  outcome='staged';
  assert.equal(await service.tick({idle:false}),'staged');
  assert.equal(service.status().error,copy);
  outcome='current';
  automaticFailure=null;
  assert.equal(await service.tick({idle:true}),'current');
  assert.equal(service.status().error,null);
  assert.equal(service.status().state,'current');
  outcome='failed';
  automaticFailure='synthetic private provider error';
  await service.tick({idle:true});
  assert.equal(service.status().error,'The update could not be installed. Your current version keeps running.');
  assert.doesNotMatch(JSON.stringify(service.status()),/private provider|legacy_exposure_pending/);
});
