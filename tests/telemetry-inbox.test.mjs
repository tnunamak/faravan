import './helpers/no-browser.mjs';
// Inbox: files from outside producers are untrusted (docs/design/TELEMETRY.md §2.2 "Inbox rule", TELEMETRY-WIRE.md §8, §9). Foreign records
// are validated again, checked against the consent generation and projected under the consent in force now. Bad files are deleted and
// counted in telemetry.self; good ones become records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTelemetry, settle,edgeCapture } from './helpers/telemetry-harness.mjs';
import { parseInboxFile, canonicalJson, MAX_INBOX_FILE_BYTES } from '../lib/v1/telemetry/catalog.mjs';
import { writeCrashFile } from '../lib/v1/telemetry/crash.mjs';

const GOLDEN_DIR = new URL('./telemetry/golden/', import.meta.url);
const goldenText = name => readFileSync(new URL(name, GOLDEN_DIR), 'utf8');
const golden = name => JSON.parse(goldenText(name));
const GOLDEN_INBOX = readdirSync(GOLDEN_DIR).filter(name => name.startsWith('inbox.') || name.endsWith('.inbox.json')).sort();

const inboxDir = h => join(h.dir, 'inbox');
const put = (h, name, content) => {
  mkdirSync(inboxDir(h), {recursive: true});
  writeFileSync(join(inboxDir(h), name), typeof content === 'string' ? content : JSON.stringify(content));
};
const left = h => (existsSync(inboxDir(h)) ? readdirSync(inboxDir(h)).sort() : []);
const currentGen = h => h.tel.status().generation;
/** A golden inbox file stamped with the generation in force now. */
const fresh = (h, name, change = file => file) => change({...golden(name), gen: currentGen(h),capture:edgeCapture(h)});
const selfCount = (h, reason) => h.transport.records().filter(r => r.name === 'telemetry.self' && r.attrs.reason === reason).reduce((sum, r) => sum + r.value, 0);
/** Records other than what the app's own housekeeping adds (the hourly outbox health row, telemetry.self). */
const foreign = h => h.transport.records().filter(r => !(r.name === 'telemetry.self' || (r.name === 'health.state' && r.attrs.check === 'outbox')));
const batchesOf = h => h.transport.bodies();

// ---- The producers' real output -----------------------------------------------------------------------------------------

test('the golden inbox files (installer, Go tray, coordinator) pass parseInboxFile and are in canonical form byte for byte', () => {
  assert.ok(GOLDEN_INBOX.length >= 4, `golden inbox files found: ${GOLDEN_INBOX.join(', ')}`);
  const origins = new Set();
  for (const name of GOLDEN_INBOX) {
    const text = goldenText(name);
    const parsed = parseInboxFile(text);
    origins.add(parsed.origin);
    assert.equal(canonicalJson(JSON.parse(text)) + '\n', text, `${name} is the canonical form plus one newline, which a Go or shell writer must produce byte for byte`);
    assert.ok(Buffer.byteLength(text) <= MAX_INBOX_FILE_BYTES);
  }
  assert.deepEqual([...origins].sort(), ['coordinator', 'installer', 'tray']);
});

test('the crash marker\'s own output passes parseInboxFile too', () => {
  const h = makeTelemetry();
  try {
    assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'uncaught_exception', error: new TypeError('x')}));
    const [name] = left(h);
    const parsed = parseInboxFile(readFileSync(join(inboxDir(h), name), 'utf8'));
    assert.equal(parsed.origin, 'crash');
    assert.equal(parsed.record.name, 'app.crash');
    assert.equal(parsed.gen, currentGen(h));
  } finally { h.cleanup(); }
});

// ---- Valid files become records, by producer -----------------------------------------------------------------------------

const PRODUCERS = [
  {name: 'inbox.coordinator-tunnel.json', origin: 'coordinator', service: 'coordinator', counts: [['health.state', {check: 'coordinator_tunnel', reason: 'network_error', state: 'blocked'}]], diagnostic: null},
  {name: 'inbox.tray-health-app-reachable.json', origin: 'tray', service: 'tray', counts: [['health.state', {check: 'app_reachable', state: 'blocked'}]], diagnostic: null},
  {name: 'inbox.tray-panic.json', origin: 'tray', service: 'tray', counts: [['crash.count', {'crash.kind': 'panic'}]], diagnostic: 'app.crash'},
  {name: 'install.run.inbox.json', origin: 'installer', service: 'installer', counts: [['install.count', {method: 'deb', outcome: 'restart_failed'}]], diagnostic: 'install.run'},
];

