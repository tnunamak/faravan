import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createLender } from '../lib/v1/lender.mjs';
import { createLendingPool } from '../lib/v1/lending-pool.mjs';
import { createAuthorityClient } from '../lib/v1/authority-client.mjs';
import { realLenderFixture } from './helpers/v1-real-lender-fixture.mjs';
import { BOTH, sandboxes, adapters, memory } from './helpers/v1-pool-fakes.mjs';
import { until } from './helpers/v1-lender-fixture.mjs';

// One serving device, one real lending pool, two authorities (owner-offline topology). Ordinary work stays at
// the incumbent host; work that names this device runs only at the device's own member store. When only the
// incumbent becomes unreachable, designated work keeps flowing, the ordinary attempt is neither duplicated nor
// moved to the member store, and every attempt, stop and settlement stays at the authority that issued it.
const vectors = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const OWN = vectors.keys[1].fingerprint;
// The owner's registry names both lent accounts, as the app's does; a registry-less fresh root would seed a legacy row with no
// counting day, which the lender (correctly) refuses.
const ACCOUNTS = [{ provider: 'claude', key: 'claude', enabled: true }, { provider: 'codex', key: 'codex', enabled: true }];
// The jobs a store was asked to claim (a replayed idempotent claim is the same job once).
const claims = (requests) => [...new Set(requests.filter((r) => r.url.endsWith('/claim')).map((r) => 'sha256:' + r.url.split('/jobs/')[1].split('/')[0]))];
const touching = (requests, digest) => requests.filter((r) => r.url.includes('/jobs/' + digest.slice(7) + '/'));

