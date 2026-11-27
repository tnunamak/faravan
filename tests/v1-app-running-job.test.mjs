import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/offers-jobs-fixture.mjs';

const gitInput = circle => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'SECRET-PROMPT-TEXT write a greeting at /home/someone/private/path', harness: 'codex'});

test('the status names who a running job is for, and nothing else about the job', {timeout: 120000}, async t => {
  const f = await appFixture(t, {hold: true}), {owner, lender, circle} = await f.connect();
  assert.equal((await api(lender.app, '/api/status')).runningJob, null, 'no job, no field value');
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'review card');
  await api(lender.app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}});
  await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'running fake sandbox');
  const ownerKey = owner.app.device.keyId;
  // New circles carry the owner's signed device name before this lender chooses a local label.
  const ownerName = (await api(owner.app, '/api/devices')).name;
  assert.deepEqual((await api(lender.app, '/api/status')).runningJob, {requester: ownerName, own: false});
  // A name this lender gave them wins.
  await api(lender.app, '/api/circles/' + circle.id + '/petnames', {method: 'POST', body: {keyId: ownerKey, label: 'Sam'}});
  assert.deepEqual(await waitFor(async () => (await api(lender.app, '/api/status')).runningJob, 'the named running job'), {requester: 'Sam', own: false});
  const text = JSON.stringify((await api(lender.app, '/api/status')).runningJob);
  assert.equal(/SECRET-PROMPT|\/home\/|github\.com/.test(text), false, 'no prompt text, path or source in the field');
});

for (const harness of ['codex', 'claude-code-subscription']) {
  for (const self of [false, true]) {
    test(`running ${harness} is recorded on ${self ? 'sent' : 'ran'} jobs only on the executing computer`, {timeout: 120000}, async t => {
      const f = await appFixture(t, {hold: true});
      const {owner, lender, circle} = await f.connect({adapters: [{spec:legacyProxyHarness(harness), installed: true,
        signedIn: true, harnessVersion: 'synthetic-only', models: ['example-model'], capabilities: []}]});
      const sender = self ? lender : owner;
      const submitted = await api(sender.app, '/api/jobs', {method: 'POST', body: {...gitInput(circle), harness}});
      const remoteBefore = !self ? (await api(owner.app, '/api/jobs')).find(row => row.job_digest === submitted.jobDigest) : null;
      assert.equal((await api(lender.app, '/api/lending')).agent ?? null, null, 'unknown agent before a run');
      await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
      await api(lender.app, '/api/agents/' + harness, {method: 'POST', body: {useForLending: true}});
      await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
      await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
      // This computer's own job is accepted without asking (pin2-ownjob); another member's job waits for the answer.
      if (!self) {
        const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'review card');
        await api(lender.app, '/api/approvals/' + card.id + '/accept', {method: 'POST', body: {}});
      }
      await waitFor(() => lender.backend.calls.some(([kind]) => kind === 'run'), 'running fake sandbox');
      // Only the job the lender is running names its agent. The row exists from submission, so waiting for the row proves nothing.
      await waitFor(async () => (await api(lender.app, '/api/jobs')).find(row => row.job_digest === submitted.jobDigest)?.agent === harness, 'running job names its agent', 30000);
      // Queue only now. While the first job waited, the lender could start either job and the test could read the wrong row.
      const queued = await api(sender.app, '/api/jobs', {method: 'POST', body: {...gitInput(circle), harness, prompt: 'Another queued job'}});
      const queuedBefore = (await api(sender.app, '/api/jobs')).find(row => row.job_digest === queued.jobDigest);
      const status = await api(lender.app, '/api/home');
      assert.equal(status.lending.agent, harness);
      assert.equal((await api(lender.app, '/api/lending')).agent, harness);
      for (const path of ['/api/jobs', '/api/jobs?circle=' + encodeURIComponent(circle.id)]) {
        const row = (await api(lender.app, path)).find(row => row.job_digest === submitted.jobDigest);
        assert.equal(row.agent, harness, path+': '+JSON.stringify({state:row.state,phase:row.jobProjection?.phase,ranHere:row.ranHere,
          current:row.current_attempt,localAgent:status.lending.agent,localAttempt:status.lending.current}));
        assert.equal(row.current_attempt.attempt_id, status.lending.current);
        if (path === '/api/jobs') assert.equal(row.role, self ? 'sent' : 'ran');
      }
      const detail = await api(lender.app, '/api/jobs/' + submitted.jobDigest + '?circle=' + encodeURIComponent(circle.id));
      assert.equal(detail.agent, harness, 'job detail also names the running agent');
      if(!self) {
        const prompt=await api(lender.app,'/api/jobs/'+submitted.jobDigest+'/prompt?circle='+encodeURIComponent(circle.id));
        assert.equal(prompt.text,gitInput(circle).prompt,'accepted prompt is available on its job page');
        await api(owner.app,'/api/jobs/'+submitted.jobDigest+'/prompt?circle='+encodeURIComponent(circle.id),{status:403});
      }
      const queuedAfter = (await api(sender.app, '/api/jobs')).find(row => row.job_digest === queued.jobDigest);
      assert.equal(queuedAfter.agent, queuedBefore.agent, 'queued job does not inherit the running agent');
      if (!self) {
        const remoteAfter = (await api(owner.app, '/api/jobs')).find(row => row.job_digest === submitted.jobDigest);
        assert.equal(remoteAfter.agent, remoteBefore.agent, 'borrower does not infer a remote agent');
        assert.equal((await api(owner.app, '/api/home')).lending.agent ?? null, null);
      }
      await api(lender.app, '/api/lending/pause', {method: 'POST', body: {}});
      assert.equal((await api(lender.app, '/api/lending')).agent, harness, 'pausing new claims keeps the active run identity');
      lender.backend.release();
      await waitFor(async () => !(await api(lender.app, '/api/lending')).current, 'run completed');
      assert.equal((await api(lender.app, '/api/lending')).agent ?? null, null, 'finished run does not leave a stale lending agent');
      const finalTranscript=await api(lender.app,'/api/jobs/'+submitted.jobDigest+'/transcript?circle='+encodeURIComponent(circle.id));
      assert.equal(finalTranscript.live,false,'delivered jobs use the signed final transcript, not a retained live buffer');
    });
  }
}