for (const producer of PRODUCERS) {
  test(`${producer.name}: widening before the inbox sweep never uploads the earlier record`, async () => {
    const h = makeTelemetry({level: 'on'});
    try {
      put(h, 'before.json', fresh(h, producer.name));
      h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare'});
      h.tel.choose({level: 'on'});
      h.tel.ingestInbox();
      await settle(h, {hours: 6});
      const records = foreign(h);
      assert.ok(records.some(record => record.name === 'problem.count'), 'allowed app counts survive the transition');
      if (producer.diagnostic) assert.ok(!records.some(record => record.name === producer.diagnostic), 'the earlier diagnostic is not uploaded');
      for (const [name, attrs] of producer.counts) {
        assert.ok(!records.some(record => record.name === name && Object.entries(attrs).every(([key, value]) => record.attrs[key] === value)),
          'an unswept earlier inbox record is dropped with its generation');
      }
      put(h, 'after.json', fresh(h, producer.name));
      h.tel.ingestInbox();
      await settle(h, {hours: 30});
      const later = foreign(h);
      if (producer.diagnostic) assert.ok(later.some(record => record.name === producer.diagnostic), 'the later diagnostic can upload');
      for (const [name, attrs] of producer.counts) {
        assert.ok(later.some(record => record.name === name && Object.entries(attrs).every(([key, value]) => record.attrs[key] === value)),
          'the later producer record can upload');
      }
    } finally { h.cleanup(); }
  });
}

for (const producer of PRODUCERS) {
  test(`${producer.name}: under ON it becomes ${producer.diagnostic ? `${producer.diagnostic} and ` : ''}its derived count`, async () => {
    const h = makeTelemetry({seed: 11});
    try {
      put(h, 'one.json', fresh(h, producer.name));
      h.tel.ingestInbox();
      assert.deepEqual(left(h), [], 'the file was taken and deleted');
      await settle(h, {hours: 6}); // past the end of the UTC day, for the day-period counts
      const records = foreign(h);
      for (const [name, attrs] of producer.counts) {
        const count = records.find(r => r.name === name);
        assert.ok(count, `${name} arrived`);
        assert.deepEqual(count.attrs, attrs);
        assert.equal(count.value, 1);
      }
      const diagnostic = records.find(r => r.name === producer.diagnostic);
      if (producer.diagnostic) {
        assert.equal(diagnostic?.name, producer.diagnostic);
        const event=batchesOf(h).flatMap(body=>body.batch).find(event=>event.event===producer.diagnostic);
        assert.equal(event.distinct_id,h.tel.bootstrap().installId);
        for(const key of ['epoch','session','trace'])assert.equal(event.properties[key],undefined);
      } else assert.equal(diagnostic, undefined, 'a counts-shaped file yields no diagnostic');
      // What the producer wrote leaves in a batch of the producer's own service. Counts the app derives from it are the app's own (crash.count, install.count).
      const written = producer.diagnostic ?? producer.counts[0][0];
      const owning = batchesOf(h).find(b => b.records.some(r => r.name === written));
      assert.ok(owning.batch.some(event=>event.event===written && event.properties.surface===producer.origin));
    } finally { h.cleanup(); }
  });

  test(`${producer.name}: under OFF it suppresses ${producer.diagnostic ? 'only its derived count, never the diagnostic' : 'its count'}`, async () => {
    const h = makeTelemetry({level: 'off', seed: 12});
    try {
      put(h, 'one.json', fresh(h, producer.name));
      h.tel.ingestInbox();
      await settle(h, {hours: 6});
      assert.equal(h.transport.requests.length,0);
    } finally { h.cleanup(); }
  });
}

