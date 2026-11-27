import test from 'node:test';
import {tempDir} from '../helpers/temp-dir.mjs';
import fs from 'node:fs';
import {createLaunchBackend} from '../../lib/v1/launch-backend.mjs';
import {bindObservedAccountSelection} from '../../lib/v1/lender.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {evaluateLending} from '../../lib/v1/lending-policy.mjs';
import {decideLending,normalizeLendingAccounting} from '../../lib/v1/lending-decision.mjs';
import {createLendingLedger,createLendingLaunch} from '../../lib/v1/lending-launch.mjs';
import {replayPolicy,expectedBaselineMetadata} from './capture-policy.mjs';
import {tryLockAsync} from '../../lib/os-lock.mjs';

test('release raw and normalized outputs remain byte-for-byte equal in all 48 cases',async()=>{
  const expected=JSON.parse(await readFile(new URL('./fixtures/policy-f0cea2f60.json',import.meta.url)));
  const {cases: storedCases, ...metadata}=expected;
  assert.deepEqual(metadata,expectedBaselineMetadata);
  assert.equal(expected.sourceSha,'f0cea2f609aa601098dba3cb437132b76d9a280f');
  assert.equal(expected.cases.length,48);
  const replay=replayPolicy(expected);
  assert.equal(replay.baselineSourceSha,expected.sourceSha);
  assert.deepEqual(JSON.parse(JSON.stringify(replay.cases)),expected.cases);
  for(const c of expected.cases) {
    assert.deepEqual(JSON.parse(JSON.stringify(evaluateLending(c.rawInput))),c.rawOutput);
    assert.deepEqual(JSON.parse(JSON.stringify(evaluateLending(c.normalizedInput))),c.normalizedOutput);
  }
  assert.ok(expected.cases.some(c=>c.state==='none'&&!c.history&&c.strategy==='automatic'&&c.normalizedOutput.admitted&&c.normalizedOutput.reservePointsMicro.seven_day>0));
});
function input() {
  return {schemaVersion:1,nowMs:1000000000,account:{id:'account-sentinel',providerId:'provider-sentinel',enabled:true,authState:'signed_in'},
    usage:{accountId:'account-sentinel',reading:null,state:'unavailable',limitResetAtMs:null,nextReadAtMs:null},
    policy:{schemaVersion:1,revision:1,enabled:true,strategy:'automatic',strategyParams:{},protectionPosition:'keep_more_for_me'},
    eligibility:{enabledNow:true,reason:'enabled',evaluatedAtMs:1000000000,settingsRevision:1,nextChangeAtMs:null},
    job:{id:'job-sentinel',attemptId:'attempt-sentinel',selection:{providerId:'provider-sentinel',accountId:'account-sentinel',modelId:'model-sentinel',effortId:null}},
    runtime:{canStart:true,nextAction:null},ledger:{accountId:'account-sentinel',revision:0,resources:[],attempts:[]},
    history:{accountId:'account-sentinel',rows:[]}};
}
test('first job without usage/history lends positive points; unavailable/429 is no hold',()=>{
  const i=input(), d=decideLending(i);assert.equal(d.kind,'lend');assert.equal(d.mode,'cold_pace');
  // Independent contract values: 20 points/hour, 10 minutes of lag, micro-points.
  const expectedLagUpper = Math.ceil(20 * 1_000_000 * (10 / 60));
  const accounting = normalizeLendingAccounting(i);
  assert.equal(accounting.age,0);
  assert.deepEqual(accounting.coordinates,[{
    id:'seven_day',instance:null,unit:'window_micro_points',upperMicro:expectedLagUpper,
    reservedMicro:0,remainingMicro:100_000_000-expectedLagUpper,
  }]);
  const weekly = d.amount.byResource.find(row=>row.id==='seven_day');
  assert.ok(weekly && weekly.amount>0 && weekly.amount<=accounting.coordinates[0].remainingMicro);
  assert.equal(d.readingAgeMs,null);
});
test('only the four specified holds and precedence',()=>{
  const cases=[['lending_off',i=>i.policy.enabled=false],['sandbox_cannot_start',i=>i.runtime.canStart=false],
    ['account_signed_out',i=>i.account.authState='reauthorization_required'],['provider_limit_reached',i=>i.usage.state='limit']];
  for(const [code,change] of cases){const i=input();change(i);assert.equal(decideLending(i).code,code);}
});
test('aged eq17 counts borrower and reservations once, preserves actual age',()=>{
  const i=input();i.usage.reading={accountId:i.account.id,observedAtMs:i.nowMs-1500000,coverage:{kind:'unknown'},windows:[
    {id:'seven_day',instance:'week-sentinel',capacityMicro:100000000,usedHiMicro:20000000,resetsAtMs:i.nowMs+3600000,maxOwnerRateMicroPerMs:0}]};
  i.ledger.resources=[{id:'seven_day',instance:'week-sentinel',unit:'window_micro_points',consumed:30000000,unrepresented:30000000,reserved:5000000}];
  const d=decideLending(i);assert.equal(d.kind,'lend');assert.equal(d.readingAgeMs,1500000);
  const c=normalizeLendingAccounting(i).coordinates[0];
  assert.equal(c.upperMicro,50000000);
  assert.equal(c.reservedMicro,5000000);
  assert.equal(c.remainingMicro,45000000);
});
test('zero spare waits with one action and finite reevaluation; invalid account/time rejected',()=>{
  const i=input();i.ledger.resources=[{id:'seven_day',instance:null,unit:'window_micro_points',consumed:0,unrepresented:0,reserved:100000000}];
  const d=decideLending(i);assert.equal(d.kind,'wait');assert.equal(d.nextEvaluationAtMs,i.nowMs+7*86400000);
  i.eligibility.settingsRevision=2;assert.throws(()=>decideLending(i),/invalid_decision_input/);
  i.eligibility.settingsRevision=1;i.job.selection.accountId='wrong';assert.throws(()=>decideLending(i),/invalid_decision_input/);
});
async function fixture(t) {
  const directory=await tempDir('foundation-lending-test-');t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(directory+'/.fleet-owner.json',JSON.stringify({thread_id:'98d9c9cc-4a8666edc3569153',disposable:true,owner_driven:false}));
  let time=1000, revision=1,starts=0;
  const journal={directory},settings=async()=>({revision});
  const ledger=createLendingLedger({journal,settings}),events=[];
  const broker={issueJobKey:async()=>({ok:true,value:{keyId:'key-sentinel',key:'SYNTHETIC-GUEST-KEY'}}),
    renewJobKey:async()=>({ok:true,value:{keyId:'key-sentinel',fence:1,expiresAtMs:999999}}),
    revokeJobKey:async()=>{events.push('revoke');return {aborted:[],unconfirmed:[]};}};
  const providers={getProvider:()=>({ok:true,value:{makeRun:({receipt,enforcement})=>({ok:true,value:{schemaVersion:1,command:'sentinel',args:[],env:{},proxy:{},receipt,enforcement}})}})};
  const backend={prepare:async()=>({ok:true,value:{sandboxId:'sandbox-sentinel'}}),
    start:async()=>{starts++;return {ok:true,value:{kind:'started',atMs:time}};},
    stop:async()=>{events.push('stop');return {ceasedAtMs:time};},remove:async()=>({ok:true})};
  const coordinator={release:async()=>({ok:true,value:{kind:'released'}}),reconcile:async()=>({ok:true,value:{kind:'owned'}})};
  const deps={journal,settings,ledger,broker,providers,backend,coordinator,clock:()=>time};
  const launch=createLendingLaunch(deps), selection=input().job.selection;
  const amount={unit:'window_micro_points',byResource:[{id:'seven_day',instance:'week-sentinel',amount:10000000}]};
  const receipt={schemaVersion:1,accountId:selection.accountId,jobId:'job-sentinel',attemptId:'attempt-sentinel',
    policyVersion:'objective/m1',quotedLedgerRevision:0,settingsRevision:1,evaluatedAtMs:time,amount,mode:'observed'};
  const enforcement={amount,wallLimitMs:60000,stopOnBudget:true,metering:'estimated',limitations:['synthetic']};
  const request={attempt:{attemptId:receipt.attemptId,jobId:receipt.jobId,generation:1,leaseProof:{schemaVersion:1,signedEnvelope:'SYNTHETIC'}},
    selection,receipt,enforcement,operationId:'prepare-sentinel',signal:new AbortController().signal};
  return {launch,ledger,deps,request,events,get starts(){return starts;},advance:n=>time+=n,revise:()=>revision++};
}
test('CAS and idempotent operations isolate two accounts and survive restart',async t=>{
  const f=await fixture(t), i={accountId:f.request.selection.accountId,expectedRevision:0,settingsRevision:1,
    operationId:'reserve',receipt:f.request.receipt,enforcement:f.request.enforcement};
  const results=await Promise.all([f.ledger.compareAndReserve(i),f.ledger.compareAndReserve({...i,operationId:'rival'})]);
  assert.equal(results.filter(result=>result.kind==='applied').length,1);
  assert.equal(results.filter(result=>result.kind==='conflict').length,1);
  const winner=results[0].kind==='applied'?i:{...i,operationId:'rival'};
  assert.equal((await f.ledger.compareAndReserve(winner)).kind,'replay');
  assert.equal((await f.ledger.compareAndReserve({...winner,expectedRevision:1})).code,'operation_conflict');
  assert.equal((await f.ledger.snapshot('another-account')).resources.length,0);
  assert.equal((await createLendingLedger(f.deps).snapshot(i.accountId)).resources[0].reserved,10000000);
});
test('concurrent/replayed start has one dispatch; ambiguous response remains fenced after restart',async t=>{
  const f=await fixture(t);await f.launch.prepareLend(f.request);
  f.deps.backend.start=async()=>{f.events.push('dispatch');throw new Error('response lost');};
  const i={attemptId:'attempt-sentinel',operationId:'start',signal:f.request.signal};
  await Promise.all([f.launch.startLend(i),f.launch.startLend(i)]);
  assert.equal(f.events.filter(x=>x==='dispatch').length,1);
  assert.equal((await createLendingLaunch(f.deps).startLend(i)).value.kind,'uncertain');
  assert.equal((await f.launch.releaseBeforeStart({attemptId:i.attemptId,reason:'restart_before_start',operationId:'release'})).error.code,'cessation_unverified');
  assert.equal((await f.ledger.snapshot(f.request.selection.accountId)).resources[0].reserved,10000000);
});
test('Stop revokes first and completes independently of a never-resolving usage reader',async t=>{
  const f=await fixture(t);await f.launch.prepareLend(f.request);
  await f.launch.startLend({attemptId:'attempt-sentinel',operationId:'start',signal:f.request.signal});
  const usageRead=new Promise(()=>{});void usageRead;
  const stop=await f.launch.stopLend({attemptId:'attempt-sentinel',reason:'owner'});
  assert.deepEqual(f.events,['revoke','stop']);assert.equal(stop.ceasedAtMs,1000);
});
test('abort release healthy evidence requires cooldown and new approval/new attempt',async t=>{
  const f=await fixture(t);await f.launch.prepareLend(f.request);
  const i={attemptId:'attempt-sentinel',reason:'paused',operationId:'release'};
  assert.equal((await f.launch.releaseBeforeStart(i)).value.claimable,true);
  assert.equal((await f.launch.releaseBeforeStart(i)).value.claimable,true);
  assert.equal((await f.ledger.snapshot(f.request.selection.accountId)).resources[0].reserved,0);
  assert.equal((await f.launch.reoffer({jobId:'job-sentinel',decision:{kind:'lend'}})).eligible,false);
  f.advance(300000);
  assert.deepEqual(await f.launch.reoffer({jobId:'job-sentinel',decision:{kind:'lend'}}),{eligible:true,newConsentRequired:true,retryAtMs:301000});
});
test('persistent aged reading never reclaims in a loop or bypasses cooldown',async t=>{
  const f=await fixture(t);await f.launch.prepareLend(f.request);
  await f.launch.releaseBeforeStart({attemptId:'attempt-sentinel',reason:'paused',operationId:'release'});
  for(let n=0;n<10;n++)assert.equal((await f.launch.reoffer({jobId:'job-sentinel',decision:{kind:'lend',mode:'aged'}})).eligible,false);
  assert.equal(f.starts,0);
});
test('repeated setup failure backoff is finite, capped, and persisted',async t=>{
  const f=await fixture(t);
  for(let n=0;n<5;n++) {
    const request=structuredClone({...f.request,signal:undefined});request.signal=f.request.signal;
    request.attempt.attemptId='setup-'+n;request.receipt.attemptId='setup-'+n;request.operationId='prepare-'+n;
    request.receipt.quotedLedgerRevision=(await f.ledger.snapshot(request.selection.accountId)).revision;
    assert.equal((await f.launch.prepareLend(request)).ok,true);
    await f.launch.releaseBeforeStart({attemptId:request.attempt.attemptId,reason:'preparation_failed',operationId:'release-'+n});
    const offer=await f.launch.reoffer({jobId:'job-sentinel',decision:{kind:'lend'}});
    assert.ok(offer.retryAtMs<=1000+1800000);assert.equal(offer.eligible,false);
  }
});
test('restart preserves pending release, exclusions, cleared consent and safe replay',async t=>{
  const f=await fixture(t);await f.launch.prepareLend(f.request);
  f.deps.coordinator.release=async()=>({ok:true,value:{kind:'uncertain'}});
  const i={attemptId:'attempt-sentinel',reason:'paused',operationId:'release'};
  assert.equal((await f.launch.releaseBeforeStart(i)).ok,false);
  f.deps.coordinator.release=async()=>({ok:true,value:{kind:'already_released'}});
  const resumed=createLendingLaunch(f.deps);assert.equal((await resumed.releaseBeforeStart(i)).ok,true);
  assert.equal((await resumed.startLend({attemptId:i.attemptId,operationId:'start'})).ok,false);
  assert.equal((await resumed.reoffer({jobId:'job-sentinel',decision:{kind:'lend'}})).newConsentRequired,true);
});
test('settlement conserves consumed and remaining, deduplicates cumulative readings and proven coverage',async t=>{
  const f=await fixture(t), p=await f.launch.prepareLend(f.request),accountId=f.request.selection.accountId;
  const event={schemaVersion:1,accountId,attemptId:'attempt-sentinel',eventId:'event-1',sequence:1,atMs:1000,
    semantics:'cumulative',meterEpoch:'epoch-1',amount:{unit:'tokens',value:3},windowDebits:[{id:'seven_day',instance:'week-sentinel',micro:3000000}]};
  const i={accountId,reservationId:p.value.reservationId,operationId:'settle',cessationAtMs:1000,
    usage:{accountId,jobReadings:[event],reading:null}};
  await f.ledger.settle(i);await f.ledger.settle({...i,operationId:'settle-again'});
  let r=(await f.ledger.snapshot(accountId)).resources[0];assert.equal(r.reserved,7000000);assert.equal(r.consumed,3000000);assert.equal(r.unrepresented,3000000);
  i.usage.reading={accountId,observedAtMs:1200,receivedAtMs:1200,postingUncertaintyMs:200,coverage:{kind:'proven',throughSequenceByAttempt:{'attempt-sentinel':1}},windows:[{id:'seven_day',instance:'week-sentinel'}]};
  await f.ledger.settle({...i,operationId:'coverage'});await f.ledger.settle({...i,operationId:'coverage-replay'});
  r=(await f.ledger.snapshot(accountId)).resources[0];assert.equal(r.reserved,0);assert.equal(r.consumed,3000000);assert.equal(r.unrepresented,0);
});

