import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {ACCOUNT, WEEK, NOW, ordinaryInput, request} from './helpers/pace50-fixtures.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {deferred, lenderFixture, until} from './helpers/v1-lender-fixture.mjs';

function adapterRig(t, overrides = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'launch-composition-'));
  const file = join(directory, 'lending-pace50-state.json');
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  const oracle = {authorizations: 0, dispatches: 0, arms: 0, disposed: 0};
  const effects = {
    arm_cessation_deadline: async () => {oracle.arms++; return () => {oracle.disposed++;};},
    launch_chunk: async () => {
      const [row] = disk().attempts;
      assert.equal(row.id, 'attempt-1');
      assert.ok(row.resources.every(r => r.held_micro > 0));
      oracle.authorizations++;
    },
    open_short_window: async () => {}, cancel_pending_attempt: async () => {},
    request_cessation: async () => {}, request_fresh_complete_reconciliation: async () => {},
    ...overrides.effects,
  };
  const open = (extra = {}) => createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK,
    now: () => NOW, buildInput: () => ordinaryInput({now: NOW}), effects, ...extra});
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return {open, disk, oracle, effects};
}

for (const cut of ['fsync', 'directory']) test(`PersistHold: ${cut} fault never authorizes and recovery never launches`, async t => {
  const r = adapterRig(t);
  let fail = false;
  const io = cut === 'fsync' ? {fsyncSync(fd) {if (fail) throw new Error('injected'); fs.fsyncSync(fd);}} :
    {fsyncDirectory(dir) {if (fail) throw new Error('injected'); const fd = fs.openSync(dir, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}};
  const a = r.open({io});
  fail = true;
  await assert.rejects(a.admit({expectedRevision: 0, request: request()}), {code: 'pace50_persist_failed'});
  assert.deepEqual([r.oracle.authorizations, r.oracle.dispatches], [0, 0]);
  await assert.rejects(a.transition({type: 'pause', event_id: 'poison', at: NOW}, {expectedRevision: 0}), {code: 'pace50_store_poisoned'});
  await a.close();
  const b = r.open();
  try {
    assert.equal(b.state().revision, cut === 'fsync' ? 0 : 1);
    await b.recover();
    assert.deepEqual([r.oracle.authorizations, r.oracle.dispatches], [0, 0]);
    if (cut === 'directory') assert.ok(b.state().attempts[0].resources.every(r => r.held_micro > 0));
  } finally {await b.close();}
});

for (const cut of ['arm', 'authorization']) test(`close at ${cut}: late callback and queued writer cannot mutate successor`, async t => {
  const entered = deferred(), release = deferred();
  const r = adapterRig(t);
  if (cut === 'arm') r.effects.arm_cessation_deadline = async () => {
    entered.resolve(); await release.promise; return () => {r.oracle.disposed++;};
  };
  else r.effects.launch_chunk = async () => {r.oracle.authorizations++; entered.resolve(); await release.promise;};
  const a = r.open();
  const admission = a.admit({expectedRevision: 0, request: request()});
  await entered.promise;
  assert.equal(r.disk().revision, 1);
  assert.ok(r.disk().attempts[0].resources.every(r => r.held_micro > 0));
  const queued = a.transition({type: 'pause', event_id: 'queued', at: NOW}, {expectedRevision: 1});
  const rejected = assert.rejects(queued, {code: 'pace50_closed'});
  await a.close({drainMs: 1});
  const b = r.open();
  try {
    const before = r.disk();
    release.resolve();
    await admission; await rejected;
    assert.deepEqual(r.disk(), before, 'old writer changed no successor state');
    await b.recover();
    assert.equal(r.oracle.authorizations, cut === 'arm' ? 0 : 1, 'recovery never replays launch_chunk');
    assert.equal(r.oracle.dispatches, 0, 'registry authorization is not a backend dispatch');
    if (cut === 'arm') assert.ok(r.oracle.disposed >= 1, 'late arm disposed');
  } finally {release.resolve(); await b.close();}
});

const settings = () => ({intent: 'on', limits: {lendingPolicy: normalizeLendingPolicy({providerConsent: {codex: true}})}});
function runtimeFor(f) {
  return createLendingRuntime({directory: join(f.root, 'pace50'), settings, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: ACCOUNT, account_week_id: WEEK, source: createSyntheticPace50Source({start: f.clock.now()})}});
}
function launch(f) {
  const abort = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, onEvent: e => f.events.push(e)});
  const done = lender.start(abort.signal).catch(e => {if (!abort.signal.aborted) throw e;});
  f.stop = async () => {abort.abort(); await done;};
}

