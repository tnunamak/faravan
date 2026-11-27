import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import { createLender, lenderDayKey } from '../lib/v1/lender.mjs';
import { createLendingPool } from '../lib/v1/lending-pool.mjs';
import { createAccountRegistry } from '../lib/v1/lending-accounts.mjs';
import { proveDurableCessation } from '../lib/v1/durable-cessation.mjs';
import { realLenderFixture } from './helpers/v1-real-lender-fixture.mjs';
import { BOTH, sandboxes, adapters, memory } from './helpers/v1-pool-fakes.mjs';
import { deferred, until } from './helpers/v1-lender-fixture.mjs';

// Real lenders (createLender) under the real pool, against the real v1 coordinator (store + HTTP handler).
// The backend is fake, but keeps one sandbox per job so two agents can run at once.
for (const accept of [true, false]) test('one owner approval for the same signed offer: ' + (accept ? 'Accept' : 'Skip'), async t => {
  const f = await realLenderFixture(t, {offers:true,mutateJob: job => {job.requirements.harness = BOTH;}});
  const sbx = sandboxes(t), storage = memory(), decision = deferred();
  const {storage: _unused, ...policy} = f.policy;
  policy.mode = 'ask';
  policy.lendingPolicy = {accountSlots: 1, machineSlots: 2};
  const registry = [
    {provider:'claude', id:'11111111-1111-4111-8111-111111111111', enabled:true},
    {provider:'codex', id:'22222222-2222-4222-8222-222222222222', enabled:true},
  ];
  const arrivals = [], prompts = [], claims = [];
  const client = new Proxy(f.client, {get(target, key) {
    const fn = Reflect.get(target, key, target);
    if (key === 'claimJob' || key === 'claimNext') return (...args) => {
      claims.push({key, digest: args[0]});
      return fn.apply(target, args);
    };
    return typeof fn === 'function' ? fn.bind(target) : fn;
  }});
  const pool = createLendingPool({
    createLender: options => createLender({...options, approve: details => {
      arrivals.push({account: options.accountKey, details});
      return options.approve(details);
    }}),
    client, storage, policy, accounts: () => registry, adapters: adapters(), capacity: 2, backend: sbx.backend,
    clock: {now: f.clock.now, monotonic: () => performance.now()},
    approve: details => {prompts.push(details); return decision.promise;},
  });
  const controller = new AbortController(), loop = pool.start(controller.signal);
  f.stop = async () => {
    decision.resolve(false); controller.abort();
    for (const entry of sbx.live.values()) entry.run?.resolve();
    await loop.catch(() => {});
  };
  await until(() => arrivals.length === 2 && prompts.length > 0, 'both actual workers present the queued offer');
  assert.equal(new Set(arrivals.map(entry => entry.account)).size, 2);
  assert.deepEqual(arrivals.map(entry => entry.details.jobDigest), [f.jobDigest, f.jobDigest]);
  assert.deepEqual(arrivals[0].details.job, arrivals[1].details.job, 'both consumed the same signed job');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].jobDigest, f.jobDigest);
  assert.deepEqual(claims, []);
  assert.equal(sbx.runs.length, 0);
  assert.equal((await f.owner.getJob(f.jobDigest)).state, 'queued');
  decision.resolve(accept);
  if (accept) {
    await until(() => sbx.runs.length === 1, 'one accepted offer executes');
    assert.deepEqual(claims, [{key:'claimJob', digest:f.jobDigest}]);
    assert.equal(pool.getState().currentJobs.length, 1);
  } else {
    await until(() => storage.peek()?.hiddenOffers?.some(row => row.jobDigest === f.jobDigest), 'Skip is persisted by the worker');
    assert.deepEqual(claims, []);
    assert.equal(sbx.runs.length, 0);
    assert.equal((await f.owner.getJob(f.jobDigest)).state, 'queued');
  }
  assert.equal(prompts.length, 1);
});

async function twoRunning(t) {
  const f = await realLenderFixture(t, { mutateJob: (job) => { job.requirements.harness = BOTH; } });
  const digests = [f.jobDigest, await f.submit(), await f.submit()];
  const sbx = sandboxes(t), storage = memory(), events = [];
  const { storage: _unused, ...policy } = f.policy;
  policy.lendingPolicy = { accountSlots: 1, machineSlots: 2 };
  const pool = createLendingPool({ createLender, storage, policy, adapters: adapters(), capacity: 2, client: f.client, backend: sbx.backend,
    clock: { now: f.clock.now, monotonic: () => performance.now() }, approve: async () => true, onEvent: (e) => events.push(e) });
  const controller = new AbortController();
  const loop = pool.start(controller.signal);
  f.stop = async () => { controller.abort(); for (const s of sbx.live.values()) s.run?.resolve(); await loop.catch(() => {}); };
  await until(() => sbx.runs.length === 2, 'two agents running at once');
  return { f, digests, sbx, storage, events, pool, controller, loop };
}

