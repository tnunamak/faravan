import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createPresenceOverrideStore} from '../lib/v1/presence-override.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// The lender's own admission loop, with the real candidate and a present owner. The owner's one-job allowance is the only thing
// that lets a present owner's job run, and only for that job, once. The production stores are passed exactly as the app passes them.
const MIN = 60000;
const settingsOn = () => ({intent: 'on', limits: {idleOnly:true,lendingPolicy: {...normalizeLendingPolicy(), providerConsent: {codex: true}}}});

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: (event) => { f.events.push(event); }});
  const running = lender.start(controller.signal);
  let failure;
  const settled = Promise.resolve(running).catch((error) => { failure = error; });
  f.stop = async () => {
    controller.abort();
    await settled;
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
}

async function presentOwnerLender(t, directory0) {
  const f = await lenderFixture(t, {policy: {mode: 'auto',idleOnly:true}, run: {model: 'gpt-6-luna'}});
  f.policy.userActive = async () => true; // the owner is at the computer
  const directory = join(f.root, directory0);
  const presenceOverrides = createPresenceOverrideStore({directory: join(directory, 'presence')});
  const runtime = createLendingRuntime({directory, settings: settingsOn, backend: {}, presence: () => true, lastActiveAt: () => null,
    selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source: createSyntheticPace50Source({start: f.clock.now()}),
      presenceOverrides}});
  f.policy.lendingRuntime = runtime;
  return {f, runtime, presenceOverrides};
}

test('a present owner\'s job is refused by the candidate when the owner has allowed nothing, and nothing runs or is held', {timeout: 90000}, async (t) => {
  const {f, runtime} = await presentOwnerLender(t, 'pace50-refused');
  launch(f);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await f.stop();
  assert.equal(f.calls.some(([kind]) => kind === 'run'), false, 'the present owner\'s job did not run');
  assert.equal(runtime.pace50.state().attempts.length, 0, 'the candidate recorded no admission');
  await runtime.close();
});

test('a job the owner allowed while present runs once, and its allowance is audited', {timeout: 90000}, async (t) => {
  const {f, runtime, presenceOverrides} = await presentOwnerLender(t, 'pace50-allowed');
  f.policy.mode = 'ask';
  presenceOverrides.request({jobId: f.jobDigest, by: 'owner', reason: 'run this one now', now: f.clock.now(), ttlMs: 15 * MIN});
  launch(f);
  await until(() => f.count('/complete') === 1, 'the allowed job completed through the candidate path');
  await f.stop();
  assert.ok(f.calls.some(([kind]) => kind === 'run'), 'the allowed job ran');
  assert.equal(runtime.pace50.state().attempts[0].owner_presence_override, true,
    'the one-job presence approval is recorded with the durable reservation');
  assert.deepEqual(presenceOverrides.audit().map((entry) => entry.event), ['requested', 'consumed'], 'one request, one use');
  assert.equal(presenceOverrides.available({jobId: f.jobDigest, now: f.clock.now()}).reason, 'already_consumed');
  await runtime.close();
});
