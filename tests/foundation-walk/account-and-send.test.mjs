import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAccountAndSendDriver, FOUNDATION_PROMPT } from './account-and-send.mjs';

const steps = ['W04_ACCOUNT_OPTIONS', 'W05_SEND_SELECTED', 'W06_RESULT_RETURN'];
function setup(t) {
  const identity = { schemaVersion: 1, accountId: 'fixture-account', jobId: 'fixture-job',
    attemptId: 'fixture-attempt', readingAgeMs: 1234 };
  const selection = { requestedModel: 'fixture-model', effectiveModel: 'fixture-model',
    requestedEffort: 'fixture-effort', effectiveEffort: 'fixture-effort' };
  const fixture = { ...identity, model: 'fixture-model', effort: 'fixture-effort', temporary: ['fixture-only'],
    ui: {
      [steps[0]]: { ...identity, ...selection, enrollment: 'confirmed', lendingMode: 'auto', supported: true },
      [steps[1]]: { ...identity, ...selection, project: null, submission: 'confirmed', prompt: FOUNDATION_PROMPT },
      [steps[2]]: { ...identity, message: 'FOUNDATION_OK', downloadedText: 'FOUNDATION_OK',
        artifact: { ...identity, signatureVerified: true,
          sha256: createHash('sha256').update('FOUNDATION_OK').digest('hex') } },
    } };
  const driver = createAccountAndSendDriver(fixture);
  t.after(async () => { await driver.cleanup({}); assert.deepEqual(fixture.temporary, []); });
  return { fixture, driver };
}
test('conservative fake-only assumption: W04-W06 preserve exact selection and never claim user validation', async t => {
  const { fixture, driver } = setup(t);
  for (const check of steps) {
    const r = await driver.run({ check });
    assert.equal(r.outcome, 'pass');
    assert.equal(r.observed.fixtureIntervention, true);
    assert.equal(r.observed.readingAgeMs, 1234);
    assert.equal(r.observed.attemptId, 'fixture-attempt');
  }
  assert.deepEqual(fixture.actions.map(a => a.action), ['enroll_and_select', 'send', 'inspect_result']);
  assert.equal(fixture.actions[0].via, 'Faravan');
  assert.equal(fixture.actions[0].lendingMode, 'auto');
  assert.equal(fixture.actions[1].project, null);
  assert.equal(fixture.actions[1].prompt, FOUNDATION_PROMPT);
  await driver.run({ check: steps[1] });
  assert.equal(fixture.actions.length, 3);
});
test('login and ambiguous submit resume after reconstruction without duplicate actions', async t => {
  const { fixture, driver } = setup(t);
  const enrolled = fixture.ui[steps[0]];
  fixture.ui[steps[0]] = { loginRequired: true };
  assert.equal((await driver.run({ check: steps[0] })).pause, 'login');
  await driver.cleanup({ paused: true });
  fixture.ui[steps[0]] = enrolled;
  const resumed = createAccountAndSendDriver(fixture);
  assert.equal((await resumed.resume({ check: steps[0] })).outcome, 'pass');
  const submitted = fixture.ui[steps[1]];
  delete fixture.ui[steps[1]];
  assert.equal((await resumed.run({ check: steps[1] })).observed.code, 'observation_ambiguous');
  assert.equal((await resumed.run({ check: steps[1] })).observed.code, 'reconciliation_required');
  fixture.ui[steps[1]] = submitted;
  assert.equal((await resumed.resume({ check: steps[1] })).outcome, 'pass');
  assert.deepEqual(fixture.actions.map(a => a.action), ['enroll_and_select', 'send']);
});
test('no implicit downgrade, changed identity or changed observation age is accepted', async t => {
  for (const mutation of [
    { effectiveModel: 'other' }, { effectiveEffort: 'other' }, { supported: false },
    { accountId: 'other' }, { jobId: 'other' }, { attemptId: 'other' }, { readingAgeMs: 0 },
    { lendingMode: 'manual' },
  ]) {
    const { fixture, driver } = setup(t);
    Object.assign(fixture.ui[steps[0]], mutation);
    assert.equal((await driver.run({ check: steps[0] })).outcome, 'fail');
    assert.equal((await driver.run({ check: steps[1] })).outcome, 'blocked');
    assert.equal(fixture.actions.length, 1);
  }
});
test('result requires exact message and file plus bound signed artifact hash', async t => {
  for (const mutate of [
    row => { row.message += '!'; }, row => { row.downloadedText += '!'; },
    row => { row.artifact.sha256 = 'bad'; }, row => { row.artifact.signatureVerified = false; },
    row => { row.artifact.attemptId = 'other'; },
  ]) {
    const { fixture, driver } = setup(t);
    await driver.run({ check: steps[0] }); await driver.run({ check: steps[1] });
    mutate(fixture.ui[steps[2]]);
    assert.equal((await driver.run({ check: steps[2] })).outcome, 'fail');
  }
});
test('cancelled, out-of-order and unsupported checks have no synthetic side effects', async t => {
  const { fixture, driver } = setup(t);
  const controller = new AbortController(); controller.abort();
  assert.equal((await driver.run({ check: steps[0], signal: controller.signal })).outcome, 'blocked');
  assert.equal((await driver.run({ check: steps[2] })).outcome, 'blocked');
  assert.equal((await driver.run({ check: 'W01_CLEAN_NONOWNER' })).outcome, 'blocked');
  assert.equal((await driver.resume({ check: steps[0] })).outcome, 'blocked');
  assert.deepEqual(fixture.actions, []);
});
