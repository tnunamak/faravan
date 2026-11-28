import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createAccountStore} from '../lib/v1/accounts.mjs';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {accountBackend, syntheticProvider} from './helpers/synthetic-run-account.mjs';

test('two Codex accounts sign in once each and lend in the enabled saved order', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const keys = ['SYNTHETIC_FIRST_ACCOUNT_KEY', 'SYNTHETIC_SECOND_ACCOUNT_KEY'];
  const signIns = [], requests = [], runs = [];
  const backend = accountBackend(syntheticBackend(f.root, {liveMessage: 'Synthetic task complete'}));
  // This base predates the helper's cleanup contract and unique sandbox handles.
  const prepare = backend.prepareAccountRun.bind(backend), destroy = backend.destroy.bind(backend);
  let sandboxNumber = 0;
  backend.prepareAccountRun = async spec => {
    const handle = await prepare(spec);
    handle.sandbox_id = 'second-account-' + ++sandboxNumber;
    return handle;
  };
  backend.destroy = async handle => ({...await destroy(handle), policy_removed: true, storage_removed: true});
  const start = backend.start.bind(backend);
  backend.start = async (handle, options) => {
    if (handle._entrypoint.startsWith('env ')) runs.push(handle._entrypoint);
    return start(handle, options);
  };
  const {owner, lender, circle, realHeartbeats} = await f.realConnect({lenderOptions: {
    backend, accountProviderConfigurations: [syntheticProvider],
    accountTransportFetch: async (_url, options) => {
      const index = keys.findIndex(key => options.headers.authorization === 'Bearer ' + key);
      assert.ok(index >= 0, 'the proxy uses one enrolled credential');
      if (options.method === 'GET') {
        signIns.push(index);
        return Response.json({subject: 'synthetic-person-' + index});
      }
      requests.push(index);
      return Response.json({id: 'synthetic-response', object: 'response', status: 'completed', model: 'example-model'});
    },
  }});
  async function settings(accountId, changes) {
    const {revision} = await api(lender.app, '/api/accounts');
    const result = await api(lender.app, '/api/accounts/' + accountId + '/settings', {method: 'POST',
      body: {expectedRevision: revision, ...changes}});
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  async function enroll(index) {
    const result = await api(lender.app, '/api/accounts', {method: 'POST', body: {
      providerId: 'codex', label: 'Account ' + index, operationId: 'enroll-' + index}});
    assert.equal(result.ok, true);
    const flow = result.value;
    const pending = await api(lender.app, '/api/accounts/flows/' + flow.flowId);
    assert.equal(pending.value.flowId, flow.flowId);
    const done = await api(lender.app, '/api/accounts/flows/' + flow.flowId + '/complete', {
      method: 'POST', body: {answer: keys[index]}});
    assert.equal(done.ok, true, JSON.stringify(done));
    await settings(done.value.id, {modelPreference: {modelId: 'example-model', enabled: true, effortIds: null}});
    // Match enrollSyntheticAccount: supply this synthetic provider's healthy initial usage.
    const store = createAccountStore({directory: join(lender.home, 'v1', 'accounts')}), at = Date.now();
    await store.transaction(state => {
      const usage = state.records[done.value.id].usage ??= {jobReadings: [], events: {}, meters: {}, pending: {},
        windowHistory: [], failures: 0, readLease: null};
      Object.assign(usage, {state: 'ready', lastAttemptAtMs: at, nextReadAtMs: null, limitResetAtMs: null,
        reading: {schemaVersion: 1, accountId: done.value.id, observationId: 'fixture-initial', sequence: at,
          observedAtMs: at, receivedAtMs: at, postingUncertaintyMs: null, coverage: {kind: 'unknown'},
          windows: [{id: 'seven_day', instance: 'seven_day:' + at, capacityMicro: 100000000,
            usedLoMicro: 0, usedHiMicro: 0, resetsAtMs: at + 7 * 86400000, maxOwnerRateMicroPerMs: 0}]}});
    });
    return done.value;
  }
  const first = await enroll(0);
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {
    dailyJobs: 10, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const second = await enroll(1);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(signIns, [0, 1], 'each account authenticates once; the first is never asked again');
  await settings(first.id, {accountOrder: [first.id, second.id]});
  const listed = await api(lender.app, '/api/accounts');
  assert.deepEqual(listed.accountOrder, [first.id, second.id]);
  for (const account of listed.accounts) assert.equal(account.authState, 'signed_in');

  const client = await owner.app.device.client(circle.id);
  // The coordinator matches a job against the lender's last published accounts. Submit only after the lender has
  // published the enabled order under test; a job matched against an older advertisement is refused.
  const published = () => realHeartbeats.filter(row => row.device === lender.app.device.keyId).at(-1)?.body.accounts
    ?.map(item => item.accountId);
  async function advertised(order) {
    await waitFor(() => JSON.stringify(published()) === JSON.stringify(order), 'published account order', 30000)
      .catch(error => { throw new Error(error.message + ': ' + JSON.stringify({published: published(), order}), {cause: error}); });
  }
  async function run(expected, credentialIndex) {
    const before = requests.length;
    const submitted = await api(owner.app, '/api/jobs', {method: 'POST', headers: {'faravan-confirm': 'yes'}, body: {
      circle: circle.id, prompt: 'Run a synthetic task ' + before,
      git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), harness: 'codex',
      runRequest: {schemaVersion: 1, models: [{providerId: 'codex', modelId: 'example-model'}], effortId: 'high'},
    }});
    const view = await client.waitForJob(submitted.jobDigest, {timeoutMs: 60000}).catch(async error => {
      throw new Error(error.message + ': ' + JSON.stringify({lending: (({status, reason}) => ({status, reason}))(await api(lender.app, '/api/lending')),
        job: await client.getJob(submitted.jobDigest), requests, runs: runs.length}), {cause: error});
    });
    assert.equal(view.state, 'result-accepted', JSON.stringify(view));
    const result = await client.fetchResult(submitted.jobDigest, {includeMetadata: true, attempt: view.current_attempt});
    assert.equal(view.current_attempt.selection.accountId, expected.id, 'the job record names the account');
    assert.equal(result.receipt.selection.accountId, expected.id);
    assert.deepEqual(requests.slice(before), [credentialIndex], 'only this account authorizes its run');
    const transcript = await client.fetchTranscript(submitted.jobDigest, {attempt: view.current_attempt});
    for (const key of keys) {
      assert.ok(!transcript.toString().includes(key), 'credentials stay out of the transcript');
      assert.ok(!result.bytes.toString().includes(key), 'credentials stay out of the result artifact');
      assert.ok(!JSON.stringify({view, result}).includes(key), 'credentials stay out of job records and output');
      assert.ok(runs.every(command => !command.includes(key)), 'the sandbox receives no account credential');
    }
  }
  await advertised([first.id, second.id]);
  await run(first, 0);
  await settings(first.id, {enabled: false});
  await advertised([second.id]);
  await run(second, 1);
  await settings(first.id, {enabled: true, accountOrder: [second.id, first.id]});
  await advertised([second.id, first.id]);
  await run(second, 1);
  assert.equal(runs.length, 3);
  assert.deepEqual(signIns, [0, 1], 'all three jobs reuse their own signed-in account');
  assert.deepEqual(requests, [0, 1, 1], 'one authorized call per run, none while accounts are disabled, reordered or advertised');
});
