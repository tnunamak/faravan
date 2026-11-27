import './helpers/no-browser.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSpendMonitor} from '../packaging/journey/local-lend-spend.mjs';
const now=1700000000000;
function reading({at=now,instance='window',spent=1000,aggregate=1000,kappa=1000000}={}) {
  return {missing:[],attempts:[{id:'attempt',resources:[{id:'seven_day',instance,kappa_micro:kappa,spent_micro:spent,
    baseline_used_micro:0,aggregate_used_micro:aggregate,aggregate_observed_at:at,initial_micro:1500000}]}]};
}
test('missing or corrupt ledger after execution fails immediately',()=>{
  for(const missing of [['missing file'],['malformed JSON']]) {
    const observe=createSpendMonitor();
    observe({digest:'a',read:reading(),now});
    assert.throws(()=>observe({digest:'a',read:{attempts:[],missing},executionStarted:true,now}),/Missing spend/);
  }
});
test('only an absent pre-admission attempt may wait',()=>{
  const observe=createSpendMonitor();
  const read={attempts:[],missing:['lending-pace50-state.json attempts[job_id=a]']};
  assert.equal(observe({digest:'a',read,now}),undefined);
  assert.throws(()=>observe({digest:'a',read,executionStarted:true,now}));
});
test('verified terminal charges survive a later job more than sixty seconds later',()=>{
  const observe=createSpendMonitor();
  observe({digest:'a',read:reading(),terminal:true,now});
  assert.ok(observe({digest:'b',read:reading({at:now+120000}),terminal:true,now:now+120000}));
});
test('identity, conversion, counters and resource removal cannot erase spend',()=>{
  for(const changes of [{instance:'replacement'},{kappa:2000000},{spent:999},{aggregate:999}]) {
    const observe=createSpendMonitor();
    observe({digest:'a',read:reading(),now});
    assert.throws(()=>observe({digest:'a',read:reading(changes),now}),/changed|regressed/);
  }
});
test('finalized charges still count against the run cap',()=>{
  const observe=createSpendMonitor();
  observe({digest:'a',read:reading({spent:1400000,aggregate:1400000}),terminal:true,now});
  observe({digest:'b',read:reading({spent:1400000,aggregate:1400000}),terminal:true,now});
  assert.throws(()=>observe({digest:'c',read:reading({spent:1400000,aggregate:1400000}),terminal:true,now}),/Run spend cap/);
});