test('PersistPending, Dispatch, PersistStartObservation and AckGate are distinct real lender boundaries', {timeout: 90000}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: {model: 'gpt-6-sol'}});
  f.policy.userActive = async () => false;
  const runtime = runtimeFor(f); f.policy.lendingRuntime = runtime;
  const originalSave = f.policy.storage.set;
  const cuts = ['pending', 'requested', 'observation'].map(name => ({name, entered: deferred(), release: deferred(), hit: false}));
  let dispatches = 0, executing = 0;
  f.policy.storage.set = async value => {
    await originalSave(value);
    const cut = cuts.find(c => !c.hit && (c.name === 'pending' ? value.pending && !value.pending.executionStartRequested :
      c.name === 'requested' ? value.pending?.executionStartRequested : value.observationPending?.length));
    if (cut) {cut.hit = true; cut.entered.resolve(); await cut.release.promise;}
  };
  const start = f.backend.start.bind(f.backend);
  f.backend.start = async (handle, options = {}) => start(handle, {...options,
    onLaunchDurable: options.onLaunchDurable ? async (...args) => {dispatches++; await options.onLaunchDurable(...args);} : undefined,
    onExecutionStarted: () => {executing++; options.onExecutionStarted?.();}});
  t.after(() => {for (const c of cuts) c.release.resolve();});
  launch(f);
  for (const cut of cuts) {
    await cut.entered.promise;
    const [row] = runtime.pace50.state().attempts;
    assert.ok(row.resources.every(r => r.held_micro > 0), cut.name + ': durable nonzero reservation');
    assert.ok(f.saved().pending, cut.name + ': durable recovery journal');
    assert.equal(dispatches, cut.name === 'observation' ? 1 : 0, cut.name);
    assert.equal(executing, 0, 'guest cannot execute before durable observation ACK');
    cut.release.resolve();
  }
  await until(() => f.count('/complete') === 1, 'completion');
  await f.stop();
  assert.equal(dispatches, 1); assert.equal(executing, 1);
  await runtime.close();
  const reopened = runtimeFor(f); f.policy.lendingRuntime = reopened;
  assert.equal(reopened.pace50.state().attempts[0].cleanup_proven, true);
  await reopened.close();
});

