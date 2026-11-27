import './helpers/no-browser.mjs';
// Replays pinned consent-model boundaries using only fixture directories and fakes.
// Off must fence dispatch across processes and resume interrupted cleanup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawn, spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {captureTransport, catalogRemoteFactory} from './helpers/telemetry-harness.mjs';
import {createConsent} from '../lib/v1/telemetry/consent.mjs';
import {createTelemetry} from '../lib/v1/telemetry/index.mjs';
import {createOutbox} from '../lib/v1/telemetry/outbox.mjs';
import {acquireProcessLockSync} from '../lib/v1/lock.mjs';
const version = '0.1.0-preview.20261020.7';
const now = () => Date.UTC(2026, 9, 21, 19, 30);
const record = JSON.parse(fs.readFileSync(new URL('./telemetry/golden/problem.count.record.json', import.meta.url)));
const options = dir => ({dir, base: dir, env: {}, version,remoteFactory:catalogRemoteFactory, endpoint: 'https://telemetry.invalid/v1/batch', now, random: () => 0, tripwire: async () => null});
function fixture(t) {
  const parent = join(homedir(), '.tmp');
  fs.mkdirSync(parent, {recursive: true});
  const dir = fs.mkdtempSync(join(parent, 'telemetry-replay-'));
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
test('another process completes Off while uploader awaits tripwire: server receives nothing', {timeout: 10000}, async t => {
  const {dir} = setup(t);
  const received = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { received.push(Buffer.concat(chunks)); res.end(); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const a = createTelemetry({...options(dir), endpoint: `http://127.0.0.1:${server.address().port}/batch`,
    tripwire: async () => { entered(); await gate; return null; }});
  const flushing = a.flushNow();
  await waiting;
  const source = `import {createTelemetry} from ${JSON.stringify(new URL('../lib/v1/telemetry/index.mjs', import.meta.url).href)}; const t = createTelemetry(${JSON.stringify(options(dir))}); t.restrict(); if(t.status().effective !== 'off') process.exit(2);`;
  const b = spawnSync(process.execPath, ['--input-type=module', '-e', source], {encoding: 'utf8', timeout: 10000});
  release();
  await flushing;
  assert.equal(b.status, 0, b.stderr);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'policy.json'))).level, 'off');
  assert.equal(received.length, 0, 'no old-generation request arrives after completed Off');
});
test('restart resumes Off purge after disk failure', async t => {
  const {dir, tel} = setup(t);
  const undo = inject(t, 'rmSync', (original, file, ...args) => {
    if (String(file).endsWith('.jsonl')) throw Object.assign(Error('injected purge failure'), {code: 'EIO'});
    return original(file, ...args);
  });
  try { assert.throws(() => tel.restrict(), /injected purge failure/); } finally { undo(); }
  let sends = 0;
  const again = createTelemetry({...options(dir), transport: async () => { sends++; throw Error('must not send'); }});
  assert.equal(again.status().effective, 'off');
  await again.flushNow();
  const retained = fs.readdirSync(join(dir, 'outbox')).filter(n => n.endsWith('.jsonl'));
  assert.equal(retained.length, 0);
  assert.equal(sends, 0);
  if (retained.length) assert.ok(fs.readFileSync(join(dir, 'outbox', retained[0]), 'utf8').includes(record.name));
});
test('preview reads Off and hides queued bytes while another writer leaves purge pending', async t => {
  const dir = fixture(t);
  const transport = captureTransport();
  const tel = createTelemetry({...options(dir), transport});
  await tel.choose({level: 'on'});
  const gen = tel.status().generation;
  const box = createOutbox({dir, base: dir, now});
  box.append([{record, gen}, {record: {...record, value: 4}, gen, notBefore: now() + 60000}]);
  await tel.flushNow();

  const before = tel.preview();
  const settled = before.items.filter(item => item.state === 'sent');
  const queued = before.items.filter(item => item.state === 'queued');
  assert.equal(before.state.effective, 'on');
  assert.equal(before.state.queued.counts, 1);
  assert.ok(before.state.queued_bytes > 0);
  assert.equal(queued.length, 1);
  assert.equal(transport.requests.length, 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].body, transport.requests[0].body);
  const segments = () => fs.readdirSync(join(dir, 'outbox')).filter(name => name.endsWith('.jsonl'));
  assert.equal(segments().length, 1);
  const segment = join(dir, 'outbox', segments()[0]);
  const raw = fs.readFileSync(segment);
  assert.ok(raw.includes(queued[0].body));

  const writer = createConsent({dir, base: dir, env: {}, uploadable: true, now});
  assert.equal(writer.restrict().after.effective, 'off');
  const pending = join(dir, 'purge-pending.json');
  assert.ok(fs.existsSync(pending));
  // Preview is the first read on this facade since the other writer set Off.
  const preview = tel.preview();
  assert.equal(preview.state.effective, 'off');
  assert.equal(preview.state.reason.kind, 'purge_pending');
  assert.deepEqual(fs.readFileSync(segment), raw);
  assert.ok(fs.existsSync(pending));
  assert.deepEqual(preview.items.filter(item => item.state === 'sent'), settled);
  assert.equal(tel.view().queued.counts, 1);
  assert.equal(tel.status().outbox.bytes, raw.length);

  await tel.restrict();
  assert.equal(fs.existsSync(pending), false);
  assert.deepEqual(segments(), []);
  assert.deepEqual(fs.readdirSync(join(dir, 'sent')), []);
  const after = tel.preview();
  assert.deepEqual(after.items, []);
  assert.equal(after.state.queued_bytes, 0);
  assert.equal(transport.requests.length, 1);

  t.diagnostic(`Queued segment held ${raw.length} raw bytes while Off and was removed by the existing purge.`);
  assert.deepEqual({
    items: preview.items.map(item => item.state),
    queued: preview.state.queued,
    bytes: preview.state.queued_bytes,
  }, {
    items: ['sent'],
    queued: {counts: 0, diagnostics: 0, quota: 0},
    bytes: 0,
  });
});
for (const point of ['before-cursor', 'after-cursor']) {
  test(`carry recovery ${point} retains exactly one record and the batch id`, t => {
    const {dir, box, tel} = setup(t), gen = tel.status().generation;
    const first = box.nextBatch({stream: 'counts', gen});
    const undo = inject(t, 'renameSync', (original, from, to) => {
      if ((point === 'before-cursor' && String(to).endsWith('/cursor.json')) ||
          (point === 'after-cursor' && String(to).endsWith('/inflight-counts.json'))) throw Error('injected carry boundary');
      return original(from, to);
    });
    try { assert.throws(() => box.carry({streams: ['counts'], fromGen: gen, gen: gen + 1}), /injected carry boundary/); } finally { undo(); }
    // Abandon every process-local outbox value; reopening runs the real sweep.
    const recovered = createOutbox({dir, base: dir, now});
    const recoveredGen = point === 'before-cursor' ? gen : gen + 1;
    const batch = recovered.nextBatch({stream: 'counts', gen: recoveredGen});
    assert.equal(batch.id, first.id);
    assert.deepEqual(batch.records, first.records);
    assert.equal(recovered.inspect({gen: recoveredGen}).filter(i => i.state === 'queued').length, 1);
    assert.equal(fs.readdirSync(join(dir, 'outbox')).filter(n => n.endsWith('.jsonl')).length, 1);
  });
}
test('same-process Off blocks dispatch at the async tripwire boundary', {timeout: 10000}, async t => {
  const {dir} = setup(t);
  let release, entered, sends = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const tel = createTelemetry({...options(dir), tripwire: async () => { entered(); await gate; return null; }, transport: async () => { sends++; throw Error('must not send'); }});
  const flushing = tel.flushNow(); await waiting;
  tel.restrict(); release(); await flushing;
  assert.equal(sends, 0);
  assert.equal(tel.status().outbox.bytes, 0);
});
test('Off in another process waits for a briefly held consent lock instead of failing', {timeout: 15000}, async t => {
  const {dir} = setup(t);
  const release = acquireProcessLockSync(join(dir, 'consent.lock'), {durable: false});
  let released = false;
  t.after(() => { if (!released) release(); });
  const source = `import {createTelemetry} from ${JSON.stringify(new URL('../lib/v1/telemetry/index.mjs', import.meta.url).href)}; const t = createTelemetry(${JSON.stringify(options(dir))}); t.restrict(); if(t.status().effective !== 'off') process.exit(2);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.on('exit', resolve));
  setTimeout(() => { released = true; release(); }, 300);
  assert.equal(await exited, 0, stderr);
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'policy.json'))).level, 'off');
  assert.equal(fs.readdirSync(join(dir, 'outbox')).filter(n => n.endsWith('.jsonl')).length, 0);
});
test('a consent change in the same process finishes an earlier failed Off purge', t => {
  const {dir, tel} = setup(t);
  const undo = inject(t, 'rmSync', (original, file, ...args) => {
    if (String(file).endsWith('.jsonl')) throw Object.assign(Error('injected purge failure'), {code: 'EIO'});
    return original(file, ...args);
  });
  try { assert.throws(() => tel.restrict(), /injected purge failure/); } finally { undo(); }
  assert.equal(tel.status().effective, 'off');
  assert.equal(tel.status().reason.kind, 'purge_pending');
  tel.choose({level: 'on'});
  assert.equal(fs.readdirSync(join(dir, 'outbox')).filter(n => n.endsWith('.jsonl')).length, 0);
  assert.equal(fs.existsSync(join(dir, 'purge-pending.json')), false);
  assert.equal(tel.status().effective, 'on');
});
test('startup replay of an interrupted carry runs under the consent authority, so a concurrent Off cannot interleave', t => {
  const {dir, box, tel} = setup(t), gen = tel.status().generation;
  box.nextBatch({stream: 'counts', gen});
  const undo = inject(t, 'renameSync', (original, from, to) => {
    if (String(to).endsWith('/inflight-counts.json')) throw Error('injected carry boundary');
    return original(from, to);
  });
  try { assert.throws(() => box.carry({streams: ['counts'], fromGen: gen, gen: gen + 1}), /injected carry boundary/); } finally { undo(); }
  // The cursor moved and the journal carries the batch survivor: the next start must replay it.
  assert.ok(fs.existsSync(join(dir, 'outbox', 'rewrite.json')));
  // Another process probes the consent lock from inside the replay. It must find the lock held.
  const probe = `import {acquireProcessLockSync} from ${JSON.stringify(new URL('../lib/v1/lock.mjs', import.meta.url).href)}; try { acquireProcessLockSync(${JSON.stringify(join(dir, 'consent.lock'))}, {durable: false})(); } catch (error) { process.exit(error.code === 'lock_busy' ? 3 : 4); }`;
  let probeStatus = null;
  const undoRead = inject(t, 'readFileSync', (original, file, ...args) => {
    if (String(file).endsWith('rewrite.json')) probeStatus = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {encoding: 'utf8', timeout: 10000}).status;
    return original(file, ...args);
  });
  try { createTelemetry(options(dir)); } finally { undoRead(); }
  assert.equal(probeStatus, 3, 'the replay must hold the consent authority; a second process must see lock_busy');
});
test('a startup that cannot take the consent lock never reports a successful Off', {timeout: 15000}, async t => {
  const {dir} = setup(t);
  const holder = `import {acquireProcessLockSync} from ${JSON.stringify(new URL('../lib/v1/lock.mjs', import.meta.url).href)}; const release = acquireProcessLockSync(${JSON.stringify(join(dir, 'consent.lock'))}, {durable: false}); console.log('ready'); setTimeout(() => { release(); process.exit(0); }, 4000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', holder], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(() => child.kill());
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('holder exited early'))); });
  // Startup waits its 2-second bound for the lock, then gives up and returns the unavailable facade.
  const tel = createTelemetry(options(dir));
  assert.throws(() => tel.restrict(), /telemetry_unavailable/, 'a restrict that did not reach the policy must not return normally');
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'policy.json'), 'utf8')).level, 'on', 'the durable policy is unchanged');
  await new Promise(resolve => child.once('exit', resolve));
  // Once the lock is free, a new process applies the Off.
  createTelemetry(options(dir)).restrict();
  assert.equal(JSON.parse(fs.readFileSync(join(dir, 'policy.json'), 'utf8')).level, 'off');
});
