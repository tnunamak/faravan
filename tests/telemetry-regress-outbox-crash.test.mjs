import './helpers/no-browser.mjs';
// Outbox crash safety (docs/design/TELEMETRY.md §2.2 "Outbox" invariants, §6 "Outbox crash"): a child process appends and
// settles in a loop and is SIGKILLed at seeded random points. After every kill the parent reopens the outbox and checks that
// nothing complete was lost, a torn tail is skipped, the next append starts on a fresh line, the cursor never moves
// backwards, and nothing is delivered twice except across a crash between the POST and settle().
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, appendFileSync, truncateSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutbox } from '../lib/v1/telemetry/outbox.mjs';
import { seededBytes } from './helpers/telemetry-harness.mjs';

const GOLDEN = name => JSON.parse(readFileSync(new URL(`./telemetry/golden/${name}.record.json`, import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 9, 21, 19, 30, 0); // every record is "appended" at this fixed time, so age bounds never interfere
const GEN = 1;
const outboxUrl = new URL('../lib/v1/telemetry/outbox.mjs', import.meta.url).href;

// A counts record carries its id in `value`, a diagnostic in `seq`. Odd ids are diagnostics, even ids counts.
const COUNTS = GOLDEN('problem.count'), DIAG = GOLDEN('problem.observed.readiness');
const recordFor = id => (id % 2 === 0 ? {...COUNTS, value: id} : {...DIAG, seq: id});
const idOf = record => (record.name === 'problem.count' ? record.value : record.seq);
const streamOfId = id => (id % 2 === 0 ? 'counts' : 'diagnostics');

/** The child: append records (and now and then take a batch and settle it), report every step on stdout with a synchronous write. */
const CHILD = `
import { writeSync } from 'node:fs';
import { createOutbox } from ${JSON.stringify(outboxUrl)};
const [dir, start, seed, nowMs] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3]), Number(process.argv[4])];
const counts = JSON.parse(process.argv[5]), diag = JSON.parse(process.argv[6]);
const say = text => writeSync(1, text + '\\n');
let state = seed >>> 0;
const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
const outbox = createOutbox({dir, base: dir, now: () => nowMs, bytes: n => Buffer.from(Array.from({length: n}, () => Math.floor(rand() * 256)))});
say('READY');
for (let id = start, round = 0; ; round++) {
  const items = [], ids = [];
  const size = 1 + Math.floor(rand() * 3); // one append call carries one to three records: one write, one fsync
  for (let j = 0; j < size; j++, id++) {
    items.push({record: id % 2 === 0 ? {...counts, value: id} : {...diag, seq: id}, gen: 1, notBefore: 0, at: nowMs});
    ids.push(id);
  }
  outbox.append(items);
  for (const appended of ids) say('A ' + appended);
  if (round % 2 === 1) {
    for (const stream of ['counts', 'diagnostics']) {
      const batch = outbox.nextBatch({stream, gen: 1, at: nowMs, maxRecords: 5});
      if (!batch) continue;
      const taken = batch.records.flatMap(json => { try { const r = JSON.parse(json); return [r.name === 'problem.count' ? r.value : r.seq]; } catch { return []; } }); // a glued torn tail is the known defect, not this test's subject
      say('B ' + taken.join(','));
      outbox.settle(batch, {body: batch.records.join('\\n'), outcome: 'sent', status: 200, at: nowMs});
      say('D ' + taken.join(','));
    }
  }
}
`;

/** Run the child until a seeded delay after its first acknowledged append, then SIGKILL it. Resolves with the lines it managed to print. */
function runAndKill({dir, start, seed, delayMs, settleFirst = false}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD, dir, String(start), String(seed), String(NOW), JSON.stringify(COUNTS), JSON.stringify(DIAG)],
      {stdio: ['ignore', 'pipe', 'pipe'], env: {...process.env, HOME: dir}});
    let out = '', err = '', killed = false;
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child did not reach the requested checkpoint')); }, 30000);
    child.stdout.on('data', chunk => {
      out += chunk;
      const reached = settleFirst ? /^D /m.test(out) : out.includes('A ');
      if (!killed && reached) { killed = true; clearTimeout(deadline); setTimeout(() => child.kill('SIGKILL'), settleFirst ? 0 : delayMs); }
    });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(deadline);
      if (signal !== 'SIGKILL') return reject(new Error(`child was not killed: code ${code} signal ${signal}: ${err}`));
      resolve(out.split('\n'));
    });
  });
}