for (const cut of ['pending', 'requested', 'observed']) test(`Crash/RecoverRemove at ${cut}: unknown removal and failed candidate write retain journal`, {timeout: 90000}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: {model: 'gpt-6-sol'}});
  f.override = async record => {
    if (record.route !== '/jobs/claim-next') return false;
    record.res.writeHead(200, {'content-type': 'application/json'}); record.res.end('null'); return true;
  };
  let runtime = runtimeFor(f); f.policy.lendingRuntime = runtime;
  const attempt = f.attempt(), id = attempt.attempt_id;
  const grant = await runtime.candidate.reserve({attemptId: id, jobId: f.jobDigest, provider: 'codex', model: 'gpt-6-sol',
    job: {requirements: {limits: {wall_seconds: 120}}, expires_at: new Date(f.clock.now() + 3600000).toISOString()}, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true);
  if (cut !== 'pending') await f.client.startAttempt(attempt, {idempotencyKey: 'saved-start'});
  if (cut === 'observed') await runtime.candidate.started(id, {ok: true});
  await f.policy.storage.set({day: new Date(f.clock.now()).toISOString().slice(0, 10), jobs: 1, milliseconds: 120000,
    ...(cut === 'observed' ? {observationPending: [{attempt, observedAt: new Date(f.clock.now()).toISOString(), idempotencyKey: 'saved-observation'}]} : {}),
    pending: {attemptId: id, attempt, jobId: f.jobDigest, prepare_contract:'create-only',
    reservedMs: 120000, ...(cut !== 'pending' ? {sandboxId: 'synthetic-only', scratchDir: f.root} : {}), executionStartRequested: cut !== 'pending', startIdempotencyKey: 'saved-start',
    candidateSettlement: {provider: 'codex', model: 'gpt-6-sol', execution: null, prepared: true, reason: 'restart_interrupted'}, resources: {cpu: 1, memoryBytes: 1}}});
  await runtime.close(); runtime = runtimeFor(f); f.policy.lendingRuntime = runtime;
  let removed = false, failSave = true, failSettlement = true, queried = 0, writeAttempts = 0, settlementAttempts = 0;
  const survivors = new Set(cut === 'pending' ? [] : ['synthetic-only']);
  f.backend.reconcilePending = async row => {
    queried++;
    assert.equal(row.attemptId, id);
    if (removed) survivors.delete(row.sandboxId);
    return {attemptId: row.attemptId, removed};
  };
  const cleanup = runtime.candidate.recordCleanup.bind(runtime.candidate);
  runtime.candidate.recordCleanup = async (...args) => {writeAttempts++; if (failSave) throw new Error('injected candidate IO failure'); return cleanup(...args);};
  const method = cut === 'pending' ? 'release' : 'finish';
  const settle = runtime.candidate[method].bind(runtime.candidate);
  runtime.candidate[method] = async (...args) => {
    settlementAttempts++;
    if (failSettlement) throw new Error('injected settlement handoff failure');
    return settle(...args);
  };
  const row = () => runtime.pace50.state().attempts[0];
  launch(f);
  await until(() => queried > 0, 'unknown dispatch reconciliation');
  assert.ok(f.saved().pending); assert.equal(row().cleanup_proven, false);
  assert.equal(survivors.size, cut === 'pending' ? 0 : 1);
  assert.ok(row().resources.every(r => r.held_micro > 0));
  removed = true; f.clock.advance(1000);
  await until(() => writeAttempts > 0, 'candidate write fault');
  assert.ok(f.saved().pending, 'only recovery journal survives candidate save failure');
  assert.equal(row().cleanup_proven, false);
  failSave = false; f.clock.advance(1000);
  await until(() => settlementAttempts > 0, 'settlement handoff fault');
  assert.equal(row().cleanup_proven, true);
  assert.equal(survivors.size, 0);
  assert.ok(f.saved().pending?.candidateSettlement, 'removal alone cannot discard settlement inputs');
  failSettlement = false; f.clock.advance(1000);
  await until(() => f.saved().pending === null, 'candidate durably owns removal');
  assert.equal(row().cleanup_proven, true);
  assert.equal(f.calls.filter(([kind]) => kind === 'run').length, 0, 'restart never dispatches');
  await f.stop(); await runtime.close();
  const reopened = runtimeFor(f); f.policy.lendingRuntime = reopened;
  assert.equal(reopened.pace50.state().attempts[0].cleanup_proven, true);
  await reopened.close();
});

for (const cut of ['pending', 'requested', 'observation']) test(`lender storage fault at ${cut}: no guest execution crosses a failed durable boundary`, {timeout: 90000}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: {model: 'gpt-6-sol'}});
  f.policy.userActive = async () => false;
  const runtime = runtimeFor(f); f.policy.lendingRuntime = runtime;
  const entered = deferred(), release = deferred();
  const originalSave = f.policy.storage.set;
  let injected = false, dispatches = 0, executions = 0;
  f.policy.storage.set = async value => {
    const matches = cut === 'pending' ? value.pending && !value.pending.executionStartRequested :
      cut === 'requested' ? value.pending?.executionStartRequested : value.observationPending?.length;
    if (!injected && matches) {
      injected = true; entered.resolve(); await release.promise;
      throw new Error('injected lender storage fault');
    }
    await originalSave(value);
  };
  const start = f.backend.start.bind(f.backend);
  f.backend.start = async (handle, options = {}) => start(handle, {...options,
    onLaunchDurable: options.onLaunchDurable ? async (...args) => {dispatches++; await options.onLaunchDurable(...args);} : undefined,
    onExecutionStarted: () => {executions++; options.onExecutionStarted?.();}});
  t.after(() => release.resolve());
  launch(f);
  await entered.promise;
  assert.equal(dispatches, cut === 'observation' ? 1 : 0);
  assert.equal(executions, 0);
  const before = f.saved();
  if (cut === 'pending') assert.ok(!before.pending);
  else {
    assert.ok(before.pending, 'earlier durable journal survives the failed next write');
    assert.equal(before.pending.executionStartRequested, cut === 'observation');
    assert.ok(runtime.pace50.state().attempts[0].resources.every(r => r.held_micro > 0));
  }
  release.resolve();
  await until(() => f.count('/release') + f.count('/fail') > 0, 'failed launch reported');
  await f.stop();
  assert.equal(executions, 0, 'failed save cannot open the guest ACK gate');
  assert.equal(dispatches, cut === 'observation' ? 1 : 0);
  await runtime.close();
  const reopened = runtimeFor(f); f.policy.lendingRuntime = reopened;
  await reopened.pace50.recover();
  assert.equal(dispatches, cut === 'observation' ? 1 : 0, 'adapter reopen cannot replay dispatch');
  await reopened.close();
});

