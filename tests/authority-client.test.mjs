import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityClient } from '../lib/v1/authority-client.mjs';

// The dual-authority lending client in isolation, with fake stores: discovery tolerates either store being down,
// each job's authority is saved before its claim and survives a restart, and nothing reaches the wrong store.
const OWN = 'sha256:' + 'a'.repeat(64);
const digest = (n) => 'sha256:' + String(n).repeat(64);
const view = (n, designated) => ({ job_digest: digest(n), state: 'queued', job: { payload: { designated_member: designated, prompt: { digest: digest('p' + n) } } } });
function store(name, log, { items = [], down = false } = {}) {
  const api = { name, down,
    async capabilities() { if (api.down) throw Object.assign(new Error('offline'), { code: 'network_error' }); return { capabilities: ['offers_v1', 'results_v1'], protocol: '1.0' }; },
    async *listOffers({ onRevision } = {}) { log.push([name, 'listOffers']); if (api.down) throw Object.assign(new Error('offline'), { code: 'network_error' }); onRevision?.(1); yield* api.items; },
    async claimJob(d) { log.push([name, 'claimJob', d]); return { job_digest: d, attempt: { job_digest: d, attempt_id: name + '-attempt' } }; },
    async claimNext() { log.push([name, 'claimNext']); return null; },
    async renew(attempt) { log.push([name, 'renew', attempt.job_digest]); return attempt; },
    async release(attempt) { log.push([name, 'release', attempt.job_digest]); return attempt; },
    async fetchArtifact(ref) { log.push([name, 'fetchArtifact', ref.digest]); return Buffer.from('x'); },
    items };
  return api;
}
function composite(incumbent, member, rows = {}, order = []) {
  return createAuthorityClient({ ownKeyId: OWN, incumbent: async () => incumbent, member: async () => member,
    routes: { read: async () => structuredClone(rows), write: async (value) => { order.push('write'); for (const k of Object.keys(rows)) delete rows[k]; Object.assign(rows, structuredClone(value)); } },
    outageMs: 20, backoffMs: 50 });
}
const read = async (client, options) => { const items = []; for await (const item of client.listOffers({ waitSeconds: 1, ...options })) items.push(item.job_digest); return items; };

test('discovery returns each store\'s own work only and survives an incumbent outage without spinning', async () => {
  const log = [];
  const incumbent = store('incumbent', log, { items: [view(1), view(2, OWN)] });
  const member = store('member', log, { items: [view(3, OWN), view(4)] });
  const client = composite(incumbent, member);
  await read(client); // the first answering store may arrive first; the next read holds both snapshots
  assert.deepEqual((await read(client)).sort(), [digest(1), digest(3)].sort(), 'a designated job is never taken from the incumbent, nor an ordinary one from the member');
  incumbent.down = true;
  incumbent.items = [];
  const during = await read(client, { since: 1 }).catch((e) => e);
  assert.ok(Array.isArray(during) || during.code === 'network_error');
  const polls = () => log.filter(([n, op]) => n === 'incumbent' && op === 'listOffers').length;
  const before = polls();
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(polls() - before <= 1, 'a down incumbent is not polled in a tight loop');
  incumbent.down = true; member.down = true;
  await assert.rejects(() => read(composite(incumbent, member)), (e) => e.code === 'network_error', 'discovery fails only when every store is down');
});

test('capabilities answer from whichever store is up', async () => {
  const log = [];
  const incumbent = store('incumbent', log, { down: true }), member = store('member', log);
  const profile = await composite(incumbent, member).capabilities({});
  assert.ok(profile.capabilities.includes('offers_v1'));
});

test('the authority is saved before the claim, survives a restart, and keeps every attempt call on one store', async () => {
  const log = [], order = [], rows = {};
  const incumbent = store('incumbent', log, { items: [view(1)] }), member = store('member', log, { items: [view(3, OWN)] });
  const first = composite(incumbent, member, rows, order);
  await read(first);
  member.claimJob = async (d) => { order.push('claim'); log.push(['member', 'claimJob', d]); return { job_digest: d, attempt: { job_digest: d, attempt_id: 'm' } }; };
  const claim = await first.claimJob(digest(3), {}, {});
  assert.deepEqual(order, ['write', 'claim'], 'the route is durable before the claim is sent');
  assert.equal(rows[digest(3)].a, 'member');
  await first.claimJob(digest(1), {}, {});
  assert.equal(rows[digest(1)].a, 'incumbent');

  // A restart: a new client with only the saved table, an incumbent that is down, and no discovery at all.
  incumbent.down = true;
  const restarted = composite(incumbent, member, rows);
  await restarted.renew(claim.attempt);
  await restarted.release(claim.attempt);
  assert.deepEqual(log.filter(([, op]) => op === 'renew' || op === 'release').map(([n, op]) => n + ':' + op), ['member:renew', 'member:release']);
  await restarted.fetchArtifact({ digest: digest('p3') }, { job: digest(3) });
  assert.equal(log.at(-1)[0], 'member');
  const ordinary = await restarted.renew({ job_digest: digest(1) });
  assert.equal(ordinary.job_digest, digest(1));
  assert.equal(log.at(-1)[0], 'incumbent', 'an ordinary attempt stays at the incumbent');
});

test('claim-next is the incumbent\'s alone', async () => {
  const log = [];
  const client = composite(store('incumbent', log), store('member', log));
  await client.claimNext({}, {});
  assert.deepEqual(log.filter(([, op]) => op === 'claimNext').map(([n]) => n), ['incumbent']);
});
