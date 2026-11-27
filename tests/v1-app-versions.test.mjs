import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api, syntheticBackend, waitFor } from './helpers/v1-app-fixture.mjs';

// P22: versions between the host and its members (BUILD-PLAN v4). The status says what waits and why; claims are held; the switch stays on.
const gitInput = circle => ({ circle: circle.id, git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), prompt: 'Synthetic task.', harness: 'codex' });
const checks = ['sbx_install', 'sbx_daemon', 'docker_login', 'network_policy'].map(name => ({ name, ok: true }));
const healthy = root => { const b = syntheticBackend(root, {}); b.probeCapabilities = async () => ({ available: true, preflight: { ok: true, checks } }); return b; };
async function lending(app, circle) {
  await api(app, '/api/lending/limits', { method: 'POST', body: { dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false } });
  await api(app, '/api/agents/codex', { method: 'POST', body: { useForLending: true } });
  await api(app, '/api/lending/mode', { method: 'POST', body: { circle: circle.id, mode: 'ask' } });
  await api(app, '/api/lending/on', { method: 'POST', body: { circle: circle.id } });
}

test('a member older than the host\'s minimum sees what to update, claims nothing, and keeps lending on', { timeout: 60000 }, async t => {
  const f = await appFixture(t);
  f.hostCapabilities = { faravan: '0.12.0', min_member: '0.12.0' };
  const { owner, lender, circle } = await f.connect({ backend: healthy(f.root), faravanVersion: '0.11.0', hostProfileMs: 50, blockerRecheckMs: 50 });
  await lending(lender.app, circle);
  await api(owner.app, '/api/jobs', { method: 'POST', body: gitInput(circle) });
  const status = await waitFor(async () => { const s = await api(lender.app, '/api/status'); return s.update?.required && s; }, 'the update is named');
  assert.deepEqual(status.update, { required: true, circle: 'Synthetic friends', needVersion: '0.12.0', haveVersion: '0.11.0' });
  assert.deepEqual([status.state, status.reason, status.intent.on], ['update', 'update_required', true]);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.deepEqual(await api(lender.app, '/api/approvals'), [], 'an out-of-date member claims nothing');
  // The host lowers its minimum (or the member updates): lending carries on by itself.
  f.hostCapabilities = { faravan: '0.12.0', min_member: '0.10.0' };
  const card = await waitFor(async () => (await api(lender.app, '/api/approvals'))[0], 'the job is claimed once the member is new enough', 30000);
  assert.ok(card);
  assert.equal((await api(lender.app, '/api/status')).update, null);
  assert.deepEqual(Object.keys((await api(lender.app, '/api/status')).host).sort(), ['faravan', 'lastReachedAt', 'minMember', 'reachable']);
});

test('a host older than this build needs is the circle row of the blockers model', { timeout: 60000 }, async t => {
  const f = await appFixture(t);
  f.hostCapabilities = { faravan: '0.11.2', min_member: null };
  const { lender, circle } = await f.connect({ backend: healthy(f.root), faravanVersion: '0.12.0', minHostVersion: '0.12.0', hostProfileMs: 50, blockerRecheckMs: 50 });
  await lending(lender.app, circle);
  const status = await waitFor(async () => { const s = await api(lender.app, '/api/status'); return s.lending_blockers?.first?.key === 'circle' && s; }, 'the host row blocks');
  assert.equal(status.reason, 'circle_update_needed');
  assert.match(status.lending_blockers.first.detail, /runs Faravan 0\.11\.2\. This computer needs 0\.12\.0 or later/);
  assert.equal(status.intent.on, true);
});

test('an unreachable host is the circle row, retries by itself, and clears when it answers', { timeout: 60000 }, async t => {
  const f = await appFixture(t);
  const { lender, circle } = await f.connect({ backend: healthy(f.root), hostProfileMs: 50, blockerRecheckMs: 50 });
  await lending(lender.app, circle);
  const original = f.override;
  f.override = async record => { if (record.route === '/capabilities' && f.hostDown) { record.res.writeHead(503, { 'content-type': 'application/problem+json' }); record.res.end(JSON.stringify({ type: 'urn:faravan:problem:unavailable', title: 'unavailable', status: 503, code: 'unavailable', retryable: true, outcome: 'not_applied' })); return true; } return original(record); };
  f.hostDown = true;
  const down = await waitFor(async () => { const s = await api(lender.app, '/api/status'); return s.reason === 'circle_unreachable' && s.host?.reachable === false && s; }, 'two misses make the host unreachable', 30000);
  assert.equal(down.lending_blockers.first.key, 'circle');
  // H3: the member's page says when the host was last reached.
  assert.equal(down.host.reachable, false); assert.ok(Number.isFinite(Date.parse(down.host.lastReachedAt)), 'it was reached before it went away');
  assert.equal(down.lending_blockers.first.action, undefined, 'there is nothing to press: it retries by itself');
  assert.equal(down.intent.on, true);
  f.hostDown = false;
  await waitFor(async () => (await api(lender.app, '/api/status')).reason !== 'circle_unreachable', 'the row clears when the host answers', 30000);
});