test('changed settings revoke preparation and release without a dispatch',async t=>{
  const f=await fixture(t);await f.launch.prepareLend(f.request);f.revise();
  const result=await f.launch.startLend({attemptId:'attempt-sentinel',operationId:'start'});
  assert.equal(result.error.code,'settings_conflict');assert.equal(f.starts,0);
  assert.equal((await f.ledger.snapshot(f.request.selection.accountId)).resources[0].reserved,0);
});
test('failed preparation without cleanup proof retains reservation and replays its result',async t=>{
  const f=await fixture(t);f.deps.backend.prepare=async()=>({ok:false,error:{code:'sandbox_unavailable'}});
  assert.equal((await f.launch.prepareLend(f.request)).error.code,'sandbox_unavailable');
  assert.equal((await f.launch.prepareLend(f.request)).error.code,'sandbox_unavailable');
  assert.equal((await f.ledger.snapshot(f.request.selection.accountId)).resources[0].reserved,10000000);
});
test('invalid cross-account settlement and delta gap cannot mutate any coordinate',async t=>{
  const f=await fixture(t),p=await f.launch.prepareLend(f.request),accountId=f.request.selection.accountId;
  const before=await f.ledger.snapshot(accountId);
  const result=await f.ledger.settle({accountId,reservationId:p.value.reservationId,operationId:'bad-settle',cessationAtMs:1000,
    usage:{accountId,jobReadings:[{accountId:'other',attemptId:'attempt-sentinel',eventId:'bad'}]}});
  assert.equal(result.kind,'rejected');assert.deepEqual(await f.ledger.snapshot(accountId),before);
  const gap=await f.ledger.settle({accountId,reservationId:p.value.reservationId,operationId:'gap',cessationAtMs:1000,
    usage:{accountId,jobReadings:[{accountId,attemptId:'attempt-sentinel',eventId:'gap',sequence:2,semantics:'delta',meterEpoch:'epoch',
      amount:{unit:'tokens',value:1},windowDebits:[{id:'seven_day',instance:'week-sentinel',micro:1}]}]}});
  assert.equal(gap.kind,'rejected');assert.deepEqual(await f.ledger.snapshot(accountId),before);
});
test('complete trace weeks improve the existing history band without a history gate',()=>{
  const i=input(),week=7*86400000;i.nowMs=20*week;i.eligibility.evaluatedAtMs=i.nowMs;
  i.history.rows=Array.from({length:19},(_,n)=>({window_id:'seven_day',start_at:n*week,resets_at:(n+1)*week,
    length_ms:week,complete:true,censored:false,source:'sentinel',rounding_points:0,trace:[[n*week,0],[(n+1)*week,1]]}));
  assert.equal(decideLending(i).kind,'lend');
});
test('native reservation requires a declared scaled unit and never offsets window points',async t=>{
  const f=await fixture(t),accountId=f.request.selection.accountId;
  const amount={unit:'native',nativeUnit:'tokens',byResource:[{id:'native-meter',instance:null,amount:10}]};
  const receipt={...f.request.receipt,amount},enforcement={...f.request.enforcement,amount};
  const i={accountId,expectedRevision:0,settingsRevision:1,operationId:'native',receipt,enforcement};
  assert.equal((await f.ledger.compareAndReserve(i)).kind,'rejected');
  const ledger=createLendingLedger({...f.deps,nativeUnits:[{id:'tokens',scale:1}]});
  const reserved=await ledger.compareAndReserve({...i,operationId:'declared-native'});
  assert.equal(reserved.kind,'applied');
  await ledger.settle({accountId,reservationId:reserved.value.reservationId,operationId:'native-settle',cessationAtMs:1000,
    usage:{accountId,reading:null,jobReadings:[{accountId,attemptId:'attempt-sentinel',eventId:'native-event',sequence:1,
      semantics:'delta',meterEpoch:'native-epoch',amount:{unit:'tokens',value:3},windowDebits:[]}]}});
  const rows=(await ledger.snapshot(accountId)).resources;
  assert.equal(rows.length,1);assert.equal(rows[0].unit,'tokens');assert.equal(rows[0].consumed,3);assert.equal(rows[0].reserved,7);
});

function repairDeferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return {promise, resolve};
}

test('repair partial coverage retains later debit and is idempotent', async t => {
  const f = await fixture(t), p = await f.launch.prepareLend(f.request);
  const accountId = f.request.selection.accountId;
  const event = (sequence, micro) => ({
    schemaVersion:1, accountId, attemptId:'attempt-sentinel',
    eventId:'partial-' + sequence, sequence, atMs:1000 + sequence,
    semantics:'cumulative', meterEpoch:'epoch-1',
    amount:{unit:'tokens', value:sequence},
    windowDebits:[{id:'seven_day', instance:'week-sentinel', micro}]
  });
  const one = event(1, 3000000), two = event(2, 5000000);
  const settle = (operationId, jobReadings, reading = null) =>
    f.ledger.settle({accountId, reservationId:p.value.reservationId,
      operationId, cessationAtMs:1003, usage:{accountId, jobReadings, reading}});
  assert.equal((await settle('first', [one])).kind, 'applied');
  assert.equal((await settle('second', [two])).kind, 'applied');
  const reading = {coverage:{kind:'proven',
    throughSequenceByAttempt:{'attempt-sentinel':1}},
    windows:[{id:'seven_day', instance:'week-sentinel'}]};
  await settle('partial-cover', [one], reading);
  let row = (await f.ledger.snapshot(accountId)).resources[0];
  assert.equal(row.consumed, 5000000);
  assert.equal(row.unrepresented, 2000000);
  await settle('repeat-cover', [one], reading);
  row = (await f.ledger.snapshot(accountId)).resources[0];
  assert.equal(row.unrepresented, 2000000);
  const wrongWindow = {...reading,
    windows:[{id:'seven_day', instance:'different-week'}]};
  await settle('other-window-cover', [one], wrongWindow);
  assert.equal((await f.ledger.snapshot(accountId)).resources[0].unrepresented, 2000000);
});

