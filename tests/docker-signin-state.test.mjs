import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createDockerSignInState} from '../lib/v1/docker-signin-state.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'docker-signin-state-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const home = path.join(root, 'app'), sbxHome = path.join(root, 'sbx');
  return {root, home, sbxHome, store: createDockerSignInState({home, sbxHome}),
    reopen: () => createDockerSignInState({home, sbxHome}),
    file: () => path.join(home, 'v1', fs.readdirSync(path.join(home, 'v1'))[0])};
}

test('construction, absent reads and stale clears do not create app state', t => {
  const f = fixture(t);
  assert.equal(f.store.read(), null);
  assert.equal(f.store.clear(null), null);
  assert.equal(f.store.clear('old-epoch'), null);
  assert.equal(fs.existsSync(f.home), false);
});

test('a refusal is synchronous, durable across store recreation, and private', t => {
  const f = fixture(t), refusal = f.store.refuse();
  assert.equal(typeof refusal.epoch, 'string');
  assert.ok(refusal.epoch.length > 0);
  assert.deepEqual(f.store.read(), refusal);
  assert.deepEqual(f.reopen().read(), refusal);
  assert.equal(fs.statSync(f.file()).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(f.home, 'v1')).mode & 0o777, 0o700);
});

test('only an exact current epoch can clear a refusal, including another store instance', t => {
  const f = fixture(t), first = f.store.refuse(), secondStore = f.reopen();
  const second = secondStore.refuse();
  assert.notEqual(first.epoch, second.epoch);
  assert.deepEqual(f.store.clear(first.epoch), second);
  assert.deepEqual(f.store.clear(null), second);
  assert.deepEqual(f.store.clear(undefined), second);
  assert.equal(f.store.clear(second.epoch), null);
  assert.equal(secondStore.read(), null);
  assert.equal(f.reopen().read(), null);
});

test('a refusal after a clear cannot be cleared by a success from an earlier generation', t => {
  const f = fixture(t), old = f.store.refuse();
  assert.equal(f.store.clear(old.epoch), null);
  const fresh = f.reopen().refuse();
  assert.notEqual(fresh.epoch, old.epoch);
  assert.deepEqual(f.store.clear(old.epoch), fresh);
  assert.deepEqual(f.store.clear(null), fresh);
});

test('state is isolated by sbxHome and app home, with normalized lexical identity', t => {
  const f = fixture(t), refusal = f.store.refuse();
  const other = createDockerSignInState({home: f.home, sbxHome: path.join(f.root, 'other-sbx')});
  assert.equal(other.read(), null);
  const otherRefusal = other.refuse();
  assert.equal(other.clear(refusal.epoch).epoch, otherRefusal.epoch);
  assert.deepEqual(f.store.read(), refusal);
  assert.equal(createDockerSignInState({home: path.join(f.root, 'other-app'), sbxHome: f.sbxHome}).read(), null);
  assert.deepEqual(createDockerSignInState({home: f.home, sbxHome: path.join(f.sbxHome, 'unused', '..')}).read(), refusal);
});

test('disk state contains only a version, hashed sbxHome identity, and refusal epoch', t => {
  const f = fixture(t), refusal = f.store.refuse();
  const bytes = fs.readFileSync(f.file(), 'utf8'), state = JSON.parse(bytes);
  assert.deepEqual(Object.keys(state).sort(), ['epoch', 'sbxHome', 'version']);
  assert.equal(state.version, 1);
  assert.match(state.sbxHome, /^[a-f0-9]{64}$/);
  assert.equal(state.epoch, refusal.epoch);
  assert.equal(bytes.includes(f.root), false);
  assert.equal(fs.readdirSync(path.join(f.home, 'v1')).some(name => name.endsWith('.tmp')), false);
});

test('returned refusal snapshots cannot mutate the stored state', t => {
  const f = fixture(t), refusal = f.store.refuse();
  assert.throws(() => { refusal.epoch = 'injected'; }, TypeError);
  assert.equal(f.store.read().epoch, refusal.epoch);
});

