import './helpers/no-browser.mjs';
// Offline and bounds (docs/design/TELEMETRY.md §2.2 outbox and uploader, §6 "Offline and bounds"): the outbox stays within 10 MiB and
// 7 days while the network is down for 8 days, eviction order and drop accounting hold, and when the network returns the backlog
// drains with backoff, Retry-After, permanent rejections, a halt on 401/403 and a request timeout.
import { ownTempDir, tempDir } from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {stampRecord} from '../lib/v1/telemetry/posthog.mjs';
import { createOutbox, OUTBOX_LIMITS } from '../lib/v1/telemetry/outbox.mjs';
import { UPLOAD } from '../lib/v1/telemetry/uploader.mjs';
import {enumMembers} from '../lib/v1/telemetry/catalog.mjs';
import { catalogView,makeTelemetry, manualClock, captureTransport, settle, START, RELEASE } from './helpers/telemetry-harness.mjs';

const DAY = 86400000, HOUR = 3600000, MIB = 1024 * 1024, SLACK = 3 * HOUR;
const golden = name => JSON.parse(readFileSync(new URL(`./telemetry/golden/${name}.record.json`, import.meta.url), 'utf8'));
const COUNTS = golden('problem.count'), QUOTA = golden('quota.week');
const shippedFile = enumMembers('shipped_file').sort((a, b) => b.length - a.length)[0];
// Use the largest allowed crash-frame list for byte pressure, keeping every record within the real catalog.
const DIAG = {...golden('problem.observed.readiness'), name: 'app.crash', origin: 'crash', attrs: {...golden('app.crash').attrs,
  frames: Array.from({length: 16}, () => ({file: shippedFile, line: 1000000}))}};
const tmp = () => tempDir('tel-offline-');
// Honor the caller's TMPDIR, including disk-backed qualification runs.
const fastDir = () => tempDir('tel-offline-');
const STREAM_OF_NAME = {'problem.count': 'counts', 'app.crash': 'diagnostics', 'quota.week': 'quota'};

/** Every line still in the outbox's segments, read straight from disk: {file, stream, at, record}. */
function segmentLines(dir) {
  const root = join(dir, 'outbox'), out = [];
  for (const file of readdirSync(root).filter(name => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(root, file), 'utf8').split('\n').filter(Boolean)) {
      const [gen, notBefore, at, ...rest] = line.split('\t');
      out.push({file, stream: file.split('.')[0], at: Number(at), record: JSON.parse(rest.join('\t'))});
    }
  }
  return out;
}
const dirBytes = dir => readdirSync(join(dir, 'outbox')).filter(n => n.endsWith('.jsonl')).reduce((sum, n) => sum + readFileSync(join(dir, 'outbox', n)).length, 0);

// ---- The outbox alone: bytes, age, eviction order, drop accounting ------------------------------------------------