test('repair pending key creation cannot report release claimable', async t => {
  const f = await fixture(t), entered = repairDeferred(), finish = repairDeferred();
  const originalIssue = f.deps.broker.issueJobKey;
  f.deps.broker.issueJobKey = async () => {
    entered.resolve();
    await finish.promise;
    return originalIssue();
  };
  const preparing = f.launch.prepareLend(f.request);
  await entered.promise;
  try {
    const release = await f.launch.releaseBeforeStart({
      attemptId:'attempt-sentinel', reason:'paused', operationId:'release-race'});
    assert.notEqual(release.value?.claimable, true);
    assert.equal(release.error?.code, 'preparation_pending');
    const restarted = createLendingLaunch(f.deps);
    const retried = await restarted.releaseBeforeStart({
      attemptId:'attempt-sentinel', reason:'paused', operationId:'release-race'});
    assert.notEqual(retried.value?.claimable, true);
  } finally {
    finish.resolve();
    await preparing;
  }
  assert.equal(f.starts, 0);
});

test('repair racing different start operations conflict with one dispatch', async t => {
  const f = await fixture(t);
  await f.launch.prepareLend(f.request);
  const both = repairDeferred();
  let arrived = 0;
  f.deps.coordinator.reconcile = async () => {
    if (++arrived === 2) both.resolve();
    await both.promise;
    return {ok:true, value:{kind:'owned'}};
  };
  const results = await Promise.all(['start-A','start-B'].map(operationId =>
    f.launch.startLend({attemptId:'attempt-sentinel', operationId})));
  assert.equal(f.starts, 1);
  assert.equal(results.filter(r => r.error?.code === 'operation_conflict').length, 1);
  assert.equal(results.filter(r => r.ok && r.value.kind === 'started').length, 1);
});