test('the crash marker\'s file (origin crash) yields app.crash under ON and only crash.count under OFF', async () => {
  for (const [level, wantDiagnostic] of [['on', true]]) {
    const h = makeTelemetry({level, seed: 13});
    try {
      assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'unhandled_rejection', error: new RangeError('x')}));
      h.tel.ingestInbox();
      assert.deepEqual(left(h), []);
      await settle(h);
      const records = foreign(h);
      assert.equal(records.some(r => r.name === 'app.crash'), wantDiagnostic, `${level}: the diagnostic`);
      assert.equal(records.find(r => r.name === 'crash.count')?.attrs['crash.kind'], 'unhandled_rejection', `${level}: the derived count`);
    } finally { h.cleanup(); }
  }
});

test('a file written before any policy exists (generation 0) is discarded', async () => {
  const h = makeTelemetry({level: null, seed: 14});
  try {
    put(h, 'zero.json', golden('inbox.coordinator-tunnel.json')); // gen 0
    h.tel.ingestInbox();
    assert.deepEqual(left(h), ['zero.json'], 'the next enabled sweep discards pre-disclosure records');
    h.tel.choose({level: 'on', region: 'US'}); // the first write: generation 1
    h.tel.ingestInbox();
    assert.deepEqual(left(h), []);
    await settle(h);
    assert.equal(foreign(h).find(r => r.name === 'health.state')?.attrs.check, undefined);
  } finally { h.cleanup(); }
});

// ---- Hostile files ----------------------------------------------------------------------------------------------------------

const panic = 'inbox.tray-panic.json';
const withRecord = change => (h => fresh(h, panic, file => ({...file, record: change(file.record)})));
const withFile = change => (h => fresh(h, panic, change));
const padded = h => JSON.stringify(fresh(h, panic)) + ' '.repeat(MAX_INBOX_FILE_BYTES);
const HOSTILE = [
  ['invalid JSON', () => '{ not json', 'inbox_invalid'],
  ['an empty file', () => '', 'inbox_invalid'],
  ['a JSON array', () => '[1,2,3]', 'inbox_invalid'],
  ['a JSON string', () => '"hello"', 'inbox_invalid'],
  ['a valid record in an oversized file (> 16 KiB)', padded, 'inbox_invalid'],
  ['a wrong format name', withFile(f => ({...f, format: 'something-else'})), 'inbox_invalid'],
  ['origin "app" (a producer pretending to be the app)', withFile(f => ({...f, origin: 'app'})), 'inbox_invalid'],
  ['origin "ui"', withFile(f => ({...f, origin: 'ui'})), 'inbox_invalid'],
  ['origin "phone"', withFile(f => ({...f, origin: 'phone'})), 'inbox_invalid'],
  ['an unknown origin', withFile(f => ({...f, origin: 'bogus'})), 'inbox_invalid'],
  ['a record whose entry does not list the origin (installer writing app.crash)', withFile(f => ({...f, origin: 'installer'})), 'inbox_invalid'],
  ['a record whose entry does not list the origin (tray writing install.run)', h => fresh(h, 'install.run.inbox.json', f => ({...f, origin: 'tray'})), 'inbox_invalid'],
  ['an unknown record name', withRecord(r => ({...r, name: 'user.keystrokes'})), 'inbox_invalid'],
  ['an unknown top-level key', withFile(f => ({...f, note: 'hello'})), 'inbox_invalid'],
  ['an unknown record key', withRecord(r => ({...r, message: 'segfault at /home/someone/.ssh'})), 'inbox_invalid'],
  ['an unknown attribute', withRecord(r => ({...r, attrs: {...r.attrs, path: '/home/someone'}})), 'inbox_invalid'],
  ['a producer-written identity (epoch)', withRecord(r => ({...r, epoch: 'e-AAAAAAAAAAAAAAAAAAAZ'})), 'inbox_invalid'],
  ['a producer-written identity (rid)', withRecord(r => ({...r, rid: 'r-AAAAAAAAAAAAAAAAAAAZ'})), 'inbox_invalid'],
  ['a free-text value where an enum is required', withRecord(r => ({...r, attrs: {...r.attrs, 'crash.kind': 'my secret message'}})), 'inbox_invalid'],
  ['a missing required attribute', withRecord(r => ({...r, attrs: {'crash.kind': 'panic'}})), 'inbox_invalid'],
  ['a wrong type for gen', withFile(f => ({...f, gen: '3'})), 'inbox_invalid'],
  ['a negative gen', withFile(f => ({...f, gen: -1})), 'inbox_invalid'],
  ['a schema version from the future', withFile(f => ({...f, schema_version: 999})), 'inbox_invalid'],
  ['a stale generation (one behind)', h => fresh(h, panic, f => ({...f, gen: currentGen(h) - 1})), 'stale_generation'],
  ['a stale generation (one ahead)', h => fresh(h, panic, f => ({...f, gen: currentGen(h) + 1})), 'stale_generation'],
  ['a stale generation (far ahead)', h => fresh(h, panic, f => ({...f, gen: 2 ** 30})), 'stale_generation'],
];

