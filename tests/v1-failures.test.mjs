import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { readFile } from 'node:fs/promises';
import { classify, newErrorRef, FAILURE_CODES } from '../lib/v1/failures.mjs';

const known = new Set(FAILURE_CODES);
const sources = [
  'lib/v1/lender.mjs', 'lib/v1/store.mjs', 'lib/docker-backend.mjs',
  'lib/executor.mjs', 'lib/v1/app.mjs',
];
function sourceCodes(source) {
  const codes = new Set();
  // Include the backend helper as well as error('…') and code:'…'.
  for (const match of source.matchAll(
    /\b(?:error|policyError|fail)\s*\(\s*['"]([a-z][a-z0-9_]*)['"]|\bcode\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g,
  )) codes.add(match[1] ?? match[2]);
  // Store's public error vocabulary also flows through need(condition, code).
  const stable = source.match(/const stable\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (stable) for (const match of stable[1].matchAll(/['"]([a-z][a-z0-9_]*)['"]/g)) codes.add(match[1]);
  // Lender-generated reasons are codes too.
  for (const match of source.matchAll(/\breason\s*:\s*['"]([a-z][a-z0-9_]*)['"]/g)) codes.add(match[1]);
  // Parse property values so a fallback cannot cross into a sibling field. Nested
  // calls, objects and commas are legal inside the expression before ?? .
  const fallback = node => {
    if (node?.type === 'LogicalExpression') {
      if (node.operator === '??' && typeof node.right.value === 'string' && /^[a-z][a-z0-9_]*$/.test(node.right.value)) codes.add(node.right.value);
      fallback(node.left);fallback(node.right);
    } else if (node?.type === 'ConditionalExpression') {
      fallback(node.consequent);fallback(node.alternate);
    }
  };
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Property' && !node.computed && ['code','releaseCode'].includes(node.key.name ?? node.key.value)) fallback(node.value);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(parse(source, {ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true}));
  return [...codes].sort();
}
// The backend's recovery evidence event does not classify a job failure.
const diagnosticOnlyCodes = new Set(['listing_retry_recovered']);
const missing = source => sourceCodes(source).filter(code => !known.has(code) && !diagnosticOnlyCodes.has(code));

test('circle selection and owner settings refusals belong to the request',()=>{
  for(const code of ['circle_required','origin_required','not_owner','invalid_circle_profile','result_unavailable']){
    const row=classify(code,'before_start','circle-settings');
    assert.equal(row.owner,'request');assert.equal(row.outcome,'failed');
    assert.deepEqual(row.counts,{job:false,minutes:'none'});
  }
});

test('every literal failure code in the job-path sources has an explicit row', async () => {
  for (const path of sources) {
    const source = await readFile(new URL('../' + path, import.meta.url), 'utf8');
    assert.deepEqual(missing(source), [], path + ': add a reviewed failure row');
  }
});
test('source guard rejects a new code instead of accepting the fallback', () => {
  for (const source of [
    "throw error('brand_new_failure')",
    "return { code: 'brand_new_failure' }",
    'throw policyError("brand_new_failure", "details")',
    "const stable = new Set(['brand_new_failure'])",
    "emit('failed', {reason:'brand_new_failure'})",
    "return {code: e.code ?? 'brand_new_failure'}",
    "return {code: lookup(a, b) ?? 'brand_new_failure'}",
    "return {code: lookup({a: 1}) ?? 'brand_new_failure'}",
    "return {code: failed ? e.code ?? 'brand_new_failure' : null}",
  ]) assert.deepEqual(missing(source), ['brand_new_failure']);
  assert.deepEqual(sourceCodes('return {code: 0};'), []);
  // A fallback belongs to this property, not a later property or nested object.
  for (const source of [
    "return {code: fault.code, lendingMode: mode ?? 'ask'}",
    "return {failure: {code: fault.code}, lendingMode: mode ?? 'ask'}",
    "return {code: fault.code, circles: circles.map(c=>({mode: modes[c.id] ?? 'ask'}))}",
  ]) assert.deepEqual(sourceCodes(source), []);
  assert.deepEqual(missing("return {releaseCode: fault.code ?? 'brand_new_failure'}"), ['brand_new_failure']);
  assert.deepEqual(missing("backend._onDiagnostic({code:'listing_retry_recovered'})"), []);
});

const cases = [
  // Confirming an action belongs to the requester; ending a hold is the lender's choice.
  ['confirmation_required', 'before_start', 'request', 'failed', false, 'none', 'request'],
  ['hold_release_requested', 'before_start', 'lender', 'requeue', false, 'none', 'lender_stop'],
  ['update_in_progress', 'before_start', 'lender', 'requeue', false, 'none', 'lender_stop'],
  ['update_in_progress', 'run', 'lender', 'uncertain', false, 'actual', 'lender_stop'],
  ['prompt_unavailable','before_start','platform','requeue',false,'none','platform'],
  ['prompt_unavailable','run','platform','uncertain',false,'actual','platform'],
  ['not_your_job','before_claim','request','failed',false,'none','request'],
  ['followup_base_unavailable','before_claim','request','failed',false,'none','request'],
  ['followup_result_changed','before_claim','request','failed',false,'none','request'],
  ['sandbox_backend_unavailable', 'prepare', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['git_source_unsupported', 'prepare', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['input_copy_failed', 'prepare', 'platform', 'requeue', false, 'none', 'platform'],
  ['git_source_transfer_failed', 'prepare', 'platform', 'requeue', false, 'none', 'platform'],
  ['sandbox_stop_failed', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['meter_unavailable', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['pace50_stop_unrecorded', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['output_path_invalid', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['output_copy_failed', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['output_missing', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['output_invalid', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['sandbox_not_ready', 'before_start', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['pace50_disabled', 'before_start', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['unreadable_window_origin', 'before_start', 'platform', 'requeue', false, 'none', 'platform'],
  ['readiness_changed', 'before_start', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['execution_failed', 'prepare', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['prepare_failed', 'prepare', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['agent_signed_out', 'run', 'lender', 'uncertain', false, 'actual', 'lender_setup'],
  ['stopped_by_lender', 'run', 'lender', 'uncertain', false, 'actual', 'lender_stop'],
  ['paused', 'run', 'lender', 'uncertain', false, 'actual', 'lender_stop'],
  ['lease_expired', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['lease_uncertain', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['network_error', 'prepare', 'platform', 'requeue', false, 'none', 'platform'],
  ['sandbox_crash', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['execution_failed', 'run', 'job', 'failed', true, 'actual', 'job'],
  ['execution_observation_failed', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['wall_timeout', 'run', 'job', 'failed', true, 'actual', 'job'],
  ['output_too_large', 'result', 'job', 'failed', true, 'actual', 'job'],
  ['tests_failed', 'run', 'job', 'failed', true, 'actual', 'job'],
  ['requirements_unsupported', 'before_claim', 'request', 'failed', false, 'none', 'request'],
  ['invalid_job_spec', 'prepare', 'request', 'failed', false, 'none', 'request'],
  ['policy_unenforceable', 'before_start', 'request', 'failed', false, 'none', 'request'],
  ['job_expired', 'before_claim', 'request', 'expired', false, 'none', 'request'],
  ['candidate_missing', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['candidate_invalid', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['result_kind_mismatch', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['meter_unavailable', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['git_commit_unverified', 'result', 'platform', 'failed', false, 'actual', 'result_delivery'],
  ['sandbox_start_failed', 'prepare', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['sandbox_ready_timeout', 'prepare', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['agent_exit_nonzero', 'run', 'job', 'failed', true, 'actual', 'job'],
  ['agent_group_not_ceased', 'run', 'job', 'failed', true, 'actual', 'job'],
  ['agent_run_failed', 'run', 'job', 'failed', true, 'actual', 'job'],
  ['entrypoint_start_failed', 'start', 'lender', 'requeue', false, 'none', 'lender_setup'],
  ['approval_denied', 'before_start', 'lender', 'requeue', false, 'none', 'lender_stop'],
  ['approval_timeout', undefined, 'lender', 'requeue', false, 'none', 'lender_stop'],
  // T21 (S3.1c): after the agent started, an interruption never requeues by itself.
  ['pace50_stop_unrecorded', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['pace50_stop_unrecorded', undefined, 'platform', 'uncertain', false, 'actual', 'platform'],
  ['unreadable_window_origin', 'before_start', 'platform', 'requeue', false, 'none', 'platform'],
  ['unreadable_window_origin', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['host_config_unreadable', 'before_start', 'platform', 'requeue', false, 'none', 'platform'],
  ['host_config_unreadable', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['sandbox_cleanup_unverified', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['sandbox_cleanup_unverified', 'before_start', 'platform', 'requeue', false, 'none', 'platform'],
  ['cessation_unverified', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['cessation_unverified', 'before_start', 'platform', 'requeue', false, 'none', 'platform'],
  ['lease_uncertain', 'before_start', 'platform', 'requeue', false, 'none', 'platform'],
  ['lease_uncertain', undefined, 'platform', 'uncertain', false, 'actual', 'platform'],
  ['restart_interrupted', 'run', 'platform', 'uncertain', false, 'actual', 'platform'],
  ['delivery_delayed', 'result', 'platform', 'delayed', false, 'actual', 'result_delivery'],
  ['job_running', 'before_claim', 'request', 'failed', false, 'none', 'request'],
];
for (const [code, phase, owner, outcome, job, minutes, key] of cases) {
  test(code + ' at ' + phase, () => {
    const {error_id, ...policy} = classify(code, phase);
    assert.match(error_id, /^SPK-[A-Z2-7]{4}$/);
    assert.deepEqual(policy, {
      owner, outcome, counts:{job, minutes},
      borrower_key:'failure.' + key + '.borrower',
      lender_key:owner === 'request' ? null : 'failure.' + key + '.lender',
    });
  });
}
test('all rows refund non-job failures and have closed, private-data-free keys', () => {
  assert.equal(known.size, FAILURE_CODES.length);
  for (const code of FAILURE_CODES) {
    const result = classify(code, 'run');
    assert.equal(result.counts.job, result.owner === 'job', code);
    assert.match(result.borrower_key, /^failure\.(lender_setup|lender_stop|platform|job|request|result_delivery)\.borrower$/);
    assert.ok(result.lender_key === null || /^failure\.[a-z_]+\.lender$/.test(result.lender_key));
    assert.deepEqual(classify(code, 'before_start').counts, {job:false, minutes:'none'});
  }
});
test('unknown, missing and prototype-named codes requeue only before the agent started, and are uncertain after', () => {
  for (const code of ['new_failure', '__proto__', 'constructor', 'toString', null, undefined, {}, '/private/account']) {
    const {error_id, ...policy} = classify(code, 'run');
    assert.match(error_id, /^SPK-[A-Z2-7]{4}$/);
    assert.deepEqual(policy, {
      owner:'platform', outcome:'uncertain', counts:{job:false, minutes:'actual'},
      borrower_key:'failure.platform.borrower', lender_key:'failure.platform.lender',
    });
    assert.equal(classify(code).outcome, 'uncertain', 'no phase: the agent may have started');
    const {error_id: prepareId, ...prepared} = classify(code, 'prepare');
    assert.match(prepareId, /^SPK-[A-Z2-7]{4}$/);
    assert.deepEqual(prepared, {
      owner:'platform', outcome:'requeue', counts:{job:false, minutes:'none'},
      borrower_key:'failure.platform.borrower', lender_key:'failure.platform.lender',
    });
  }
});
test('every code has a class: only a failure before the agent started requeues (T21)', () => {
  const closed = new Set(['failed', 'expired', 'cancelled', 'delayed', 'uncertain']);
  for (const code of FAILURE_CODES) {
    for (const phase of ['run', 'result', undefined]) {
      const outcome = classify(code, phase).outcome;
      const ranNothing = classify(code, phase).counts.minutes === 'none';
      assert.ok(closed.has(outcome) || (outcome === 'requeue' && ranNothing), code + ' at ' + phase + ' is ' + outcome);
    }
    for (const phase of ['before_claim', 'before_start', 'prepare', 'start'])
      assert.notEqual(classify(code, phase).outcome, 'uncertain', code + ' before the agent started cannot be uncertain');
  }
  assert.equal(classify('delivery_delayed', 'result').outcome, 'delayed');
});
test('results are fresh and modifying one cannot corrupt later classifications', () => {
  const original = classify('wall_timeout', 'run');
  original.owner = 'lender'; original.counts.job = false;
  assert.equal(classify('wall_timeout', 'run').owner, 'job');
  assert.deepEqual(classify('wall_timeout', 'run').counts, {job:true, minutes:'actual'});
});

test('short IDs are stable per code and job across borrower/lender phases', () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  const borrower = classify('execution_failed', 'run', digest);
  const lender = classify('execution_failed', 'prepare', digest);
  assert.match(borrower.error_id, /^SPK-[A-Z2-7]{4}$/);
  assert.equal(borrower.error_id, lender.error_id);
  assert.equal(borrower.error_id, classify('execution_failed', 'result', digest).error_id);
  assert.notEqual(borrower.error_id, classify('execution_failed', 'run', 'sha256:' + 'b'.repeat(64)).error_id);
  assert.notEqual(borrower.error_id, classify('wall_timeout', 'run', digest).error_id);
  // Keep policy differences even when the correlation label is the same.
  assert.equal(borrower.owner, 'job');
  assert.equal(lender.owner, 'lender');
});

test('error IDs encode the first 20 SHA-256 bits with RFC 4648 base32', () => {
  const code = 'wall_timeout', digest = 'sha256:' + 'c'.repeat(64);
  const hex = createHash('sha256').update(JSON.stringify([code, digest])).digest('hex');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const expected = Number.parseInt(hex.slice(0, 5), 16).toString(32).padStart(4, '0')
    .split('').map(char => alphabet[Number.parseInt(char, 32)]).join('');
  assert.equal(classify(code, 'run', digest).error_id, 'SPK-' + expected);
  // Delimiter-like input must not alias another tuple.
  assert.notEqual(classify('ab', 'run', 'c').error_id, classify('a', 'run', 'bc').error_id);
});

test('missing/invalid digests are code-only fallbacks and never stringify objects', () => {
  const hostile = {toString() {throw Error('must not stringify');},
    toJSON() {throw Error('must not serialize');}};
  const expected = classify('wall_timeout', 'run', '').error_id;
  for (const digest of [undefined, null, {}, [], 42, hostile]) {
    assert.equal(classify('wall_timeout', 'run', digest).error_id, expected);
  }
  assert.equal(classify(hostile, 'run', hostile).error_id, classify(undefined).error_id);
});

test('IDs do not expose codes, full job digests, or diagnostic input', () => {
  const digest = 'sha256:' + 'd'.repeat(64);
  const code = '/private/account diagnostic';
  const result = classify(code, 'run', digest);
  assert.match(result.error_id, /^SPK-[A-Z2-7]{4}$/);
  assert.ok(!JSON.stringify(result).includes(digest));
  assert.ok(!JSON.stringify(result).includes(code));
  assert.equal(result.borrower_key, 'failure.platform.borrower');
  const first = result.error_id;
  result.error_id = 'changed';
  assert.equal(classify(code, 'run', digest).error_id, first);
});

test('newErrorRef is six random base32 characters', () => {
  const refs = new Set(Array.from({ length: 50 }, newErrorRef));
  for (const ref of refs) assert.match(ref, /^[A-Z2-7]{6}$/);
  assert.ok(refs.size > 40);
});
