import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeptAndCleanupDriver, KEPT_ACTIONS } from './kept-and-cleanup.mjs';

const check = 'W09_FIXTURE';
function setup(t) {
  const identity = { schemaVersion: 1, accountId: 'a', jobId: 'j', attemptId: 'attempt', readingAgeMs: 123 };
  const fixture = { ...identity, owned: [], kept: {}, cleanupProofs: {},
    allocation: { ...identity, closed: true }, unrelated: [{ pid: 999, container: 'unrelated' }] };
  const resource = (kind, id) => {
    fixture.owned.push({ ...identity, kind, id });
    fixture.cleanupProofs[kind + ':' + id] = { ...identity, kind, resourceId: id,
      cessation: 'confirmed', removed: true, rosterLeft: true };
  };
  resource('backend', 'backend'); resource('membership', 'circle'); resource('target', 'target');
  for (const kind of KEPT_ACTIONS) fixture.kept[kind] = { ...identity, kind, confirmed: true,
    commit: 'a'.repeat(40), digest: 'b'.repeat(64), verified: true, disposable: true, targetId: 'target' };
  const make = () => createKeptAndCleanupDriver(fixture, { keptCheck: check });
  const driver = make();
  t.after(async () => {
    // Dispose only this in-memory fixture; no external resources exist.
    fixture.owned = []; fixture.allocation = { ...identity, closed: true };
    assert.equal((await driver.cleanup()).outcome, 'pass');
    assert.deepEqual(fixture.unrelated, [{ pid: 999, container: 'unrelated' }]);
  });
  return { fixture, driver, make, resource, identity };
}
test('conservative synthetic-only assumption: injected W09 transcript is not product validation', async t => {
  const { fixture, driver } = setup(t);
  const out = await driver.run({ check });
  assert.equal(out.outcome, 'pass');
  assert.equal(out.observed.fixtureIntervention, true);
  assert.equal(out.observed.readingAgeMs, 123);
  assert.deepEqual(fixture.actions.map(a => a.kind), KEPT_ACTIONS);
  assert.deepEqual(out.evidencePaths, []);
  assert.equal((await driver.cleanup()).outcome, 'pass');
  assert.equal((await driver.run({ check })).observed.code, 'cleanup_started');
});
test('missing transfer receipt resumes after reconstruction without replay', async t => {
  const { fixture, driver, make } = setup(t);
  const proof = fixture.kept.transfer; delete fixture.kept.transfer;
  assert.equal((await driver.run({ check })).outcome, 'blocked');
  assert.equal((await driver.run({ check })).observed.code, 'reconciliation_required');
  fixture.kept.transfer = proof;
  assert.equal((await make().resume({ check })).outcome, 'pass');
  assert.equal(fixture.actions.filter(a => a.kind === 'transfer').length, 1);
});
test('pinned source and verified disposable application fail closed', async t => {
  for (const [kind, mutation] of [
    ['pinned_repo_source', { commit: 'main' }],
    ['verified_review', { verified: false }],
    ['apply_disposable', { digest: 'c'.repeat(64) }],
    ['apply_disposable', { disposable: false }],
    ['apply_disposable', { targetId: 'unowned' }],
    ['rename_circle', { attemptId: 'other' }],
  ]) {
    const { fixture, driver } = setup(t);
    Object.assign(fixture.kept[kind], mutation);
    assert.equal((await driver.run({ check })).outcome, 'fail');
    assert.ok(!fixture.completed.includes(kind));
  }
});
test('pending removal and stale roster entry prevent cleanup success', async t => {
  const { fixture, driver } = setup(t);
  fixture.cleanupProofs['backend:backend'].removed = false;
  assert.equal((await driver.cleanup()).outcome, 'blocked');
  fixture.cleanupProofs['backend:backend'].removed = true;
  fixture.cleanupProofs['membership:circle'].rosterLeft = false;
  assert.equal((await driver.cleanup()).outcome, 'blocked');
  fixture.cleanupProofs['membership:circle'].rosterLeft = true;
  assert.equal((await driver.cleanup()).outcome, 'pass');
  assert.equal(fixture.actions.filter(a => a.kind === 'remove_owned' && a.id === 'backend:backend').length, 1);
});
test('idle, zero and cancellation acknowledgement never prove cessation', async t => {
  const { fixture, driver } = setup(t);
  const proof = fixture.cleanupProofs['backend:backend'];
  Object.assign(proof, { cessation: 'unknown', cancelAcknowledged: true, idle: true, activeCount: 0 });
  assert.equal((await driver.cleanup()).outcome, 'blocked');
  assert.ok(!fixture.actions.some(a => a.kind === 'remove_owned' && a.id === 'backend:backend'));
  Object.assign(proof, { cessation: 'never_started', authoritative: true, allocationClosed: false });
  assert.equal((await driver.cleanup()).outcome, 'blocked');
  proof.allocationClosed = true;
  assert.equal((await driver.cleanup()).outcome, 'pass');
});
test('late backend allocation is rechecked, not hidden by earlier cleanup', async t => {
  const { fixture, driver, resource } = setup(t);
  fixture.allocation.closed = false;
  assert.equal((await driver.cleanup()).outcome, 'blocked');
  resource('backend', 'late');
  fixture.cleanupProofs['backend:late'].cessation = 'unknown';
  fixture.allocation.closed = true;
  assert.equal((await driver.cleanup()).outcome, 'blocked');
  assert.ok(fixture.actions.some(a => a.kind === 'cancel_owned' && a.id === 'backend:late'));
  fixture.cleanupProofs['backend:late'].cessation = 'confirmed';
  assert.equal((await driver.cleanup()).outcome, 'pass');
  resource('backend', 'unexpected-late');
  fixture.cleanupProofs['backend:unexpected-late'].removed = false;
  assert.equal((await driver.cleanup()).outcome, 'blocked');
});
test('foreign proofs and unrelated PID/container never authorize removal', async t => {
  const { fixture, driver } = setup(t);
  fixture.cleanupProofs['backend:backend'].resourceId = 'foreign';
  assert.equal((await driver.cleanup()).outcome, 'blocked');
  assert.ok(!fixture.actions.some(a => a.kind === 'remove_owned' && a.id === 'backend:backend'));
  assert.ok(fixture.actions.every(a => !JSON.stringify(a).includes('999') && !JSON.stringify(a).includes('unrelated')));
});
test('empty ledger still requires authoritative allocation closure', async t => {
  const { fixture, driver } = setup(t);
  fixture.owned = []; delete fixture.allocation;
  assert.equal((await driver.cleanup()).outcome, 'blocked');
});
test('aborted run has no actions and reconstructed identity cannot reuse history', async t => {
  const { fixture, driver, make } = setup(t);
  const controller = new AbortController(); controller.abort();
  assert.equal((await driver.run({ check, signal: controller.signal })).outcome, 'blocked');
  assert.deepEqual(fixture.actions, []);
  fixture.attemptId = 'different';
  assert.throws(make, /fixture_binding_mismatch/);
});