for (const [label, make, reason] of HOSTILE) {
  test(`hostile: ${label} is deleted, counted as ${reason}, and produces nothing`, async () => {
    const h = makeTelemetry({seed: 15});
    try {
      h.tel.choose({level:'on'}); // another policy write, so that "one behind" is not generation 0
      put(h, 'bad.json', make(h));
      h.tel.ingestInbox();
      assert.deepEqual(left(h), [], 'the file is deleted');
      await settle(h);
      assert.equal(selfCount(h, reason), 1, `counted once as ${reason}`);
      assert.equal(selfCount(h, reason === 'inbox_invalid' ? 'stale_generation' : 'inbox_invalid'), 0, 'and not under the other reason');
      assert.deepEqual(foreign(h), [], 'no record from a bad file');
    } finally { h.cleanup(); }
  });
}

test('hostile files all at once: each is counted under its own reason and the good file between them still arrives', async () => {
  const h = makeTelemetry({seed: 16});
  try {
    h.tel.choose({level:'on'});
    HOSTILE.forEach(([, make], index) => put(h, `a${String(index).padStart(3, '0')}.json`, make(h)));
    put(h, 'b-good.json', fresh(h, 'inbox.tray-health-app-reachable.json'));
    h.tel.ingestInbox();
    assert.deepEqual(left(h), []);
    await settle(h);
    assert.equal(selfCount(h, 'inbox_invalid'), HOSTILE.filter(([, , reason]) => reason === 'inbox_invalid').length);
    assert.equal(selfCount(h, 'stale_generation'), HOSTILE.filter(([, , reason]) => reason === 'stale_generation').length);
    assert.deepEqual(foreign(h).map(r => r.name), ['health.state']);
  } finally { h.cleanup(); }
});

test('a file that went stale because the person changed consent after the producer wrote it is dropped and counted', async () => {
  const h = makeTelemetry({seed: 17});
  try {
    put(h, 'old.json', fresh(h, panic));
    h.tel.choose({level:'on'}); // any policy write is a new generation
    assert.deepEqual(left(h), ['old.json'], 'a downgrade-free change keeps the file until the sweep');
    h.tel.ingestInbox();
    assert.deepEqual(left(h), []);
    await settle(h);
    assert.equal(selfCount(h, 'stale_generation'), 1);
    assert.deepEqual(foreign(h), []);
  } finally { h.cleanup(); }
});

test('more than 200 files: the first 200 (by name) are read, the rest are deleted unread and counted', async () => {
  const h = makeTelemetry({seed: 18});
  try {
    for (let i = 0; i < 230; i++) put(h, `f${String(i).padStart(3, '0')}.json`, fresh(h, panic));
    h.tel.ingestInbox();
    assert.deepEqual(left(h), [], 'all 230 files are gone');
    // Drain: diagnostics leave 50 at a time, every 5 minutes.
    await settle(h);
    for (let i = 0; i < 30 && h.tel.status().outbox.queued.diagnostics > 0; i++) { h.clock.advance(6 * 60000); await h.tel.flushNow(); }
    const crashes = foreign(h).filter(r => r.name === 'app.crash');
    assert.equal(crashes.length, 200, 'exactly 200 files were read');
    assert.equal(selfCount(h, 'inbox_invalid'), 30, 'the 30 extra files were counted');
    const total = foreign(h).filter(r => r.name === 'crash.count').reduce((sum, r) => sum + r.value, 0);
    assert.equal(total, 200);
  } finally { h.cleanup(); }
});

