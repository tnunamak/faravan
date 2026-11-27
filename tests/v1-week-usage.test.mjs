import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { weekAllowance } from '../lib/v1/quota.mjs';
import { requestVM } from '../ui/v1/src/view-models.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';

// S6.2: the week's remaining allowance and its age, never a share of one job.
const at=Date.parse('2026-10-19T12:00:00Z');
const measured={provider:'claude',remaining:70.5,observedAt:at-60000,resetsAt:at+86400000};
const checked_at=new Date(measured.observedAt).toISOString();

test('week allowance is only a fresh, valid Claude reading with its check time',()=>{
  for(const remaining of [0,70.5,100])
    assert.deepEqual(weekAllowance({...measured,remaining},at),{remaining,checked_at});
  assert.deepEqual(weekAllowance({...measured,observedAt:at-299999},at).checked_at,new Date(at-299999).toISOString());
  for(const change of [
    {provider:'codex'},{remaining:null},{remaining:'70'},{remaining:NaN},{remaining:-1},{remaining:101},
    {observedAt:at+1},{observedAt:at-300000},{observedAt:null},{resetsAt:at},{resetsAt:NaN},
  ]) assert.equal(weekAllowance({...measured,...change},at),null,JSON.stringify(change));
  assert.equal(weekAllowance(null,at),null);
  assert.equal(weekAllowance(measured,NaN),null);
});

test('request VM carries the allowance and friend minutes, and omits unknown or other-provider values',()=>{
  const allowance={remaining:70.5,checked_at};
  for(const harness of ['claude','claude-code','claude-code-subscription']) {
    const vm=requestVM({harness,runtimeSeconds:1200,allowance,friendMinutes:42});
    assert.equal(vm.timeLimit,'20 min');
    assert.deepEqual(vm.allowance,{remaining:70.5,checkedAt:checked_at});
    assert.equal(vm.friendMinutes,42);
    assert.equal(JSON.stringify(vm).includes('%'),false,'no percentage copy');
  }
  for(const request of [{},{harness:'codex',allowance},{harness:'claude-code-api-key',allowance},
    ...[null,undefined,{},{remaining:70},{checked_at},{remaining:101,checked_at},{remaining:-1,checked_at},
      {remaining:70,checked_at:'soon'},{remaining:'70',checked_at}].map(allowance=>({harness:'claude',allowance}))])
    assert.equal(requestVM(request).allowance,null,JSON.stringify(request));
  for(const friendMinutes of [null,undefined,-1,NaN,Infinity,'42'])
    assert.equal(requestVM({friendMinutes}).friendMinutes,null);
  assert.equal(requestVM({friendMinutes:0}).friendMinutes,0);
});

for(const harness of ['claude-code-subscription','codex'])
  test('approval API projects the week allowance only for '+harness,{timeout:120000},async t=>{
    const fresh=()=>({provider:'claude',remaining:70.5,observedAt:Date.now()-1000,resetsAt:Date.now()+86400000});
    let quota=fresh();
    const f=await appFixture(t),{owner,lender,circle}=await f.connect({
      adapters:[{spec:legacyProxyHarness(harness),installed:true,signedIn:true,
        harnessVersion:'synthetic-only',models:[],capabilities:[]}],
      quotaReader:async()=>quota,
    });
    const digest='sha256:'+'a'.repeat(64);
    await writeFile(join(lender.home,'v1','contributions.json'),JSON.stringify({version:1,truncated:false,corrupt:false,
      events:[{circle:'c',keyId:digest,jobDigest:digest,attemptId:'seed',kind:'runtime',at:Date.now()-1000,
        startedAt:Date.now()-421000,milliseconds:420000}]}));
    await api(lender.app,'/api/lending/limits',{method:'POST',body:{
      dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200,idleOnly:false}});
    await api(lender.app,'/api/agents/'+harness,{method:'POST',body:{useForLending:true}});
    await api(lender.app,'/api/lending/mode',{method:'POST',body:{circle:circle.id,mode:'ask'}});
    await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
    await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,
      git:'https://github.com/example/synthetic.git',commit:'1'.repeat(40),
      prompt:'Synthetic weekly allowance request.',harness}});
    const card=await waitFor(async()=>(await api(lender.app,'/api/approvals'))[0],'review card',30000);
    assert.equal(card.runtimeSeconds,1200);
    assert.equal(card.friendMinutes,7,'minutes Faravan counted for friends in the last 7 days');
    assert.equal('weekShare' in card,false);
    if(harness==='codex') assert.equal(card.allowance,null);
    else {
      assert.equal(card.allowance.remaining,70.5);
      assert.equal(card.allowance.checked_at,new Date(quota.observedAt).toISOString());
      assert.equal(requestVM(card).allowance.remaining,70.5);
    }
    quota=null;
    await api(lender.app,'/api/status');
    assert.equal((await api(lender.app,'/api/approvals'))[0].allowance,null);
    await api(lender.app,'/api/approvals/'+card.id+'/skip',{method:'POST',body:{}});
  });
