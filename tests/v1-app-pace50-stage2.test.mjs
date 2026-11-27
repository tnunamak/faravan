import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// App-pair acceptance for the candidate path. The borrower is the owner app. The lender app takes the candidate option
// and the fake sandbox. Presence, Stop, Pause, On and the saved limits are the app's own routes. Nothing here calls
// adapter effects directly, and nothing edits durable state.
const gitInput = (circle) => ({circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40),
  prompt: 'Synthetic task: write a greeting. No external execution.', harness: 'codex'});
const evidence = () => ({source: createSyntheticPace50Source({start: Date.now()}),
  account_week_id: 'synthetic-week-1'});
async function lendAutomatically(lender, circle, idleOnly = false) {
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly,
    lendingPolicy: {providerConsent: {codex: true}}}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
}
const durable = (home) => JSON.parse(fs.readFileSync(join(home, 'v1', 'lending-pace50-state.json'), 'utf8'));
const count = (backend, kind) => backend.calls.filter(([name]) => name === kind).length;

test('with presence off, owner return during admission does not stop the job', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  // Hold the admission step, which runs after the reservation and before any sandbox exists.
  let enteredAdmission, releaseAdmission;
  const entered = new Promise((resolve) => { enteredAdmission = resolve; });
  const released = new Promise((resolve) => { releaseAdmission = resolve; });
  const admitJob = backend.admitJob.bind(backend);
  backend.admitJob = async (spec) => { enteredAdmission(); await released; return admitJob(spec); };
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(), idleReader: undefined});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await entered;
  assert.equal(durable(lender.home).attempts.length, 1, 'the reservation exists before the sandbox');
  // With the controls off, activity reports do not cancel the reservation.
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 5}});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  releaseAdmission();
  await waitFor(() => count(backend,'run')===1,'the job runs after admission');
  assert.equal(count(backend,'prepare'),1);
});

test('with presence off, owner return after preparation does not stop the job', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  // Hold right after the sandbox exists, before the entrypoint starts.
  let enteredStart, releaseStart;
  const entered = new Promise((resolve) => { enteredStart = resolve; });
  const released = new Promise((resolve) => { releaseStart = resolve; });
  const prepare = backend.prepare.bind(backend);
  backend.prepare = async (spec) => { const handle = await prepare(spec); enteredStart(); await released; return handle; };
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(), idleReader: undefined});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await entered;
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 5}});
  releaseStart();
  await waitFor(() => count(backend,'run')===1,'the job runs after preparation');
});

// The same held admission with no owner return: the agent runs. The hold alone does not block work.
test('a held admission with no stop still runs the agent once the admission is released', {timeout: 180000}, async (t) => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root, {});
  let enteredAdmission, releaseAdmission;
  const entered = new Promise((resolve) => { enteredAdmission = resolve; });
  const released = new Promise((resolve) => { releaseAdmission = resolve; });
  const admitJob = backend.admitJob.bind(backend);
  backend.admitJob = async (spec) => { enteredAdmission(); await released; return admitJob(spec); };
  const {owner, lender, circle} = await f.connect({backend, lendingPace50: evidence(), idleReader: undefined});
  await api(lender.app, '/api/desktop/presence', {method: 'POST', body: {idleSeconds: 3600}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: gitInput(circle)});
  await lendAutomatically(lender, circle);
  await entered;
  releaseAdmission();
  await waitFor(() => count(backend, 'run') === 1, 'the agent ran once');
  assert.equal(count(backend, 'prepare'), 1, 'one sandbox was prepared');
});

test('idle-only opt-in checks activity again before the prepared agent starts', {timeout:60000},async t=>{
  const f=await appFixture(t),backend=syntheticBackend(f.root,{});
  let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const prepare=backend.prepare.bind(backend);
  backend.prepare=async spec=>{const handle=await prepare(spec);entered();await held;return handle;};
  t.after(()=>release());
  const {owner,lender,circle}=await f.connect({backend,lendingPace50:evidence(),idleReader:undefined});
  await api(lender.app,'/api/desktop/presence',{method:'POST',body:{idleSeconds:3600}});
  await api(owner.app,'/api/jobs',{method:'POST',body:gitInput(circle)});
  await lendAutomatically(lender,circle,true);
  await waiting;
  await api(lender.app,'/api/desktop/presence',{method:'POST',body:{idleSeconds:5}});
  release();
  await waitFor(()=>durable(lender.home).attempts[0]?.process_state==='ceased','the unstarted job is cleaned up');
  assert.equal(count(backend,'run'),0);
});
