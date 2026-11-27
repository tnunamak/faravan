import test from 'node:test';
import assert from 'node:assert/strict';
import { createLender } from '../../lib/v1/lender.mjs';

// Conservative preservation assumption: a worker that has not started its
// loop must not launch/reserve through a status read. This does not qualify
// the replacement Foundation launch path or a running worker's status view.
test('assuming stopped workers, snapshots and settings notifications have no launch effects', async () => {
  const effects = [];
  const forbidden = name => () => {
    effects.push(name);
    throw new Error('unexpected synthetic effect: ' + name);
  };
  const make = accountKey => {
    const policy = {
      enabled: true,
      mode: 'ask',
      storage: { get: forbidden('storage.get'), set: forbidden('storage.set') },
      lendingRuntime: {
        reserve: forbidden('runtime.reserve'),
        release: forbidden('runtime.release'),
        candidate: {
          reserve: forbidden('candidate.reserve'),
          admitStart: forbidden('candidate.admitStart'),
          started: forbidden('candidate.started'),
          release: forbidden('candidate.release'),
        },
      },
    };
    const worker = createLender({
      accountKey, policy,
      client: { startAttempt: forbidden('coordinator.startAttempt') },
      backend: {
        lenderCapabilities: forbidden('backend.lenderCapabilities'),
        admitJob: forbidden('backend.admitJob'),
        prepare: forbidden('backend.prepare'),
        start: forbidden('backend.start'),
        requestStop: forbidden('backend.requestStop'),
      },
      credentialValues: forbidden('credentialValues'),
      clock: {
        now: () => 1000, monotonic: () => 1000,
        setTimeout: forbidden('timer.set'), clearTimeout: forbidden('timer.clear'),
      },
    });
    return { worker, policy };
  };
  // Distinct keys are opaque fixture identities, not an assertion about a
  // provider/account parser or the production account selection algorithm.
  const left = make('synthetic-left');
  const right = make('synthetic-right');
  const baseline = right.worker.getState();
  for (let i = 0; i < 3; i++) {
    for (const { worker } of [left, right]) {
      assert.equal(worker.admits({}), 'lender_stopped');
      assert.equal(worker.getState().current, null);
      assert.equal(worker.snapshot.counters, null);
    }
  }
  const copy = left.worker.snapshot;
  copy.status = 'running';
  copy.current = 'fabricated-attempt';
  assert.equal(left.worker.getState().status, 'paused');
  assert.equal(left.worker.getState().current, null);
  left.policy.mode = 'auto';
  left.worker.reconfigure();
  await left.worker.refreshAdmission();
  assert.equal(left.worker.admits({}), 'lender_stopped');
  assert.deepEqual(right.worker.getState(), baseline, 'one worker cannot mutate another snapshot');
  await assert.rejects(left.worker.stopCurrentJob('unowned-attempt'),
    error => error.code === 'no_current_job');
  assert.deepEqual(effects, [], 'reads/notifications cannot silently acquire authority or reserve');
  // No loop, timer, sandbox, file, native credential, or network fixture was
  // opened, so there is no started resource to stop or dispose.
});