test('repair coverage isolates meter epochs and window instances', async t => {
  const f=await fixture(t), accountId=f.request.selection.accountId;
  f.request.receipt.amount.byResource.push({id:'seven_day',instance:'next-week',amount:10000000});
  const p=await f.launch.prepareLend(f.request);
  const event=(meterEpoch,eventId,windowDebits)=>({accountId,attemptId:'attempt-sentinel',
    meterEpoch,eventId,sequence:1,semantics:'cumulative',amount:{unit:'tokens',value:1},windowDebits});
  const old=event('old-meter','old-event',[{id:'seven_day',instance:'week-sentinel',micro:3000000}]);
  const reset=event('new-meter','new-event',[
    {id:'seven_day',instance:'week-sentinel',micro:2000000},
    {id:'seven_day',instance:'next-week',micro:4000000}]);
  const settle=(operationId,jobReadings,windows)=>f.ledger.settle({accountId,
    reservationId:p.value.reservationId,operationId,cessationAtMs:1000,
    usage:{accountId,jobReadings,reading:windows?{windows,
      coverage:{kind:'proven',throughSequenceByAttempt:{'attempt-sentinel':1}}}:null}});
  await settle('epochs-old',[old]);await settle('epochs-new',[reset]);
  await settle('cover-old',[old],[{id:'seven_day',instance:'week-sentinel'}]);
  let rows=(await f.ledger.snapshot(accountId)).resources;
  assert.equal(rows.find(r=>r.instance==='week-sentinel').unrepresented,2000000);
  assert.equal(rows.find(r=>r.instance==='next-week').unrepresented,4000000);
  await settle('cover-new-window',[reset],[{id:'seven_day',instance:'next-week'}]);
  await settle('cover-new-window-repeat',[reset],[{id:'seven_day',instance:'next-week'}]);
  rows=(await f.ledger.snapshot(accountId)).resources;
  assert.equal(rows.find(r=>r.instance==='week-sentinel').unrepresented,2000000);
  assert.equal(rows.find(r=>r.instance==='next-week').unrepresented,0);
  assert.equal(rows.reduce((n,r)=>n+r.consumed,0),9000000);
  assert.equal(rows.reduce((n,r)=>n+r.reserved,0),11000000,'unknown posting/finality retains the unused reservation');
});

