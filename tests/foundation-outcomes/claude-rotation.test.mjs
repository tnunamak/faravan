// Conservative partial slice: 429 defers exchange; this is NOT Claude rotation qualification.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageTokenRefresher} from '../../lib/v1/usage-token-refresh.mjs';

for (const kind of ['seconds', 'date']) {
  test(`conservative refresh 429: full ${kind} deadline, no in-flight retry`, async () => {
    let time = Date.UTC(2026, 0, 1);
    const deadline = time + 3600_000;
    let calls = 0, sleeps = 0, releases = 0;
    const refresher = createUsageTokenRefresher({
      now: () => time,
      backoffMs: 1000,
      records: {claude: {refresh: {
        url: 'https://synthetic.invalid/token', hosts: ['synthetic.invalid'], clientId: 'fixture'
      }}},
      store: {
        credential: async () => ({kind: 'oauth', refresh: 'synthetic-only', generation: 'g1', expiresAt: 0}),
        stagedRefresh: async () => null,
        lockRefresh: async () => () => { releases++; },
        stageRefresh: async () => { assert.fail('429 must not stage rotation'); },
        rotate: async () => { assert.fail('429 must not publish generation'); }
      },
      reader: {verify: async () => { assert.fail('429 must not verify a replacement'); }},
      sleep: async () => { sleeps++; },
      fetchImpl: async () => {
        calls++;
        return calls === 1
          ? {status: 429, headers: {get: () => kind === 'seconds' ? '3600' : new Date(deadline).toUTCString()}}
          : {status: 400, json: async () => ({error: 'invalid_grant'})};
      }
    });
    const first = await refresher.refresh('claude', {force: true});
    assert.equal(first.ok, false);
    assert.equal(first.account_state, 'retry');
    assert.equal(calls, 1);
    assert.equal(sleeps, 0);
    assert.equal(releases, 1);
    time = deadline - 1;
    const deferred = await refresher.refresh('claude', {force: true});
    assert.equal(deferred.reason, 'refresh_backoff');
    assert.equal(calls, 1);
    time = deadline;
    const rejected = await refresher.refresh('claude', {force: true});
    assert.equal(rejected.reason, 'invalid_grant');
    assert.equal(calls, 2);
    assert.equal(releases, 2);
  });
}
