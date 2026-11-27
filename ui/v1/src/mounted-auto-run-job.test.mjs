import {createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Job} from './jobs.jsx';

// The job page shows what the person asked for from the moment the job exists. What the lender chose for the run appears
// only once that choice is saved, and the provider's own report only with the result.
beforeEach(() => { resetPage('#/job/x'); installClock(); });
afterEach(teardown);

const ID = 'sha256:' + 'e'.repeat(64);
const P = 'jobs/' + encodeURIComponent(ID);
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true};
const choice = {intent:'strongest', model:'gpt-6-sol', effort:'high', rule_version:'auto-run-v1', reason:'highest_capability_rank', capped:false, pricing_revision:'prices-sha256:' + 'a'.repeat(64)};
const record = (state, extra = {}) => ({job_digest:ID, circle:{id:'c1'}, state, status:state, requestedAutoRun:'strongest',
  current_attempt:{holder:'fp-2', attempt_id:'a1', generation:1, ...(state === 'queued' ? {} : {execution_started_at:new Date(Date.now() - 60000).toISOString()})},
  local:{title:'Fix the login loop', prompt:'Fix it', agent:'codex', submittedAt:new Date(Date.now() - 120000).toISOString()}, ...extra});
async function show(job, extra = {}) {
  const api = createFakeApi({[P]: job, [P + '/changes']: {format:'diff', diff:'', files:[], diffstat:{files:0, insertions:0, deletions:0}, ...extra},
    [P + '/prompt']: {text:'Fix it'}, [P + '/transcript']: {text:'', live:false}});
  const view = await mount(h(Job, {key:ID + ':c1', id:ID, requestedCircle:'c1', api, circle:'c1', circles:[circle], revision:0, mutate:async () => ({}), setDialog() {}, members:[],
    headingRef:{current:null}, refresh:async () => {}, draft:{submission:null}, data:{jobs:[], devices:{fingerprint:'fp-1', name:'MacBook', circles:[]}}}));
  await api.answer(P + '?circle=c1'); await flush();
  if (job.state === 'result-accepted') { await api.answer(P + '/changes?circle=c1'); await flush(); }
  return view;
}

for (const state of ['queued', 'running', 'failed']) {
  test(`a ${state} automatic job shows Asked for and says the run request is not chosen yet`, async () => {
    const text = (await show(record(state))).text();
    assert.match(text, /Asked for: Strongest offered/);
    assert.match(text, /Requested for this run: not chosen yet/);
    assert.doesNotMatch(text, /Provider reported: `/);
  });
}

test('a finished automatic job shows the choice, the saved request and what the provider reported', async () => {
  const text = (await show(record('result-accepted', {receipt:{harness:'codex', harness_version:'1.2.3', model:'gpt-6-sol', backend:'docker-sbx', duration_ms:60000, egress_applied:'provider-only', auto_run_v1:choice}}))).text();
  assert.match(text, /Asked for: Strongest offered/);
  assert.match(text, /Requested for this run: gpt-6-sol \/ high effort/);
  assert.match(text, /Provider reported: gpt-6-sol/);
  assert.match(text, /Provider effort: not reported/);
});

test('a job asked for no automatic choice shows no automatic lines', async () => {
  const text = (await show(record('queued', {requestedAutoRun:undefined}))).text();
  assert.doesNotMatch(text, /Asked for:|Requested for this run|Provider reported/);
});
