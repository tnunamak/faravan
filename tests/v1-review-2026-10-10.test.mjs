import './helpers/no-browser.mjs';
// Review regressions from the 2026-10-10 audit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import * as p from '../lib/protocol/index.mjs';
import { resolveShortLink } from '../lib/v1/short-invite.mjs';
import { applyResult } from '../lib/v1/apply.mjs';
import { parseUnifiedDiff, patchHazards } from '../lib/git-candidate.mjs';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { memoryIntentStore } from './helpers/apply-intents.mjs';

const page = await readFile(new URL('../public/join/index.html', import.meta.url), 'utf8');
const code = 'abcde23456';
// The apply caller retains an earlier observation before requesting a result.
const applyAttempt = digest => ({ job_digest: digest, attempt_id: 'review-attempt', generation: 1, holder: 'review-holder' });
const at = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
function publication(origin, seed, name = 'Real circle') {
  const key = p.privateKeyFromSeed(seed), root = p.generateRootKeyPair().privateKey;
  const now = Math.floor(Date.now() / 1000);
  const envelope = p.createInvite({ circle: randomUUID(), coordinator: origin, invite_id: randomUUID(),
    invite_public_key: p.exportPublicKey(key), created_at: at(now - 1), expires_at: at(now + 3600),
    display_name: name, owner_name: 'Owner' }, root);
  return { envelope, invite_binding: p.createInviteBinding(envelope, key) };
}
function render(source, link, transport, crypto) {
  const elements = new Map(), url = new URL(link);
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', hidden: true,
      addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}, select() {} });
    return elements.get(id);
  };
  const context = { document: { getElementById: element },
    location: { href: link, hash: url.hash, pathname: url.pathname, origin: url.origin },
    history: { replaceState() {} }, navigator: {}, fetch: transport, crypto,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clearTimeout,
    TextDecoder, TextEncoder, Uint8Array, JSON, Date, Object, String, Array, Number, Error, Promise };
  runInNewContext(source.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  return { context, element };
}

for (const unsupported of ['no WebCrypto', 'Ed25519 unavailable']) {
  test(`review: ${unsupported} must not show a server-substituted circle name`, async () => {
    const origin = 'https://queue.example', seed = randomBytes(32).toString('base64url');
    const real = publication(origin, seed);
    const fake = publication(origin, randomBytes(32).toString('base64url'), 'Other circle');
    fake.envelope.payload.invite_public_key = real.envelope.payload.invite_public_key;
    assert.equal(p.inviteLinkFromPublication(fake, { coordinator: origin, seed }).ok, false);
    const crypto = unsupported === 'no WebCrypto' ? undefined : {
      subtle: { importKey: async () => { throw new Error('NotSupportedError'); } } };
    const view = render(page, `${origin}/i/${code}#${seed}`,
      async () => new Response(JSON.stringify(fake)), crypto);
    await view.context.faravanJoinReady;
    assert.match(view.element('identity').textContent, /can’t check/);
    assert.doesNotMatch(view.element('heading').textContent, /Other circle/);
  });
}

// TODO: Queue-served JavaScript can read the fragment; protection requires an independent trust boundary.
test.todo('review: a queue serving the landing verifier must not recover the fragment seed and rebind the root', async t => {
  let current, received;
  const server = createServer(async (req, res) => {
    if (req.url === '/received') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received = Buffer.concat(chunks).toString(); res.end('ok'); return;
    }
    if (req.url === '/v1/invites/' + code) {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(current)); return;
    }
    res.setHeader('content-type', 'text/html');
    // Both this inline code and its same-origin request are allowed by the shipped short-page CSP.
    res.end(page.replace('<script>', '<script>globalThis.captureReady = fetch("/received", {method:"POST", body:location.hash.slice(1)});'));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const seed = randomBytes(32).toString('base64url'), link = `${origin}/i/${code}#${seed}`;
  const real = publication(origin, seed); current = real;
  const response = await fetch(link), served = await response.text();
  const view = render(served, link, (url, options) => fetch(new URL(url, origin), options), webcrypto);
  await view.context.captureReady; await view.context.faravanJoinReady;
  assert.equal(received, seed, 'the substituted queue received the seed over HTTP');
  current = publication(origin, received, 'Replacement circle');
  assert.notEqual(current.envelope.payload.root_fingerprint, real.envelope.payload.root_fingerprint);
  const resolved = await resolveShortLink(link);
  const decoded = p.decodeInviteLink(resolved);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.invite.payload.root_fingerprint, real.envelope.payload.root_fingerprint,
    'opening the landing page must not give its server authority to substitute the root');
});