test('8 days offline: 10 MiB and 7 days hold at every step; every evicted record is reported exactly once', () => {
  const dir = fastDir(), clock = manualClock();
  try {
    const drops = [];
    const outbox = createOutbox({dir, base: dir, now: clock.now, onDrop: (reason, n, name) => drops.push({reason, n, name})});
    const appended = {}, bump = name => { appended[name] = (appended[name] ?? 0) + 1; };
    const add = (record, extra = {}) => { outbox.append([{record, gen: 1, at: clock.now(), ...extra}]); bump(record.name); };
    const diagnosticsPerHour = Math.ceil(80 * 1024 / Buffer.byteLength(JSON.stringify(DIAG)));
    const addDiagnostics = hour => {
      const records = Array.from({length: diagnosticsPerHour}, (_, i) => ({...DIAG, seq: hour * diagnosticsPerHour + i}));
      outbox.append(records.map(record => ({record, gen: 1, at: clock.now()})));
      for (const record of records) bump(record.name);
    };
    for (let hour = 0; hour <= 8 * 24; hour++) {
      if (hour % 24 === 0) console.log(`offline byte-pressure simulation: hour ${hour} of 192`);
      clock.set(START + hour * HOUR);
      add({...COUNTS, period: new Date(clock.now()).toISOString().slice(0, 13), value: hour + 1});
      addDiagnostics(hour); // At least 80 KiB of valid diagnostics per hour: the byte bound bites before age.
      if (hour % (7 * 24) === 0) add(QUOTA); // one quota week per simulated week
      assert.ok(dirBytes(dir) <= OUTBOX_LIMITS.totalBytes, `hour ${hour}: ${dirBytes(dir)} bytes queued (limit ${OUTBOX_LIMITS.totalBytes})`);
      assert.ok(outbox.stats().bytes <= 10 * MIB, `hour ${hour}: stats().bytes over 10 MiB`);
      outbox.enforceBounds(); // what the facade's tick does every hour
      for (const line of segmentLines(dir)) assert.ok(line.at >= clock.now() - 7 * DAY, `hour ${hour}: a ${line.record.name} queued ${(clock.now() - line.at) / HOUR} h ago is still queued`);
    }
    // Which bound fired: the byte bound evicted diagnostics only; the age bound took the rest (the day-0 quota week and the oldest counts).
    const byBytes = drops.filter(d => d.reason === 'dropped_bytes'), byAge = drops.filter(d => d.reason === 'dropped_age');
    assert.ok(byBytes.length > 0 && byAge.length > 0, 'both bounds were exercised');
    assert.deepEqual([...new Set(byBytes.map(d => d.name))], ['app.crash'], 'bytes evict diagnostics first; quota weeks and counts were not touched');
    assert.ok(byAge.some(d => d.name === 'quota.week'), 'the 8-day-old quota week aged out');
    assert.deepEqual([...new Set(drops.map(d => d.reason))].sort(), ['dropped_age', 'dropped_bytes']);
    // Accounting: appended = still queued + reported dropped, per record name.
    const queued = {};
    for (const line of segmentLines(dir)) queued[line.record.name] = (queued[line.record.name] ?? 0) + 1;
    const dropped = {};
    for (const d of drops) dropped[d.name] = (dropped[d.name] ?? 0) + d.n;
    for (const name of Object.keys(appended)) assert.equal((queued[name] ?? 0) + (dropped[name] ?? 0), appended[name], `${name}: queued + dropped must equal appended`);
    // The network comes back: the backlog drains, and nothing that was reported dropped is delivered.
    let delivered = 0;
    for (const stream of ['counts', 'quota', 'diagnostics']) {
      for (let guard = 0; guard < 1000; guard++) {
        const batch = outbox.nextBatch({stream, gen: 1, at: clock.now(), maxRecords: stream === 'quota' ? 1 : 50});
        if (!batch) break;
        delivered += batch.records.length;
        outbox.settle(batch, {body: batch.records.join('\n'), outcome: 'sent', status: 200});
      }
    }
    const totalAppended = Object.values(appended).reduce((a, b) => a + b, 0), totalDropped = drops.reduce((a, d) => a + d.n, 0);
    assert.equal(delivered + totalDropped, totalAppended, 'every record was either delivered or reported dropped, none both and none neither');
    assert.equal(delivered, Object.values(queued).reduce((a, b) => a + b, 0));
    assert.equal(outbox.stats().queued.counts + outbox.stats().queued.diagnostics + outbox.stats().queued.quota, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('eviction order under byte pressure: diagnostics, then quota weeks, then counts', () => {
  const dir = fastDir(), clock = manualClock();
  try {
    const events = [];
    const outbox = createOutbox({dir, base: dir, now: clock.now, onDrop: (reason, n, name) => {
      // Called after the victim segment is gone: nothing of an earlier-evicted stream may remain.
      const left = new Set(segmentLines(dir).map(line => line.stream));
      const stream = STREAM_OF_NAME[name];
      if (reason === 'dropped_bytes') {
        if (stream === 'quota') assert.ok(!left.has('diagnostics'), 'a quota week was evicted while diagnostics were still queued');
        if (stream === 'counts') assert.ok(!left.has('diagnostics') && !left.has('quota'), 'counts were evicted while diagnostics or quota weeks were still queued');
      }
      events.push({reason, n, name});
    }});
    const copies = base => Math.floor(0.5 * MIB / (Buffer.byteLength(JSON.stringify(stampRecord(base,{at:START}))) + 32)); // include stamps and changing seq digits
    const diagCopies = copies(DIAG), quotaCopies = copies(QUOTA), countCopies = copies(COUNTS);
    const sizes = {'problem.count': countCopies, 'app.crash': diagCopies, 'quota.week': quotaCopies};
    const block = base => Array.from({length: sizes[base.name]}, (_, i) => base.name === 'app.crash' ? {...base, seq: base.seq * diagCopies + i} : {...base});
    const add = records => { clock.advance(1000); outbox.append(records.map(record => ({record, gen: 1, at: clock.now()}))); };
    // Fill with: counts first (oldest), then quota weeks, then diagnostics, 12 MiB in all, so the cap forces evictions.
    for (let i = 0; i < 4; i++) add(block({...COUNTS, value: i + 1})); // about 2 MiB of counts
    for (let i = 0; i < 3; i++) add(block(QUOTA)); // about 1.5 MiB of quota weeks
    for (let i = 0; i < 12; i++) add(block({...DIAG, seq: i})); // about 6 MiB of diagnostics
    assert.ok(dirBytes(dir) <= 10 * MIB);
    const droppedNames = () => new Set(events.filter(e => e.reason === 'dropped_bytes').map(e => e.name));
    assert.deepEqual([...droppedNames()], [], 'nothing was evicted below the cap');
    // Push diagnostics past the cap: only diagnostics go, oldest first.
    for (let i = 12; i < 24; i++) add(block({...DIAG, seq: i}));
    assert.deepEqual([...droppedNames()], ['app.crash']);
    const survivingDiag = segmentLines(dir).filter(l => l.stream === 'diagnostics').map(l => l.record.seq);
    assert.deepEqual(survivingDiag, [...survivingDiag].sort((a, b) => a - b), 'order kept');
    assert.ok(survivingDiag.at(-1) === 24 * diagCopies - 1 && survivingDiag[0] > 0, 'the oldest diagnostics went first, the newest stayed');
    assert.equal(segmentLines(dir).filter(l => l.stream === 'quota').length, 3 * quotaCopies, 'quota weeks untouched while diagnostics could be evicted');
    assert.equal(segmentLines(dir).filter(l => l.stream === 'counts').length, 4 * countCopies, 'counts untouched');
    // Now quota weeks crowd out every diagnostic, then each other; counts survive.
    for (let i = 0; i < 25; i++) add(block(QUOTA));
    assert.equal(segmentLines(dir).filter(l => l.stream === 'diagnostics').length, 0, 'diagnostics are gone before any quota week is lost');
    assert.ok(droppedNames().has('quota.week'));
    assert.equal(segmentLines(dir).filter(l => l.stream === 'counts').length, 4 * countCopies, 'counts still untouched');
    // Finally counts alone over the cap: only now are counts evicted.
    for (let i = 0; i < 25; i++) add(block({...COUNTS, value: 100 + i}));
    assert.ok(droppedNames().has('problem.count'));
    assert.ok(dirBytes(dir) <= 10 * MIB);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

// ---- The facade: an 8-day outage, the self-reported drops, recovery -----------------------------------------------

/** One simulated hour of app life: a lender failure, a lender job, and (weekly) a quota window; then the hour closes. */
function liveHour(h, hour) {
  const codes = ['sandbox_start_failed', 'cessation_unverified', 'lender_failed'];
  h.tel.observe('lender-failure', {code: codes[hour % codes.length], phase: 'prepare'});
  h.tel.observe('lender-failure', {code: codes[(hour + 1) % codes.length], phase: 'run'});
  h.tel.observe('event:lending', {account: 'codex:0', status: 'preparing'});
  h.clock.advance(60000);
  h.tel.observe('event:lending', {account: 'codex:0', status: hour % 2 ? 'finished' : 'failed', reason: hour % 2 ? undefined : 'sandbox_start_failed'});
  if (hour % (7 * 24) === 0) {
    h.tel.observe('event:quota-window', {provider: 'codex', windowKind: 'seven_day', plan: 'plus', lendingOn: true, ownerUsedPct: 60, lentPoints: 5, unusedPct: 30,
      shortfall: false, coverage: 0.9, contaminated: false, history: 5, slots: Array.from({length: 28}, () => ({o: 1, l: 0}))});
  }
}
const recordsByName = transport => {
  const out = {};
  for (const record of transport.records()) out[record.name] = (out[record.name] ?? 0) + 1;
  return out;
};
/** Records still queued or in flight must not be older than 7 days (by their own hour/period). */
const stampEnd = stamp => (stamp.length === 13 ? Date.parse(stamp + ':00:00Z') + HOUR : stamp.length === 10 ? Date.parse(stamp + 'T00:00:00Z') + DAY : Infinity);
function assertNothingOlderThanSevenDays(h, label) {
  const limit = h.clock.now() - 7 * DAY - HOUR; // a record's own period ends before it is queued, hence the slack of one hour
  for (const line of segmentLines(h.dir)) {
    // The facade enforces the age bound from its hourly housekeeping, so a record can outlive 7 days by up to that hour.
    assert.ok(line.at >= h.clock.now() - 7 * DAY - SLACK, `${label}: queued ${line.record.name} is older than 7 days`);
    assert.ok(stampEnd(line.record.hour ?? line.record.period ?? '') >= limit - DAY, `${label}: ${line.record.name} for ${line.record.hour ?? line.record.period} is older than 7 days`);
  }
  for (const inflight of readdirSync(join(h.dir, 'outbox')).filter(name => /^inflight-/.test(name)).map(name => join(h.dir, 'outbox', name))) {
    for (const json of JSON.parse(readFileSync(inflight, 'utf8')).records) {
      const record = JSON.parse(json);
      assert.ok(stampEnd(record.hour ?? record.period ?? '') >= limit - DAY, `${label}: the in-flight batch still holds a ${record.name} for ${record.hour ?? record.period}, older than 7 days`);
    }
  }
}

/** One hour of the app's clock, then an upload attempt only when no backoff wait is running (a flush inside a wait is the DEFECT test's subject). */
async function stepHour(h) {
  h.clock.set(Math.ceil((h.clock.now() + 1) / HOUR) * HOUR + 1000);
  h.tel.tick();
  h.clock.advance(11 * 60000);
  if (h.tel.status().upload.backoffUntil === null) await h.tel.flushNow();
}
/** Flush until nothing is queued, waiting out any backoff and the 5 minute diagnostics spacing; never inside a backoff wait. */
async function drain(h, limit = 800) {
  for (let i = 0; i < limit; i++) {
    const queued = h.tel.status().outbox.queued;
    if (queued.counts + queued.diagnostics + queued.quota === 0) return;
    const until = h.tel.status().upload.backoffUntil;
    if (until !== null) h.clock.set(until); else h.clock.advance(6 * 60000);
    await h.tel.flushNow();
  }
}
const okRecords = transport => transport.requests.filter(r => r.status >= 200 && r.status < 300).flatMap(r => JSON.parse(r.body).batch.map(catalogView));
async function simulateOutage({failWith, t}) {
  const down = {on: true};
  const transport = captureTransport({respond: () => { if (down.on) { if (failWith === 'network') throw new Error('ENETUNREACH'); return {status: failWith}; } return {status: 200}; }});
  const h = makeTelemetry({transport, level: 'on', dir: ownTempDir(t, 'tel-offline-')});
  const control = makeTelemetry({level: 'on', dir: ownTempDir(t, 'tel-offline-')}); // the same life with a working network: what would have been delivered
  const driveOne = async (target, hour) => { liveHour(target, hour); await (target === h ? stepHour(h) : settle(target)); };
  for (let hour = 0; hour < 8 * 24; hour++) {
    await driveOne(h, hour);
    await driveOne(control, hour);
    assert.ok(h.tel.status().outbox.bytes <= 10 * MIB, `hour ${hour}: outbox over 10 MiB`);
    assertNothingOlderThanSevenDays(h, `hour ${hour}`);
  }
  assert.deepEqual(okRecords(h.transport), [], 'no request got through while the network was down');
  down.on = false;
  return {h, control, transport, outageEnd: h.clock.now()};
}

test('8 days offline through the facade: bounds hold, the transport recovers, drops are self-reported and equal the evicted records', {timeout: 120000}, async t => {
  const {h, control, transport, outageEnd} = await simulateOutage({failWith: 'network', t});
  try {
    // The backlog drains once the network is back (diagnostics go every 5 minutes, one batch each).
    await drain(h);
    await stepHour(h); await drain(h); // the hour that carries the telemetry.self counts closes and uploads
    // The control runs on to the outage run's clock: the drain above waits out backoffs for hours, and health.state is hourly.
    while (control.clock.now() < h.clock.now()) await stepHour(control);
    await drain(control);
    const queued = h.tel.status().outbox.queued;
    assert.equal(queued.counts + queued.diagnostics + queued.quota, 0, 'the backlog drained');
    // Batches obey the wire limits while draining.
    for (const batch of transport.bodies()) {
      assert.ok(batch.records.length <= 50, 'at most 50 records');
      if (batch.stream === 'quota') assert.equal(batch.records.length, 1, 'a quota week travels alone');
    }
    // What the app reported about its own drops, from the uploaded counts.
    const selfDrops = {};
    let reported = 0;
    for (const record of transport.records().filter(r => r.name === 'telemetry.self' && ['dropped_age', 'dropped_bytes'].includes(r.attrs.reason))) {
      selfDrops[record.attrs.entry] = (selfDrops[record.attrs.entry] ?? 0) + record.value;
      reported += record.value;
    }
    assert.ok(reported > 0, 'the outage evicted records and the app counted them');
    // For every record name: delivered + reported dropped == what a working network would have delivered.
    const delivered = recordsByName(transport), wouldHave = recordsByName(control.transport), mismatches = [];
    for (const name of Object.keys(wouldHave).filter(n => !['telemetry.self','health.state'].includes(n))) {
      const total = (delivered[name] ?? 0) + (selfDrops[name] ?? 0);
      if (total !== wouldHave[name]) mismatches.push(`${name}: delivered ${delivered[name] ?? 0} + self-reported dropped ${selfDrops[name] ?? 0} = ${total}, but the app made ${wouldHave[name]}`);
    }
    assert.deepEqual(mismatches, [], 'every evicted record is reported once and every delivered record was not reported dropped');
    assert.ok(control.transport.records().length > 0);
    // Nothing older than 7 days was delivered once the network returned (a record's period ends before it is queued: a day period by up to a day).
    for (const record of transport.records().filter(r => r.name !== 'telemetry.self' && r.name !== 'quota.week')) {
      const stamp = record.hour ?? record.period ?? '';
      const slack = SLACK + (stamp.length === 10 ? DAY : 0);
      assert.ok(stampEnd(stamp) >= outageEnd - 7 * DAY - slack, `${record.name} for ${stamp} was delivered after the outage although it is older than 7 days`);
    }
  } finally { h.cleanup(); control.cleanup(); }
});

test('DEFECT: a batch already in flight is still subject to the 7-day bound: a record reported dropped is not delivered later', () => {
  const dir = fastDir(), clock = manualClock();
  try {
    const drops = [];
    const outbox = createOutbox({dir, base: dir, now: clock.now, onDrop: (reason, n, name) => drops.push({reason, n, name})});
    outbox.append([{record: {...COUNTS, value: 1}, gen: 1, at: clock.now()}]);
    const batch = outbox.nextBatch({stream: 'counts', gen: 1, at: clock.now()});
    assert.equal(batch.records.length, 1); // the POST fails; the batch stays in flight
    clock.advance(8 * DAY);
    outbox.append([{record: {...COUNTS, value: 2}, gen: 1, at: clock.now()}]);
    outbox.enforceBounds(); // the hourly housekeeping
    assert.deepEqual(drops, [{reason: 'dropped_age', n: 1, name: 'problem.count'}], 'the 8-day-old record was evicted and reported');
    const retry = outbox.nextBatch({stream: 'counts', gen: 1, at: clock.now()});
    const values = (retry?.records ?? []).map(json => JSON.parse(json).value);
    assert.ok(!values.includes(1), 'the record that was reported dropped is delivered anyway, 8 days old (outbox.mjs nextBatch returns the stored in-flight batch without the age check)');
    assert.deepEqual(values, [2]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the self-reported drop counts are queryable from the next uploaded counts batch (reason and entry)', async t => {
  const {h, transport} = await simulateOutage({failWith: 503, t});
  try {
    await drain(h);
    await stepHour(h); await drain(h);
    const selfRecords = okRecords(transport).filter(r => r.name === 'telemetry.self');
    assert.ok(selfRecords.some(r => r.attrs.reason === 'dropped_age' && r.attrs.entry !== 'none'), 'age drops are counted per entry');
    for (const request of transport.requests.filter(r => r.status === 200)) { const batch = JSON.parse(request.body); if(batch.batch.some(event=>event.event==='telemetry.self'))assert.ok(batch.batch.every(event=>event.properties.$geoip_disable===true)); }
  } finally { h.cleanup(); }
});

// ---- Uploader behavior when the network answers --------------------------------------------------------------------

/** A telemetry whose app has one diagnostic ready to send; the transport answers by `respond`. */
async function oneBatchReady({respond, random, version, dir} = {}) {
  const transport = captureTransport({respond});
  const h = makeTelemetry({transport, ...(random ? {random} : {}), ...(version ? {version} : {}), ...(dir ? {dir} : {})});
  h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare'});
  h.tel.tick();
  return h;
}
const upload = h => h.tel.status().upload;

test('backoff doubles from 1 minute to the 6 hour cap, with the jitter factor, and waits are honored', async () => {
  for (const [random, jitter] of [[() => 0, 0.75], [() => 0.5, 1], [() => 1, 1.25]]) {
    const h = await oneBatchReady({respond: () => ({status: 503}), random});
    try {
      for (let n = 1; n <= 12; n++) {
        const before = h.transport.requests.length, at = h.clock.now();
        await h.tel.flushNow();
        assert.equal(h.transport.requests.length, before + 1, `failure ${n}: exactly one attempt`);
        assert.equal(upload(h).failures, n);
        const expected = Math.min(UPLOAD.maxBackoffMs,Math.max(UPLOAD.minBackoffMs,UPLOAD.minBackoffMs * 2 ** (n - 1) * jitter));
        assert.equal(upload(h).backoffUntil - at, expected, `failure ${n}, jitter ${jitter}: wait`);
        assert.ok(upload(h).backoffUntil - at <= UPLOAD.maxBackoffMs, 'never beyond the cap plus jitter');
        // At the end of the wait the next attempt goes out (a call during the wait is the DEFECT test below).
        h.clock.set(upload(h).backoffUntil);
      }
      assert.equal(UPLOAD.minBackoffMs, 60000);
      assert.equal(UPLOAD.maxBackoffMs, 6 * HOUR);
    } finally { h.cleanup(); }
  }
});

test('DEFECT: a flush during the backoff wait must not stop later flushes from uploading', async () => {
  const h = await oneBatchReady({respond: () => ({status: 503})});
  try {
    await h.tel.flushNow(); // the attempt fails: backing off for 45 s
    const wait = upload(h).backoffUntil - h.clock.now();
    assert.ok(wait > 0);
    h.clock.advance(wait / 3);
    await h.tel.flushNow(); // the 30 s upload timer fires inside the wait: nothing is due, nothing is sent
    assert.equal(h.transport.requests.length, 1, 'no attempt during the wait');
    h.clock.set(upload(h).backoffUntil + 1000);
    await h.tel.flushNow();
    assert.equal(h.transport.requests.length, 2, 'the attempt after the wait goes out (uploader.mjs flushNow: the early return inside the async function clears `running` before it is assigned, so it stays set for good)');
  } finally { h.cleanup(); }
});

test('a retry carries the same batch id, so the server can dedupe', async () => {
  const h = await oneBatchReady({respond: () => ({status: 503})});
  try {
    for (let n = 0; n < 4; n++) { await h.tel.flushNow(); h.clock.set(upload(h).backoffUntil); }
    const ids = new Set(h.transport.bodies().map(b => b.batch.map(event=>event.uuid).join()));
    assert.equal(h.transport.requests.length, 4);
    assert.equal(ids.size, 1);
  } finally { h.cleanup(); }
});

test('success resets the backoff', async () => {
  let fail = true;
  const h = await oneBatchReady({respond: () => ({status: fail ? 500 : 200})});
  try {
    await h.tel.flushNow(); h.clock.set(upload(h).backoffUntil);
    await h.tel.flushNow(); h.clock.set(upload(h).backoffUntil);
    assert.equal(upload(h).failures, 2);
    fail = false;
    await h.tel.flushNow();
    assert.equal(upload(h).failures, 0);
    assert.equal(upload(h).backoffUntil, null);
  } finally { h.cleanup(); }
});

test('429 with Retry-After: 120 makes the next attempt wait exactly 120 s; the cap is 6 h; a date and junk are handled', async () => {
  const cases = [
    ['120', 120000], ['0', 0], ['999999', 6 * HOUR], ['21600', 6 * HOUR], ['21601', 6 * HOUR],
  ];
  for (const [header, expected] of cases) {
    const h = await oneBatchReady({respond: () => ({status: 429, headers: {'retry-after': header}})});
    try {
      const at = h.clock.now();
      await h.tel.flushNow();
      assert.equal(upload(h).failures, 1);
      assert.equal((upload(h).backoffUntil ?? at) - at, expected, `Retry-After: ${header}`);
      if (expected > 0) {
        const requests = h.transport.requests.length;
        h.clock.set(at + expected);
        await h.tel.flushNow();
        assert.equal(h.transport.requests.length, requests + 1, 'one attempt as soon as it has');
      }
    } finally { h.cleanup(); }
  }
  // An HTTP date.
  const h = await oneBatchReady({respond: ({}) => ({status: 503, headers: {'retry-after': new Date(START + 50000).toUTCString()}})});
  try {
    const at = h.clock.now(); // START + 0 plus the second granularity of an HTTP date
    await h.tel.flushNow();
    assert.ok(Math.abs(upload(h).backoffUntil - (START + 50000)) <= 1000, `HTTP-date Retry-After: ${upload(h).backoffUntil - at}`);
  } finally { h.cleanup(); }
  // Junk falls back to the normal backoff.
  const junk = await oneBatchReady({respond: () => ({status: 429, headers: {'retry-after': 'soon'}})});
  try {
    const at = junk.clock.now();
    await junk.tel.flushNow();
    assert.equal(upload(junk).backoffUntil - at, UPLOAD.minBackoffMs);
  } finally { junk.cleanup(); }
});

test('400, 413, 415 and 422 drop the batch, count `rejected` and never retry it; later batches still go', async () => {
  for (const status of [400, 413, 415, 422]) {
    let calls = 0;
    const h = await oneBatchReady({respond: () => ({status: calls++ === 0 ? status : 200})});
    try {
      await h.tel.flushNow();
      assert.equal(h.transport.requests.length, 1);
      assert.equal(h.transport.requests[0].status, status);
      assert.equal(upload(h).backoffUntil, null, `${status}: a permanent rejection does not back off`);
      const item = h.tel.preview().items.find(i => i.state === 'rejected');
      assert.ok(item, `${status}: the rejected body stays in the sent ledger`);
      assert.equal(item.status, status);
      // Not retried, not queued again.
      h.clock.advance(7 * HOUR);
      await h.tel.flushNow();
      assert.ok(!h.transport.bodies().slice(1).some(b => b.batch.some(event=>h.transport.bodies()[0].batch.some(original=>original.uuid===event.uuid))), `${status}: the rejected batch was sent again`);
      assert.equal(h.tel.status().outbox.queued.diagnostics, 0, `${status}: the rejected batch left the queue`);
      // The count arrives in the next uploaded counts batch, naming the entry.
      await settle(h);
      const rejected = h.transport.records().filter(r => r.name === 'telemetry.self' && r.attrs.reason === 'rejected');
      assert.equal(rejected.reduce((sum, r) => sum + r.value, 0), 1, `${status}: one rejection counted`);
      assert.equal(rejected[0].attrs.entry, 'problem.observed.readiness');
    } finally { h.cleanup(); }
  }
});

test('401 and 403 halt uploads for this version: never retried, also after a restart, until a new version', async () => {
  for (const status of [401, 403]) {
    const dir = tmp();
    const h = await oneBatchReady({respond: () => ({status}), dir});
    try {
      await h.tel.flushNow();
      assert.equal(h.transport.requests.length, 1);
      assert.equal(upload(h).halted, true);
      for (let day = 1; day <= 3; day++) {
        h.clock.advance(day * DAY);
        h.tel.observe('lender-failure', {code: 'lender_failed', phase: 'run'});
        await settle(h);
        await h.tel.flushNow();
      }
      assert.equal(h.transport.requests.length, 1, `${status}: not retried`);
      // A restart of the same version stays halted.
      const sameVersion = makeTelemetry({dir, level: null, clock: h.clock, transport: h.transport});
      await sameVersion.tel.flushNow();
      assert.equal(sameVersion.transport.requests.length, 1, `${status}: still halted after a restart of the same version`);
      assert.equal(sameVersion.tel.status().upload.halted, true);
      // A new app version may try again.
      const next = makeTelemetry({dir, level: null, clock: h.clock, transport: captureTransport(), version: '0.1.0-preview.20261022.1'});
      await next.tel.flushNow();
      assert.ok(next.transport.requests.length >= 1, `${status}: a new version uploads again`);
      assert.equal(next.tel.status().upload.halted, false);
    } finally { rmSync(dir, {recursive: true, force: true}); }
  }
});

test('a hung request is aborted by a 5 s timeout and counted as a failure', {timeout: 10000}, async () => {
  assert.equal(UPLOAD.timeoutMs, 5000);
  // The module has no injected timeout: AbortSignal.timeout(5000) is called inline. The test records the requested duration and
  // shortens the real signal; the transport resolves only when its signal aborts.
  const real = AbortSignal.timeout, requested = [];
  AbortSignal.timeout = ms => { requested.push(ms); return real.call(AbortSignal, 30); };
  let aborts = 0;
  const hung = async (url, init) => new Promise((_, reject) => {
    assert.ok(init.signal instanceof AbortSignal);
    init.signal.addEventListener('abort', () => { aborts++; reject(init.signal.reason); });
  });
  try {
    const h = makeTelemetry({transport: hung});
    h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare'});
    h.tel.tick();
    await h.tel.flushNow();
    assert.deepEqual(requested, [5000], 'the request has a 5 s total timeout');
    assert.equal(aborts, 1, 'the hung request was aborted');
    assert.equal(upload(h).failures, 1);
    assert.equal(upload(h).last.error, 'network');
    assert.ok(upload(h).backoffUntil > h.clock.now(), 'a timeout backs off like any failure');
    assert.equal(h.tel.status().outbox.queued.diagnostics, 1, 'the batch is kept for the retry');
    h.cleanup();
  } finally { AbortSignal.timeout = real; }
});

test('the uploader sends no cookies and a fixed user-agent, and the version in the request is the packaged one', async () => {
  const h = await oneBatchReady();
  try {
    await h.tel.flushNow();
    assert.deepEqual(Object.keys(h.transport.requests[0].headers).sort(), ['content-encoding', 'content-type', 'user-agent']);
    assert.equal(h.transport.requests[0].headers['user-agent'], 'telemetry/1');
    assert.equal(h.transport.bodies()[0].batch[0].properties.app_version, RELEASE);
  } finally { h.cleanup(); }
});