// Judge r13 triage (item 1): the pool's top-level state names only its first running account, so a job row must be matched
// by its exact attempt. Two own executions on two accounts each name their own agent; a third job queued behind them names none.
test('two own executions each name their own agent, and a queued third job names none', {timeout: 180000}, async t => {
  const adapter = harness => ({spec:legacyProxyHarness(harness), installed: true, signedIn: true, harnessVersion: 'synthetic-only',
    models: ['example-model'], capabilities: []});
  const f = await appFixture(t, {hold: true});
  const {lender, circle} = await f.connect({adapters: [adapter('codex'), adapter('claude-code-subscription')]});
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 5, dailyMinutes: 120, maxWallSeconds: 1200,
    idleOnly: false, lendingPolicy: {providerConsent: {claude: true, codex: true}}}});
  for (const harness of ['codex', 'claude-code-subscription']) await api(lender.app, '/api/agents/' + harness, {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  const send = (harness, prompt) => api(lender.app, '/api/jobs', {method: 'POST', body: {...gitInput(circle), harness, prompt}});
  const runs = () => lender.backend.calls.filter(([kind]) => kind === 'run').length;
  const rowOf = async digest => (await api(lender.app, '/api/jobs')).find(row => row.job_digest === digest);
  const first = await send('codex', 'First own execution');
  await waitFor(() => runs() === 1, 'the first own execution starts', 20000);
  const second = await send('claude-code-subscription', 'Second own execution');
  await waitFor(() => runs() === 2, 'the second own execution starts beside the first', 20000);
  const third = await send('codex', 'Queued third job');
  const thirdBefore = await rowOf(third.jobDigest);
  const [firstRow, secondRow, thirdRow] = await waitFor(async () => {
    const rows = [await rowOf(first.jobDigest), await rowOf(second.jobDigest), await rowOf(third.jobDigest)];
    return rows[0]?.current_attempt && rows[1]?.current_attempt ? rows : null;
  }, 'both running rows', 20000);
  assert.notEqual(firstRow.current_attempt.attempt_id, secondRow.current_attempt.attempt_id, 'the two executions have distinct attempts');
  assert.equal(firstRow.agent, 'codex', 'the first execution names its own account');
  assert.equal(secondRow.agent, 'claude-code-subscription', 'the second execution names its own account, not the first one');
  assert.equal(thirdRow.current_attempt ?? null, null, 'the third job waits behind them');
  assert.equal(thirdRow.agent, thirdBefore?.agent, 'a queued job inherits no running agent');
  const circleRows = await api(lender.app, '/api/jobs?circle=' + encodeURIComponent(circle.id));
  assert.equal(circleRows.find(row => row.job_digest === second.jobDigest)?.agent, 'claude-code-subscription', 'the circle job list names it too');
  const detail = await api(lender.app, '/api/jobs/' + second.jobDigest + '?circle=' + encodeURIComponent(circle.id));
  assert.equal(detail.agent, 'claude-code-subscription', 'the second job page names its own agent');
});
