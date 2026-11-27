import test from 'node:test';
import assert from 'node:assert/strict';
import {decideLending, normalizeLendingAccounting} from '../../lib/v1/lending-decision.mjs';
import {evaluateLending} from '../../lib/v1/lending-policy.mjs';

const M=1000000, AGE=1500000;
function fixture() {
  const now=1000000000, accountId='account-sentinel';
  return {schemaVersion:1,nowMs:now,
    account:{id:accountId,providerId:'provider-sentinel',enabled:true,authState:'signed_in'},
    usage:{accountId,state:'ready',limitResetAtMs:null,nextReadAtMs:null,
      reading:{accountId,observedAtMs:now-AGE,coverage:{kind:'unknown'},windows:[
        {id:'seven_day',instance:'week-sentinel',capacityMicro:100*M,usedHiMicro:20*M,
          resetsAtMs:now+3600000,maxOwnerRateMicroPerMs:0}]}},
    policy:{schemaVersion:1,revision:1,enabled:true,strategy:'automatic',strategyParams:{},protectionPosition:'keep_more_for_me'},
    eligibility:{enabledNow:true,reason:'enabled',evaluatedAtMs:now,settingsRevision:1,nextChangeAtMs:null},
    job:{id:'job-sentinel',attemptId:'attempt-sentinel',
      selection:{accountId,providerId:'provider-sentinel',modelId:'model-sentinel',effortId:null}},
    runtime:{canStart:true,nextAction:null},
    ledger:{accountId,revision:0,attempts:[],resources:[
      {id:'seven_day',instance:'week-sentinel',unit:'window_micro_points',
        consumed:30*M,unrepresented:30*M,reserved:5*M}]},
    history:{accountId,rows:[]}};
}
const coordinate=i=>normalizeLendingAccounting(i).coordinates[0];
function freeze(value) {
  if(value && typeof value==='object') {Object.values(value).forEach(freeze);Object.freeze(value);}
  return value;
}
test('valid aged decision control consumes the real normalized allocator input',()=>{
  for(const ownerRate of [0,10]) {
    const i=fixture();i.usage.reading.windows[0].maxOwnerRateMicroPerMs=ownerRate;
    const n=normalizeLendingAccounting(i), direct=evaluateLending(n.evaluation), d=decideLending(i);
    assert.equal(direct.admitted,true);
    assert.equal(d.kind,'lend');
    assert.equal(d.mode,'aged');assert.equal(d.readingAgeMs,AGE);
    assert.equal(n.evaluation.objectiveInput.observedAt,i.nowMs-AGE);
    assert.deepEqual(d.amount.byResource,Object.entries(direct.reservePointsMicro)
      .filter(([,amount])=>amount>0).map(([id,amount])=>({id,instance:'week-sentinel',amount})));
    assert.ok(d.amount.byResource[0].amount>0);
  }
});
test('equation17 exact accounting: upper50, one reservation5, room45',()=>{
  const i=fixture(), c=coordinate(i);
  assert.deepEqual(c,{id:'seven_day',instance:'week-sentinel',unit:'window_micro_points',
    upperMicro:50*M,reservedMicro:5*M,remainingMicro:45*M});
  const w=normalizeLendingAccounting(i).evaluation.objectiveInput.windows.seven_day;
  assert.equal(w.usedMicro,50*M);assert.equal(w.committedMicro,5*M);
  assert.equal(w.lentMicro,35*M); // fixed-share exposure must retain consumed plus held
  i.ledger.resources[0].reserved=0;
  const released=coordinate(i);
  assert.equal(released.upperMicro,50*M);assert.equal(released.reservedMicro,0);
  assert.equal(released.remainingMicro,50*M);
  assert.equal(released.remainingMicro-c.remainingMicro,5*M);
});
test('positive owner increment and fractional micro-point rounding happen once',()=>{
  const i=fixture();i.usage.reading.windows[0].maxOwnerRateMicroPerMs=10;
  assert.deepEqual(coordinate(i),{id:'seven_day',instance:'week-sentinel',unit:'window_micro_points',
    upperMicro:65*M,reservedMicro:5*M,remainingMicro:30*M});
  i.usage.reading.windows[0].maxOwnerRateMicroPerMs=0.5/AGE;
  assert.equal(coordinate(i).upperMicro,50*M+1);
  assert.equal(coordinate(i).remainingMicro,45*M-1);
});
test('other window, nonmatching instance and native unit cannot offset accounting',()=>{
  const i=fixture(), expected=coordinate(i);
  const row=i.ledger.resources[0];
  i.ledger.resources.push({...row,id:'five_hour',reserved:90*M,unrepresented:90*M},
    {...row,instance:'next-week',reserved:90*M,unrepresented:90*M},
    {...row,unit:'tokens',reserved:90*M,unrepresented:90*M});
  assert.deepEqual(coordinate(i),expected);
});
test('account bindings fail closed and all normalization and decision inputs stay immutable',()=>{
  for(const field of ['usage','ledger','history']) {
    const i=fixture();i[field].accountId='another-account';
    assert.throws(()=>normalizeLendingAccounting(i),/invalid_decision_input/);
    assert.throws(()=>decideLending(i),/invalid_decision_input/);
  }
  const wrong=fixture();wrong.usage.reading.accountId='another-account';
  assert.throws(()=>normalizeLendingAccounting(wrong),/invalid_decision_input/);
  const i=fixture(), before=structuredClone(i);freeze(i);
  normalizeLendingAccounting(i);decideLending(i);
  assert.deepEqual(i,before);
});
test('full accounting exhaustion reaches the facade, not just an unused helper',()=>{
  const i=fixture();i.ledger.resources[0].reserved=50*M;
  assert.equal(coordinate(i).remainingMicro,0);
  assert.equal(decideLending(i).kind,'wait');
});
