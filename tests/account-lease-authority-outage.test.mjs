import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';

// P2 (design 1119, trigger met): while the coordinator is unreachable, a locally-valid lease still
// authorizes the provider dispatch; the loan stays bounded by the lease's own expiry, and the completed
// result delivers once the coordinator answers again. The coordinator confirming leases while reachable
// (release and membership fences) is proven by the held-body tests in account-authority-integration.

const providerConfiguration = {
  descriptor: {schemaVersion: 1, id: 'codex', label: 'Configured key service', signInKind: 'api_key', refreshKind: 'none',
    usageKind: 'job_local', maxConcurrentJobs: 1, nativeUnits: [{id: 'tokens', scale: 1}],
    models: [{id: 'example-model', label: 'Example', enabled: true, rank: 0, pareto: null,
      efforts: [{id: 'high', label: 'High'}], defaultEffort: 'high'}],
    destinations: [{origin: 'https://controlled.invalid', pathPrefixes: ['/v1'], methods: ['POST']}]},
  identityUrl: 'https://controlled.invalid/me', identitySubjectField: 'subject', command: 'codex', args: ['exec'],
  modelFlag: '-m', effortFlag: '--effort', keyEnv: 'JOB_KEY', baseUrlEnv: 'BASE_URL',
};
async function enroll(app, key, operationId) {
  const flow = await api(app, '/api/accounts', {method: 'POST', body: {providerId: 'codex', label: operationId, operationId}});
  const account = (await api(app, '/api/accounts/flows/' + flow.value.flowId + '/complete', {method: 'POST', body: {answer: key}})).value;
  const {revision} = await api(app, '/api/accounts');
  const settings = await api(app, '/api/accounts/' + account.id + '/settings', {method: 'POST',
    body: {expectedRevision: revision, modelPreference: {modelId: 'example-model', enabled: true, effortIds: null}}});
  assert.equal(settings.ok, true, JSON.stringify(settings));
  return account;
}

test('a coordinator outage mid-run never refuses the provider dispatch, and the result still delivers', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  backend.prepareAccountRun = async spec => {
    const h = await backend.prepare(spec);
    h.job_id = spec.job_id; h.sandbox_id = 'outage-' + randomUUID(); h._cleanupId = randomUUID();
    return h;
  };
  backend.inspect = async h => ({job_id: h.job_id, status: 'exited'});
  const upstream = [];
  const originalStart = backend.start.bind(backend);
  let dark = false;
  backend.start = async (h, opts) => {
    if (h._entrypoint.startsWith('env ')) {
      // The coordinator goes dark exactly around the provider dispatch, and returns right after it.
      dark = true;
      try {
        const key = /JOB_KEY=([^']+)/.exec(h._entrypoint)?.[1];
        const base = /BASE_URL=([^']+)/.exec(h._entrypoint)?.[1];
        const response = await fetch(base + '/responses', {method: 'POST',
          headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
          body: JSON.stringify({model: 'example-model', effort: 'high'})});
        upstream.push(response.status);
        assert.equal(response.status, 200, 'the dispatch is authorized by the lease the lender holds');
      } finally { dark = false; }
      h._entrypoint = 'completed-outage-provider';
    }
    return originalStart(h, opts);
  };
  const {owner, lender, circle} = await f.realConnect({lenderOptions: {
    backend, accountProviderConfigurations: [providerConfiguration],
    accountTransportFetch: async (_url, options) => {
      if (options.method === 'GET') return Response.json({subject: 'outage-subject'});
      return Response.json({id: 'outage-response', object: 'response', status: 'completed', model: 'example-model'});
    },
  }});
  // Only circle traffic goes dark: the lender's own app and the provider transport keep answering.
  // The outage is the P2 fixture's own shape: a bare HTTP 503 (no problem body), which the client
  // classifies as code http_error with status 503 - an inability to answer, never a lease judgment.
  const coordinator = circle.origin;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => String(url).startsWith(coordinator) && dark
    ? Promise.resolve(new Response('Service Unavailable', {status: 503}))
    : realFetch(url, options);
  t.after(() => { globalThis.fetch = realFetch; });
  const account = await enroll(lender.app, 'OUTAGE_ACCOUNT', 'outage-enroll');
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const submitted = await api(owner.app, '/api/jobs', {method: 'POST', body: {
    circle: circle.id, prompt: 'Signed account job through a coordinator outage',
    git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), harness: 'codex',
    runRequest: {schemaVersion: 1, models: [{providerId: 'codex', modelId: 'example-model'}], effortId: 'high'},
  }});
  const client = await owner.app.device.client(circle.id);
  const view = await waitFor(async () => {
    try {
      const current = await client.getJob(submitted.jobDigest);
      return current.state === 'result-accepted' ? current : null;
    } catch { return null; /* reads during the dark window are retryable */ }
  }, 'the job completes through the outage and the recovery', 90000);
  assert.deepEqual(upstream, [200], 'exactly one provider dispatch, authorized while the coordinator was dark');
  assert.equal(view.attempts_started, 1, 'the outage never failed the attempt');
  const result = await client.fetchResult(submitted.jobDigest, {includeMetadata: true, attempt: view.current_attempt});
  assert.deepEqual(result.receipt.selection, {providerId: 'codex', accountId: account.id, modelId: 'example-model', effortId: 'high'});
});
