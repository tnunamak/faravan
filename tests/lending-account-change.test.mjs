import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountChangeHarness} from './helpers/account-change-harness.mjs';

for (const provider of ['claude-code-subscription','codex']) {
  const name=text=>provider+': '+text;

  test(name('new accounts are off and take no job'),async t=>{
    const h=createAccountChangeHarness(t,{provider});
    h.add('A');h.add('B');
    await h.start();t.after(()=>h.close());
    assert.deepEqual(h.activeKeys(),[]);
  });

  test(name('turning an account on admits only that account, in the owner order'),async t=>{
    const h=createAccountChangeHarness(t,{provider});
    const a=h.add('A'),b=h.add('B'),c=h.add('C');
    await h.start();t.after(()=>h.close());
    h.registry.setEnabled(c.id,true);h.registry.setEnabled(a.id,true);
    h.registry.setOrder(h.family,[c.id,a.id,b.id]);
    await h.changed();
    assert.deepEqual(h.activeKeys(),[h.keyOf(c),h.keyOf(a)]);
    assert.equal(h.holdOf(h.keyOf(c)),null);
    assert.equal(h.holdOf(h.keyOf(a)),null);
  });

  test(name('turning an account off keeps its worker and refuses its next job, not its neighbour'),async t=>{
    const h=createAccountChangeHarness(t,{provider});
    const a=h.add('A'),b=h.add('B');
    h.registry.setEnabled(a.id,true);h.registry.setEnabled(b.id,true);
    await h.start();t.after(()=>h.close());
    assert.deepEqual(h.workerKeys(),[h.keyOf(a),h.keyOf(b)]);
    h.registry.setEnabled(a.id,false);
    await h.changed();
    assert.equal(h.holdOf(h.keyOf(a)),'lending_off');
    assert.equal(h.holdOf(h.keyOf(b)),null);
    assert.deepEqual(h.workerKeys(),[h.keyOf(a),h.keyOf(b)],'no worker is replaced or re-keyed');
  });

  test(name('all accounts off is one clear wait, and turning one on resumes only that account'),async t=>{
    const h=createAccountChangeHarness(t,{provider});
    const a=h.add('A'),b=h.add('B');
    h.registry.setEnabled(a.id,true);h.registry.setEnabled(b.id,true);
    await h.start();t.after(()=>h.close());
    h.registry.setEnabled(a.id,false);h.registry.setEnabled(b.id,false);
    await h.changed();
    assert.equal(h.holdOf(h.keyOf(a)),'lending_off');
    assert.equal(h.holdOf(h.keyOf(b)),'lending_off');
    assert.equal(h.admits({author:'someone'}),'lending_off','the public wait names the off accounts');
    h.registry.setEnabled(b.id,true);
    await h.changed();
    assert.equal(h.holdOf(h.keyOf(b)),null);
    assert.equal(h.holdOf(h.keyOf(a)),'lending_off');
    assert.equal(h.admits({author:'someone'}),null);
  });

  test(name('a removed account keeps its stored rows, after a restart too, and takes no new job'),async t=>{
    const h=createAccountChangeHarness(t,{provider});
    const a=h.add('A'),b=h.add('B');
    h.registry.setEnabled(a.id,true);h.registry.setEnabled(b.id,true);
    h.keepRow(h.keyOf(a));
    await h.start();t.after(()=>h.close());
    h.registry.markRemoved(a.id);
    await h.changed();
    assert.equal(h.holdOf(h.keyOf(a)),'lending_off');
    assert.equal(h.holdOf(h.keyOf(b)),null);
    await h.restart();
    assert.ok(h.workerKeys().includes(h.keyOf(a)),'the removed account still has a worker that owns its stored row');
    assert.equal(h.holdOf(h.keyOf(a)),'lending_off');
    assert.equal(h.holdOf(h.keyOf(b)),null);
  });
}

