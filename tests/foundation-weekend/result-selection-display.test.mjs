import test from 'node:test';
import assert from 'node:assert/strict';
import {howItRanVM} from '../../ui/v1/src/view-models.mjs';

import {readFile} from 'node:fs/promises';
import {signEnvelope, verifyEnvelope, privateKeyFromSeed, exportPublicKey,
  validateModelEffortPairs} from '../../lib/protocol/index.mjs';

const vectors = JSON.parse(await readFile(
  new URL('../../docs/protocol/vectors/golden.json', import.meta.url), 'utf8'));
// Only repository TEST-ONLY synthetic vector seeds; no account or roster authority.
// All fixtures are in memory: no native stores, writes, network or cleanup resources.
function signingKey(kind) {
  const vector = vectors.objects[kind];
  const key = vectors.keys[vector.key_index];
  const privateKey = privateKeyFromSeed(Buffer.from(key.seed_hex, 'hex'));
  assert.equal(exportPublicKey(privateKey), key.public_key);
  return {privateKey, publicKey: key.public_key};
}
function signedResult(overrides = {}) {
  const payload = structuredClone(vectors.objects.result.envelope.payload);
  Object.assign(payload.receipt, {model: 'provider-model'}, overrides);
  if (payload.receipt.auto_run_v1) {
    payload.receipt.capabilities_applied = [...new Set([
      ...payload.receipt.capabilities_applied, 'auto_run_v1'])];
  }
  const {privateKey, publicKey} = signingKey('result');
  // signEnvelope performs the real schema validation before signing.
  const envelope = signEnvelope('result', payload, privateKey);
  const verified = verifyEnvelope('result', envelope, publicKey);
  assert.equal(verified.ok, true, 'signed positive fixture must verify before display');
  return {envelope, verified, publicKey, privateKey};
}
function receipt(overrides = {}) {
  return signedResult(overrides).verified.payload.receipt;
}
function selection(overrides = {}) {
  return {intent: 'cheapest', model: 'lender-model', effort: 'high',
    rule_version: 'fixture-v1', reason: 'fixture', capped: false,
    pricing_revision: 'fixture-v1', ...overrides};
}
const autoLines = (job, options) => howItRanVM(job, options).lines.filter(line =>
  /^(Asked for:|Requested for this run:|Provider reported:|Provider effort:)/.test(line.text));
const texts = (job, options) => autoLines(job, options).map(line => line.text);

test('no receipt keeps lender selection and provider evidence unknown', () => {
  assert.deepEqual(texts({requestedAutoRun: 'cheapest'}), [
    'Asked for: Cheapest that fits',
    'Requested for this run: not chosen yet',
    'Provider reported: nothing yet',
    'Provider effort: not reported',
  ]);
  assert.deepEqual(autoLines({requestedAutoRun: 'cheapest'}).map(line => line.by),
    ['your request', 'the lender', 'the provider', 'the provider']);
});

test('missing or unknown intent does not fabricate an automatic choice', () => {
  for (const requestedAutoRun of [undefined, null, '', 'unsupported']) {
    assert.deepEqual(texts({requestedAutoRun}), []);
  }
});

test('lender selection is not promoted to provider-reported model or effort', () => {
  const job = {requestedAutoRun: 'cheapest',
    receipt: receipt({auto_run_v1: selection()})};
  assert.deepEqual(texts(job), [
    'Asked for: Cheapest that fits',
    'Requested for this run: `lender-model` / high effort',
    'Provider reported: `provider-model`',
    'Provider effort: not reported',
  ]);
  assert.equal(autoLines(job)[1].by, 'chosen by the lender');
});

test('receipt intent supports strongest and reports lender capping separately', () => {
  assert.deepEqual(texts({receipt: receipt({auto_run_v1:
    selection({intent: 'strongest', effort: 'max', capped: true})})}), [
    'Asked for: Strongest offered',
    'Requested for this run: `lender-model` / max effort (held to the lender’s effort limit)',
    'Provider reported: `provider-model`',
    'Provider effort: not reported',
  ]);
});

test('requested intent mismatch never displays the other saved selection', () => {
  assert.deepEqual(texts({requestedAutoRun: 'strongest',
    receipt: receipt({auto_run_v1: selection()})}), [
    'Asked for: Strongest offered',
    'Requested for this run: not chosen yet',
    'Provider reported: `provider-model`',
    'Provider effort: not reported',
  ]);
});

