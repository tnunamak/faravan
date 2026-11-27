// A coordinator store with a fake clock and test-only keys, for replaying TLC traces
// (spec/tla) step by step against the real store code. Only time is faked; every
// request goes through the store's own proof, idempotency and transaction code.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as p from '../../lib/protocol/index.mjs';
import { openV1Store } from '../../lib/v1/store.mjs';

// All keys are public TEST-ONLY fixtures; no enrollment, network, provider or model calls.
const golden = JSON.parse(readFileSync(new URL('../../docs/protocol/vectors/golden.json', import.meta.url)));
assert.match(golden.warning, /TEST-ONLY/);
const keys = [...golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')))];
export const fp = keys.map(k => p.fingerprint(p.exportPublicKey(k)));
const vectors = Object.fromEntries(Object.entries(golden.objects).map(([k, v]) => [k, v.envelope]));
const circle = vectors.job.payload.circle;
const origin = 'https://coordinator.example';
const base = origin + '/v1/circles/' + circle;
const START = Date.parse('2026-10-09T12:00:00Z') / 1000;
export const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const segment = digest => digest.slice(7);
const advertisement = {
  harnesses: ['codex'], models: ['example-model'], capabilities: ['patch-output'],
  egress: ['provider-only'], enforced_limits: Object.keys(vectors.job.payload.requirements.limits),
  max_limits: vectors.job.payload.requirements.limits,
};

// Lender devices: 1 is in the golden roster; 3 is added as a second lender.
export function storeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-replay-'));
  let now = START, sequence = 0;
  const options = { path: join(dir, 'store.sqlite'), circle, origin, rootFingerprint: fp[2],
    initialRoster: vectors.roster, clock: () => now,
    idGenerator: () => 'aaaaaaaa-aaaa-4aaa-8aaa-' + (++sequence).toString(16).padStart(12, '0') };
  let store = openV1Store(options);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const f = {
    get store() { return store; }, get now() { return now; }, epoch: 7,
    advance(seconds) { now += seconds; },
    reopen() { store.close(); store = openV1Store(options); },
    ctx(device, method, route, body, overrides = {}) {
      return { proof: p.buildRequestProof({
        circle, roster_epoch: f.epoch, method, target: base + route,
        body: method === 'GET' ? Buffer.alloc(0) : Buffer.from(p.canonicalize(body)),
        content_type: method === 'GET' ? '' : 'application/json', artifact_media_type: '',
        idempotency_key: method === 'POST' ? randomUUID() : '',
        created: now, nonce: randomBytes(16).toString('base64url'), ...overrides,
      }, keys[device]) };
    },
    upload(ref, device = 0) {
      const route = '/artifacts/' + segment(ref.digest);
      const ctx = { proof: p.buildRequestProof({ circle, roster_epoch: f.epoch, method: 'PUT',
        target: base + route, body_digest: ref.digest, content_length: ref.bytes,
        content_type: 'application/octet-stream', artifact_media_type: ref.media_type,
        idempotency_key: '', created: now, nonce: randomBytes(16).toString('base64url') }, keys[device]) };
      const reservation = store.reserveArtifact(fp[device], ref, { ...ctx, transport: false });
      const id = reservation.reservation_id;
      return store.commitArtifact(fp[device], id, ref, f.ctx(device, 'POST', '/artifact-reservations/' + id + '/commit', ref));
    },
    // Publishes a job with the job inputs uploaded and a second lender in the roster.
    publish(overrides = {}) {
      f.upload(vectors.job.payload.source.artifact);
      f.upload(vectors.job.payload.prompt);
      const third = { key_id: fp[3], public_key: golden.keys[3].public_key, joined_epoch: vectors.roster.payload.epoch };
      const roster = p.signEnvelope('roster', { ...vectors.roster.payload, epoch: f.epoch + 1,
        members: [...vectors.roster.payload.members, third] }, keys[2]);
      store.installRoster(roster, f.ctx(0, 'PUT', '/roster', roster, { roster_epoch: roster.payload.epoch }));
      f.epoch = roster.payload.epoch;
      const job = p.signEnvelope('job', { ...vectors.job.payload, author: fp[0], roster_epoch: f.epoch,
        intent_id: randomUUID(), created_at: iso(now), expires_at: iso(now + 3600), ...overrides }, keys[0]);
      store.publishJob(job, f.ctx(0, 'POST', '/jobs', job));
      return { job, digest: p.digest(job.payload) };
    },
    get(digest) { return store.getJob(fp[0], digest, f.ctx(0, 'GET', '/jobs/' + segment(digest))); },
    claim(digest, device, lease = 30) {
      const body = { advertisement, lease_seconds: lease };
      return store.claimJob(fp[device], digest, advertisement,
        f.ctx(device, 'POST', '/jobs/' + segment(digest) + '/claim', body), lease).attempt;
    },
    start(a, device) {
      return store.start(fp[device], a.attempt_id, a.generation,
        f.ctx(device, 'POST', '/attempts/' + a.attempt_id + '/start', { generation: a.generation }));
    },
    observe(a, device) {
      return store.observeExecutionStart(fp[device], a.attempt_id, a.generation,
        f.ctx(device, 'POST', '/attempts/' + a.attempt_id + '/observed-start', { generation: a.generation }));
    },
    release(a, device, code = 'restart_interrupted') {
      const reason = JSON.stringify({ code }), body = { generation: a.generation, reason };
      return store.release(fp[device], a.attempt_id, a.generation, reason,
        f.ctx(device, 'POST', '/attempts/' + a.attempt_id + '/release', body));
    },
    stopped(a, device) {
      const body = { generation: a.generation, stopped_at: iso(now) };
      return store.stopped(fp[device], a.attempt_id, a.generation, body.stopped_at,
        f.ctx(device, 'POST', '/attempts/' + a.attempt_id + '/stopped', body));
    },
  };
  return f;
}
