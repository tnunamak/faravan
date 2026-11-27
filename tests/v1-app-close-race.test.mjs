import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, bounded, waitFor } from './helpers/v1-app-fixture.mjs';

// Regression: a lending start that is still waiting when its app closes must not start a lender
// that nothing will stop. The start resumed after close() had already aborted the controller, so
// the lender kept claiming from the coordinator for the rest of the process (found in the full
// Node suite under load: the test file did not exit).
test('a lending start that resumes after its app closes starts no lender', { timeout: 60000 }, async t => {
  const f = await appFixture(t), { lender, circle } = await f.connect();
  await api(lender.app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(lender.app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(lender.app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });

  // Hold the start inside device.client() until the app is closing, then let it continue.
  const device = lender.app.device, client = device.client.bind(device);
  let entered = false, release, claims = 0;
  device.client = async (...args) => {
    entered = true;
    await new Promise(resolve => { release = resolve; });
    const real = await client(...args);
    const claimNext = real.claimNext;
    real.claimNext = (...values) => { claims++; return claimNext(...values); };
    return real;
  };

  const starting = api(lender.app, '/api/lending/on', { method: 'POST', body: { circle: circle.id }, status: 409 }).catch(error => error);
  await waitFor(() => entered, 'lending start reached the device client');
  await bounded(lender.app.close(), 'close during a lending start');
  release();
  await starting;

  const claimsAtClose = claims;
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(claims, claimsAtClose, 'no lender claims the coordinator after its app closed');
});

test("concurrent close callers all wait until the app lock is released",{timeout:60000},async t=>{
 const f=await appFixture(t),owner=await f.start("owner");
 const first=owner.app.close();t.after(()=>first);
 await owner.app.close();
 const reopened=await f.start("owner");
 assert.ok(reopened.app.origin);
 await first;
});