test('during a host outage, Lending names the unreachable circle and never blames passed checks', { timeout: 60000 }, async t => {
  const f = await appFixture(t);
  const { lender, circle } = await f.connect({ backend: healthy(f.root), hostProfileMs: 50, blockerRecheckMs: 50 });
  await lending(lender.app, circle);
  f.override = async record => { if (record.route === '/capabilities' && f.hostDown) { record.res.writeHead(503, { 'content-type': 'application/problem+json' }); record.res.end(JSON.stringify({ type: 'urn:faravan:problem:unavailable', title: 'unavailable', status: 503, code: 'unavailable', retryable: true, outcome: 'not_applied' })); return true; } return false; };
  f.hostDown = true;
  const down = await waitFor(async () => { const s = await api(lender.app, '/api/status'); return s.reason === 'circle_unreachable' && s.host?.reachable === false && s; }, 'two misses make the host unreachable', 30000);
  // The status names the circle and its host, so Lending can say who is unreachable instead of blaming checks that passed.
  assert.equal(down.lendingProjection.admissionReason, 'circle_unreachable');
  assert.equal(down.lending_blockers.first.label, circle.name);
  assert.equal(typeof down.lending_blockers.first.hostName, 'string');
  assert.ok(down.lending_blockers.first.hostName.length > 0);
  assert.ok(down.lending_blockers.items.filter(item => item.key !== 'circle').every(item => item.status === 'ok' || item.status === 'unknown'), 'no other check is blocked');
});

test('the heartbeat carries this member\'s Faravan version for the owner to read', { timeout: 60000 }, async t => {
  const f = await appFixture(t);
  const { lender, circle } = await f.connect({ backend: healthy(f.root), faravanVersion: '0.12.0', heartbeatMs: 100 });
  await lending(lender.app, circle);
  const heartbeat=await waitFor(() => f.heartbeats?.findLast(body=>Number.isSafeInteger(body.seq)), 'a full heartbeat was sent');
  assert.equal(heartbeat.versions.faravan, '0.12.0');
  assert.equal(heartbeat.versions.protocol, '1');
});

// P17a through the app: when the host deletes a job, and "Delete this job".
test('the app reads a finished job\'s retention and deletes it on request', { timeout: 120000 }, async t => {
  const f = await appFixture(t);
  const { owner, lender, circle } = await f.realConnect();
  const sent = await api(lender.app, '/api/jobs', { method: 'POST', body: { ...gitInput(circle), prompt: 'Synthetic task: say hi.', send_anyway:true } });
  const digest = sent.jobDigest;
  await api(lender.app, '/api/jobs/' + digest + '/cancel', { method: 'POST', body: { circle: circle.id } });
  const retention = await waitFor(async () => { const r = await api(lender.app, '/api/jobs/' + digest + '/retention?circle=' + circle.id); return r.ended_at && r; }, 'the cancelled job is finished');
  assert.equal(Date.parse(retention.retained_until) - Date.parse(retention.ended_at), 30 * 86400 * 1000);
  assert.equal(retention.deletable, true);
  const deleted = await api(lender.app, '/api/jobs/' + digest + '/delete', { method: 'POST', body: { circle: circle.id } });
  assert.equal(deleted.deleted, true);
  await api(lender.app, '/api/jobs/' + digest + '/retention?circle=' + circle.id, { status: 404 });
  void owner;
});

test('the app device reports its own release to the coordinator, including preview builds',async t=>{
 const f=await appFixture(t),seen=[],original=f.override;
 f.override=async record=>{seen.push(record.req.headers['faravan-version']);return original(record);};
 const owner=await f.start('owner',{faravanVersion:'0.12.3-preview'});
 await f.provisionFromHome('owner');
 const circle=await api(owner.app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Version check'}});
 await (await owner.app.device.client(circle.id)).capabilities({refresh:true});
 assert.ok(seen.includes('0.12.3'),'all clients of this device share the actual normalized release');
 assert.equal(seen.includes('unknown'),false);
});