for (const explicit of [true,false]) {
  test('last removed lending account drains its own work without becoming legacy: '+(explicit?'explicit':'legacy control'), async t=>{
    const f=await realLenderFixture(t,{mutateJob:job=>{job.requirements.harness=['codex'];}});
    const dir=await mkdtemp(join(tmpdir(),'pool-registry-'));
    t.after(()=>rm(dir,{recursive:true,force:true}));
    const registry=createAccountRegistry({file:join(dir,'accounts.json'),now:f.clock.now});
    const account=explicit?registry.setEnabled(registry.add({provider:'codex',label:'Synthetic Codex'}).id,true):null;
    const sbx=sandboxes(t),storage=memory(),{storage:_unused,...policy}=f.policy;
    await storage.set({day:lenderDayKey(f.clock.now(),policy.timeZone),jobs:0,milliseconds:0,pending:null});
    policy.lendingPolicy={accountSlots:1,machineSlots:2};
    const pool=createLendingPool({createLender,storage,policy,adapters:adapters().filter(a=>a.spec.harness_id==='codex'),
      accounts:()=>registry.listForPool(),capacity:2,client:f.client,backend:sbx.backend,
      clock:{now:f.clock.now,monotonic:()=>performance.now()},approve:async()=>true});
    const controller=new AbortController(),loop=pool.start(controller.signal);
    try {
      await until(()=>sbx.runs.length===1,'first synthetic job admitted');
      const first=pool.getState().currentJobs[0];
      const running=sbx.runs[0];
      assert.ok(first?.attemptId);
      assert.equal(first.account==='codex:0',!explicit);
      assert.equal(storage.peek().accounts[first.account].pending?.attemptId,first.attemptId);
      if (explicit) {
        const removed=registry.markRemoved(account.id);
        assert.equal(removed.enabled,false);
        assert.equal(registry.get(account.id).removed,true);
        assert.deepEqual(registry.list(),[]);
        pool.reconfigure();
        assert.equal(storage.peek().accounts[first.account].pending?.attemptId,first.attemptId);
      }
      await pool.stopCurrentJob(first.attemptId);
      await until(()=>sbx.gone.has(running.sandbox)&&!storage.peek().accounts[first.account].pending,'exact owned operation drains');
      const next=await f.submit();
      const probe={author:'synthetic-borrower',circle:f.job.payload.circle,
        requirements:structuredClone(f.job.payload.requirements),expires_at:new Date(f.clock.now()+86400000).toISOString()};
      await pool.refreshAdmission();
      if (explicit) {
        // Let an incorrectly spawned replacement make its normal polling turn.
        await new Promise(resolve=>setTimeout(resolve,200));
        const view=await f.owner.getJob(next);
        assert.equal(view.state,'queued','removed explicit account must not claim fresh work');
        assert.equal(sbx.runs.length,1);
        assert.notEqual(pool.admits(probe),null,'a removed row is not a truly legacy profile');
      } else {
        await until(()=>sbx.runs.length===2,'a truly legacy profile still starts a fresh job');
        assert.equal(pool.getState().currentJobs[0]?.account,'codex:0');
      }
    } finally {
      controller.abort();
      for(const sandbox of sbx.live.values())sandbox.run?.resolve();
      await loop;
    }
  });
}

