import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';

// Read the current account answers without starting provider reads or sampling desktop activity.
test('status keeps each account label and current decision together',async()=>{
  const rows=[{id:'first',provider:'codex',label:'Personal',decision:{admitted:false,reason:'account_signed_out'}},
    {id:'second',provider:'codex',label:'Work',decision:{admitted:true,reason:null}}];
  const runtime=createLendingRuntime({settings:()=>({}),accountStatus:async()=>structuredClone(rows),
    presence:()=>assert.fail('status must not sample presence'),readOverride:()=>assert.fail('status must not read a provider')});
  assert.deepEqual((await runtime.view()).accounts,rows);
  rows[0].decision={admitted:true,reason:null};rows[1].decision={admitted:false,reason:'provider_limit_reached'};
  assert.deepEqual((await runtime.view()).accounts,rows,'the next view carries the new account answers');
});

test('manual refresh forwards only the named account and cancellation to the provider reader',async()=>{
  const controller=new AbortController(),calls=[];
  const runtime=createLendingRuntime({settings:()=>({}),refreshRead:async(key,options)=>{
    calls.push([key,options]);return {refresh_succeeded:false,probe:{reason:'auth'}};},
    accountStatus:()=>assert.fail('refresh must not substitute an account view for a provider read')});
  assert.deepEqual(await runtime.refreshCapacity('codex:second',{signal:controller.signal}),{
    reason:'refresh_failed',probe:{reason:'auth'}});
  assert.deepEqual(calls,[['codex:second',{signal:controller.signal,forceRefresh:true}]]);
});

import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAccountExecution} from '../lib/v1/account-execution.mjs';
import {createAccountBroker} from '../lib/v1/account-broker.mjs';

// The broker reads saved provider observations; the real account decision and
// ledger compute the answer. Only provider I/O and the clock are synthetic.
function decisionFixture(t) {
  const at=Date.parse('2026-11-01T12:00:00Z'),records={};
  const reading=id=>({schemaVersion:1,accountId:id,observationId:'read-'+id,sequence:1,observedAtMs:at,receivedAtMs:at,
    postingUncertaintyMs:null,coverage:{kind:'unknown'},windows:[{id:'seven_day',instance:'week',capacityMicro:100e6,
      usedLoMicro:0,usedHiMicro:0,resetsAtMs:at+7*86400000,maxOwnerRateMicroPerMs:null}]});
  for(const id of ['first','second'])records[id]={schemaVersion:1,id,providerId:'claude',label:id,authState:'signed_in',
    generation:0,enabled:true,modelOrder:[],subjectId:id,secret:{credential:{access:'synthetic',refresh:'synthetic',expires:0}},
    usage:{reading:reading(id),jobReadings:[],windowHistory:[],state:'ready',limitResetAtMs:null,lastAttemptAtMs:at,nextReadAtMs:at+300000}};
  const store={read:()=>structuredClone({records}),get:id=>structuredClone(records[id]??null),
    transaction:async fn=>fn({records}),exclusive:async(_id,fn)=>fn(),exclusiveUsage:async(_id,fn)=>fn()};
  const adapter={descriptor:{refreshKind:'none',usageKind:'remote',nativeUnits:[],models:[]}};
  const providers={getProvider:()=>({ok:true,value:adapter}),listProviders:()=>[adapter]};
  const broker=createAccountBroker({store,providers,clock:()=>at,proxy:{dispatch:()=>assert.fail('no remote requests')},authority:{verify:async()=>({ok:false})}});
  const directory=mkdtempSync(join(tmpdir(),'current-account-decision-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  let beforeSettings=async()=>{};
  const execution=createAccountExecution({directory,store,broker,providers,clock:()=>at,settings:async()=>{
    await beforeSettings();return {schemaVersion:1,enabled:true,revision:1,strategy:'automatic',strategyParams:{},protectionPosition:'keep_more_for_me'};}});
  return {at,records,execution,delaySettings:fn=>{beforeSettings=fn;}};
}

test('a stale provider reading reduces current allowance to a wait instead of Ready',async t=>{
  const f=decisionFixture(t);
  assert.equal((await f.execution.lendability({accountId:'first'})).kind,'lend');
  f.records.first.usage.reading.observedAtMs-=6*3600000;
  const decision=await f.execution.lendability({accountId:'first'});
  assert.equal(decision.kind,'wait');assert.equal(decision.reason,'no_spare');
  assert.ok(decision.nextEvaluationAtMs>f.at);
});

test('a mixed provider reading set advertises only the account that can lend',async t=>{
  const f=decisionFixture(t);f.records.second.usage.state='limit';f.records.second.usage.limitResetAtMs=f.at+3600000;
  const first=await f.execution.lendability({accountId:'first'}),second=await f.execution.lendability({accountId:'second'});
  assert.equal(first.kind,'lend');assert.equal(second.kind,'hold');assert.equal(second.code,'provider_limit_reached');
  assert.deepEqual(await f.execution.lendableAccounts([{accountId:'first'},{accountId:'second'}]),[{accountId:'first'}]);
});

test('an older async decision cannot return Ready after a newer provider-limit reading',async t=>{
  const f=decisionFixture(t);let release,entered;const waiting=new Promise(r=>{entered=r;});
  f.delaySettings(()=>new Promise(r=>{release=r;entered();}));
  const old=f.execution.lendability({accountId:'first'});await waiting;
  f.records.first.usage.state='limit';f.records.first.usage.limitResetAtMs=f.at+3600000;
  f.delaySettings(async()=>{});
  const current=await f.execution.lendability({accountId:'first'});
  assert.equal(current.kind,'hold');assert.equal(current.code,'provider_limit_reached');
  release();const previous=await old;
  assert.equal(previous.kind,'hold');assert.equal(previous.code,'provider_limit_reached');
});
