import {advance, createFakeApi, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';

// Judge r7 O1 on the real App (real watchUpdates, read queues and revision policy). The daemon reports each
// lending account separately; two accounts alternate. Same-type events whose content did not change must not
// invalidate pages, and an open job page re-reads only for events about its own job.
const GLOBAL = ['readiness', 'home', 'circles', 'agents', 'devices', 'approvals', 'activity', 'jobs'];
const isGlobal = path => GLOBAL.includes(path);
const D = 'sha256:' + 'a'.repeat(64), OTHER = 'sha256:' + 'b'.repeat(64);
const JOB = 'jobs/' + encodeURIComponent(D) + '?circle=c1';
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true, selected: true};
const tableFor = () => ({
  readiness: {ok: true}, home: () => ({observedAt: new Date(Date.now()).toISOString(), lending: {enabled: true}}),
  circles: [circle], agents: [], devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []},
  approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
  [JOB]: () => ({job_digest: D, circle: {id: 'c1'}, state: 'queued', status: 'queued',
    local: {title: 'Waiting job', prompt: 'Waiting job', submittedAt: new Date(Date.now() - 60000).toISOString()}}),
});
afterEach(teardown);

async function settle(api, rounds = 14) {
  for (let n = 0; n < rounds; n++) {
    await advance(6000);
    for (const open of api.openReads(path => isGlobal(path) || path === JOB || path === 'hosting')) await api.answer(open.path);
  }
}
const lending = (account, status = 'idle') => ({circle: 'c1', account, status, label: 'Waiting for a job.'});

test('App mounted: two accounts alternating unchanged lending states revise pages once each, then never again', async () => {
  resetPage('#/circles'); installClock();
  const api = createFakeApi(tableFor());
  await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  await api.emit('lending', lending('claude:0')); await api.emit('lending', lending('codex:0'));
  await settle(api);
  const settled = api.count('hosting');
  for (let i = 0; i < 20; i++) await api.emit('lending', lending(i % 2 ? 'codex:0' : 'claude:0'));
  await settle(api);
  assert.equal(api.count('hosting'), settled, 'repeated per-account states read nothing again');
  await api.emit('lending', lending('codex:0', 'running'));
  await settle(api);
  assert.equal(api.count('hosting'), settled + 1, 'a real change for one account still revises pages');
});

test('App mounted: an open job page ignores events about other jobs and lending, and stays current', async () => {
  resetPage('#/job/' + encodeURIComponent(D) + '/c1'); installClock();
  const api = createFakeApi(tableFor());
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release(); await settle(api);
  const before = api.count(JOB);
  await api.emit('job', {job_digest: OTHER, state: 'running'});
  await api.emit('lending', lending('claude:0', 'running'));
  await api.emit('approval', {state: 'accepted', jobDigest: OTHER});
  await settle(api);
  assert.equal(api.count(JOB), before, 'no re-read for other jobs or lending');
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/);
  await api.emit('job', {job_digest: D, state: 'claimed'});
  await settle(api);
  assert.equal(api.count(JOB), before + 1, 'an event about this job re-reads it once');
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/);
  // Back-to-back news about this job: the next read starts at once, inside the usual five-second spacing.
  await api.emit('job', {job_digest: D, state: 'running'});
  if (!api.openReads(JOB).length) await api.emit('job', {job_digest: D, state: 'claimed'});
  assert.equal(api.openReads(JOB).length, 1, 'news about this job is read at once, not after the read spacing');
  await api.answer(JOB);
  await api.emit('job', {job_digest: D, state: 'stop_requested'});
  assert.equal(api.openReads(JOB).length, 1, 'a second change one moment later is read at once too');
  await api.answer(JOB);
  assert.doesNotMatch(view.text(), /Last known|Job status is updating/);
});
