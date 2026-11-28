import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, existsSync} from "node:fs";

import {join} from "node:path";
import {fileURLToPath} from 'node:url';
import {realLenderFixture} from './helpers/v1-real-lender-fixture.mjs';
import {crashProcess} from './helpers/crash-process.mjs';
import {createLender} from '../lib/v1/lender.mjs';

const worker=fileURLToPath(new URL('./helpers/recovery-lender-child.mjs',import.meta.url));
test('G05 SIGKILL during execution, borrower cancel, restart reports cessation',{timeout:60000},async t=>{
  const f=await realLenderFixture(t);
  writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now()}));
  await crashProcess(t,worker,[f.root,'running','run'],'running');
  await f.owner.cancelJob(f.jobDigest);
  await crashProcess(t,worker,[f.root,'recovered','recover'],'recovered');
  assert.equal((await f.owner.getJob(f.jobDigest)).current_attempt.compute_stopped,true);
  assert.ok(existsSync(join(f.root,'recovered.json')));
});

test('G05 death before sending preserves the live stopped report during reconciliation',async t=>{
  const f=await realLenderFixture(t);
  const configure=()=>writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now(),liveStop:'failure'}));
  configure();
  await crashProcess(t,worker,[f.root,'stopped-before-send','run'],'stopped-before-send');
  const saved=JSON.parse(readFileSync(join(f.root,'app-home','v1','app-counters.json'),'utf8'));
  assert.ok(saved.pending);
  assert.ok(saved.stoppedPending);
  assert.equal(f.realRequests.filter(row=>row.url.endsWith('/stopped')).length,0);
  f.clock.advance(20000);configure();
  await crashProcess(t,worker,[f.root,'recovered','app-recover'],'recovered');
  const view=await f.owner.getJob(f.jobDigest);
  assert.equal(view.current_attempt.compute_stopped,true);
  assert.equal(view.current_attempt.stopped_at,saved.stoppedPending.stoppedAt);
  assert.deepEqual(f.realRequests.filter(row=>row.url.endsWith('/stopped')).map(row=>row.key),[saved.stoppedPending.idempotencyKey]);
});

test('G05 a failed stopped-journal save retains the execution owner',async t=>{
  const f=await realLenderFixture(t,{runError:Object.assign(new Error('execution failed'),{code:'execution_failed'})});
  const set=f.policy.storage.set;
  f.policy.storage.set=async value=>{
    if(value.stoppedPending)throw Object.assign(new Error('disk unavailable'),{code:'EIO'});
    return set(value);
  };
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,adapters:f.adapters,policy:f.policy,
    clock:f.clock,approve:async()=>true,credentialValues:async()=>[]});
  await assert.rejects(lender.start(),{code:'EIO'});
  assert.ok(f.saved().pending);
  assert.ok(f.saved().claimedPending);
  assert.equal(f.realRequests.filter(row=>row.url.endsWith('/stopped')).length,0);
});

for(const liveStop of ['cancel','failure'])test('G05 live '+liveStop+' retries the exact stopped report after Off restart',{timeout:60000},async t=>{
  let dropped=null;
  const f=await realLenderFixture(t,{intercept(req){
    if(dropped||!req.url.endsWith('/stopped'))return false;
    const chunks=[];
    req.on('data',chunk=>chunks.push(chunk));
    req.on('end',()=>{
      dropped={key:req.headers['idempotency-key'],body:JSON.parse(Buffer.concat(chunks))};
      req.socket.destroy();
    });
    return true;
  }});
  const configure=()=>writeFileSync(join(f.root,'crash-config.json'),JSON.stringify({origin:f.origin,now:f.clock.now(),liveStop,jobDigest:f.jobDigest}));
  configure();
  await crashProcess(t,worker,[f.root,'live-cleanup','run'],'live-cleanup');
  assert.ok(dropped,'the first stopped request was dropped before commit');
  const saved=JSON.parse(readFileSync(join(f.root,'live-cleanup.json'),'utf8'));
  assert.equal(saved.pending,null);
  assert.equal(saved.claimedPending,null);
  assert.equal((await f.owner.getJob(f.jobDigest)).current_attempt.compute_stopped,false);
  f.clock.advance(20000);configure();
  const requests=f.realRequests.length;
  await crashProcess(t,worker,[f.root,'recovered','app-recover'],'recovered');
  const view=await f.owner.getJob(f.jobDigest);
  assert.equal(view.current_attempt.compute_stopped,true);
  assert.equal(view.current_attempt.stopped_at,dropped.body.stopped_at);
  assert.equal(view.state,liveStop==='cancel'?'cancelled':'failed');
  const reports=f.realRequests.filter(row=>row.url.endsWith('/stopped'));
  assert.equal(reports.length,2);
  assert.deepEqual(reports.map(row=>row.key),[dropped.key,dropped.key]);
  assert.equal(reports[0].bodyDigest,reports[1].bodyDigest);
  assert.equal(saved.stoppedPending.stoppedAt,dropped.body.stopped_at);
  assert.equal(saved.stoppedPending.idempotencyKey,dropped.key);
  assert.equal(f.realRequests.slice(requests).some(row=>/\/(claim-next|start|renew)$/.test(row.url)),false);
  assert.equal(readFileSync(join(f.root,'executions'),'utf8'),'run\n');
  const settings=JSON.parse(readFileSync(join(f.root,'app-home','v1','app-settings.json'),'utf8'));
  assert.equal(settings.intent,'off');
});
