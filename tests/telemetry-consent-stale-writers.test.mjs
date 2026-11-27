import './helpers/no-browser.mjs';
// Off must hold against a second process that still caches the old consent, and must leave no payload copy behind:
// not in the rewrite journal, not in a temporary segment, and not in the sent ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawn, spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {catalogRemoteFactory} from './helpers/telemetry-harness.mjs';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {createOutbox} from '../lib/v1/telemetry/outbox.mjs';
const version = '0.1.0-preview.20261020.7';
const now = () => Date.UTC(2026, 9, 21, 19, 30);
const record = JSON.parse(fs.readFileSync(new URL('./telemetry/golden/problem.count.record.json', import.meta.url)));
const options = dir => ({dir, base: dir, env: {}, version,remoteFactory:catalogRemoteFactory, endpoint: 'https://telemetry.invalid/v1/batch', now, random: () => 0, tripwire: async () => null});
// The child is a second OS process on the same directory: it runs the complete Off facade and exits.
const offSource = dir => `import {createTelemetry} from ${JSON.stringify(new URL('../lib/v1/telemetry/index.mjs', import.meta.url).href)}; const t = createTelemetry(${JSON.stringify(options(dir))}); t.restrict(); if(t.status().effective !== 'off') process.exit(2);`;
function fixture(t) {
  const parent = join(homedir(), '.tmp');
  fs.mkdirSync(parent, {recursive: true});
  const dir = fs.mkdtempSync(join(parent, 'telemetry-stale-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}
function setup(t) {
  const dir = fixture(t), tel = createTelemetry(options(dir));
  tel.choose({level: 'on'});
  const box = createOutbox({dir, base: dir, now});
  box.append([{record, gen: tel.status().generation}]);
  return {dir, tel, box};
}
function inject(t, method, replacement) {
  const original = fs[method];
  t.mock.method(fs, method, (...args) => replacement(original, ...args));
  syncBuiltinESMExports();
  return () => { t.mock.restoreAll(); syncBuiltinESMExports(); };
}
const policy = dir => JSON.parse(fs.readFileSync(join(dir, 'policy.json'), 'utf8'));
/** Every file under the telemetry directory that can hold a record or a sent body. */
function payloads(dir) {
  const list = sub => { try { return fs.readdirSync(join(dir, sub)).map(name => `${sub}/${name}`); } catch { return []; } };
  return [...list('outbox').filter(name => /\.jsonl(\.tmp)?$|rewrite\.json$|inflight-/.test(name)), ...list('sent'), ...list('inbox'),
    ...['rollup.json', 'purge-pending.json'].filter(name => fs.existsSync(join(dir, name)))];
}

test('a process with cached consent cannot undo Off that another process completed', t => {
  const {dir, tel} = setup(t);
  const before = policy(dir).generation;
  const b = spawnSync(process.execPath, ['--input-type=module', '-e', offSource(dir)], {encoding: 'utf8', timeout: 10000});
  assert.equal(b.status, 0, b.stderr);
  assert.equal(policy(dir).level, 'off');
  // A still holds the counts policy it read at start. Its next write is not a choice of On.
  tel.resetIdentity();
  assert.equal(policy(dir).level, 'off', 'Off survives a stale writer');
  assert.ok(policy(dir).generation > before + 1, 'the stale write cannot reuse the Off generation');
  assert.equal(tel.status().effective, 'off');
});

test('Off removes the payload copies of an interrupted lane rewrite', t => {
  const {dir, tel, box} = setup(t), gen = tel.status().generation;
  const undo = inject(t, 'renameSync', (original, from, to) => {
    if (String(from).endsWith('.jsonl.tmp')) throw Object.assign(Error('injected rename failure'), {code: 'EIO'});
    return original(from, to);
  });
  try { assert.throws(() => box.carry({streams: ['counts'], fromGen: gen, gen: gen + 1}), /injected rename failure/); } finally { undo(); }
  assert.ok(fs.existsSync(join(dir, 'outbox', 'rewrite.json')), 'fixture: the rewrite journal holds a copy');
  tel.restrict();
  assert.deepEqual(payloads(dir), []);
});

test('Off interrupted by a crash after a failed rewrite leaves no payload after restart', async t => {
  const {dir, tel, box} = setup(t), gen = tel.status().generation;
  let undo = inject(t, 'renameSync', (original, from, to) => {
    if (String(from).endsWith('.jsonl.tmp')) throw Object.assign(Error('injected rename failure'), {code: 'EIO'});
    return original(from, to);
  });
  try { assert.throws(() => box.carry({streams: ['counts'], fromGen: gen, gen: gen + 1}), /injected rename failure/); } finally { undo(); }
  undo = inject(t, 'rmSync', (original, file, ...args) => {
    if (String(file).endsWith('.jsonl')) throw Object.assign(Error('injected purge failure'), {code: 'EIO'});
    return original(file, ...args);
  });
  try { assert.throws(() => tel.restrict(), /injected purge failure/); } finally { undo(); }
  let sends = 0;
  const again = createTelemetry({...options(dir), transport: async () => { sends++; throw Error('must not send'); }});
  await again.flushNow();
  assert.equal(again.status().effective, 'off');
  assert.equal(policy(dir).level, 'off');
  assert.deepEqual(payloads(dir), []);
  assert.equal(sends, 0);
});

test('a reply settled after another process completed Off does not restore the sent ledger', {timeout: 20000}, async t => {
  const {dir} = setup(t);
  let child, exited;
  // Pause A between its in-flight check and the ledger write; B gets a full second to complete Off there.
  const undo = inject(t, 'writeFileSync', (original, file, ...args) => {
    if (!child && String(file).includes(`${join(dir, 'sent')}/`)) {
      child = spawn(process.execPath, ['--input-type=module', '-e', offSource(dir)], {stdio: ['ignore', 'ignore', 'pipe']});
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      exited = new Promise(resolve => child.on('exit', code => resolve({code, stderr})));
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    return original(file, ...args);
  });
  t.after(undo);
  const a = createTelemetry({...options(dir), transport: async () => ({status: 200, headers: {get: () => null}, body: {cancel: async () => {}}})});
  await a.flushNow();
  undo();
  assert.ok(child, 'fixture: A reached the ledger write');
  const {code, stderr} = await exited;
  assert.equal(code, 0, stderr);
  assert.equal(policy(dir).level, 'off');
  assert.deepEqual(payloads(dir), [], 'nothing from the old consent remains, the sent ledger included');
});