test('repair preparation fence survives lost response and cannot assert release', async t => {
  const f=await fixture(t);let releases=0;
  f.deps.backend.prepare=async()=>{throw new Error('synthetic lost prepare response');};
  f.deps.coordinator.release=async()=>{releases++;return {ok:true,value:{kind:'released'}};};
  await assert.rejects(f.launch.prepareLend(f.request),/synthetic lost prepare response/);
  const restarted=createLendingLaunch(f.deps);
  const i={attemptId:'attempt-sentinel',reason:'paused',operationId:'lost-prepare-release'};
  for(let n=0;n<2;n++)assert.equal((await restarted.releaseBeforeStart(i)).error.code,'preparation_uncertain');
  assert.equal((await restarted.prepareLend(f.request)).ok,false);
  assert.equal(releases,0);assert.equal(f.starts,0);
  assert.equal((await f.ledger.snapshot(f.request.selection.accountId)).resources[0].reserved,10000000);
});

test('repair delayed key resolves before cleanup and release retry becomes claimable', async t => {
  const f=await fixture(t),entered=repairDeferred(),finish=repairDeferred(),order=[];
  f.deps.broker.issueJobKey=async()=>{
    entered.resolve();await finish.promise;order.push('key-created');
    return {ok:true,value:{keyId:'key-sentinel',key:'SYNTHETIC-GUEST-KEY'}};
  };
  f.deps.broker.revokeJobKey=async()=>{order.push('revoke');};
  f.deps.backend.remove=async()=>{order.push('remove');return {ok:true};};
  f.deps.coordinator.release=async()=>{order.push('release');return {ok:true,value:{kind:'released'}};};
  const preparing=f.launch.prepareLend(f.request);await entered.promise;
  const i={attemptId:'attempt-sentinel',reason:'paused',operationId:'delayed-release'};
  try {
    assert.equal((await f.launch.releaseBeforeStart(i)).error.code,'preparation_pending');
    assert.deepEqual(order,[]);
  } finally {finish.resolve();await preparing;}
  assert.deepEqual(order,['key-created','revoke','remove','release']);
  assert.equal((await createLendingLaunch(f.deps).releaseBeforeStart(i)).value.claimable,true);
  assert.equal(f.starts,0);
});

test('repair settings read and dispatch exclude a cooperating settings writer', async t => {
  const f=await fixture(t);await f.launch.prepareLend(f.request);
  const reading=repairDeferred(),resume=repairDeferred();
  const launch=createLendingLaunch({...f.deps,settings:async()=>{
    reading.resolve();await resume.promise;return f.deps.settings();
  }});
  const starting=launch.startLend({attemptId:'attempt-sentinel',operationId:'locked-start'});
  await reading.promise;
  let writer;
  try {
    writer=await tryLockAsync(f.deps.journal.directory+'/writer.lock');
    assert.ok(!writer,'settings reader must hold the dispatch journal lock');
  } finally {if(writer)writer.release();resume.resolve();}
  assert.equal((await starting).value.kind,'started');
  writer=await tryLockAsync(f.deps.journal.directory+'/writer.lock');
  assert.ok(writer,'writer may proceed after dispatch commits');
  try {f.revise();} finally {writer.release();}
  assert.equal((await launch.startLend({attemptId:'attempt-sentinel',operationId:'locked-start'})).value.kind,'started');
  assert.equal(f.starts,1);
});

test('repair settings writer before dispatch produces conflict without starting', async t => {
  const f=await fixture(t);await f.launch.prepareLend(f.request);
  const renewed=repairDeferred(),resume=repairDeferred();
  f.deps.broker.renewJobKey=async()=>{
    renewed.resolve();await resume.promise;return {ok:true,value:{keyId:'key-sentinel'}};
  };
  const starting=f.launch.startLend({attemptId:'attempt-sentinel',operationId:'writer-first'});
  await renewed.promise;
  const writer=await tryLockAsync(f.deps.journal.directory+'/writer.lock');
  try {assert.ok(writer);f.revise();} finally {if(writer)writer.release();resume.resolve();}
  assert.equal((await starting).error.code,'settings_conflict');assert.equal(f.starts,0);
});