test('malformed, unknown-version, extra-field and wrong-identity state fail closed', t => {
  const f = fixture(t);
  f.store.refuse();
  const file = f.file(), valid = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const bytes of ['{broken', 'null', '[]', JSON.stringify({...valid, version: 2}),
    JSON.stringify({...valid, epoch: ''}), JSON.stringify({...valid, epoch: 17}),
    JSON.stringify({...valid, sbxHome: 'foreign'}), JSON.stringify({...valid, stdout: 'must not be accepted'})]) {
    fs.writeFileSync(file, bytes);
    const store = f.reopen(), refused = store.read();
    assert.ok(refused?.epoch, bytes);
    assert.equal(refused.error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
    assert.deepEqual(store.read(), refused, 'the error epoch is stable');
    assert.throws(() => store.clear(refused.epoch), {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'});
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'reading and clearing an error never erase it');
  }
});

test('a non-file state path fails closed without exposing filesystem details', t => {
  const f = fixture(t);
  f.store.refuse();
  const file = f.file();
  fs.unlinkSync(file); fs.mkdirSync(file);
  const refused = f.reopen().read();
  assert.ok(refused?.epoch);
  assert.equal(refused.error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  assert.equal(refused.error.message.includes(f.root), false);
});

test('state symlinks fail closed without reading or replacing their targets', t => {
  const f = fixture(t);
  f.store.refuse();
  const file = f.file(), target = path.join(f.root, 'unrelated');
  fs.writeFileSync(target, 'private unrelated contents');
  fs.unlinkSync(file); fs.symlinkSync(target, file);
  const store = f.reopen();
  assert.equal(store.read().error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  assert.throws(() => store.refuse(), {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'});
  assert.equal(fs.readFileSync(target, 'utf8'), 'private unrelated contents');
});

test('refusal write failures throw and remain visibly blocked in this store', t => {
  const f = fixture(t);
  fs.mkdirSync(f.home); fs.writeFileSync(path.join(f.home, 'v1'), 'not a directory');
  assert.throws(() => f.store.refuse(), {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'});
  const refused = f.store.read();
  assert.ok(refused?.epoch);
  assert.equal(refused.error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  assert.throws(() => f.store.clear(refused.epoch), {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'});
});

test('a failed replacement never silently clears a refusal and cleans temporary files', t => {
  const f = fixture(t), refusal = f.store.refuse(), file = f.file();
  const before = fs.readFileSync(file, 'utf8');
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('private storage error'); });
  assert.throws(() => f.store.clear(refusal.epoch), {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'});
  rename.mock.restore();
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(f.store.read().error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  assert.deepEqual(f.reopen().read(), refusal);
  assert.equal(fs.readdirSync(path.dirname(file)).length, 1);
});

test('a clear barrier failure restores the old refusal when storage permits it', t => {
  const f = fixture(t), refusal = f.store.refuse();
  const original = fs.fsyncSync;
  let barriers = 0;
  const sync = t.mock.method(fs, 'fsyncSync', fd => {
    if (++barriers === 2) throw new Error('directory barrier failed after rename');
    return original(fd);
  });
  assert.throws(() => f.store.clear(refusal.epoch), {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'});
  sync.mock.restore();
  assert.equal(f.store.read().error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  assert.deepEqual(f.reopen().read(), refusal);
});

test('read and close failures are returned as fail-closed blockers', t => {
  const f = fixture(t);
  f.store.refuse();
  const read = t.mock.method(fs, 'readFileSync', () => { throw new Error('private read failure'); });
  assert.equal(f.reopen().read().error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  read.mock.restore();
  const originalClose = fs.closeSync;
  const close = t.mock.method(fs, 'closeSync', fd => { originalClose(fd); throw new Error('private close failure'); });
  assert.equal(f.reopen().read().error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  close.mock.restore();
});

test('oversized state is rejected and state-directory symlinks are not followed', t => {
  const f = fixture(t);
  f.store.refuse(); fs.writeFileSync(f.file(), ' '.repeat(4097));
  assert.equal(f.reopen().read().error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  const otherHome = path.join(f.root, 'linked-app');
  fs.mkdirSync(otherHome);
  fs.symlinkSync(path.join(f.home, 'v1'), path.join(otherHome, 'v1'));
  const linked = createDockerSignInState({home: otherHome, sbxHome: f.sbxHome});
  assert.equal(linked.read().error?.code, 'DOCKER_SIGNIN_STATE_UNAVAILABLE');
  assert.throws(() => linked.refuse(), {code: 'DOCKER_SIGNIN_STATE_UNAVAILABLE'});
});

test('an explicit later refusal can repair malformed data and establish a fresh durable epoch', t => {
  const f = fixture(t);
  f.store.refuse(); fs.writeFileSync(f.file(), '{broken');
  const store = f.reopen(), broken = store.read(), fresh = store.refuse();
  assert.notEqual(fresh.epoch, broken.epoch);
  assert.equal(fresh.error, undefined);
  assert.deepEqual(store.read(), fresh);
  assert.deepEqual(f.reopen().read(), fresh);
});

test('invalid home arguments are rejected before accessing the filesystem', () => {
  for (const options of [{}, {home: '/app'}, {sbxHome: '/sbx'}, {home: '', sbxHome: '/sbx'}, {home: '/app', sbxHome: 1}]) {
    assert.throws(() => createDockerSignInState(options), TypeError);
  }
});
