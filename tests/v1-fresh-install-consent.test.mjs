import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-lifecycle-fixture.mjs';

// A fresh install starts with lending intent on and both providers consented, but no agent
// has been chosen for lending. This guard pins that no job runs on the lender until the
// owner chooses an agent. A job offered by a circle member must stay unclaimed before that choice.
test('a fresh install claims no job until the owner chooses an agent to lend', {timeout: 120000}, async t => {
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({freshLending: 'automatic'});

  const settings = await api(lender.app, '/api/lending');
  assert.equal(settings.intent, 'on', 'first-start intent');
  assert.deepEqual(settings.limits.lendingPolicy.providerConsent, {claude: true, codex: true}, 'first-start provider consent');
  const agentsBefore = await api(lender.app, '/api/agents');
  assert.equal(agentsBefore.filter(a => a.useForLending === true).length, 0, 'no agent is chosen for lending on first start');

  // The owner is away for the whole test (the desktop reports presence), so presence never
  // explains a missing claim; only the agent choice changes between the two halves.
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});

  const submit = prompt => api(owner.app, '/api/jobs', {method: 'POST', body: {
    circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt, harness: 'codex'}});
  const offered = await submit('Offered before the owner chose an agent');
  await api(lender.app, '/api/circles/' + circle.id + '/check', {method: 'POST', body: {}});

  // Let the lender poll several times; none may claim, start, or run the job.
  await new Promise(resolve => setTimeout(resolve, 2000));
  const job = f.jobs.get(offered.jobDigest);
  assert.equal(job.current_attempt ?? null, null, 'the job has no claim attempt');
  assert.equal(job.state, 'queued');
  assert.equal(lender.backend.calls.filter(([kind]) => kind === 'run' || kind === 'admit').length, 0, 'nothing ran on the lender');

  // The lender is running and the install rule is set, and the only thing between it and a claim is the agent choice.
  const blocked = await api(lender.app, '/api/status');
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.blockers, [{kind: 'no_agents'}]);
  assert.equal((await api(lender.app, '/api/home')).intent.reason, 'agent_not_ready');

  // Control: the Lend page agent switch is the one step that lets the lender claim.
  // No presence, lending-on or join-mode call is made after the first half.
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  const second = await submit('Offered after the owner chose an agent');
  await waitFor(() => f.jobs.get(second.jobDigest).state === 'result-accepted', 'a new job is claimed and finished once the owner chose an agent', 60000);
  assert.notEqual(f.jobs.get(second.jobDigest).current_attempt ?? null, null, 'a real claim exists');
  assert.ok(lender.backend.calls.some(([kind]) => kind === 'run' || kind === 'admit'), 'the job ran on the lender');
});
