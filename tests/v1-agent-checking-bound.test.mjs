import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { HARNESS_ADAPTERS } from '../lib/harnesses/index.mjs';

const native = HARNESS_ADAPTERS.find(a => a.spec.harness_id === 'codex');
const codexRow = async app => (await api(app, '/api/agents'))[0];

// A proxy identity probe that never answers while the test runs, and a clock the test moves. After the display bound
// (20 s of that clock) an account whose check is still running must not keep saying "Checking": the work may go on, but the
// row says what the blockers say, that Faravan has not confirmed it and a new check can be started.
test('an account whose check outlasts the display bound stops saying Checking', {timeout: 120000}, async t => {
  const held = [];
  t.after(() => { for (const pending of held.splice(0)) pending(null); });
  const clock = {t: 1_000};
  const f = await appFixture(t);
  const {lender, circle} = await f.connect({
    adapters: [{...native, installed: true, signedIn: false}],
    monotonic: () => clock.t,
    signInProbeTimeoutMs: 100,
    lendingSignInProbe: async () => ({signedIn: null, secretPresent: true}),
    lendingIdentityProbe: () => new Promise(resolve => held.push(resolve)),
  });
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await waitFor(() => held.length === 1, 'the held proxy probe');
  const during = await waitFor(async () => { const r = await codexRow(lender.app); return r.signInState === 'Checking' ? r : null; }, 'Checking while the probe is young');
  assert.equal(during.checking === true || during.signInState === 'Checking', true);
  clock.t += 25_000;
  const later = await codexRow(lender.app);
  assert.notEqual(later.signInState, 'Checking', 'a check older than the display bound is not shown as running');
});
