// Replays of TLC traces from spec/tla/LendingLease.tla against the real store.
// Each test is one trace, one store call per model step. A test here fails while
// the bug it shows is open; `npm run protocol:replay` runs this folder.
import '../helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeFixture } from './store-fixture.mjs';

const L1 = 1, L2 = 3;

// TLC: LendingLease_counter.cfg, invariant I2c_CounterWithinMax (attempts_started <= max_attempts).
// The commit that counts late observations (368d4ca2) says: "With max_attempts 1 the
// requeued job fails, and no second run can start." That held only when the late observation
// landed before the second try was authorized. A late observation of a stopped attempt that
// landed after the job moved to a newer attempt spent a try too, so the newer try showed 2 of 1.
// Shipped code: that observation spends no try (store.mjs observeExecutionStart); this passes.
test('I2c: a late observed-start of a stopped attempt does not spend a try of the job\'s newer attempt', t => {
  const f = storeFixture(t);
  const { digest } = f.publish({ max_attempts: 1 });
  // 1. L1 claims, the coordinator authorizes its start. L1's guard starts; L1 saves its
  //    observation intent and sends observed-start, which is delayed in the network.
  const first = f.claim(digest, L1);
  f.start(first, L1);
  // 2. L1 crashes before its agent gets the launch ack. On restart it removes the
  //    sandbox, releases (restart_interrupted) and reports /stopped: the fence ends.
  f.release(first, L1);
  f.stopped(first, L1);
  assert.equal(f.get(digest).state, 'queued');
  assert.equal(f.get(digest).attempts_started, 0);
  // 3. L2 claims and its start is authorized (0 of 1 tries spent).
  const second = f.claim(digest, L2);
  f.start(second, L2);
  // 4. L1's delayed observed-start for the first try arrives. Its stop was already reported and the job
  //    belongs to L2's try now, so it spends no try.
  f.observe(first, L1);
  assert.equal(f.get(digest).attempts_started, 0);
  // 5. L2's observed-start is accepted: its try is the one try of max_attempts 1, and its agent runs.
  f.observe(second, L2);
  const view = f.get(digest);
  assert.equal(view.attempts_started, 1, `attempts_started ${view.attempts_started} for max_attempts 1 (state ${view.state})`);
});