test('.tmp files and other names are ignored: not read, not deleted, not counted', async () => {
  const h = makeTelemetry({seed: 19});
  try {
    put(h, 'half.json.tmp', JSON.stringify(fresh(h, panic)).slice(0, 40)); // a producer still writing
    put(h, 'done.json.tmp', fresh(h, panic)); // complete, but not renamed yet
    put(h, 'notes.txt', 'hello');
    put(h, '.hidden', 'x');
    h.tel.ingestInbox();
    assert.deepEqual(left(h), ['.hidden', 'done.json.tmp', 'half.json.tmp', 'notes.txt']);
    await settle(h);
    assert.equal(selfCount(h, 'inbox_invalid'), 0);
    assert.deepEqual(foreign(h), []);
    // After the producer renames it, it is taken.
    mkdirSync(inboxDir(h), {recursive: true});
    put(h, 'done.json', fresh(h, panic)); // re-create with fresh proof after the negative phase advanced time
    h.tel.ingestInbox();
    await settle(h);
    assert.ok(foreign(h).some(r => r.name === 'crash.count'));
  } finally { h.cleanup(); }
});

test('DEFECT: a directory named like an inbox file does not stop the sweep for the files after it', async () => {
  const h = makeTelemetry({seed: 20});
  try {
    mkdirSync(join(inboxDir(h), 'trap.json'), {recursive: true});
    put(h, 'z.json', fresh(h, 'inbox.tray-health-app-reachable.json'));
    h.tel.ingestInbox();
    await settle(h);
    assert.ok(foreign(h).some(r => r.name === 'health.state' && r.attrs.check === 'app_reachable'), 'the good file after the directory was still taken (index.mjs ingestInbox: discard() calls rmSync without recursive on a directory, it throws inside the catch handler, and the outer catch ends the whole sweep, now and at every later sweep)');
    assert.deepEqual(left(h).filter(name => name !== 'trap.json'), [], 'and it was deleted');
  } finally { h.cleanup(); }
});

// ---- Limits on what files can add -----------------------------------------------------------------------------------------

test('DEFECT: repeated inbox records for a cell that allows one per period are not all lost (health.state maxPerPeriod 1)', async () => {
  const h = makeTelemetry({seed: 21});
  try {
    // A tray that restarts, or two sweeps in one hour, writes the same health row again. The cell is limited to 1 per record.
    for (let i = 0; i < 3; i++) put(h, `h${i}.json`, fresh(h, 'inbox.tray-health-app-reachable.json'));
    h.tel.ingestInbox();
    await settle(h); await settle(h);
    const rows = foreign(h).filter(r => r.name === 'health.state' && r.attrs.check === 'app_reachable');
    assert.ok(rows.length >= 1, 'the tray\'s health row arrived at least once (the cell was summed to 3, failed validation at the outbox and was dropped as internal_error)');
    assert.ok(rows.every(r => r.value === 1));
    assert.equal(selfCount(h, 'internal_error'), 0, 'no record was rejected by the app\'s own validator');
  } finally { h.cleanup(); }
});

test('DEFECT: an hour with more events than a cell may carry still reports that cell (problem.count maxPerPeriod 10000)', async () => {
  const h = makeTelemetry({seed: 22});
  try {
    for (let i = 0; i < 10003; i++) h.tel.observe('lender-failure', {code: 'lender_failed', phase: 'run'});
    await settle(h); await settle(h);
    const rows = h.transport.records().filter(r => r.name === 'problem.count' && r.attrs['error.type'] === 'lender_failed');
    assert.ok(rows.length >= 1, 'the cell was reported');
    assert.ok(rows.every(r => r.value <= 10000), 'no record carries more than maxPerPeriod');
    // A batch may not hold two records for one cell, so the excess cannot ride in a second record: the rollup self-reports it.
    const saturated = h.transport.records().filter(r => r.name === 'telemetry.self' && r.attrs.reason === 'rollup_full' && r.attrs.entry === 'problem.count');
    const counted = rows.reduce((sum, r) => sum + r.value, 0) + saturated.reduce((sum, r) => sum + r.value, 0);
    assert.equal(counted, 10003, 'nothing was lost: the cell carries its cap and the excess is self-reported');
  } finally { h.cleanup(); }
});
