import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsageHostReader } from '../../lib/v1/usage-host-reader.mjs';

// Conservative assumption: a profile UUID must be a nonblank string with no
// surrounding whitespace. This exercises host verification, not enrollment.
const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
function setup(doc, afterProfile) {
  const calls = [];
  const reader = createUsageHostReader({
    store: {},
    records: { claude: { parser: 'claude', hosts: ['fixture.invalid'], subscriptionKinds: ['oauth'],
      usage: { url: 'https://fixture.invalid/usage', headers: {}, keep: {} },
      identity: { url: 'https://fixture.invalid/profile', headers: {} } } },
    now: () => 100,
    fetchImpl: async (url, options) => {
      calls.push({ url, redirect: options.redirect });
      return { status: 200, json: async () => {
        if (url.endsWith('/profile')) { afterProfile?.(); return doc; }
        return {};
      } };
    },
  });
  return { reader, calls };
}
const verify = (reader, signal) => reader.verify({
  provider: 'claude', accountKey: 'synthetic-account', bearer: 'synthetic-only', kind: 'oauth', signal,
});

test('host verification refuses blank or malformed UUID; a label/email cannot substitute', async () => {
  for (const uuid of ['', ' ', '\t\n', ' ' + first, first + ' ', 1, {}, [first, second], null, undefined]) {
    const { reader } = setup({ account: { uuid, email: 'test@example.invalid', name: 'Claude' } });
    const response = await verify(reader);
    assert.equal(response.ok, false);
    assert.equal(response.identity_sha256_16, null);
  }
  for (const doc of [{}, { account: [] }, { account: 'Claude' }, { accounts: [{ uuid: first }, { uuid: second }] }]) {
    assert.equal((await verify(setup(doc).reader)).ok, false);
  }
});
test('authenticated UUIDs give distinct stable hashes, without publishing raw subjects', async () => {
  const a = await verify(setup({ account: { uuid: first } }).reader);
  const b = await verify(setup({ account: { uuid: second } }).reader);
  const again = await verify(setup({ account: { uuid: first } }).reader);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.match(a.identity_sha256_16, /^[a-f0-9]{16}$/);
  assert.notEqual(a.identity_sha256_16, b.identity_sha256_16);
  assert.equal(a.identity_sha256_16, again.identity_sha256_16);
  assert.doesNotMatch(JSON.stringify(a), new RegExp(first));
});
test('cancel before verification dispatches nothing; cancellation after response cannot succeed', async () => {
  const before = new AbortController();
  before.abort();
  const one = setup({ account: { uuid: first } });
  await assert.rejects(verify(one.reader, before.signal));
  assert.equal(one.calls.length, 0);
  const during = new AbortController();
  const two = setup({ account: { uuid: first } }, () => during.abort());
  await assert.rejects(verify(two.reader, during.signal));
});