test('an incumbent outage stalls only ordinary work: designated work runs at the member store, nothing runs twice, stop stays exact', async (t) => {
  let incumbentDown = false;
  const f = await realLenderFixture(t, { memberStore: true, publish: false,
    mutateJob: (job) => { job.requirements.harness = BOTH; },
    intercept: (req) => { if (!incumbentDown) return false; req.socket.destroy(); return true; },
    policy: { servesMember: true } });
  const ordinary = await f.publish({ designated: false, text: 'ordinary one' });
  const designated = await f.publish({ designated: true, text: 'designated one' });

  const sbx = sandboxes(t), storage = memory(), events = [];
  const { storage: _unused, ...policy } = f.policy;
  policy.lendingPolicy = { accountSlots: 1, machineSlots: 2 };
  let rows = {};
  const client = createAuthorityClient({ ownKeyId: OWN, incumbent: async () => f.client, member: async () => f.member.client(1),
    routes: { read: async () => structuredClone(rows), write: async (value) => { rows = structuredClone(value); } },
    outageMs: 100, backoffMs: 300 });
  const pool = createLendingPool({ createLender, storage, policy, adapters: adapters(), capacity: 2, accounts: () => ACCOUNTS, client, backend: sbx.backend,
    clock: { now: f.clock.now, monotonic: () => performance.now() }, approve: async () => true, onEvent: (e) => events.push(e) });
  const controller = new AbortController();
  const loop = pool.start(controller.signal);
  f.stop = async () => { controller.abort(); for (const s of sbx.live.values()) s.run?.resolve(); await loop.catch(() => {}); };

  // One device executes one ordinary and one designated job, each at its own origin.
  await until(() => sbx.runs.length === 2, 'the ordinary and the designated job both run');
  const ordinaryAttempt = (await f.owner.getJob(ordinary)).current_attempt;
  const designatedAttempt = (await f.member.owner.getJob(designated)).current_attempt;
  assert.ok(ordinaryAttempt && designatedAttempt, 'each job has an attempt at its own authority');
  assert.equal((await f.member.owner.getJob(ordinary)).attempts_started, 0, 'the member copy of the ordinary job is never dispatched');
  assert.equal((await f.owner.getJob(designated)).attempts_started, 0, 'the incumbent copy of the designated job is never dispatched');
  assert.deepEqual(claims(f.realRequests), [ordinary], 'only the ordinary job was claimed at the incumbent');
  assert.deepEqual(claims(f.member.requests), [designated], 'only the designated job was claimed at the member store');
  assert.equal(rows[ordinary]?.a, 'incumbent');
  assert.equal(rows[designated]?.a, 'member');
  const running = pool.getState().currentJobs;
  assert.equal(running.length, 2);
  assert.equal(new Set(running.map((j) => j.account)).size, 2, 'one slot per account: two accounts, one job each');
  assert.deepEqual(running.map((j) => j.attemptId).sort(), [ordinaryAttempt.attempt_id, designatedAttempt.attempt_id].sort());

  // More work of both kinds arrives while the device is full, then only the incumbent is isolated.
  const ordinaryLater = await f.publish({ designated: false, text: 'ordinary two' });
  const designatedLater = await f.publish({ designated: true, text: 'designated two' });
  incumbentDown = true;

  // The designated job finishes at the member store while the incumbent is dark.
  const designatedSandbox = [...sbx.live.values()].find((s) => s.handle.job_id.includes(designated.slice(7, 23)));
  const ordinarySandbox = [...sbx.live.values()].find((s) => s.handle.job_id.includes(ordinary.slice(7, 23)));
  assert.ok(designatedSandbox && ordinarySandbox, 'each job has its own sandbox');
  designatedSandbox.run.resolve();
  await until(() => sbx.runs.length === 3, 'the freed slot takes designated work while the incumbent is down');
  assert.equal((await f.member.owner.getJob(designated)).state, 'result-accepted', 'the designated result landed at the member store');
  const laterAttempt = (await f.member.owner.getJob(designatedLater)).current_attempt;
  assert.ok(laterAttempt, 'the later designated job was discovered and claimed at the member store');
  assert.equal(ordinarySandbox.run !== null && !sbx.gone.has(ordinarySandbox.handle.sandbox_id), true, 'the ordinary attempt keeps running');
  assert.equal((await f.member.owner.getJob(ordinaryLater)).attempts_started, 0, 'the retained ordinary debt is not moved to the member store');
  assert.deepEqual(claims(f.member.requests), [designated, designatedLater], 'the member store only ever saw designated claims');
  assert.equal(sbx.runs.length, 3, 'three distinct jobs, three executions: nothing ran twice');
  assert.equal(pool.getState().currentJobs.length, 2, 'the shared slot budget still holds two attempts');

  // Stop is scoped to the exact attempt: stopping the designated attempt leaves the ordinary one running.
  pool.pause();
  await pool.stopCurrentJob(laterAttempt.attempt_id);
  await until(() => pool.getState().currentJobs.length === 1, 'only the designated attempt stops');
  assert.equal(pool.getState().currentJobs[0].attemptId, ordinaryAttempt.attempt_id);
  assert.ok(touching(f.member.requests, ordinary).every((r) => r.url.includes('/jobs/' + ordinary.slice(7) + '/') && !r.url.endsWith('/claim')),
    'the member store never claimed the ordinary job');

  // The incumbent returns; the retained ordinary attempt stops at the incumbent and nowhere else.
  incumbentDown = false;
  await pool.stopCurrentJob(ordinaryAttempt.attempt_id);
  await until(() => pool.getState().currentJobs.length === 0, 'the ordinary attempt stops');
  const after = storage.peek();
  assert.equal(after.pending, null);
  assert.equal(Object.values(after.accounts).reduce((sum, a) => sum + a.jobs, 0), after.jobs, 'one counter totals both authorities');
  assert.equal(sbx.runs.length, 3);
  assert.deepEqual(claims(f.realRequests).filter((d) => d !== ordinary && d !== ordinaryLater), [], 'the incumbent only ever saw ordinary claims');
  assert.equal((await f.owner.getJob(designated)).attempts_started, 0);
  assert.equal((await f.owner.getJob(designatedLater)).attempts_started, 0);
});
