import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as probe from '../lib/v1/lending-probe.mjs';
import * as source from '../lib/v1/lending-pace50-source.mjs';

const T = Date.parse('2026-10-23T05:00:00Z');
// Fixture values are hashes, the only form that leaves the guest. None is an account identifier.
const H = { account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888' };
const OTHER_EMAIL = 'cccc2222dddd3333';
// An e-mail address, not the '@' in resource instance keys such as seven_day@<reset>.
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/;
const CLAUDE_AUTH = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
const GOOD = { status: 200, account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org };
const usageBody = () => ({
  five_hour: { utilization: 13, resets_at: '2026-10-23T10:00:00Z' },
  seven_day: { utilization: 3, resets_at: '2026-10-30T05:00:00Z' },
  extra_usage: { is_enabled: false },
});
const probeLine = (body, identity) => `{"faravan_probe":1,"status":200,"body":${JSON.stringify(body)}${identity === undefined ? '' : `,"identity":${JSON.stringify(identity)}`}}`;
const identityOf = ({ account_sha256_16, email_sha256_16, org_sha256_16 }) => ({ account_sha256_16, email_sha256_16, org_sha256_16 });
const windows = [
  { window_id: 'seven_day', window_minutes: 10080, used_pct: 3, resets_at: T + 7 * 86400000, observed_at: T, state: 'open' },
  { window_id: 'five_hour', window_minutes: 300, used_pct: 13, resets_at: T + 5 * 3600000, observed_at: T, state: 'open' },
];
const fact = (identity, observed_at = T) => ({ extra_usage: 'disabled', observed_at, guest_auth: CLAUDE_AUTH, identity });

test('the usage probe binds the account identity from its profile read to the same run as funding and windows', async () => {
  let reply;
  const p = probe.createLendingProbe({ runGuest: async () => reply, now: () => T });
  reply = { stdout: probeLine(usageBody(), GOOD) };
  assert.equal((await p.probe('claude')).ok, true);
  assert.deepEqual(p.funding('claude'), { extra_usage: 'disabled', observed_at: T, identity: identityOf(GOOD) });

  // A later run whose profile read failed carries no identity: nothing from the earlier run is inherited.
  reply = { stdout: probeLine(usageBody(), { status: 403 }) };
  await p.probe('claude');
  assert.deepEqual(p.funding('claude'), { extra_usage: 'disabled', observed_at: T, identity: null });
});

test('the identity read keeps only well-formed hashes, and no raw e-mail or identifier reaches the parsed result', () => {
  const ok = probe.parseProbeOutput('claude', probeLine(usageBody(), GOOD), T);
  assert.deepEqual(ok.identity, identityOf(GOOD));
  assert.equal(probe.parseProbeOutput('claude', probeLine(usageBody(), { ...GOOD, email_sha256_16: 'someone@example.com' }), T).identity, null);
  assert.equal(probe.parseProbeOutput('claude', probeLine(usageBody(), { ...GOOD, account_sha256_16: 'abc' }), T).identity, null);
  assert.equal(probe.parseProbeOutput('claude', probeLine(usageBody(), { status: 403 }), T).identity, null);
  assert.equal(probe.parseProbeOutput('claude', probeLine(usageBody()), T).identity, null, 'no identity field at all');
  const leaky = probe.parseProbeOutput('claude', probeLine(usageBody(), { ...GOOD, email: 'someone@example.com', uuid: 'raw-uuid' }), T);
  assert.doesNotMatch(JSON.stringify(leaky), EMAIL_SHAPED);
  assert.doesNotMatch(JSON.stringify(leaky), /raw-uuid/);
});

test('admission compares only a stable account id or an e-mail hash: a match admits, a mismatch or an unknown refuses', () => {
  const observed = identityOf(GOOD);
  assert.deepEqual(source.claudeAccountMatch(observed, { email_sha256_16: H.email }), { verified: true, account_id: H.account, reason: null });
  assert.deepEqual(source.claudeAccountMatch(observed, { account_sha256_16: H.account }), { verified: true, account_id: H.account, reason: null });
  assert.deepEqual(source.claudeAccountMatch(observed, { email_sha256_16: OTHER_EMAIL }), { verified: false, reason: 'identity_mismatch' });
  assert.deepEqual(source.claudeAccountMatch(observed, { account_sha256_16: '9999888877776666' }), { verified: false, reason: 'identity_mismatch' });
  assert.deepEqual(source.claudeAccountMatch(observed, null), { verified: false, reason: 'expected_identity_unknown' });
  assert.deepEqual(source.claudeAccountMatch(observed, {}), { verified: false, reason: 'expected_identity_unknown' });
  assert.deepEqual(source.claudeAccountMatch(null, { email_sha256_16: H.email }), { verified: false, reason: 'identity_unobserved' });
  assert.deepEqual(source.claudeAccountMatch({ email_sha256_16: H.email }, { email_sha256_16: H.email }),
    { verified: false, reason: 'identity_unobserved' }, 'a stable account id is required even when the e-mail matches');
});

test('a matched identity from the same run clears identity_unknown; the next missing fact is what refuses', async () => {
  const matched = source.createRealPace50Source({
    readings: async () => ({ windows }),
    funding: async () => fact(identityOf(GOOD)),
    expectedIdentity: async () => ({ email_sha256_16: H.email }),
  });
  const observation = await matched.observe({ provider: 'claude' });
  assert.deepEqual(observation.identity, { verified: true, account_id: H.account, reason: null });
  assert.deepEqual(source.paceInputFromObservation(observation, { now: T, context: {} }),
    { refuse: 'executor_unknown' }, 'identity passes; the account week and epoch now come from the same run, so the executor is the next unproven fact');
});

test('a mismatched identity refuses as identity_mismatch; an unknown one keeps identity_unknown, and the reason is named', async () => {
  const mismatch = source.createRealPace50Source({ readings: async () => ({ windows }),
    funding: async () => fact(identityOf(GOOD)), expectedIdentity: async () => ({ email_sha256_16: OTHER_EMAIL }) });
  const mismatched = await mismatch.observe({ provider: 'claude' });
  assert.deepEqual(mismatched.identity, { verified: false, reason: 'identity_mismatch' });
  assert.deepEqual(source.paceInputFromObservation(mismatched, { now: T, context: {} }), { refuse: 'identity_mismatch' },
    'a different account is a separate refusal, so the owner sees what to do and an unknown check never reads as theirs');

  const unexpected = source.createRealPace50Source({ readings: async () => ({ windows }),
    funding: async () => fact(identityOf(GOOD)), expectedIdentity: async () => null });
  assert.deepEqual((await unexpected.observe({ provider: 'claude' })).identity, { verified: false, reason: 'expected_identity_unknown' });

  const unobserved = source.createRealPace50Source({ readings: async () => ({ windows }),
    funding: async () => fact(null), expectedIdentity: async () => ({ email_sha256_16: H.email }) });
  assert.deepEqual((await unobserved.observe({ provider: 'claude' })).identity, { verified: false, reason: 'identity_unobserved' });

  const otherRun = source.createRealPace50Source({ readings: async () => ({ windows }),
    funding: async () => fact(identityOf(GOOD), T - 60000), expectedIdentity: async () => ({ email_sha256_16: H.email }) });
  assert.deepEqual((await otherRun.observe({ provider: 'claude' })).identity, { verified: false, reason: 'identity_unobserved' },
    'an identity from another probe run is not this run\'s identity');
});

test('no raw identifier reaches the observation or the pace input', async () => {
  const src = source.createRealPace50Source({ readings: async () => ({ windows }),
    funding: async () => fact(identityOf(GOOD)), expectedIdentity: async () => ({ email_sha256_16: H.email }) });
  const observation = await src.observe({ provider: 'claude' });
  assert.doesNotMatch(JSON.stringify(observation), EMAIL_SHAPED);
  assert.doesNotMatch(JSON.stringify(source.paceInputFromObservation(observation, { now: T, context: {} })), EMAIL_SHAPED);
});

// Sandpiper, 2026-11-01: the provider stopped sending a five-hour window once it closed, so the ledger kept the last five-hour
// reading from the day before. Every later probe then failed the same-run test and held as "account cannot be confirmed".
test('a window left over from an earlier run makes the roster incomplete; it does not make this run\'s identity unknown', async () => {
  const stale = [windows[0], { ...windows[1], resets_at: T - 3600000, observed_at: T - 86400000, state: 'unknown' }];
  const src = source.createRealPace50Source({ readings: async () => ({ windows: stale }),
    funding: async () => fact(identityOf(GOOD)), expectedIdentity: async () => ({ account_sha256_16: H.account }) });
  const observation = await src.observe({ provider: 'claude' });
  assert.deepEqual(observation.identity, { verified: true, account_id: H.account, reason: null });
  assert.equal(observation.complete, false);
  const failures = source.observationProofFailures(observation);
  assert.equal(failures.includes('identity_unknown'), false);
  assert.equal(failures.includes('funding_unknown'), false, 'funding is this run\'s fact too');
  assert.equal(failures.includes('resources_incomplete'), true);
  assert.deepEqual(source.paceInputFromObservation(observation, { now: T, context: {} }), { refuse: 'resources_incomplete' });
});

test('a Claude reply with "five_hour": null records the five-hour window as not open in the same run', async () => {
  const body = { five_hour: null, seven_day: { utilization: 6, resets_at: '2026-10-30T05:00:00Z' }, extra_usage: { is_enabled: false } };
  const parsed = probe.parseProbeOutput('claude', probeLine(body, GOOD), T);
  assert.deepEqual(parsed.readings.find(r => r.window_id === 'five_hour'),
    { window_id: 'five_hour', window_minutes: 300, used_pct: 0, resets_at: null, observed_at: T, state: 'not_open', source: 'probe' });
  const absent = probe.parseProbeOutput('claude', probeLine({ seven_day: body.seven_day }, GOOD), T);
  assert.equal(absent.readings.some(r => r.window_id === 'five_hour'), false, 'a missing key is not read as a closed window');
});