test('no provider session or agent entrypoint exists before the durable lender dispatch guard', {timeout:30000}, async t => {
  const {DockerSbxBackend} = await import('../lib/docker-backend.mjs');
  const {createSbxPolicy, sbxRunner} = await import('./helpers/sbx-policy-model.mjs');
  const f = await lenderFixture(t, {policy:{mode:'auto'}, run:{model:'gpt-6-sol'},
    mutateJob:job => { job.requirements.limit_modes = {disk_bytes:'preferred'}; }});
  const previous = process.env.FARAVAN_SBX_HOME;
  process.env.FARAVAN_SBX_HOME = join(f.root, 'isolated-sbx');
  t.after(() => { if (previous === undefined) delete process.env.FARAVAN_SBX_HOME; else process.env.FARAVAN_SBX_HOME = previous; });
  const runner = sbxRunner(createSbxPolicy(), args => ({code:0,stdout:args[0] === 'ls' ? '[]' : '',stderr:''}));
  const backend = new DockerSbxBackend({runCommand:runner.run, home:process.env.FARAVAN_SBX_HOME,
    hostDisk:{free:async()=>({free:2**40})}});
  // Guest process supervision is simulated; prepare and entrypoint exec use the real backend.
  backend._installGuard = async () => null;
  const command = backend._runJobCommand.bind(backend);
  backend._runJobCommand = (handle, args, onLog, options = {}) => {
    if (onLog || options.onExecutionStarted) {
      const disk = JSON.parse(fs.readFileSync(join(f.root,'pace50','lending-pace50-state.json'),'utf8'));
      assert.equal(disk.attempts[0].launch_state,'started','entrypoint exec follows the durable launch write');
      return runner.run(args);
    }
    return command(handle, args, onLog, options);
  };
  const fakeStart = f.backend.start.bind(f.backend);
  f.backend.prepare = spec => backend.prepare({...spec,auth_strategy:'docker-native-oauth'});
  f.backend.start = (handle, options) => handle._bookkeeping ? fakeStart(handle, options) : backend.start(handle, options);
  f.backend.destroy = handle => backend.destroy(handle);
  f.policy.userActive = async () => false;
  const runtime = runtimeFor(f); f.policy.lendingRuntime = runtime;
  const release = deferred();
  const started = runtime.candidate.started.bind(runtime.candidate);
  let atGuard = false;
  runtime.candidate.started = async (...args) => { atGuard = true; await release.promise; return started(...args); };
  t.after(() => release.resolve());
  launch(f);
  await until(() => atGuard || f.events.some(e => ['failed','declined'].includes(e.status)), 'prepare reaches launch guard');
  assert.ok(atGuard, JSON.stringify(f.events.map(({status,reason}) => ({status,reason}))));
  const isAgent = args => args[0] === 'exec' && args.some(arg => /codex.*exec/.test(arg));
  const before = runner.calls.slice();
  release.resolve();
  await until(() => runner.calls.some(isAgent), 'entrypoint after durable launch');
  await f.stop();
  assert.equal(before.some(args => args[0] === 'run' && args.includes('-d')), false, 'no default provider agent before guard');
  assert.equal(before.some(isAgent), false, 'no explicit agent before guard');
  assert.equal(runtime.pace50.state().attempts[0].launch_state, 'started');
});
