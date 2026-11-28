import './helpers/no-browser.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

// D7: a job over a hard limit is refused, never carded. A job no rule covers still gets a card when every hard gate passes.
// An approved card is checked again before it runs. Hard gates here: the owner's global daily minutes.
const harness = 'claude-code-subscription';
async function setup(t) {
  const common = {syntheticAccounts:'claude'};
  const f = await appFixture(t, {hold: true}), {owner, circle} = await f.connect({}, common);
  await api(owner.app, '/api/agents/' + harness + '/run', {method: 'POST', body: {model: 'claude-haiku-5-5', effort: null}});
  await api(owner.app, '/api/agents/' + harness, {method: 'POST', body: {useForLending: true}});
  const limits = body => api(owner.app, '/api/lending/limits', {method: 'POST', body: {idleOnly: false, maxWallSeconds: 1200,
    lendingPolicy: {strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 30}, providerConsent: {claude: true}, accountPlans: {claude: 'max20'}}, ...body}});
  await limits({});
  // Automatic mode whose rule covers only the owner: a member's job is covered by no rule.
  await api(owner.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  const view = await api(owner.app, '/api/lending');
  const own = view.standingRules.map(({appOwned, ...r}) => r.circle === circle.id ? {...r, people: [owner.app.device.keyId]} : r);
  await api(owner.app, '/api/lending/rules', {method: 'POST', body: {rules: own, version: view.configVersion}});
  const member = await f.start('member', common);
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  await api(member.app, '/api/circles/join', {method: 'POST', body: {link: invite}});
  await api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {}});
  await member.app.device.refreshRoster(circle.id);
  const submit = prompt => api(member.app, '/api/jobs', {headers:{'faravan-confirm':'yes'},method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt, harness}});
  const cards = async () => (await api(owner.app, '/api/approvals')).filter(c => c.jobDigest || c.job_digest);
  const runs = () => owner.backend.calls.filter(([kind]) => kind === 'run').length;
  return {f, owner, circle, member, limits, submit, cards, runs};
}
const digestOf = c => c.jobDigest ?? c.job_digest;

test('a hard daily limit refuses a job with no card, and the same job gets a card once the limit is cleared', {timeout: 180000}, async t => {
  const x = await setup(t);
  await x.limits({dailyMinutes: 1});
  await api(x.owner.app, '/api/lending/on', {method: 'POST', body: {circle: x.circle.id}});
  const job = await x.submit('Over the daily minutes');
  await new Promise(r => setTimeout(r, 4000));
  assert.deepEqual(await x.cards(), [], 'a hard gate makes no card');
  assert.equal(x.runs(), 0);
  assert.equal(x.f.jobs.get(job.jobDigest).state, 'queued', 'and nothing claimed it');
  await x.limits({dailyMinutes: null});
  await waitFor(async () => (await x.cards()).some(c => digestOf(c) === job.jobDigest), 'the card once the hard limit is gone', 30000);
  assert.equal(x.runs(), 0, 'a card runs nothing until it is approved');
});

test('an approved card is checked again: a limit set while it waited refuses it with no run', {timeout: 180000}, async t => {
  const x = await setup(t);
  await api(x.owner.app, '/api/lending/on', {method: 'POST', body: {circle: x.circle.id}});
  const job = await x.submit('Carded, then capped');
  await waitFor(async () => (await x.cards()).some(c => digestOf(c) === job.jobDigest), 'the card', 30000);
  await x.limits({dailyMinutes: 1});
  const card = (await x.cards()).find(c => digestOf(c) === job.jobDigest);
  const refused = await api(x.owner.app, '/api/approvals/' + encodeURIComponent(card.id) + '/accept', {method: 'POST', body: {}, status: 409});
  assert.equal(refused.code, 'daily_limit');
  await new Promise(r => setTimeout(r, 3000));
  assert.equal(x.runs(), 0, 'approval is not an exemption from the daily limit');
  assert.notEqual(x.f.jobs.get(job.jobDigest).state, 'result-accepted');
});

test('in Ask mode a job over the daily cap is refused with no card, and gets a card once the cap is cleared', {timeout: 180000}, async t => {
  const x = await setup(t);
  await api(x.owner.app, '/api/lending/mode', {method: 'POST', body: {circle: x.circle.id, mode: 'ask'}});
  await x.limits({dailyMinutes: 1});
  await api(x.owner.app, '/api/lending/on', {method: 'POST', body: {circle: x.circle.id}});
  const job = await x.submit('Ask mode, over the daily cap');
  await new Promise(r => setTimeout(r, 4000));
  assert.deepEqual(await x.cards(), [], 'Ask mode still makes no card for a hard-gated job');
  assert.equal(x.runs(), 0);
  assert.equal(x.f.jobs.get(job.jobDigest).state, 'queued');
  await x.limits({dailyMinutes: null});
  await waitFor(async () => (await x.cards()).some(c => digestOf(c) === job.jobDigest), 'the card once the cap is gone', 30000);
  assert.equal(x.runs(), 0);
});

const cap = (x, limits) => api(x.owner.app, '/api/lending/requester-limits', {method: 'POST', body: {circle: x.circle.id, keyId: x.member.app.device.keyId, limits}});

test('a per-person cap refuses that person\'s job with no card, in Ask mode too', {timeout: 180000}, async t => {
  const x = await setup(t);
  await api(x.owner.app, '/api/lending/mode', {method: 'POST', body: {circle: x.circle.id, mode: 'ask'}});
  await cap(x, {dailyMinutes: 1, dailyJobs: null});
  await api(x.owner.app, '/api/lending/on', {method: 'POST', body: {circle: x.circle.id}});
  const job = await x.submit('Over the per-person cap');
  await new Promise(r => setTimeout(r, 4000));
  assert.deepEqual(await x.cards(), [], 'a per-person hard cap makes no card');
  assert.equal(x.runs(), 0);
  assert.equal(x.f.jobs.get(job.jobDigest).state, 'queued');
  await cap(x, null);
  await waitFor(async () => (await x.cards()).some(c => digestOf(c) === job.jobDigest), 'the card once the cap is gone', 30000);
});

test('a per-person cap set while a card waits withdraws the card, and nothing runs', {timeout: 180000}, async t => {
  const x = await setup(t);
  await api(x.owner.app, '/api/lending/on', {method: 'POST', body: {circle: x.circle.id}});
  const job = await x.submit('Carded, then the person is capped');
  await waitFor(async () => (await x.cards()).some(c => digestOf(c) === job.jobDigest), 'the card', 30000);
  await cap(x, {dailyMinutes: 1, dailyJobs: null});
  await waitFor(async () => (await x.cards()).length === 0, 'the card is withdrawn', 30000);
  assert.equal(x.runs(), 0);
  assert.equal(x.f.jobs.get(job.jobDigest).state, 'queued');
});
