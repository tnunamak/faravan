import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sign, createPublicKey, createHash} from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import {MODEL_EFFORT_PAIRS_CAPABILITY, HOST_CAPABILITIES} from '../lib/v1/versions.mjs';

// The automatic choice travels as its own typed, versioned field. A validator that does not know it must refuse the job,
// never read it as an explicit request or drop it.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const pub = golden.keys.map(k => k.public_key);
const job = golden.objects.job.envelope.payload;
const clone = value => structuredClone(value);
const CAP = 'auto_run_v1';
function autoJob(intent = 'cheapest', over = {}) {
  const payload = clone(job);
  delete payload.requirements.model;
  payload.requirements.capabilities = [...new Set([...payload.requirements.capabilities, CAP])];
  payload.auto_run_v1 = {intent};
  return Object.assign(payload, over);
}
const rawSign = (kind, payload, key = keys[0]) => {
  const bytes = Buffer.concat([Buffer.from('faravan/' + kind + '/v1\0'), createHash('sha256').update(p.canonicalize(payload)).digest()]);
  return {payload, signature: {algorithm: 'Ed25519', key_id: p.fingerprint(createPublicKey(key)), value: sign(null, bytes, key).toString('base64url')}};
};

test('a job may carry an automatic choice only together with its capability', () => {
  for (const intent of ['cheapest', 'strongest']) assert.equal(p.verifyEnvelope('job', p.signEnvelope('job', autoJob(intent), keys[0]), pub[0]).ok, true);
  const noCapability = autoJob(); noCapability.requirements.capabilities = noCapability.requirements.capabilities.filter(c => c !== CAP);
  assert.throws(() => p.signEnvelope('job', noCapability, keys[0]));
  const noField = autoJob(); delete noField.auto_run_v1;
  assert.throws(() => p.signEnvelope('job', noField, keys[0]));
});

test('the choice is closed: two intents, nothing else, and not beside an explicit model or effort', () => {
  for (const bad of [{intent: 'best'}, {intent: ''}, {intent: 'cheapest', extra: 1}, {}, {intent: ['cheapest']}, 'cheapest'])
    assert.throws(() => p.signEnvelope('job', autoJob('cheapest', {auto_run_v1: bad}), keys[0]));
  const withEffort = autoJob('cheapest', {budget_v1: {effort: 'low'}});
  withEffort.requirements.capabilities = [...withEffort.requirements.capabilities, 'budget_v1'];
  assert.throws(() => p.signEnvelope('job', withEffort, keys[0]), 'an explicit effort and an automatic choice are two answers to one question');
  const withModel = autoJob(); withModel.requirements.model = {any_of: ['example-model']};
  assert.throws(() => p.signEnvelope('job', withModel, keys[0]));
  const budgetOnly = autoJob('strongest', {budget_v1: {max_list_usd: 5}});
  budgetOnly.requirements.capabilities = [...budgetOnly.requirements.capabilities, 'budget_v1'];
  assert.equal(p.verifyEnvelope('job', p.signEnvelope('job', budgetOnly, keys[0]), pub[0]).ok, true, 'a dollar cap still applies to an automatic choice');
});

test('a validator that predates the choice refuses the job instead of running it as an explicit one', () => {
  const signed = rawSign('job', autoJob());
  const recognized = ['patch-output', 'verify_v1', 'results_v1', 'parent_link_v1', 'working_directory_v1', 'source_manifest_v1', 'source_project_name_v1', 'filtered_git_v1', 'budget_v1', MODEL_EFFORT_PAIRS_CAPABILITY];
  const before = p.validateRequirements(signed.payload.requirements, {recognizedCapabilities: recognized});
  assert.equal(before.ok, false);
  assert.equal(before.code, 'unsupported_version');
  assert.equal(p.validateRequirements(signed.payload.requirements).ok, true);
  // And the closed payload schema refuses the unknown field itself.
  const bare = clone(signed.payload); bare.requirements.capabilities = bare.requirements.capabilities.filter(c => c !== CAP);
  assert.equal(p.verifyEnvelope('job', rawSign('job', bare), pub[0]).ok, false);
});

test('a lender without the capability, or with no configured pair, cannot satisfy an automatic job', () => {
  const payload = autoJob(), req = payload.requirements;
  const ad = {harnesses: ['codex'], models: ['example-model'], capabilities: [...req.capabilities, MODEL_EFFORT_PAIRS_CAPABILITY],
    egress: [req.egress], enforced_limits: Object.keys(req.limits), max_limits: {...req.limits},
    model_efforts: [{harness: 'codex', model: 'example-model', effort: 'low'}]};
  assert.equal(p.canSatisfy(req, ad, {job: payload}).ok, true);
  assert.deepEqual(p.canSatisfy(req, {...ad, capabilities: ad.capabilities.filter(c => c !== CAP)}, {job: payload}).unmet, ['capability:' + CAP]);
  const legacy = {...ad}; delete legacy.model_efforts;
  assert.ok(p.canSatisfy(req, legacy, {job: payload}).unmet.includes('model_effort'), 'no configured pair, nothing to choose from');
  const wrongHarness = {...req, harness: ['other']};
  assert.equal(p.canSatisfy(wrongHarness, ad, {job: {...payload, requirements: wrongHarness}}).ok, false);
});

test('the host advertises the capability, and a result receipt that records the choice must match the job', () => {
  assert.ok(HOST_CAPABILITIES.includes(CAP));
  const result = clone(golden.objects.result.envelope.payload);
  const choice = {intent: 'cheapest', model: 'example-model', effort: 'low', rule_version: 'auto-run-v1', reason: 'lowest_list_price', capped: false, pricing_revision: 'prices-sha256:' + 'a'.repeat(64)};
  result.receipt.auto_run_v1 = choice;
  result.receipt.capabilities_applied = [...result.receipt.capabilities_applied, CAP];
  assert.equal(p.verifyEnvelope('result', p.signEnvelope('result', result, keys[1]), pub[1]).ok, true);
  const mismatch = clone(result); mismatch.receipt.capabilities_applied = mismatch.receipt.capabilities_applied.filter(c => c !== CAP);
  assert.throws(() => p.signEnvelope('result', mismatch, keys[1]), 'a recorded choice and the capability come together');
  for (const bad of [{...choice, intent: 'best'}, {...choice, effort: 'ultra'}, {...choice, extra: 1}, {...choice, capped: 'no'}]) {
    const broken = clone(result); broken.receipt.auto_run_v1 = bad;
    assert.throws(() => p.signEnvelope('result', broken, keys[1]));
  }
});