test('schema-supported absent selection and null provider model remain unknown', () => {
  assert.deepEqual(texts({requestedAutoRun: 'cheapest', receipt: receipt({model: null})}), [
    'Asked for: Cheapest that fits',
    'Requested for this run: not chosen yet',
    'Provider reported: model not reported',
    'Provider effort: not reported',
  ]);
});

test('legacy provider model does not imply an automatic or lender-selected pair', () => {
  const result = howItRanVM({receipt: receipt()});
  assert.deepEqual(texts({receipt: receipt()}), []);
  assert.ok(result.lines.some(line => line.text.includes('provider-model')));
});

test('compact display retains the same evidence separation without mutating input', () => {
  const job = {requestedAutoRun: 'cheapest',
    receipt: receipt({model: null, auto_run_v1: selection()})};
  const original = structuredClone(job);
  assert.deepEqual(texts(job, {compact: true}), texts(job));
  assert.deepEqual(job, original);
});

test('golden job and result remain valid schema/crypto positive controls', () => {
  for (const kind of ['job', 'result']) {
    const vector = vectors.objects[kind];
    const {privateKey, publicKey} = signingKey(kind);
    const original = structuredClone(vector.envelope);
    assert.equal(verifyEnvelope(kind, original, publicKey).ok, true);
    assert.deepEqual(signEnvelope(kind, original.payload, privateKey), original);
    assert.deepEqual(vector.envelope, original, 'golden input remains untouched');
  }
});

test('signed receipt changes are detected even after a valid verification', () => {
  const {envelope, publicKey} = signedResult({auto_run_v1: selection()});
  const changed = structuredClone(envelope);
  changed.payload.receipt.model = 'different-provider-model';
  assert.equal(verifyEnvelope('result', changed, publicKey).ok, false);
  assert.equal(verifyEnvelope('result', envelope, publicKey).ok, true);
});

test('real tuple validator accepts exact and harness-bound configured pairs', () => {
  const options = {models: ['example-model'], harnesses: ['codex']};
  const pair = {harness: 'codex', model: 'example-model', effort: 'low'};
  assert.equal(validateModelEffortPairs([pair], options).ok, true);
  assert.equal(validateModelEffortPairs([{model: 'example-model', effort: 'low'}],
    {...options, harness: 'codex'}).ok, true);
  assert.equal(validateModelEffortPairs([pair,
    {...pair, effort: 'high'}], options).ok, true, 'distinct efforts are distinct tuples');
});

test('real tuple validator rejects duplicates, missing effort and unconfigured values', () => {
  const options = {models: ['example-model'], harnesses: ['codex']};
  const pair = {harness: 'codex', model: 'example-model', effort: 'low'};
  assert.equal(validateModelEffortPairs([pair], options).ok, true, 'positive oracle');
  for (const pairs of [
    [pair, {...pair}],
    [{harness: 'codex', model: 'example-model'}],
    [{...pair, model: 'not-configured'}],
    [{...pair, harness: 'not-configured'}],
    [{...pair, effort: 'unsupported'}],
    [{...pair, effort: null}],
  ]) assert.equal(validateModelEffortPairs(pairs, options).ok, false);
  assert.equal(validateModelEffortPairs([pair], {...options, harness: 'codex'}).ok,
    false, 'harness-bound tuples must omit the harness field');
});

test('real signed-result validator rejects incompatible auto selection, not a display fallback', () => {
  const positive = signedResult({auto_run_v1: selection()});
  assert.equal(positive.verified.ok, true);
  for (const mutate of [
    payload => {payload.receipt.auto_run_v1.effort = 'unsupported';},
    payload => {delete payload.receipt.auto_run_v1.effort;},
    payload => {delete payload.receipt.auto_run_v1.rule_version;},
    payload => {payload.receipt.auto_run_v1.model = '';},
    payload => {payload.receipt.capabilities_applied =
      payload.receipt.capabilities_applied.filter(value => value !== 'auto_run_v1');},
    // Closed receipt schema has no top-level effort or effective/requested fields.
    payload => {payload.receipt.effort = 'high';},
    payload => {payload.receipt.effective_model = 'invented';},
  ]) {
    const payload = structuredClone(positive.envelope.payload);
    mutate(payload);
    assert.throws(() => signEnvelope('result', payload, positive.privateKey));
    assert.equal(verifyEnvelope('result',
      {...positive.envelope, payload}, positive.publicKey).ok, false);
  }
});