test('two lent accounts run real lender jobs side by side; a third job waits; each stop leaves the other account intact', async (t) => {
  const { f, digests, sbx, storage, pool } = await twoRunning(t);
  assert.deepEqual(sbx.runs.map((r) => r.agent).sort(), ['claude', 'codex'], 'one job per lent account');
  const state = pool.getState();
  assert.deepEqual(state.currentJobs.map((j) => j.account).sort(), ['claude:0', 'codex:0']);
  const accounts = storage.peek().accounts;
  assert.ok(accounts['claude:0'].pending && accounts['codex:0'].pending, 'both accounts journal their own running attempt');
  // The third job is held: both account slots are busy, so nobody claimed it.
  await new Promise((r) => setTimeout(r, 200));
  const states = await Promise.all(digests.map(async (d) => (await f.owner.getJob(d)).state));
  assert.equal(states.filter((s) => s === 'queued').length, 1, 'exactly one job still waits: ' + states.join(','));
  assert.equal(sbx.runs.length, 2);

  pool.pause();
  const [first, second] = state.currentJobs;
  await pool.stopCurrentJob(first.attemptId);
  await until(() => !storage.peek().accounts[first.account].pending, 'first account settles its stop');
  const other = storage.peek().accounts[second.account];
  assert.equal(other.pending?.attemptId, second.attemptId, 'the other account\'s journal is untouched');
  assert.equal(pool.getState().currentJobs.length, 1);
  assert.equal(sbx.runs.length, 2, 'pause holds: the freed account does not take the waiting job');

  await pool.stopCurrentJob(second.attemptId);
  await until(() => !storage.peek().accounts[second.account].pending, 'second account settles its stop');
  const after = storage.peek();
  assert.equal(after.pending, null);
  assert.equal(after.accounts[first.account].jobs, 1);
  assert.equal(after.accounts[second.account].jobs, 1);
  assert.equal(after.jobs, 2, 'the pool totals both accounts');
  assert.equal(sbx.gone.size, 2, 'both sandboxes removed');
  const final = await Promise.all(digests.map(async (d) => (await f.owner.getJob(d)).state));
  assert.equal(final.filter((s) => s === 'queued').length >= 1, true, 'the held job was never taken: ' + final.join(','));
  assert.ok((await proveDurableCessation({ store: storage, backend: sbx.backend })).proven);
});

test('a crash with two accounts running leaves both journals; a restarted app must prove both sandboxes gone', async (t) => {
  const { sbx, storage, controller, loop, pool } = await twoRunning(t);
  const running = pool.getState().currentJobs.map((j) => j.attemptId).sort();
  // Simulate the process dying: persist what is on disk now, then let the loop unwind.
  const snapshot = structuredClone(storage.peek());
  assert.deepEqual(Object.values(snapshot.accounts).map((a) => a.pending?.attemptId).filter(Boolean).sort(), running);
  assert.ok(snapshot.pending, 'root mirrors only one of them');
  const asked = [];
  const inventory = (present) => ({ reconcilePending: async (p) => { asked.push(p.attemptId); return { removed: p.attemptId !== present, attemptId: p.attemptId }; } });
  const disk = { get: async () => structuredClone(snapshot) };
  assert.equal((await proveDurableCessation({ store: disk, backend: inventory(null) })).proven, true);
  assert.deepEqual(asked.sort(), running, 'all gone is proven only after every recorded attempt was checked');
  for (const present of running) {
    const proof = await proveDurableCessation({ store: disk, backend: inventory(present) });
    assert.deepEqual({ proven: proof.proven, attemptId: proof.attemptId }, { proven: false, attemptId: present }, 'either account\'s leftover sandbox blocks the proof');
  }
  controller.abort(); for (const s of sbx.live.values()) s.run?.resolve(); await loop.catch(() => {});
});

// O-A (r11): an account that cannot run a job must not make the pool read as ready while another account runs.
// Real lenders under the real pool. The adapter source is async and read on every check, as the app's is.
function identity({ codexSignedIn = true, claudeSignedIn = true, codexLent = true, claudeLent = true } = {}) {
  return BOTH.map((id) => ({ spec:legacyProxyHarness(id), installed: true, signedIn: id === 'codex' ? codexSignedIn : claudeSignedIn,
    enabled: id === 'codex' ? codexLent : claudeLent, harnessVersion: 'test-only', models: ['example-model'], capabilities: [] }));
}
async function accounts(t, { busy = false, busyOn = 'claude', sandboxDown = false, maxResources, ...signin } = {}) {
  // A busy job only the busy account can take; otherwise a job no account can take, so nothing is claimed.
  const busyHarness = busyOn === 'codex' ? 'codex' : 'claude-code-subscription';
  const f = await realLenderFixture(t, { mutateJob: (job) => { job.requirements.harness = busy ? [busyHarness] : ['opencode']; } });
  const sbx = sandboxes(t), storage = memory();
  if (sandboxDown) {
    const up = sbx.backend.lenderCapabilities;
    sbx.backend.lenderCapabilities = () => ({ ...up(), available: false });
  }
  let current = identity(signin);
  const { storage: _unused, ...policy } = f.policy;
  policy.lendingPolicy = { accountSlots: 1, machineSlots: 2 };
  const pool = createLendingPool({ createLender, storage, policy, adapters: async () => current, capacity: 2, maxResources,
    client: f.client, backend: sbx.backend, clock: { now: f.clock.now, monotonic: () => performance.now() }, approve: async () => true });
  const controller = new AbortController(), loop = pool.start(controller.signal);
  t.after(async () => { controller.abort(); for (const s of sbx.live.values()) s.run?.resolve(); await loop.catch(() => {}); });
  if (busy) await until(() => sbx.runs.length === 1, 'the job runs');
  // The same shape of probe the app's readiness reads (a standard job from someone else).
  const probe = { author: 'faravan-readiness-probe', circle: f.job.payload.circle, requirements: structuredClone(f.job.payload.requirements),
    expires_at: new Date(f.clock.now() + 86400000).toISOString() };
  return { f, pool, sbx, storage, probe, setIdentity: (next) => { current = identity(next); } };
}

