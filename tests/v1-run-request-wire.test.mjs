import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sign, createPublicKey, createHash} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {RUN_REQUEST_CAPABILITY as CAP, HOST_CAPABILITIES, MODEL_EFFORT_PAIRS_CAPABILITY} from '../lib/v1/versions.mjs';

// The signed run request travels as its own typed, versioned field and is covered by the job signature. A validator that does not
// know the capability refuses the job; it never drops the field or reads it as a plain model.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const pub = golden.keys.map(k => k.public_key);
const clone = value => structuredClone(value);
const rawSign = (kind, payload, key = keys[0]) => {
  const bytes = Buffer.concat([Buffer.from('faravan/' + kind + '/v1\0'), createHash('sha256').update(p.canonicalize(payload)).digest()]);
  return {payload, signature: {algorithm: 'Ed25519', key_id: p.fingerprint(createPublicKey(key)), value: sign(null, bytes, key).toString('base64url')}};
};
function requestJob(runRequest = {schemaVersion: 1, models: 'any', effortId: null}, over = {}) {
  const payload = clone(golden.objects.job.envelope.payload);
  delete payload.requirements.model;
  payload.requirements.capabilities = [...new Set([...payload.requirements.capabilities, CAP])];
  payload.runRequest = runRequest;
  return Object.assign(payload, over);
}
const model = (id, over = {}) => ({id, label: id, enabled: true, rank: 0, pareto: null, efforts: [{id: 'low', label: 'Low'}, {id: 'high', label: 'High'}], defaultEffort: 'low', ...over});

test('new designated work requires its capability while historical signed bytes remain readable',()=>{
  const job=requestJob(undefined,{designated_member:'sha256:'+'a'.repeat(64)});
  job.requirements.capabilities=job.requirements.capabilities.filter(value=>value!=='designated_member_v1');
  assert.equal(p.checkNewJob(job).ok,false);
  assert.equal(p.verifyEnvelope('job',rawSign('job',job),pub[0]).ok,true);
  job.requirements.capabilities.push('designated_member_v1');
  assert.equal(p.checkNewJob(job).ok,true);
});

test('a job may carry a run request only together with its capability, and the signature covers it', () => {
  const ok = requestJob({schemaVersion: 1, models: [{providerId: 'claude', modelId: 'opus'}], effortId: 'high'});
  const signed = p.signEnvelope('job', ok, keys[0]);
  assert.equal(p.verifyEnvelope('job', signed, pub[0]).ok, true);
  const tampered = clone(signed); tampered.payload.runRequest.effortId = 'low';
  assert.equal(p.verifyEnvelope('job', tampered, pub[0]).ok, false, 'a changed effort breaks the signature');
  const noCapability = requestJob(); noCapability.requirements.capabilities = noCapability.requirements.capabilities.filter(c => c !== CAP);
  assert.throws(() => p.signEnvelope('job', noCapability, keys[0]));
  const noField = requestJob(); delete noField.runRequest;
  assert.throws(() => p.signEnvelope('job', noField, keys[0]));
});

test('the request is closed and is not a second answer beside an explicit model, effort or automatic choice', () => {
  for (const bad of [{}, {schemaVersion: 2, models: 'any', effortId: null}, {schemaVersion: 1, models: [], effortId: null},
    {schemaVersion: 1, models: 'all', effortId: null}, {schemaVersion: 1, models: 'any'}, {schemaVersion: 1, models: 'any', effortId: ''},
    {schemaVersion: 1, models: 'any', effortId: null, extra: 1}, {schemaVersion: 1, models: [{providerId: 'p'}], effortId: null},
    {schemaVersion: 1, models: [{providerId: 'p', modelId: 'm'}, {providerId: 'p', modelId: 'm'}], effortId: null}, 'any'])
    assert.throws(() => p.signEnvelope('job', requestJob(bad), keys[0]), JSON.stringify(bad));
  const withModel = requestJob(); withModel.requirements.model = {any_of: ['example-model']};
  assert.throws(() => p.signEnvelope('job', withModel, keys[0]));
  const withEffort = requestJob(undefined, {budget_v1: {effort: 'low'}});
  withEffort.requirements.capabilities = [...withEffort.requirements.capabilities, 'budget_v1'];
  assert.throws(() => p.signEnvelope('job', withEffort, keys[0]));
  const withAuto = requestJob(undefined, {auto_run_v1: {intent: 'cheapest'}});
  withAuto.requirements.capabilities = [...withAuto.requirements.capabilities, 'auto_run_v1'];
  assert.throws(() => p.signEnvelope('job', withAuto, keys[0]));
});