test('review: apply must not execute a repository reference-transaction hook', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.review-apply-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Review'); git('config', 'user.email', 'review@example.invalid');
  await writeFile(join(dir, 'a.txt'), 'old\n');
  git('add', 'a.txt'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD'), hook = join(dir, '.git/hooks/reference-transaction');
  await writeFile(hook, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$0.log"\n', { mode: 0o700 });
  const bytes = Buffer.from('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n');
  const device = { intentStore: memoryIntentStore(), selectCircle: async () => ({ id: 'review' }), client: async () => ({
    getJob: async digest => ({ current_attempt: applyAttempt(digest) }),
    fetchResult: async (digest, { attempt }) => {
      assert.deepEqual(attempt, applyAttempt(digest));
      return { bytes, candidate: { media_type: 'text/x-diff' },
      receipt: { harness: 'review', model: 'test', duration_ms: 1000 },
      job: { source: { kind: 'git', commit: base }, prompt: {} } }; },
    fetchArtifact: async () => Buffer.from('Review patch') }) };
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    const result = await applyResult({ digest: 'sha256:' + '1'.repeat(64), circle: 'review', repo: dir, device });
    assert.equal(result.status, 'applied');
    assert.equal(git('show', `${result.branch}:a.txt`), 'new');
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
  let ran = false;
  try { ran = Boolean(await readFile(hook + '.log', 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(ran, false, 'reference-transaction ran during apply branch creation');
});

test('review: apply must not run a configured core.fsmonitor command', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.review-fsmonitor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Review'); git('config', 'user.email', 'review@example.invalid');
  await writeFile(join(dir, 'a.txt'), 'old\n');
  git('add', 'a.txt'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD'), monitor = join(dir, 'fsmonitor.sh');
  await writeFile(monitor, '#!/bin/sh\nprintf "%s\\n" "$1" >> "$0.log"\nexit 1\n', { mode: 0o700 });
  git('config', 'core.fsmonitor', monitor);
  const bytes = Buffer.from('diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n');
  const device = { intentStore: memoryIntentStore(), selectCircle: async () => ({ id: 'review' }), client: async () => ({
    getJob: async digest => ({ current_attempt: applyAttempt(digest) }),
    fetchResult: async (digest, { attempt }) => {
      assert.deepEqual(attempt, applyAttempt(digest));
      return { bytes, candidate: { media_type: 'text/x-diff' },
      receipt: { harness: 'review', model: 'test', duration_ms: 1000 },
      job: { source: { kind: 'git', commit: base }, prompt: {} } }; },
    fetchArtifact: async () => Buffer.from('Review patch') }) };
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    const result = await applyResult({ digest: 'sha256:' + '2'.repeat(64), circle: 'review', repo: dir, device });
    assert.equal(result.status, 'applied');
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
  }
  let ran = false;
  try { ran = Boolean(await readFile(monitor + '.log', 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.equal(ran, false, 'core.fsmonitor ran during apply');
});

test('review: patch hazards must reject Windows absolute and escaping symlink targets', () => {
  const targets = ['C:/Users/user/outside', String.raw`\\server\share\outside`, String.raw`..\..\outside`];
  const accepted = targets.filter(target => {
    const bytes = Buffer.from('diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+' + target + '\n\\ No newline at end of file\n');
    return patchHazards(parseUnifiedDiff(bytes)).length === 0;
  });
  assert.deepEqual(accepted, [], 'unblocked Windows targets');
});

test('review: a binary patch must not create an external symlink on the result branch', async t => {
  const dir = await mkdtemp(join(process.cwd(), '.review-binary-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.name', 'Review'); git('config', 'user.email', 'review@example.invalid');
  await writeFile(join(dir, '.gitattributes'), 'link binary\n');
  git('add', '-A'); git('-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(dir, 'link'), '/etc/passwd'); git('add', 'link');
  const bytes = Buffer.from(execFileSync('git', ['diff', '--cached', '--binary'], { cwd: dir, encoding: 'utf8' })
    .replace('new file mode 100644', 'new file mode 120000'));
  git('reset', '--hard', '-q', base);
  const device = { intentStore: memoryIntentStore(), selectCircle: async () => ({ id: 'review' }), client: async () => ({
    getJob: async digest => ({ current_attempt: applyAttempt(digest) }),
    fetchResult: async (digest, { attempt }) => {
      assert.deepEqual(attempt, applyAttempt(digest));
      return { bytes, candidate: { media_type: 'text/x-diff' },
      receipt: { harness: 'review', model: 'test', duration_ms: 1 },
      job: { source: { kind: 'git', commit: base }, prompt: {} } }; },
    fetchArtifact: async () => Buffer.from('Binary patch') }) };
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  let result;
  try { result = await applyResult({ digest: 'sha256:' + '2'.repeat(64), circle: 'review', repo: dir, device }); }
  catch (error) { assert.equal(error.code, 'unsafe_patch'); return; }
  finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
  assert.equal(result.status, 'applied');
  assert.match(git('ls-tree', result.branch, 'link'), /^120000 /);
  assert.notEqual(git('show', result.branch + ':link'), '/etc/passwd', 'binary patch created an external symlink');
});

async function approvalScenario(t) {
  const dir = await mkdtemp(join(process.cwd(), '.review-enrollment-')), previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const cleanups = [];
  t.after(async () => {
    try { for (const cleanup of cleanups.reverse()) await cleanup(); }
    finally {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
  const f = await appFixture({ after: fn => cleanups.push(fn) });
  const owner = await f.start('owner', { autoApprove: false, approvalPollMs: 60000 });
  const joiner = await f.start('joiner', { joinWaitMs: 0 });
  await f.provisionFromHome('owner');
  const circle = await api(owner.app, '/api/circles', { method: 'POST', body: { origin: f.origin, name: 'Review' } });
  const prefix = '/api/circles/' + circle.id;
  const invite = (await api(owner.app, prefix + '/invite', { method: 'POST', body: {} })).invite;
  const joined = await api(joiner.app, '/api/circles/join', { method: 'POST', body: { link: invite } });
  return { f, owner, joiner, circle, prefix, joined };
}

test('review: a queue replay with a future timestamp must not restore a removed member', { timeout: 60000 }, async t => {
  const { f, owner, joiner, circle, prefix, joined } = await approvalScenario(t);
  await api(owner.app, prefix + '/approve', { method: 'POST', body: { enrollmentId: joined.enrollment.enrollment_id } });
  await api(owner.app, prefix + '/remove-member', { method: 'POST', body: { keyId: joiner.app.device.keyId } });
  const before = (await owner.app.device.rosterCache(circle.id).get()).current.payload;
  assert.equal(before.members.some(m => m.key_id === joiner.app.device.keyId), false);
  const old = f.circles.get(circle.id).enrollments[0];
  let replayTime = new Date(Date.now() + 365 * 86400000).toISOString();
  f.override = async ({ circleId, route, req, res }) => {
    if (circleId !== circle.id || route !== '/enrollments' || req.method !== 'GET') return false;
    const replay = { enrollment_id: randomUUID(), state: 'pending', invite_id: old.invite_id,
      device_public_key: old.device_public_key, enrollment_proof: old.enrollment_proof,
      created_at: replayTime };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(p.canonicalize({ items: [replay], next_cursor: null })); return true;
  };
  let finished;
  const completed = new Promise(resolve => { finished = resolve; });
  const original = owner.app.device.approveEnrollments.bind(owner.app.device);
  owner.app.device.approveEnrollments = async (...args) => {
    const result = await original(...args); finished(result); return result;
  };
  await api(owner.app, prefix + '/approval-mode', { method: 'POST', body: { approveEach: false } });
  const approved = await completed;
  assert.deepEqual(approved.approved, [], 'a removed key was auto-approved using its old enrollment proof');
  replayTime = new Date().toISOString();
  assert.deepEqual((await original(circle.id)).approved, [], 'a current queue timestamp cannot revive a consumed invite either');
  const after = (await owner.app.device.rosterCache(circle.id).get()).current.payload;
  assert.equal(after.epoch, before.epoch, 'replay must not publish another roster');
  f.override = async () => false;
  const fresh = (await api(owner.app, prefix + '/invite', { method: 'POST', body: {} })).invite;
  await api(joiner.app, '/api/circles/join', { method: 'POST', body: { link: fresh } });
  // Simulate a crash after consuming the fresh invite but before saving its roster publication.
  const latest = f.circles.get(circle.id).enrollments.at(-1), store = owner.app.device.intentStore(circle.id);
  const saved = await store.get('invite:' + latest.invite_id);
  await store.set('invite:' + latest.invite_id, { ...saved, approvedKey: joiner.app.device.keyId, approvedEpoch: after.epoch + 1 });
  assert.deepEqual((await original(circle.id)).approved, [joiner.app.device.keyId], 'a fresh invite may approve the removed device again');
  await owner.app.device.removeMember(circle.id, joiner.app.device.keyId);
  for (const prior of [old, latest]) {
    f.override = async ({ route, req, res }) => {
      if (route !== '/enrollments' || req.method !== 'GET') return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(p.canonicalize({ items: [{ enrollment_id: randomUUID(), state: 'pending', invite_id: prior.invite_id, device_public_key: prior.device_public_key, enrollment_proof: prior.enrollment_proof, created_at: replayTime }], next_cursor: null }));
      return true;
    };
    assert.deepEqual((await original(circle.id)).approved, [], 'neither consumed invite may undo the second removal');
  }
});

test('review: enabling approve-each must stop an automatic sweep that has not approved yet', { timeout: 30000 }, async t => {
  const { owner, circle, prefix, joined } = await approvalScenario(t);
  assert.equal(joined.enrollment.state, 'pending');
  let release, entered, finished;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const completed = new Promise(resolve => { finished = resolve; });
  t.after(() => release());
  const original = owner.app.device.approveEnrollments.bind(owner.app.device);
  owner.app.device.approveEnrollments = async (...args) => {
    entered(); await gate; const result = await original(...args); finished(result); return result;
  };
  await api(owner.app, prefix + '/approval-mode', { method: 'POST', body: { approveEach: false } });
  await ready;
  assert.deepEqual(await api(owner.app, prefix + '/approval-mode', { method: 'POST', body: { approveEach: true } }), { approveEach: true });
  release(); const result = await completed;
  assert.equal(owner.app.device.selectCircle(circle.id).approveEach, true);
  assert.deepEqual(result.approved, [], 'the old automatic sweep approved after the mode change returned');
});
