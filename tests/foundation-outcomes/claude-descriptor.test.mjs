import assert from 'node:assert/strict';
import test from 'node:test';
import { PROVIDER_RECORDS } from '../../lib/v1/usage-provider-records.mjs';

// Conservative partial source-record coverage, NOT a ProviderDescriptor or
// production Claude adapter. Retains fv-outcome-baseline-provenance-1114.
// No refresh configuration/credential data is inspected or reconstructed.
test('partial Claude source contract: configured observation endpoints stay on their explicit HTTPS host', () => {
  const record = PROVIDER_RECORDS.claude;
  assert.deepEqual(record.hosts, ['api.anthropic.com']);
  for (const [entry, path] of [[record.usage, '/api/oauth/usage'], [record.identity, '/api/oauth/profile']]) {
    const url = new URL(entry.url);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.hostname, 'api.anthropic.com');
    assert.equal(url.pathname, path);
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.search, '');
    assert.equal(url.hash, '');
  }
  assert.deepEqual(record.subscriptionKinds, ['oauth', 'setup-token']);
  // An API key must not acquire subscription-usage capability by label alone.
  assert.equal(record.subscriptionKinds.includes('api_key'), false);
});

test('partial Claude source contract: nested allowlists and observation metadata cannot be redirected by consumers', () => {
  const record = PROVIDER_RECORDS.claude;
  const before = JSON.stringify({ hosts: record.hosts, usage: record.usage,
    identity: record.identity, subscriptionKinds: record.subscriptionKinds });
  const mutations = [
    () => { record.hosts.push('other.invalid'); },
    () => { record.usage.url = 'https://other.invalid/usage'; },
    () => { record.identity.url = 'https://other.invalid/profile'; },
    () => { record.usage.headers['anthropic-beta'] = 'changed'; },
    () => { record.usage.keep.five_hour.push('unexpected'); },
    () => { record.subscriptionKinds.push('api_key'); },
  ];
  for (const mutate of mutations) assert.throws(mutate, TypeError);
  assert.equal(JSON.stringify({ hosts: record.hosts, usage: record.usage,
    identity: record.identity, subscriptionKinds: record.subscriptionKinds }), before);
});
