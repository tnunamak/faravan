import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSessionStore, SESSION_IDLE_MS } from '../lib/v1/browser-sessions.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-sessions-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return join(dir, 'v1', 'sessions.json');
}

test('a session created before a restart still verifies after the store is reopened', async t => {
  const file = await scratch(t);
  const first = await openSessionStore(file);
  const {secret} = await first.create({kind: 'local', label: 'Browser on this computer'});
  await first.close();
  const second = await openSessionStore(file);
  assert.equal(second.instance, first.instance, 'cookie names stay stable across restarts');
  assert.equal(second.verify(secret, 'local')?.kind, 'local');
});

test('the file holds only hashes, is private to the user, and never the secret', async t => {
  const file = await scratch(t);
  const store = await openSessionStore(file);
  const {secret} = await store.create({kind: 'phone', label: 'Pixel', scopes: ['inbox:read']});
  const text = await readFile(file, 'utf8');
  assert.equal(text.includes(secret), false);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('a kind never verifies as another kind: a phone session is not a local owner session', async t => {
  const store = await openSessionStore(await scratch(t));
  const phone = await store.create({kind: 'phone', label: 'Pixel', scopes: ['inbox:read']});
  const local = await store.create({kind: 'local', label: 'Browser'});
  assert.equal(store.verify(phone.secret, 'local'), null);
  assert.equal(store.verify(local.secret, 'phone'), null);
  assert.deepEqual(store.verify(phone.secret, 'phone').scopes, ['inbox:read']);
});

test('unknown kinds and scopes are refused at creation', async t => {
  const store = await openSessionStore(await scratch(t));
  await assert.rejects(store.create({kind: 'admin', label: 'x'}), /invalid_request/);
  await assert.rejects(store.create({kind: 'phone', label: 'x', scopes: ['settings:write']}), /invalid_request/);
  await assert.rejects(store.create({kind: 'phone', label: 'x', scopes: []}), /invalid_request/);
});

test('sessions expire after 30 idle days, and use slides the window', async t => {
  let now = 1_000_000;
  const file = await scratch(t);
  const store = await openSessionStore(file, {now: () => now});
  const kept = await store.create({kind: 'local', label: 'a'});
  const idle = await store.create({kind: 'local', label: 'b'});
  now += SESSION_IDLE_MS - 1;
  assert.ok(store.verify(kept.secret, 'local'));
  now += SESSION_IDLE_MS - 1;
  assert.ok(store.verify(kept.secret, 'local'), 'used yesterday, still signed in');
  assert.equal(store.verify(idle.secret, 'local'), null, 'idle for 30 days, signed out');
  await store.close();
  const reopened = await openSessionStore(file, {now: () => now});
  assert.ok(reopened.verify(kept.secret, 'local'), 'the slide survives a restart');
  assert.equal(reopened.list('local').length, 1, 'expired records are dropped');
});

test('revoking a session takes effect at once and survives a restart', async t => {
  const file = await scratch(t);
  const store = await openSessionStore(file);
  const phone = await store.create({kind: 'phone', label: 'Pixel', scopes: ['inbox:read']});
  const [listed] = store.list('phone');
  assert.equal(listed.label, 'Pixel');
  assert.equal('hash' in listed, false, 'lists never expose the hash');
  assert.equal(await store.revoke(listed.id), true);
  assert.equal(store.verify(phone.secret, 'phone'), null);
  assert.equal(await store.revoke(listed.id), false);
  await store.close();
  assert.equal((await openSessionStore(file)).verify(phone.secret, 'phone'), null);
});

test('local browsers are capped by evicting the least recently used; phones are refused when full', async t => {
  let now = 1;
  const store = await openSessionStore(await scratch(t), {now: () => now, limits: {local: 2, phone: 1}});
  const a = await store.create({kind: 'local', label: 'a'}); now++;
  const b = await store.create({kind: 'local', label: 'b'}); now++;
  store.verify(a.secret, 'local'); now++;
  await store.create({kind: 'local', label: 'c'});
  assert.ok(store.verify(a.secret, 'local'));
  assert.equal(store.verify(b.secret, 'local'), null);
  await store.create({kind: 'phone', label: 'p', scopes: ['inbox:read']});
  await assert.rejects(store.create({kind: 'phone', label: 'q', scopes: ['inbox:read']}), /too_many_phones/);
});

test('a damaged file starts empty instead of stopping the app, and garbage secrets never verify', async t => {
  const file = await scratch(t);
  const store = await openSessionStore(file);
  await store.close();
  await writeFile(file, '{not json');
  const reopened = await openSessionStore(file);
  assert.equal(reopened.list('local').length, 0);
  for (const value of [undefined, null, '', 'x'.repeat(5000), 42]) assert.equal(reopened.verify(value, 'local'), null);
});