test('composed preparation uncertainty retains reservation across recreation until exact cleanup',async t=>{
  const f=await fixture(t);let owned=null,releases=0,creates=0,removes=0;
  const native={
    prepare:async job=>{creates++;owned={job_id:job.job_id,sandbox_id:'owned-sandbox',_cleanupId:'owned-incarnation'};throw Error('created then lost response');},
    start:async()=>{},cancel:async()=>{},inspect:async h=>({job_id:h.job_id,status:'exited'}),
    destroy:async h=>{removes++;return {job_id:h.job_id,sandbox_id:h.sandbox_id,removed:true,scratch_removed:true,policy_removed:true,storage_removed:true};}
  };
  let visible=false;
  const options={backend:native,journalDirectory:f.deps.journal.directory+'/backend',clock:()=>1000,
    resolveJob:async()=>({job_id:'job-sentinel'}),bindRun:async()=>{},
    recoverHandle:async({attemptId})=>visible&&attemptId==='attempt-sentinel'?owned:null};
  f.deps.backend=createLaunchBackend(options);
  f.deps.coordinator.release=async()=>{releases++;return {ok:true,value:{kind:'released'}};};
  const launch=createLendingLaunch(f.deps);
  assert.equal((await launch.prepareLend(f.request)).error.code,'preparation_uncertain');
  const release={attemptId:'attempt-sentinel',reason:'preparation_failed',operationId:'reconcile-release'};
  const reopened=createLendingLaunch({...f.deps,backend:createLaunchBackend(options)});
  assert.equal((await reopened.releaseBeforeStart(release)).ok,false);
  assert.equal(releases,0);assert.equal(creates,1);
  assert.deepEqual((await f.ledger.snapshot('account-sentinel')).resources,
    [{id:'seven_day',instance:'week-sentinel',unit:'window_micro_points',consumed:0,reserved:10000000,unrepresented:0}]);
  visible=true;
  assert.equal((await reopened.releaseBeforeStart(release)).value.claimable,true);
  assert.equal((await reopened.releaseBeforeStart(release)).value.claimable,true);
  assert.equal(releases,1);assert.equal(removes,1);assert.equal(creates,1);
  assert.deepEqual((await f.ledger.snapshot('account-sentinel')).resources,
    [{id:'seven_day',instance:'week-sentinel',unit:'window_micro_points',consumed:0,reserved:0,unrepresented:0}]);
});

test('binding persistence failure retains composed preparation ownership until recovery',async t=>{
  const f=await fixture(t);let owned,failBinding=false,releases=0;
  const original=fs.renameSync;
  const native={
    prepare:async job=>{owned={job_id:job.job_id,sandbox_id:'persist-sandbox',_cleanupId:'persist-incarnation'};failBinding=true;return owned;},
    start:async()=>{},cancel:async()=>{},inspect:async h=>({job_id:h.job_id,status:'exited'}),
    destroy:async h=>({job_id:h.job_id,sandbox_id:h.sandbox_id,removed:true,scratch_removed:true,policy_removed:true,storage_removed:true})
  };
  let visible=false;
  const options={backend:native,journalDirectory:f.deps.journal.directory+'/backend',clock:()=>1000,
    resolveJob:async()=>({job_id:'job-sentinel'}),bindRun:async()=>{},recoverHandle:async()=>visible?owned:null};
  f.deps.backend=createLaunchBackend(options);
  f.deps.coordinator.release=async()=>{releases++;return {ok:true,value:{kind:'released'}};};
  fs.renameSync=(from,to)=>{
    if(failBinding&&String(to).startsWith(options.journalDirectory+'/')){failBinding=false;throw Error('synthetic binding persistence failure');}
    return original(from,to);
  };
  try{assert.equal((await createLendingLaunch(f.deps).prepareLend(f.request)).error.code,'preparation_uncertain');}
  finally{fs.renameSync=original;}
  const launch=createLendingLaunch({...f.deps,backend:createLaunchBackend(options)});
  const request={attemptId:'attempt-sentinel',reason:'preparation_failed',operationId:'persist-release'};
  assert.equal((await launch.releaseBeforeStart(request)).ok,false);
  assert.equal(releases,0);assert.equal((await f.ledger.snapshot('account-sentinel')).resources[0].reserved,10000000);
  visible=true;
  assert.equal((await launch.releaseBeforeStart(request)).value.claimable,true);
  assert.equal(releases,1);assert.equal((await f.ledger.snapshot('account-sentinel')).resources[0].reserved,0);
});

test('account result selection never substitutes requested model for observation',()=>{
  const selection=input().job.selection;
  const unknown={model:null};assert.throws(()=>bindObservedAccountSelection(unknown,selection),/model_unverified/);
  assert.deepEqual(unknown,{model:null});
  const mismatch={model:'other-model'};assert.throws(()=>bindObservedAccountSelection(mismatch,selection),/model_unverified/);
  assert.deepEqual(mismatch,{model:'other-model'});
  const match={model:'model-sentinel'};bindObservedAccountSelection(match,selection);
  assert.deepEqual(match,{model:'model-sentinel',selection});
  assert.notEqual(match.selection,selection);
});

