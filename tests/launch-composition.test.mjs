import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {join} from 'node:path';

import {createLender} from '../lib/v1/lender.mjs';
import {deferred, lenderFixture, until} from './helpers/v1-lender-fixture.mjs';

function launch(f) {
  const abort = new AbortController();
  const lender = createLender({...f.runOptions,client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, onEvent: e => f.events.push(e)});
  const done = lender.start(abort.signal).catch(e => {if (!abort.signal.aborted) throw e;});
  f.stop = async () => {abort.abort(); await done;};
}

test('PersistPending, Dispatch, PersistStartObservation and AckGate are distinct real lender boundaries', {timeout: 90000}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: {model: 'gpt-6-sol'}});
  f.policy.userActive = async () => false;
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
    assert.ok(f.saved().pending, cut.name + ': durable recovery journal');
    assert.equal(dispatches, cut.name === 'observation' ? 1 : 0, cut.name);
    assert.equal(executing, 0, 'guest cannot execute before durable observation ACK');
    cut.release.resolve();
  }
  await until(() => f.count('/complete') === 1, 'completion');
  await f.stop();
  assert.equal(dispatches, 1); assert.equal(executing, 1);

});

for (const cut of ['pending', 'requested', 'observation']) test(`lender storage fault at ${cut}: no guest execution crosses a failed durable boundary`, {timeout: 90000}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: {model: 'gpt-6-sol'}});
  f.policy.userActive = async () => false;
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
  }
  release.resolve();
  await until(() => f.count('/release') + f.count('/fail') > 0, 'failed launch reported');
  await f.stop();
  assert.equal(executions, 0, 'failed save cannot open the guest ACK gate');
  assert.equal(dispatches, cut === 'observation' ? 1 : 0);
  assert.equal(dispatches, cut === 'observation' ? 1 : 0, 'a failed journal write cannot replay dispatch');
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
      assert.equal(f.saved().pending.executionStartRequested,true,'entrypoint exec follows the durable launch write');
      return runner.run(args);
    }
    return command(handle, args, onLog, options);
  };
  const fakeStart = f.backend.start.bind(f.backend);
  f.backend.prepare = spec => backend.prepare({...spec,auth_strategy:'docker-native-oauth'});
  f.backend.start = (handle, options) => handle._bookkeeping ? fakeStart(handle, options) : backend.start(handle, options);
  f.backend.destroy = handle => backend.destroy(handle);
  f.policy.userActive = async () => false;
  const release = deferred();
  const save=f.policy.storage.set;
  let atGuard=false;
  f.policy.storage.set=async value=>{await save(value);if(value.pending?.executionStartRequested&&!atGuard){atGuard=true;await release.promise;}};
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
});
