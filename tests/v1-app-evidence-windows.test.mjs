import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { observeAgentEvidence } from '../lib/v1/app.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';

const minute=60000,base=Date.parse('2026-10-19T12:00:00Z');
const observe=(prior,signedIn,offset,source='sandbox-store')=>
  observeAgentEvidence(prior,{signedIn},source,base+offset);

for(const [label,gap,signedIn,count] of [
  ['inside',10*minute-1,false,2],
  ['at the boundary',10*minute,false,2],
  ['outside',10*minute+1,true,1],
])test('definite negatives '+label+' the ten-minute window',()=>{
  const good=observe({},true,0);
  const first=observe(good,false,minute);
  assert.equal(first.signedIn,true);
  const second=observe(first,false,minute+gap);
  assert.equal(second.signedIn,signedIn);
  assert.equal(second.signOutCount,count);
  if(signedIn)assert.deepEqual(second.evidence,good.evidence);
});

test('an expired negative starts a new pair; unknown checks do not extend its window',()=>{
  let value=observe({},true,0);
  value=observe(value,false,minute);
  value=observe(value,null,10*minute);
  value=observe(value,false,11*minute+1);
  assert.equal(value.signedIn,true);
  assert.equal(value.signOutCount,1);
  value=observe(value,false,12*minute);
  assert.equal(value.signedIn,false);
  assert.equal(value.signOutCount,2);
});

test('unknown checks preserve a recent pair, while success clears it',()=>{
  let value=observe({},true,0);
  value=observe(value,false,minute);
  value=observe(value,null,2*minute);
  value=observe(value,false,3*minute);
  assert.equal(value.signedIn,false);
  value=observe(value,true,4*minute,'job');
  assert.equal(value.signedIn,true);
  assert.equal(value.signOutCount,0);
  assert.ok(value.evidence.some(row=>row.fact==='successful_job'));
  value=observe(value,false,5*minute);
  assert.equal(value.signedIn,true);
  assert.equal(value.signOutCount,1);
  value=observe(value,false,6*minute,'job');
  assert.equal(value.signedIn,false,'real job authentication failure is immediate');
});

test('a legacy or future-dated negative cannot supply a recent pair',()=>{
  for(const prior of [
    {signedIn:true,signOutCount:1},
    observe(observe({},true,0),false,2*minute),
  ]) {
    const value=observe(prior,false,minute);
    assert.equal(value.signedIn,true);
    assert.equal(value.signOutCount,1);
  }
});

test('unknown duration starts at the first failure and resets on definite evidence',()=>{
  const good=observe({},true,0);
  let value=observe(good,null,minute);
  assert.equal(value.unknownSince,base+minute);
  for(const signedIn of [null,undefined]) {
    value=observe(value,signedIn,29*minute);
    assert.equal(value.unknownSince,base+minute);
    assert.deepEqual(value.evidence,good.evidence);
    assert.equal(value.signedIn,true);
  }
  value=observe(value,false,30*minute);
  assert.equal(value.unknownSince,null);
  assert.equal(value.signedIn,true,'one negative retains routing evidence');
  value=observe(value,null,31*minute);
  assert.equal(value.unknownSince,base+31*minute);
  value=observe(value,true,32*minute,'job');
  assert.equal(value.unknownSince,null);
  value=observeAgentEvidence(value,{installed:false},'sandbox',base+33*minute);
  assert.equal(value.unknownSince,null,'not installed is definite evidence');
});

test("Can't check appears after thirty minutes of unknown without erasing last sign-in evidence",
  {timeout:30000},async t=>{
  let time=base,signedIn=true,probes=0;
  const f=await appFixture(t),{app,backend}=await f.start('evidence-windows',{
    adapters:HARNESS_ADAPTERS.filter(a=>a.spec.harness_id==='codex').map(a=>({...a,lendingSpec:undefined,spec:{...a.spec,auth_strategy:'docker-native-oauth',credential_in_guest:false}})),
    clock:{now:()=>time},
    identityProbe:async()=>{probes++;return {providers:[{harness_id:'codex',installed:true,signedIn}]};},
  });
  const refresh=()=>api(app,'/api/agents/refresh',{method:'POST',body:{}});
  const row=async()=>(await api(app,'/api/agents'))[0];
  const attention=async()=>(await api(app,'/api/home')).attention.filter(a=>a.agent==='codex');
  const original=(await refresh())[0].evidence.find(e=>e.fact==='signed_in');
  await api(app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  time+=60*minute;signedIn=null;await refresh();
  assert.notEqual((await row()).signInState,"Can't check",'old success does not age a new failure');
  assert.deepEqual(await attention(),[]);
  time+=30*minute-1;await refresh();
  assert.notEqual((await row()).signInState,"Can't check");
  assert.deepEqual(await attention(),[]);
  time++;
  const expired=await row();
  assert.equal(expired.signInState,"Can't check");
  assert.equal(expired.remedy,'Check again');
  assert.equal(expired.signedIn,true);
  assert.deepEqual(expired.evidence.find(e=>e.fact==='signed_in'),original);
  assert.deepEqual(await attention(),[{label:"Can't check ChatGPT (Codex)",remedy:'Check again',agent:'codex'}]);
  assert.equal(probes,3,'reads show elapsed unknown time without starting a probe');
  signedIn=true;await refresh();
  assert.equal((await row()).signInState,'Signed in');
  assert.deepEqual(await attention(),[]);
  signedIn=null;await refresh();time+=30*minute-1;
  assert.notEqual((await row()).signInState,"Can't check",'recovery starts a new unknown window');
  assert.equal(backend.calls.some(([kind])=>kind==='run'||kind==='prepare'),false);
});