const cursorOf = dir => JSON.parse(readFileSync(join(dir, 'outbox', 'cursor.json'), 'utf8'));
/** (seq, offset) per lane must never decrease; `next` must never decrease. */
function assertCursorForward(before, after, label) {
  assert.ok(after.next >= before.next, `${label}: cursor.next went backwards (${before.next} -> ${after.next})`);
  for (const [lane, was] of Object.entries(before.lanes)) {
    const now = after.lanes[lane];
    assert.ok(now, `${label}: lane ${lane} vanished from the cursor`);
    assert.ok(now.seq > was.seq || (now.seq === was.seq && now.offset >= was.offset), `${label}: lane ${lane} moved back ${JSON.stringify(was)} -> ${JSON.stringify(now)}`);
  }
}
const parses = json => { try { JSON.parse(json); return true; } catch { return false; } };
/** Ids of the queued records whose body is valid JSON. A garbage body is reported separately (see the DEFECT test). */
const queuedIds = outbox => outbox.inspect({gen: GEN, at: NOW}).filter(item => item.state === 'queued' && parses(item.body)).map(item => idOf(JSON.parse(item.body)));
const garbageBodies = outbox => outbox.inspect({gen: GEN, at: NOW}).filter(item => item.state === 'queued' && !parses(item.body)).length;
const segmentsOf = dir => readdirSync(join(dir, 'outbox')).filter(name => name.endsWith('.jsonl')).sort();

