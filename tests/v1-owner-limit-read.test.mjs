import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createPace50Candidate, minimumMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {LINES, lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// The owner's saved per-job limit reaches the admission request in three states: the saved number, the documented $4 default
// when no limit was saved, and a hold by name when the settings file cannot be read. An unreadable file is never read as unset.
// The hold comes before the trusted source is read, before the objective builder runs, and before anything is recorded.
// Synthetic data only; no provider calls.
const HAIKU = 'claude-haiku-5-5';
const HAIKU_LIMIT = minimumMaxJobUsdForModel(HAIKU) + 0.01;
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};
// The damaged file from the review report: a saved limit beside an audit trail that is not a list.
const DAMAGED = '{"version":1,"values":{"maxJobUsd":0.25},"audit":"damaged"}';

function ownerDir(t, contents = null) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'owner-limit-store-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  if (contents !== null) fs.writeFileSync(join(dir, 'owner-settings.json'), contents);
  return dir;
}
const setLimit = (dir, maxJobUsd) => createOwnerSettings({directory: dir}).set({by: 'owner', reason: 'synthetic limit', now: NOW, maxJobUsd});

// The builder records each request it is asked to build, and refuses, so nothing is admitted. A null directory means no settings store.
function candidateFor(t, dir) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'owner-limit-read-'));
  const source = createSyntheticPace50Source({start: NOW});
  const observe = source.observe.bind(source);
  let observed = 0;
  source.observe = (args) => { observed += 1; return observe(args); };
  const requests = [];
  const ownerSettings = dir === null ? null : createOwnerSettings({directory: dir});
  const opened = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK, source, ownerSettings,
    buildInput: async ({request}) => { requests.push(request); return {refuse: 'owner_scenarios_unknown'}; }});
  t.after(async () => {
    await opened.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {...opened, requests, observed: () => observed, source};
}

const previewOf = (pace) => pace.candidate.preview({jobId: 'job-1', job, provider: 'claude', model: HAIKU});

// A value container that is not a plain object of the known fields is unreadable. An array in particular must never read as unset.
test('a malformed value container is unreadable, never unset, and holds admission without a builder run', {timeout: 30000}, async t => {
  for (const values of ['[]', '"x"', '5', 'null', '{"maxJobUsd":0.25,"extra":true}']) {
    const dir = ownerDir(t, `{"version":1,"values":${values},"audit":[]}`);
    assert.deepEqual(createOwnerSettings({directory: dir}).limit(), {state: 'unreadable', maxJobUsd: null}, values);
  }
  const dir = ownerDir(t, '{"version":1,"values":[],"audit":[]}');
  const pace = candidateFor(t, dir);
  assert.equal(await pace.candidate.preflight({provider: 'claude'}), 'owner_settings_unreadable');
  const reserved = await pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', job, model: HAIKU});
  assert.equal(reserved.reason, 'owner_settings_unreadable');
  assert.equal(pace.observed(), 0, 'the trusted source is not read');
  assert.deepEqual(pace.requests, [], 'the builder does not run');
  assert.equal(pace.adapter.state().attempts.length, 0, 'nothing is held');
});

test('the store reads the saved limit as set, unset or unreadable, and never reads an unreadable file as unset', t => {
  const dir = ownerDir(t);
  const store = createOwnerSettings({directory: dir});
  assert.deepEqual(store.limit(), {state: 'unset', maxJobUsd: null}, 'no file: no limit was ever saved');
  setLimit(dir, 0.25);
  assert.deepEqual(store.limit(), {state: 'set', maxJobUsd: 0.25});
  fs.writeFileSync(join(dir, 'owner-settings.json'), '{"version":1,"values":{"maxJobUsd":null},"audit":[]}');
  assert.deepEqual(store.limit(), {state: 'unset', maxJobUsd: null}, 'a file with no limit saved is unset');
  fs.writeFileSync(join(dir, 'owner-settings.json'), DAMAGED);
  assert.deepEqual(store.limit(), {state: 'unreadable', maxJobUsd: null});
  assert.equal(store.values(), null, 'values() still reads nothing for an unreadable file');
});

test('a saved per-job limit reaches the admission request as its micro-unit value', {timeout: 30000}, async t => {
  const dir = ownerDir(t);
  setLimit(dir, HAIKU_LIMIT);
  const pace = candidateFor(t, dir);
  const preview = await previewOf(pace);
  assert.equal(pace.requests.length, 1, 'the builder was asked for the request: ' + JSON.stringify(preview));
  assert.equal(preview.admitted, false, 'the synthetic builder still refuses after receiving the request');
  assert.equal(pace.requests[0].owner_max_job_usd_micro, Math.ceil(HAIKU_LIMIT * 1_000_000));
});

test('with no limit saved, the request carries the documented $4 default, never null', {timeout: 30000}, async t => {
  const absent = candidateFor(t, ownerDir(t));
  await previewOf(absent);
  assert.equal(absent.requests[0].owner_max_job_usd_micro, 4000000, 'no file');
  const unset = candidateFor(t, ownerDir(t, '{"version":1,"values":{"maxJobUsd":null},"audit":[]}'));
  await previewOf(unset);
  assert.equal(unset.requests[0].owner_max_job_usd_micro, 4000000, 'a file with no limit saved');
});

test('with no settings store at all, the request carries no owner cap', {timeout: 30000}, async t => {
  const pace = candidateFor(t, null);
  await previewOf(pace);
  assert.equal(pace.requests[0].owner_max_job_usd_micro, null);
});

test('an unreadable settings file holds admission by name, before the source, the builder or any record', {timeout: 30000}, async t => {
  const dir = ownerDir(t);
  setLimit(dir, 0.25);
  fs.writeFileSync(join(dir, 'owner-settings.json'), DAMAGED);
  const pace = candidateFor(t, dir);
  const preview = await previewOf(pace);
  assert.equal(preview.admitted, false);
  assert.equal(preview.reason, 'owner_settings_unreadable');
  const decision = pace.candidate.decisionFor('claude');
  assert.equal(decision.reason, 'owner_settings_unreadable');
  assert.equal(decision.objective.reasonText, 'Holding — your saved per-job limit cannot be read. This needs you: save the per-job limit again. '
    + 'Saving replaces the unreadable file after you confirm, and keeps a copy of it beside the new one.');
  assert.equal(await pace.candidate.preflight({provider: 'claude'}), 'owner_settings_unreadable');
  assert.deepEqual(await pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', job, model: HAIKU}),
    {ok: false, reason: 'owner_settings_unreadable', policyReason: 'owner_settings_unreadable', probe: null});
  assert.equal(pace.observed(), 0, 'the trusted source was never read');
  assert.deepEqual(pace.requests, [], 'the objective builder never ran');
  assert.equal(pace.adapter.state().attempts.length, 0, 'nothing is held');
});

test('an unreadable owner file holds the fresh status projection despite spare quota and no prior job decision', {timeout: 30000}, async t => {
  const dir = ownerDir(t, DAMAGED);
  const pace = candidateFor(t, dir);
  pace.source.state.used = {weekly: 0, short: 0};
  const before = pace.candidate.decisionFor('claude');
  assert.equal(before.reason, 'objective_evidence_unknown', 'no job has produced a prior decision');
  assert.deepEqual(pace.source.state.used, {weekly: 0, short: 0}, 'the synthetic reading has the full quota available');

  const status = await pace.candidate.projectStatus({provider: 'claude', model: HAIKU, automatic: false});

  assert.deepEqual(status, {admitted: false, reason: 'owner_settings_unreadable', objective: null});
  assert.equal(pace.candidate.decisionFor('claude').reason, 'objective_evidence_unknown',
    'a jobless status projection does not replace the last job result');
  assert.equal(pace.observed(), 0, 'the owner settings hold is applied before a fresh meter read');
});

test('runtime surfaces an unreadable owner hold before it reads quota', {timeout: 30000}, async t => {
  const ownerDirectory = ownerDir(t, DAMAGED);
  const runtimeDirectory = fs.mkdtempSync(join(tmpdir(), 'owner-limit-runtime-'));
  const source = createSyntheticPace50Source({start: NOW, used: {weekly: 0, short: 0}});
  const observe = source.observe.bind(source);
  let observed = 0;
  source.observe = async args => { observed += 1; return observe(args); };
  const runtime = createLendingRuntime({directory: runtimeDirectory, backend: {}, now: () => NOW, presence: () => false,
    settings: () => ({enabled: true, intent: 'on', activeCircle: 'circle-1', modes: {'circle-1': 'ask'},
      limits: {lendingPolicy: {accountPlans: {claude: 'max20', codex: 'unknown'}}}}),
    pace50: {account: ACCOUNT, account_week_id: WEEK, source,
      ownerSettings: createOwnerSettings({directory: ownerDirectory})}});
  t.after(async () => { await runtime.close(); fs.rmSync(runtimeDirectory, {recursive: true, force: true}); });

  assert.equal(runtime.candidate.decisionFor('claude').reason, 'objective_evidence_unknown', 'no job has decided this account');
  const view = await runtime.view();
  const claude = view.accounts.find(row => row.provider === 'claude');
  assert.equal(claude.decision.reason, 'owner_settings_unreadable');
  assert.equal(claude.decision.status.line, LINES.owner_settings);
  assert.equal(claude.decision.availability.status.line, LINES.owner_settings);
  assert.deepEqual(claude.decision.windows, [], 'a blocked status does not wait for quota windows');
  assert.equal(runtime.candidate.decisionFor('claude').reason, 'objective_evidence_unknown',
    'the status projection does not create a job decision');
  assert.equal(observed, 0, 'the runtime does not read a meter after the owner settings hold is known');
});

test('repairing the settings file lifts the hold on the next admission read', {timeout: 30000}, async t => {
  const dir = ownerDir(t, DAMAGED);
  const pace = candidateFor(t, dir);
  assert.equal((await previewOf(pace)).reason, 'owner_settings_unreadable');
  fs.writeFileSync(join(dir, 'owner-settings.json'), JSON.stringify({version:1,values:{maxJobUsd:HAIKU_LIMIT},audit:[]}));
  await previewOf(pace);
  assert.equal(pace.requests.length, 1, 'the builder runs once the file reads again');
  assert.equal(pace.requests[0].owner_max_job_usd_micro, Math.ceil(HAIKU_LIMIT * 1_000_000));
});

test('the held status names the owner settings cause and says that it needs the owner', () => {
  const status = lendingStatus({admitted: false, reason: 'owner_settings_unreadable'});
  assert.equal(status.id, 'owner_settings');
  assert.match(status.line, /saved per-job limit cannot be read/);
  assert.match(status.line, /needs you/);
  assert.match(status.line, /save the per-job limit again/);
});


test('jobless Codex projection uses the saved limit instead of a synthetic cent', {timeout: 30000}, async t => {
  const dir = ownerDir(t);
  setLimit(dir, 4);
  const pace = candidateFor(t, dir);
  await pace.candidate.projectStatus({provider: 'codex', automatic: false});
  assert.equal(pace.requests.length, 1);
  assert.equal(pace.requests[0].requested_usd_micro, 4_000_000);
});