test('a validator that predates the capability refuses the job instead of dropping the request', () => {
  const signed = rawSign('job', requestJob());
  const old = ['patch-output', 'verify_v1', 'results_v1', 'parent_link_v1', 'working_directory_v1', 'source_manifest_v1', 'source_project_name_v1', 'filtered_git_v1', 'budget_v1', MODEL_EFFORT_PAIRS_CAPABILITY, 'auto_run_v1'];
  const before = p.validateRequirements(signed.payload.requirements, {recognizedCapabilities: old});
  assert.equal(before.ok, false);
  assert.equal(before.code, 'unsupported_version');
  assert.equal(p.validateRequirements(signed.payload.requirements).ok, true);
  const bare = clone(signed.payload); bare.requirements.capabilities = bare.requirements.capabilities.filter(c => c !== CAP);
  assert.equal(p.verifyEnvelope('job', rawSign('job', bare), pub[0]).ok, false, 'the closed schema refuses the unknown field itself');
});

test('a lender satisfies a run request only through an advertised account, model and effort', () => {
  const payload = requestJob({schemaVersion: 1, models: [{providerId: 'claude', modelId: 'opus'}], effortId: 'high'}), req = payload.requirements;
  const ad = {harnesses: [...(req.harness ?? ['codex'])], models: ['example-model'], capabilities: [...req.capabilities],
    egress: [req.egress], enforced_limits: Object.keys(req.limits), max_limits: {...req.limits},
    accounts: [{accountId: 'a1', providerId: 'claude', models: [model('opus')]}]};
  assert.equal(p.canSatisfy(req, ad, {job: payload}).ok, true);
  const unmet = over => p.canSatisfy(req, {...ad, ...over}, {job: payload});
  assert.ok(unmet({accounts: [{accountId: 'a1', providerId: 'claude', models: [model('opus', {efforts: [{id: 'low', label: 'Low'}]})]}]}).unmet.includes('run_request'), 'no silent downgrade');
  assert.ok(unmet({accounts: [{accountId: 'a1', providerId: 'codex', models: [model('opus')]}]}).unmet.includes('run_request'));
  assert.ok(unmet({accounts: [{accountId: 'a1', providerId: 'claude', models: [model('opus', {enabled: false})]}]}).unmet.includes('run_request'));
  const noAccounts = {...ad}; delete noAccounts.accounts;
  assert.ok(p.canSatisfy(req, noAccounts, {job: payload}).unmet.includes('run_request'));
  assert.equal(p.canSatisfy(req, {...ad, capabilities: ad.capabilities.filter(c => c !== CAP)}, {job: payload}).ok, false);
  assert.equal(p.canSatisfy(req, {...ad, accounts: [{accountId: 'a1', providerId: 'claude', subjectId: 'person@example.invalid', models: []}]}, {job: payload}).ok, false,
    'an advertisement carries no upstream subject');
});

test('the host advertises the capability, and a receipt that records a selection says so and carries no extra field', () => {
  assert.ok(HOST_CAPABILITIES.includes(CAP));
  const result = clone(golden.objects.result.envelope.payload);
  const selection = {providerId: 'claude', accountId: 'a1', modelId: 'opus', effortId: 'high'};
  result.receipt.selection = selection;
  result.receipt.model = selection.modelId;
  result.receipt.capabilities_applied = [...result.receipt.capabilities_applied, CAP];
  assert.equal(p.verifyEnvelope('result', p.signEnvelope('result', result, keys[1]), pub[1]).ok, true);
  const mismatch = clone(result); mismatch.receipt.capabilities_applied = mismatch.receipt.capabilities_applied.filter(c => c !== CAP);
  assert.throws(() => p.signEnvelope('result', mismatch, keys[1]), 'a recorded selection and the capability come together');
  for (const bad of [{...selection, subjectId: 'x'}, {...selection, effortId: undefined}, {...selection, modelId: ''}, {providerId: 'claude'}]) {
    const broken = clone(result); broken.receipt.selection = bad;
    assert.throws(() => p.signEnvelope('result', broken, keys[1]), JSON.stringify(bad));
  }
});

test('a signed receipt cannot report a different model from its selection', () => {
  const result = clone(golden.objects.result.envelope.payload);
  result.receipt.selection = {providerId: 'claude', accountId: 'a1', modelId: 'opus', effortId: 'high'};
  result.receipt.capabilities_applied = [...result.receipt.capabilities_applied, CAP];
  result.receipt.model = 'other-model';
  assert.throws(() => p.signEnvelope('result', result, keys[1]));
});


test('new signed jobs require a run request and reject removed dollar caps',()=>{
  const missing=requestJob();delete missing.runRequest;
  assert.throws(()=>p.signEnvelope('job',missing,keys[0]));
  for(const removed of [{budget_v1:{max_list_usd:1}},{auto_run_v1:{intent:'cheapest'}}])
    assert.throws(()=>p.signEnvelope('job',requestJob(undefined,removed),keys[0]));
});