test('50 SIGKILLs: complete records survive, torn tails are skipped, the cursor only moves forward, nothing repeats', {timeout: 180000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-crash-'));
  try {
    let state = 12345;
    const rand = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
    const acked = new Set(), batchTaken = new Set(), delivered = new Set();
    const cutOffIds = new Set(), maybe = new Set(); // maybe: the (up to three) records of the append call a kill interrupted
    let nextId = 1, lastCursor = {next: 0, lanes: {}}, tornRuns = 0, inflightRuns = 0, settledByChild = 0;
    const deliveries = new Map(); // id -> how many times a batch carrying it was settled (child or parent)

    for (let run = 0; run < 50; run++) {
      const label = `run ${run}`;
      const lines = await runAndKill({dir, start: nextId, seed: 1000 + run, delayMs: Math.floor(rand() * 160), settleFirst: run === 0});
      let maxPrinted = nextId - 1;
      for (const line of lines) {
        const [tag, rest] = [line[0], line.slice(2)];
        if (tag === 'A') { const id = Number(rest); acked.add(id); maxPrinted = Math.max(maxPrinted, id); }
        else if (tag === 'B' && rest.length) rest.split(',').forEach(id => batchTaken.add(Number(id)));
        else if (tag === 'D' && rest.length) { settledByChild++; for (const id of rest.split(',').map(Number)) { delivered.add(id); deliveries.set(id, (deliveries.get(id) ?? 0) + 1); } }
      }
      for (let j = 1; j <= 3; j++) maybe.add(maxPrinted + j);
      // A line cut by the kill is not trusted (it has no newline after it): only complete lines are in `lines` before the last element.
      assert.ok(acked.size > 0, `${label}: the child appended nothing before it was killed (kill too early to be meaningful)`);

      // What the kill left on disk, before the parent touches anything. The outbox keeps one in-flight file per stream
      // (inflight-<stream>.json), so outbox/inflight.json is never written here: inflightBefore is always null, and the
      // allowances for a batch in flight (inflightIds, fromInflight) never apply. A record delivered again after a crash
      // between POST and settle is reported. telemetry-outbox-crash.test.mjs reads each stream's file.
      const inflightPath = join(dir, 'outbox', 'inflight.json');
      const inflightBefore = existsSync(inflightPath) ? JSON.parse(readFileSync(inflightPath, 'utf8')) : null;
      const inflightIds = new Set((inflightBefore?.records ?? []).filter(parses).map(json => idOf(JSON.parse(json))));
      if (inflightBefore) inflightRuns++;

      // Damage the tail some of the time, the way a power cut would: a half-written line, or a final line cut short.
      const bySeq = (a, b) => Number(a.match(/-(\d+)\.jsonl$/)[1]) - Number(b.match(/-(\d+)\.jsonl$/)[1]);
      const lanesOnDisk = ['counts.', 'diagnostics.'].map(prefix => segmentsOf(dir).filter(name => name.startsWith(prefix)).sort(bySeq)).filter(list => list.length);
      const countsSegments = lanesOnDisk.length ? lanesOnDisk[run % 2 === 0 ? 0 : lanesOnDisk.length - 1] : []; // the segment to damage, in whichever lane has one
      const damagedStream = countsSegments.length ? (countsSegments[0].startsWith('counts.') ? 'counts' : 'diagnostics') : null;
      let cutOff = null;
      if (run % 4 === 1 && countsSegments.length) {
        const file = join(dir, 'outbox', countsSegments.at(-1));
        appendFileSync(file, `${GEN}\t0\t${NOW}\t{"name":"problem.cou`); // no newline: a torn tail
        tornRuns++;
      } else if (run % 4 === 3 && countsSegments.length) {
        const file = join(dir, 'outbox', countsSegments.at(-1));
        const text = readFileSync(file, 'utf8');
        const lastLine = text.slice(0, -1).split('\n').at(-1);
        // Only an unconsumed tail can be torn by a power cut: bytes the cursor already passed were fsynced long before.
        const at = cursorOf(dir).lanes[file.split('/').at(-1).replace(/-\d+\.jsonl$/, '')];
        const consumed = at && at.seq === Number(file.match(/-(\d+)\.jsonl$/)[1]) && at.offset > text.length - lastLine.length - 1;
        if (text.endsWith('\n') && lastLine.includes('\t{') && !consumed && !inflightBefore) { // a batch already taken points at byte offsets, so its records are not torn tails
          cutOff = idOf(JSON.parse(lastLine.split('\t').slice(3).join('\t')));
          truncateSync(file, statSync(file).size - 1 - Math.floor(rand() * (lastLine.length - 8))); // cuts into the last record, removing its newline
        }
      }

      if (cutOff !== null) cutOffIds.add(cutOff);
      // ---- Reopen. Every complete record must be readable, none twice.
      const outbox = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(run + 1)});
      assertCursorForward(lastCursor, cursorOf(dir), `${label} (reopen)`);
      const queued = queuedIds(outbox);
      assert.equal(new Set(queued).size, queued.length, `${label}: a record is queued twice`);
      for (const id of queued) assert.ok(acked.has(id) || maybe.has(id) || batchTaken.has(id), `${label}: record ${id} is queued but was never appended`);
      for (const id of acked) {
        if (cutOffIds.has(id)) continue; // the parent cut this one off itself
        if (delivered.has(id) || batchTaken.has(id)) continue; // consumed, or in a batch whose settle the kill may have interrupted
        assert.ok(queued.includes(id), `${label}: acknowledged record ${id} is neither queued nor delivered`);
      }
      if (cutOff !== null) assert.ok(!queued.includes(cutOff), `${label}: a record cut short was read as complete`);
      // Per lane the readable order is the append order.
      for (const stream of ['counts', 'diagnostics']) {
        const ids = queued.filter(id => streamOfId(id) === stream);
        assert.deepEqual(ids, [...ids].sort((a, b) => a - b), `${label}: ${stream} records out of order`);
      }
      // Records the child delivered must not be queued again, unless a settle was cut in half (then the same batch is still in flight).
      for (const id of delivered) assert.ok(!queued.includes(id) || inflightIds.has(id), `${label}: delivered record ${id} is queued again`);

      // ---- The next append starts on a fresh line and is readable.
      const top = Math.max(nextId, maxPrinted, ...queued, ...acked);
      const wantEven = (damagedStream ?? 'counts') === 'counts'; // the new record goes to the lane that was damaged
      const markerId = (top + 1) % 2 === (wantEven ? 0 : 1) ? top + 1 : top + 2;
      nextId = markerId + 1;
      outbox.append([{record: recordFor(markerId), gen: GEN, notBefore: 0, at: NOW}]);
      acked.add(markerId);
      assert.equal(streamOfId(markerId), damagedStream ?? 'counts');
      assert.ok(queuedIds(outbox).includes(markerId), `${label}: the record appended after the crash is not readable`);
      assert.ok(queuedIds(outbox).filter(id => !queued.includes(id)).every(id => id === markerId), `${label}: the append produced something other than the marker`);
      // ---- Deliver what is queued (on most runs) the way the uploader does, and check the monotonic cursor and no repeats.
      if (run % 5 !== 4) {
        const reopened = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(100 + run)});
        for (const stream of ['counts', 'diagnostics']) {
          for (let guard = 0; guard < 500; guard++) {
            const batch = reopened.nextBatch({stream, gen: GEN, at: NOW, maxRecords: 50});
            if (!batch) break;
            const ids = batch.records.filter(parses).map(json => idOf(JSON.parse(json)));
            const fromInflight = inflightBefore && batch.id === inflightBefore.id;
            for (const id of ids) {
              if (delivered.has(id) && !(fromInflight && inflightIds.has(id))) assert.fail(`${label}: record ${id} was delivered twice outside a POST-to-settle crash`);
              assert.equal(streamOfId(id), stream, `${label}: batch of ${stream} carries ${id}`);
            }
            reopened.settle(batch, {body: batch.records.join('\n'), outcome: 'sent', status: 200, at: NOW});
            for (const id of ids) { delivered.add(id); deliveries.set(id, (deliveries.get(id) ?? 0) + 1); }
          }
        }
        assertCursorForward(lastCursor, cursorOf(dir), `${label} (after delivery)`);
      }
      lastCursor = cursorOf(dir);
    }
    // Over 50 kills the damage cases did occur, and a duplicate delivery only ever came from an interrupted settle.
    assert.ok(tornRuns >= 8, `torn-tail cases ran: ${tornRuns}`);
    // Exercise a truncated complete tail independently of the random kill timing and in-flight state.
    const truncatedDir = mkdtempSync(join(tmpdir(), 'tel-truncated-'));
    try {
      const fresh = createOutbox({dir: truncatedDir, base: truncatedDir, now: () => NOW, bytes: seededBytes(201)});
      fresh.append([{record: recordFor(2), gen: GEN, notBefore: 0, at: NOW}]);
      const file = join(truncatedDir, 'outbox', segmentsOf(truncatedDir)[0]);
      truncateSync(file, statSync(file).size - 5);
      const recovered = createOutbox({dir: truncatedDir, base: truncatedDir, now: () => NOW, bytes: seededBytes(202)});
      assert.ok(!queuedIds(recovered).includes(2), 'a truncated tail is not read as a complete record');
      recovered.append([{record: recordFor(4), gen: GEN, notBefore: 0, at: NOW}]);
      assert.ok(queuedIds(recovered).includes(4), 'a new record remains readable after the truncated tail');
    } finally { rmSync(truncatedDir, {recursive: true, force: true}); }
    assert.ok(settledByChild > 0, 'the child settled batches before it was killed');
    for (const [id, times] of deliveries) assert.ok(times <= 2, `record ${id} was delivered ${times} times`);
      } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a crash between the POST and settle() returns the same batch id and the same records', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-crash-'));
  try {
    const first = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(1)});
    for (let id = 2; id <= 12; id += 2) first.append([{record: recordFor(id), gen: GEN, notBefore: 0, at: NOW}]);
    const taken = first.nextBatch({stream: 'counts', gen: GEN, at: NOW, maxRecords: 3});
    assert.equal(taken.records.length, 3);
    // The process dies here: the POST succeeded, settle never ran. A new process opens the same directory.
    const second = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(2)});
    const again = second.nextBatch({stream: 'counts', gen: GEN, at: NOW, maxRecords: 3});
    assert.equal(again.id, taken.id, 'the same batch id, so the server can dedupe');
    assert.deepEqual(again.records, taken.records);
    // After settle, the next batch moves on and the settled records never return.
    second.settle(again, {body: again.records.join('\n'), outcome: 'sent', status: 200, at: NOW});
    const next = second.nextBatch({stream: 'counts', gen: GEN, at: NOW, maxRecords: 3});
    assert.notEqual(next.id, taken.id);
    assert.deepEqual(next.records.map(json => JSON.parse(json).value), [8, 10, 12]);
    assert.ok(!next.records.some(json => taken.records.includes(json)));
    // And a third process, after another settle, finds nothing in flight and nothing left.
    second.settle(next, {body: '', outcome: 'sent', status: 200, at: NOW});
    const third = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(3)});
    assert.equal(third.inflight(), null);
    assert.equal(third.nextBatch({stream: 'counts', gen: GEN, at: NOW}), null);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a torn tail is skipped on read and the next append is readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-crash-'));
  try {
    const outbox = createOutbox({dir, base: dir, now: () => NOW});
    outbox.append([{record: recordFor(2), gen: GEN, notBefore: 0, at: NOW}]);
    const file = join(dir, 'outbox', segmentsOf(dir)[0]);
    appendFileSync(file, `${GEN}\t0\t${NOW}\t{"name":"problem.count","per`); // power cut in the middle of a line
    const reopened = createOutbox({dir, base: dir, now: () => NOW});
    assert.deepEqual(queuedIds(reopened), [2], 'the torn line is not a record');
    assert.equal(garbageBodies(reopened), 0);
    assert.deepEqual(reopened.nextBatch({stream: 'counts', gen: GEN, at: NOW}).records.map(json => JSON.parse(json).value), [2]);
    reopened.append([{record: recordFor(4), gen: GEN, notBefore: 0, at: NOW}]);
    assert.ok(queuedIds(reopened).includes(4), 'the new record is readable and is not part of the torn line');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('DEFECT: after a torn tail and a new append, the torn fragment is not delivered as a record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-crash-'));
  try {
    const outbox = createOutbox({dir, base: dir, now: () => NOW});
    outbox.append([{record: recordFor(2), gen: GEN, notBefore: 0, at: NOW}]);
    const file = join(dir, 'outbox', segmentsOf(dir)[0]);
    appendFileSync(file, `${GEN}\t0\t${NOW}\t{"name":"problem.count","per`);
    const reopened = createOutbox({dir, base: dir, now: () => NOW});
    reopened.append([{record: recordFor(4), gen: GEN, notBefore: 0, at: NOW}]); // terminates the torn line with a newline
    assert.equal(garbageBodies(reopened), 0, 'the terminated torn line is still skipped on read (design: "a torn last line after a crash is skipped")');
    const batch = reopened.nextBatch({stream: 'counts', gen: GEN, at: NOW});
    assert.ok(batch.records.every(parses), 'every record in a batch is valid JSON, so the uploader does not reject the whole batch');
    assert.deepEqual(batch.records.map(json => JSON.parse(json).value), [2, 4]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a corrupt cursor.json is survivable: every segment is read from its start and the server dedupes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-crash-'));
  try {
    const outbox = createOutbox({dir, base: dir, now: () => NOW});
    for (const id of [2, 4]) outbox.append([{record: recordFor(id), gen: GEN, notBefore: 0, at: NOW}]);
    appendFileSync(join(dir, 'outbox', 'cursor.json'), '{ torn');
    const reopened = createOutbox({dir, base: dir, now: () => NOW});
    assert.deepEqual(queuedIds(reopened), [2, 4]);
    assert.doesNotThrow(() => reopened.append([{record: recordFor(6), gen: GEN, notBefore: 0, at: NOW}]));
    assert.deepEqual(queuedIds(reopened), [2, 4, 6]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('the cursor only moves forward: a late or repeated settle of an older batch changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-crash-'));
  try {
    const outbox = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(4)});
    for (let id = 2; id <= 10; id += 2) outbox.append([{record: recordFor(id), gen: GEN, notBefore: 0, at: NOW}]);
    const first = outbox.nextBatch({stream: 'counts', gen: GEN, at: NOW, maxRecords: 2});
    const stale = structuredClone(first);
    outbox.settle(first, {body: 'a', outcome: 'sent', status: 200, at: NOW});
    const second = outbox.nextBatch({stream: 'counts', gen: GEN, at: NOW, maxRecords: 2});
    outbox.settle(second, {body: 'b', outcome: 'sent', status: 200, at: NOW});
    const before = cursorOf(dir);
    outbox.settle(stale, {body: 'a', outcome: 'sent', status: 200, at: NOW});
    assertCursorForward(before, cursorOf(dir), 'stale settle');
    assert.deepEqual(cursorOf(dir).lanes, before.lanes);
    const rest = outbox.nextBatch({stream: 'counts', gen: GEN, at: NOW});
    assert.deepEqual(rest.records.map(json => JSON.parse(json).value), [10], 'the stale settle did not bring delivered records back');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('DEFECT: a batch in flight keeps its batch id when another stream takes a batch meanwhile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tel-crash-'));
  try {
    const outbox = createOutbox({dir, base: dir, now: () => NOW, bytes: seededBytes(5)});
    outbox.append([{record: recordFor(1), gen: GEN, notBefore: 0, at: NOW}]); // a diagnostic
    const diagnostics = outbox.nextBatch({stream: 'diagnostics', gen: GEN, at: NOW});
    // The POST of that batch failed; an hour closes and a counts record is due before the retry.
    outbox.append([{record: recordFor(2), gen: GEN, notBefore: 0, at: NOW}]);
    const counts = outbox.nextBatch({stream: 'counts', gen: GEN, at: NOW});
    assert.ok(counts);
    // The retry of the diagnostics batch must reuse its id (design: delivery is at least once, the server dedupes on batch_id).
    const retry = outbox.nextBatch({stream: 'diagnostics', gen: GEN, at: NOW});
    assert.equal(retry?.id, diagnostics.id, 'the second stream\'s batch replaced inflight.json, so the first batch was re-made under a new id (outbox.mjs nextBatch: one inflight slot for all streams)');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