test('composed confirmed aborted preparation releases once only after exact cleanup receipt',async t=>{
  const f=await fixture(t),controller=new AbortController();let releases=0,removed=0;
  f.request.signal=controller.signal;
  const native={
    prepare:async job=>{controller.abort();return {job_id:job.job_id,sandbox_id:'abort-owned',_cleanupId:'abort-incarnation'};},
    start:async()=>{},cancel:async()=>{},inspect:async h=>({job_id:h.job_id,status:'exited'}),
    destroy:async h=>{removed++;return {job_id:h.job_id,sandbox_id:h.sandbox_id,removed:true,scratch_removed:true,policy_removed:true,storage_removed:true};}
  };
  f.deps.backend=createLaunchBackend({backend:native,journalDirectory:f.deps.journal.directory+'/backend',clock:()=>1000,
    resolveJob:async()=>({job_id:'job-sentinel'}),bindRun:async()=>{},recoverHandle:async()=>null});
  f.deps.coordinator.release=async()=>{releases++;return {ok:true,value:{kind:'released'}};};
  const launch=createLendingLaunch(f.deps);
  assert.equal((await launch.prepareLend(f.request)).error.code,'stopped');
  assert.equal((await launch.prepareLend(f.request)).error.code,'stopped');
  assert.equal(releases,1);assert.equal(removed,1);
  assert.deepEqual((await f.ledger.snapshot('account-sentinel')).resources,
    [{id:'seven_day',instance:'week-sentinel',unit:'window_micro_points',consumed:0,reserved:0,unrepresented:0}]);
});

test('unknown composed preparation cannot manufacture cessation or bypass ledger fence',async t=>{
  const f=await fixture(t);
  f.deps.backend.prepare=async()=>({ok:false,error:{code:'preparation_uncertain'}});
  const launch=createLendingLaunch(f.deps);await launch.prepareLend(f.request);
  assert.equal((await launch.stopLend({attemptId:'attempt-sentinel',reason:'owner'})).ceasedAtMs,null);
  const snapshot=await f.ledger.snapshot('account-sentinel');
  assert.equal((await f.ledger.release({accountId:'account-sentinel',reservationId:snapshot.attempts[0].reservationId,
    operationId:'bypass',cessation:{kind:'never_started',atMs:1000}})).code,'cessation_unverified');
  assert.equal((await f.ledger.snapshot('account-sentinel')).resources[0].reserved,10000000);
});

test('dead outer preparation owner reconciles native debt while a live OS lock stays pending',async t=>{
 const f=await fixture(t),prepared=await f.launch.prepareLend(f.request);assert.equal(prepared.ok,true);
 const file=f.deps.journal.directory+'/lending.json',data=JSON.parse(await readFile(file));
 const row=data.launches['attempt-sentinel'];row.preparing=true;row.prepareOwnerProtocol=1;row.backendPending=true;
 await writeFile(file,JSON.stringify(data));let reconciles=0;
 f.deps.backend.reconcilePreparation=async()=>{reconciles++;return {ok:true,value:{kind:'removed'}};};
 const {createHash}=await import('node:crypto');
 const lock=f.deps.journal.directory+'/'+createHash('sha256').update(JSON.stringify('attempt-sentinel')).digest('hex')+'.prepare.lock';
 const owner=await tryLockAsync(lock);assert.ok(owner);
 const request={attemptId:'attempt-sentinel',reason:'preparation_failed',operationId:'orphan-release'};
 try{assert.equal((await f.launch.releaseBeforeStart(request)).error.code,'preparation_pending');assert.equal(reconciles,0);}
 finally{owner.release();}
 assert.equal((await createLendingLaunch(f.deps).releaseBeforeStart(request)).value.claimable,true);
 assert.equal(reconciles,1);assert.equal((await f.ledger.snapshot(f.request.selection.accountId)).resources[0].reserved,0);
});

test('started settlement requires both native cessation and resolved transport debt',async t=>{
 const f=await fixture(t);const prepared=await f.launch.prepareLend(f.request);
 await f.launch.startLend({attemptId:'attempt-sentinel',operationId:'start'});
 f.deps.broker.revokeJobKey=async()=>({aborted:[],unconfirmed:['pending-remote-operation']});
 assert.equal((await f.launch.stopLend({attemptId:'attempt-sentinel',reason:'finished'})).ceasedAtMs,null);
 const usage={accountId:f.request.selection.accountId,jobReadings:[],reading:null};
 assert.equal((await f.launch.settleUsage({attemptId:'attempt-sentinel',usage})).error.code,'cessation_unverified');
 assert.equal((await f.ledger.snapshot(usage.accountId)).resources[0].reserved,10000000);
 f.deps.broker.revokeJobKey=async()=>({aborted:[],unconfirmed:[]});
 assert.equal((await f.launch.stopLend({attemptId:'attempt-sentinel',reason:'reconciliation'})).ceasedAtMs,1000);
 assert.equal((await f.launch.settleUsage({attemptId:'attempt-sentinel',usage})).ok,true);
 assert.equal((await f.ledger.snapshot(usage.accountId)).resources[0].reserved,10000000,'Stop alone never invents final zero usage');
 assert.ok(prepared.value.reservationId);
});
