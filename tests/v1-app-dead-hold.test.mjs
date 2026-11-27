import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {createOpsClient} from '../lib/v1/ops/execute.mjs';
import {runOpsCommand} from '../lib/v1/ops/cli.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

test('owner recovery requires confirmation, refuses unknown inventory and logs its full-charge intent', {timeout:60000}, async t=>{
  const f=await appFixture(t),now=Date.now();
  const source=createSyntheticPace50Source({start:now});
  const first=await f.start('dead-hold',{lendingPace50:{source,account_week_id:'synthetic-week-1'}});
  const account=first.app.device.keyId;
  await first.app.close();
  const pace=createPace50Candidate({directory:join(first.home,'v1'),now:()=>now,account,account_week_id:'synthetic-week-1',source});
  const grant=await pace.candidate.reserve({attemptId:'dead',jobId:'job',provider:'claude',model:'claude-haiku-5-5',
    job:{requirements:{limits:{wall_seconds:300}},expires_at:new Date(now+3600000).toISOString()},automatic:true,ownerAbsent:true});
  assert.equal(grant.ok,true,JSON.stringify(grant));
  await pace.candidate.started('dead',{ok:true});await pace.adapter.close();
  const restarted=await f.start('dead-hold',{lendingPace50:{source,account_week_id:'synthetic-week-1'}});
  const {app,backend}=restarted;
  const row=()=>JSON.parse(fs.readFileSync(join(first.home,'v1','lending-pace50-state.json'),'utf8')).attempts.find(a=>a.id==='dead');
  const held=row().resources.map(r=>r.held_micro);
  await api(app,'/api/lending/stop',{method:'POST',body:{attemptId:'dead',confirmed:true},status:409});
  await api(app,'/api/lending/off',{method:'POST',body:{}});
  assert.deepEqual(row().resources.map(r=>r.held_micro),held);
  await api(app,'/api/lending/release-hold',{method:'POST',body:{attemptId:'dead'},status:428});
  await api(app,'/api/lending/release-hold',{method:'POST',body:{attemptId:'dead',confirmed:true},status:400});
  backend.proveHoldAbsent=async()=>({absent:false,attemptId:'dead',reason:'process_scan_incomplete'});
  const refusal=await api(app,'/api/lending/release-hold',{method:'POST',body:{attemptId:'dead'},headers:{'faravan-confirm':'yes'},status:409});
  assert.equal(refusal.code,'cessation_unverified');
  assert.equal(refusal.detail,'process_scan_incomplete');
  await t.test('hold refusal details survive the operation API and JSON and human CLI',async()=>{
    const client=createOpsClient({home:first.home,autostart:false});
    for(const detail of ['sandbox_home_unverified','sandbox_inventory_failed','sandbox_inventory_incomplete',
      'sandbox_inventory_unreadable','sandbox_present','process_scan_incomplete','process_present',
      'sandbox_cleanup_unverified','process_scan_failed','platform_unsupported','job_identity_unknown']) {
      backend.proveHoldAbsent=async()=>({absent:false,attemptId:'dead',reason:detail});
      const operation=await api(app,'/api/ops/lending.release_hold',{method:'POST',body:{attemptId:'dead'},headers:{'faravan-confirm':'yes'},status:409});
      assert.equal(operation.detail,detail,'operation API preserves '+detail);
      for(const json of [true,false]) {
        let output='';const stream={write:chunk=>{output+=chunk;}};
        const exit=await runOpsCommand(['lending','release-hold','--attempt-id','dead','--yes',...(json?['--json']:[])],
          {client,stdin:{isTTY:false},stdout:stream,stderr:stream});
        assert.equal(exit,4);
        if(json)assert.equal(JSON.parse(output).detail,detail);else assert.ok(output.includes(detail),output);
      }
      assert.deepEqual(row().resources.map(r=>r.held_micro),held,'diagnostic requests cannot change the hold');
    }
  });
  await t.test('missing, throwing and misbound absence proofs have named refusals',async()=>{
    const cases=[
      {probe:undefined,detail:'absence_proof_unavailable'},
      {probe:async()=>{throw Error('private internal exception');},detail:'absence_check_failed'},
      {probe:async()=>({absent:true,attemptId:'another'}),detail:'attempt_identity_mismatch'},
      {probe:async()=>({absent:false,attemptId:'dead'}),detail:'absence_proof_unavailable'},
    ];
    for(const {probe,detail} of cases){
      backend.proveHoldAbsent=probe;
      const refusal=await api(app,'/api/lending/release-hold',{method:'POST',body:{attemptId:'dead'},headers:{'faravan-confirm':'yes'},status:409});
      assert.equal(refusal.code,'cessation_unverified');assert.equal(refusal.detail,detail);
      assert.deepEqual(row().resources.map(r=>r.held_micro),held);
    }
  });
  backend.proveHoldAbsent=async()=>({absent:true,attemptId:'dead'});
  const result=await api(app,'/api/lending/release-hold',{method:'POST',body:{attemptId:'dead'},headers:{'faravan-confirm':'yes'}});
  assert.equal(result.applied,true);assert.equal(result.settled,false);
  assert.deepEqual(row().resources.map(r=>r.held_micro),held,'full charge waits for safe reset');
  const log=await api(app,'/api/lending/log');
  assert.ok(log.some(row=>row.message.includes('full-charge hold recovery for dead')));
});