test('O-A: one account busy and the other signed out: the pool does not say a new job can start', async (t) => {
  const { pool, probe } = await accounts(t, { busy: true, codexSignedIn: false });
  assert.equal(pool.admits(probe), 'busy', 'the only usable account is running; Codex cannot take a job');
});

test('O-A: one account busy and a usable spare account with room still admits the next job', async (t) => {
  const { pool, probe } = await accounts(t, { busy: true, codexSignedIn: true });
  assert.equal(pool.admits(probe), null, 'Codex is signed in, lent and idle: a second job can start');
});

test('O-A: when no account can run a job, the pool names the sign-in; a signed-out account is not the workspace', async (t) => {
  const { pool, probe } = await accounts(t, { codexSignedIn: false, claudeSignedIn: false });
  await until(() => pool.admits(probe) !== 'lender_starting', 'both accounts have been checked');
  assert.equal(pool.admits(probe), 'agent_signed_out');
});

test('O-A: the busy account outranks a spare that is not lent, whichever is listed first', async (t) => {
  const { pool, probe } = await accounts(t, { busy: true, busyOn: 'codex', claudeLent: false });
  assert.equal(pool.admits(probe), 'busy', 'Claude is listed first but is not lent: the next job waits for the running one');
});

test('O-A: when no account is lent, the reason is that none is chosen', async (t) => {
  const { pool, probe } = await accounts(t, { claudeLent: false, codexLent: false });
  await until(() => pool.admits(probe) !== 'lender_starting', 'both accounts have been checked');
  assert.equal(pool.admits(probe), 'agent_not_chosen');
});

test('O-A: a sandbox that is genuinely down is still reported as the workspace, with signed-in accounts', async (t) => {
  const { pool, probe } = await accounts(t, { sandboxDown: true });
  await until(() => pool.admits(probe) !== 'lender_starting', 'both accounts have been checked');
  assert.equal(pool.admits(probe), 'sandbox_not_ready');
});

test('O-A: the machine room still refuses a second job while the first holds the CPUs', async (t) => {
  const { pool, probe } = await accounts(t, { busy: true, codexSignedIn: true, maxResources: { cpu: 2, memoryBytes: Infinity } });
  assert.equal(pool.admits(probe), 'machine_capacity');
});

test('O-A: a sign-in change is proven by an explicit refresh before the next readiness read', async (t) => {
  const { pool, probe, setIdentity } = await accounts(t, { busy: true, codexSignedIn: false });
  assert.equal(pool.admits(probe), 'busy');
  setIdentity({ codexSignedIn: true });
  await pool.refreshAdmission();
  assert.equal(pool.admits(probe), null, 'Codex is signed in: the second job can start');
  setIdentity({ codexSignedIn: false });
  await pool.refreshAdmission();
  assert.equal(pool.admits(probe), 'busy', 'a sign-out is seen before the next read');
});

test('O-A: when the busy account finishes it is checked again and the pool is ready for the next job', async (t) => {
  const { pool, probe, sbx } = await accounts(t, { busy: true, codexSignedIn: false });
  assert.equal(pool.admits(probe), 'busy');
  for (const s of sbx.live.values()) s.run.resolve();
  await until(() => pool.getState().currentJobs.length === 0, 'the job finishes');
  await until(() => pool.admits(probe) !== 'busy' && pool.admits(probe) !== 'lender_starting', 'Claude is checked again');
  assert.equal(pool.admits(probe), null, 'Claude is idle and usable');
});