test('Set Agents starts only Codex in an already-running all-off App pool', {timeout: 60000}, async t => {
  const {join} = await import('node:path');
  const {appFixture, api, waitFor} = await import('./helpers/v1-app-fixture.mjs');
  const {legacyProxyHarness} = await import('./helpers/legacy-proxy-harness.mjs');
  const {processLockOwners} = await import('../lib/v1/lock.mjs');
  const providers = ['codex', 'claude-code-subscription'];
  const poolStarts = [];
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({
    adapters: () => providers.map(id => {
      const spec = legacyProxyHarness(id);
      return {spec, lendingSpec: spec, installed: true, signedIn: true, proxySignedIn: true,
        harnessVersion: 'synthetic-only', models: [id === 'codex' ? 'gpt-5.4' : 'claude-haiku-5-5'], capabilities: []};
    }),
    onLendingPoolStart: options => poolStarts.push(options),
  });
  const app = lender.app, accounts = app.lendingAccounts(), registry = accounts.registry();
  const codex = registry.add({provider: 'codex', label: 'Synthetic unselected Codex'});
  const claude = registry.add({provider: 'claude', label: 'Synthetic unselected Claude'});
  const rows = () => accounts.listForPool().map(({id, provider, key, enabled, legacy_provider}) =>
    ({id, provider, key, enabled, legacyProvider: legacy_provider ?? null}));
  const choice = list => Object.fromEntries(list.filter(row => providers.includes(row.id)).map(row => [row.id, row.useForLending]));
  const state = () => api(app, '/api/lending');
  const lock = () => processLockOwners(join(lender.home, 'v1', 'app-counters.json.lock'));
  const beforeAgents = choice(await api(app, '/api/agents'));
  const beforeRegistry = rows();
  assert.deepEqual(beforeAgents, {codex: false, 'claude-code-subscription': false});
  assert.deepEqual(beforeRegistry, [
    {id: codex.id, provider: 'codex', key: 'codex:' + codex.id, enabled: false, legacyProvider: null},
    {id: claude.id, provider: 'claude', key: 'claude:' + claude.id, enabled: false, legacyProvider: null},
  ]);
  assert.deepEqual(lock(), []);
  const started = await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  assert.equal(started.enabled, true);
  assert.equal(started.circle, circle.id);
  const originalLock = await waitFor(() => lock().length === 1 && lock(), 'the existing pool owns one counter lock', 5000);
  assert.deepEqual(poolStarts, [{circle: circle.id}]);
  const diagnosticIds=['codex:'+codex.id+'#0','claude:'+claude.id+'#0'];
  assert.deepEqual((await state()).accountStates.map(s=>s.account),diagnosticIds);
  await waitFor(async()=>(await state()).reason==='no_accounts','empty-account decision');
  const beforeAdmission = app.lendingAdmission();
  assert.equal(beforeAdmission,'no_accounts','the account decision names the missing configuration');

  const selected = choice(await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}}));
  assert.deepEqual(selected, {codex: true, 'claude-code-subscription': false});
  const afterRegistry = rows();
  assert.deepEqual(afterRegistry.filter(row => !row.legacyProvider), beforeRegistry);
  assert.deepEqual(afterRegistry.filter(({enabled}) => enabled).map(({key, legacyProvider}) => ({key, legacyProvider})),
    [{key: 'codex', legacyProvider: 'codex'}], 'the supported first choice creates one eligible default row');
  const woke = await waitFor(async () => {
    const view = await state();
    return view.accountStates.some(s=>s.account==='codex:0')&&view;
  }, 'Set Agents alone starts a worker in the existing pool', 5000);
  assert.deepEqual(woke.accountStates.map(row=>row.account),[...diagnosticIds,'codex:0']);
  assert.equal(woke.enabled, true);
  assert.equal(woke.circle, circle.id);
  assert.deepEqual(choice(await api(app, '/api/agents')), selected, 'Codex remains chosen and Claude stays off');
  assert.deepEqual(rows(), afterRegistry, 'neither of the seeded rows was enabled');
  assert.deepEqual(lock(), originalLock, 'the worker was added under the original lock');
  assert.deepEqual(poolStarts, [{circle: circle.id}], 'the app did not start a second pool');
  t.diagnostic(JSON.stringify({circleId: circle.id, beforeAgents, beforeRegistry, beforeAdmission, afterAgentChoice: selected,
    afterRegistry, workersAfterChoice: woke.accountStates.map(({account, status, reason}) => ({account, status, reason})),
    poolStarts: poolStarts.length, counterLocks: lock().length, sameCounterLock: true}));
});
