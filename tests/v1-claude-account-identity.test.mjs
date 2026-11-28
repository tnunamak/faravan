import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as probe from '../lib/v1/lending-probe.mjs';

const T = Date.parse('2026-10-23T05:00:00Z');
// Fixture values are hashes, the only form that leaves the guest. None is an account identifier.
const H = { account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888' };

// An e-mail address, not the '@' in resource instance keys such as seven_day@<reset>.
const EMAIL_SHAPED = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/;

const GOOD = { status: 200, account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org };
const usageBody = () => ({
  five_hour: { utilization: 13, resets_at: '2026-10-23T10:00:00Z' },
  seven_day: { utilization: 3, resets_at: '2026-10-30T05:00:00Z' },
  extra_usage: { is_enabled: false },
});
const probeLine = (body, identity) => `{"faravan_probe":1,"status":200,"body":${JSON.stringify(body)}${identity === undefined ? '' : `,"identity":${JSON.stringify(identity)}`}}`;
const identityOf = ({ account_sha256_16, email_sha256_16, org_sha256_16 }) => ({ account_sha256_16, email_sha256_16, org_sha256_16 });

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

// Sandpiper, 2026-11-01: the provider stopped sending a five-hour window once it closed, so the ledger kept the last five-hour
// reading from the day before. Every later probe then failed the same-run test and held as "account cannot be confirmed".
