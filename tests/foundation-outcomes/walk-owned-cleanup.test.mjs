import test from 'node:test';
import assert from 'node:assert/strict';
import {createKeptAndCleanupDriver} from '../foundation-walk/kept-and-cleanup.mjs';

// Conservative assumption: this tests the existing SYNTHETIC receipt ledger only.
// No real operation, signature, provider, incarnation or W09/W10 qualification.
// Dependency retained: fv-outcome-walk-aged-stop-actions-1114.
const binding = {schemaVersion:1, accountId:'account', jobId:'job', attemptId:'attempt', readingAgeMs:1500000};
function setup() {
  const fixture = {...binding, owned:[], cleanupProofs:{}, allocation:{...binding, closed:true}};
  const driver = createKeptAndCleanupDriver(fixture, {keptCheck:'W09_KEEP_REGRESSIONS'});
  const own = (kind,id,proof={}) => {
    fixture.owned.push({...binding,kind,id});
    fixture.cleanupProofs[kind+':'+id] = {...binding,kind,resourceId:id,...proof};
  };
  return {fixture,driver,own};
}
const code = async (driver,outcome,expected) => {
  const result = await driver.cleanup();
  assert.equal(result.outcome,outcome);
  assert.equal(result.observed.code,expected);
  assert.equal(result.observed.fixtureIntervention,true);
  return result;
};

test('conservative synthetic ledger: a late backend invalidates previous cleanup success', async () => {
  const {fixture,driver,own} = setup();
  await code(driver,'pass','synthetic_cleanup_confirmed');
  own('backend','late');
  own('source','input',{removed:true});
  await code(driver,'blocked','cleanup_unconfirmed');
  assert.deepEqual(fixture.actions.map(a=>[a.kind,a.id]),[['cancel_owned','backend:late']]);
  const run = await driver.run({check:'W09_KEEP_REGRESSIONS'});
  assert.equal(run.observed.code,'cleanup_started');
  fixture.cleanupProofs['backend:late'].cessation='confirmed';
  await code(driver,'blocked','cleanup_unconfirmed'); // cessation is not removal
  fixture.cleanupProofs['backend:late'].removed=true;
  await code(driver,'pass','synthetic_cleanup_confirmed');
  const actions = structuredClone(fixture.actions);
  await code(driver,'pass','synthetic_cleanup_confirmed');
  assert.deepEqual(fixture.actions,actions); // replay does not duplicate cleanup requests
});

test('conservative synthetic ledger: never-started requires both authoritative and allocation-closed proof', async () => {
  for (const omitted of ['authoritative','allocationClosed']) {
    const {fixture,driver,own} = setup();
    own('backend','prepared',{cessation:'never_started',authoritative:true,allocationClosed:true,removed:true});
    delete fixture.cleanupProofs['backend:prepared'][omitted];
    await code(driver,'blocked','cleanup_unconfirmed');
    assert.equal(fixture.actions.some(a=>a.kind==='remove_owned'),false);
    fixture.cleanupProofs['backend:prepared'][omitted]=true;
    await code(driver,'pass','synthetic_cleanup_confirmed');
  }
});

test('conservative synthetic ledger: cancellation and removal do not substitute for cessation or roster proof', async () => {
  const {fixture,driver,own} = setup();
  own('backend','running',{state:'idle',cancelled:true,removed:true});
  own('membership','member',{removed:true});
  await code(driver,'blocked','cleanup_unconfirmed');
  assert.equal(fixture.actions.some(a=>a.kind==='leave_owned'),false);
  fixture.cleanupProofs['backend:running'].cessation='confirmed';
  await code(driver,'blocked','cleanup_unconfirmed');
  assert.equal(fixture.actions.some(a=>a.kind==='leave_owned'&&a.id==='membership:member'),true);
  fixture.cleanupProofs['membership:member'].rosterLeft=true;
  await code(driver,'pass','synthetic_cleanup_confirmed');
  fixture.allocation.closed=false;
  await code(driver,'blocked','cleanup_unconfirmed');
});

test('conservative synthetic ledger: foreign binding is refused before any cleanup request', async () => {
  for (const field of ['accountId','jobId','attemptId','readingAgeMs']) {
    const {fixture,driver,own} = setup();
    own('source','foreign',{removed:true});
    fixture.owned[0][field] = field==='readingAgeMs'?0:'foreign';
    await code(driver,'blocked','invalid_owned_ledger');
    assert.deepEqual(fixture.actions,[]);
  }
});

test('conservative synthetic ledger: mismatched resource receipt cannot prove owned backend cessation', async () => {
  const {fixture,driver,own} = setup();
  own('backend','owned',{cessation:'confirmed',removed:true});
  fixture.cleanupProofs['backend:owned'].resourceId='another';
  await code(driver,'blocked','cleanup_unconfirmed');
  assert.equal(fixture.actions.some(a=>a.kind==='remove_owned'),false);
  fixture.cleanupProofs['backend:owned'].resourceId='owned';
  await code(driver,'pass','synthetic_cleanup_confirmed');
});
