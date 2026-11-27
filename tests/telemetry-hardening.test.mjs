import './helpers/no-browser.mjs';
// Regressions for what the reviews of the runtime found: each test is one concrete input or interleaving.
import { tempDir } from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutbox, OUTBOX_LIMITS } from '../lib/v1/telemetry/outbox.mjs';
import { createConsent } from '../lib/v1/telemetry/consent.mjs';
import { createUploader } from '../lib/v1/telemetry/uploader.mjs';
import { createRollup, ROLLUP_LIMITS } from '../lib/v1/telemetry/rollup.mjs';
import { createTelemetry } from '../lib/v1/telemetry/index.mjs';
import { project } from '../lib/v1/telemetry/projection.mjs';
import { forwardedHeaders } from '../lib/v1/telemetry/switch.mjs';
import { parseRecord } from '../lib/v1/telemetry/catalog.mjs';
import { captureTransport, makeTelemetry, manualClock, seededBytes, settle, ENDPOINT, RELEASE, START } from './helpers/telemetry-harness.mjs';

const scratch = () => tempDir('tel-hard-');
const problem = {name: 'problem.count', period: '2026-10-21T19', attrs: {'error.type': 'unknown', 'problem.registry': 'problem', component: 'app', phase: 'none', outcome: 'requeue', surface: 'http'}, value: 1};
const diag = {name: 'problem.observed.readiness', kind: 'event', hour: '2026-10-21T19', rid: 'r-AAAAAAAAAAAAAAAAAAAA', epoch: 'e-AAAAAAAAAAAAAAAAAAAA', session: 's-AAAAAAAAAAAAAAAAAAAA', seq: 1, attrs: problem.attrs};
const wire = record => parseRecord(record, {origin: 'app'});

function rig({tripwire = async () => null, transport = captureTransport()} = {}) {
  const dir = scratch(), now = () => START + 7200000;
  const consent = createConsent({dir, base: dir, uploadable: true, bytes: seededBytes(1), now});
  consent.choose({level: 'on', region: 'US'});
  const outbox = createOutbox({dir, base: dir, now, bytes: seededBytes(2)});
  const uploader = createUploader({allowed:()=>true, consent, outbox, transport, endpoint: ENDPOINT, version: RELEASE, platform: {osType: 'linux', arch: 'amd64'}, tripwire, onSelf: () => {}, now, random: () => 0});
  return {dir, consent, outbox, uploader, transport};
}

test('an in-flight batch from an earlier generation is never reused, also after a crash between the policy write and the re-stamp', () => {
  const dir = scratch();
  try {
    const outbox = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(3)});
    outbox.append([{record: wire(diag), gen: 1, notBefore: 0, at: START}]);
    const first = outbox.nextBatch({stream: 'diagnostics', gen: 1, at: START});
    assert.equal(first.gen, 1);
    // The policy moved to generation 2 and the process died before the transition ran. A restart asks under generation 2.
    const again = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(4)});
    assert.equal(again.nextBatch({stream: 'diagnostics', gen: 2, at: START}), null, 'the old batch is not offered under the new consent');
    assert.ok(!readdirSync(join(dir, 'outbox')).some(name => name.startsWith('inflight-diagnostics')), 'and its file is gone');
    assert.equal(again.nextBatch({stream: 'diagnostics', gen: 1, at: START}), null, 'its records were dropped as stale');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('a consent change while the tripwire is awaited sends nothing', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const r = rig({tripwire: () => gate});
  r.outbox.append([{record: wire(diag), gen: r.consent.current().generation, notBefore: 0, at: START}]);
  const flush = r.uploader.flushNow();
  await new Promise(resolve => setImmediate(resolve));
  const change = r.consent.restrict(); // the person turns telemetry off: the transition purges and aborts
  r.uploader.abort();
  r.outbox.purge();
  release(null);
  await flush;
  assert.equal(change.after.effective, 'off');
  assert.equal(r.transport.requests.length, 0, 'the payload chosen before the change is not sent after it');
  rmSync(r.dir, {recursive: true, force: true});
});

test('a flush that fails during backoff does not stop later flushes, after the wait ends', async () => {
  let now = START + 7200000, fail = true;
  const dir = scratch();
  const consent = createConsent({dir, base: dir, uploadable: true, bytes: seededBytes(1), now: () => now});
  consent.choose({level: 'on', region: 'US'});
  const outbox = createOutbox({dir, base: dir, now: () => now, bytes: seededBytes(2)});
  const transport = captureTransport({respond: () => ({status: fail ? 503 : 200})});
  const uploader = createUploader({allowed:()=>true, consent, outbox, transport, endpoint: ENDPOINT, version: RELEASE, platform: {osType: 'linux', arch: 'amd64'}, tripwire: async () => null, now: () => now, random: () => 0.5});
  outbox.append([{record: wire(diag), gen: consent.current().generation, notBefore: 0, at: now}]);
  await uploader.flushNow();
  assert.equal(transport.requests.length, 1);
  await uploader.flushNow(); // inside the backoff wait
  assert.equal(transport.requests.length, 1);
  fail = false; now += 7 * 3600000;
  await uploader.flushNow();
  assert.equal(transport.requests.length, 2, 'the latch is gone once the wait has passed');
  assert.equal(uploader.status().failures, 0);
  rmSync(dir, {recursive: true, force: true});
});

test('request suppression marks fail closed when full, and expire with the job', () => {
  let t = START;
  const view = {gen: 1, streams: ['counts', 'diagnostics', 'quota']};
  const rollup = createRollup({now: () => t, identity: () => ({epoch: 'e-' + 'A'.repeat(20), session: 's-' + 'A'.repeat(20)}), bytes: seededBytes(5)});
  for (let i = 0; i < ROLLUP_LIMITS.suppressed; i++) rollup.observe({op: 'suppress', key: 'borrower:j' + i}, view);
  // The 1,001st request asked to be left out, but its mark does not fit: its job must not be captured.
  rollup.observe({op: 'suppress', key: 'borrower:extra'}, view);
  const lifecycle = key => { rollup.observe({op: 'span', family: 'job.run', key, step: 'open', abandon: {'job.role': 'borrower', outcome: 'abandoned'}}, view);
    rollup.observe({op: 'span', family: 'job.run', key, step: 'close', attrs: {'job.role': 'borrower', outcome: 'finished'}}, view); };
  lifecycle('borrower:extra');
  t += 3 * 86400000;
  const first = rollup.closeDue(view);
  // 48 hours later every mark has expired and the set has room again.
  lifecycle('borrower:extra');
  t += 3 * 86400000;
  const later = rollup.closeDue(view);
  assert.equal(first.some(i => i.record.name === 'job.outcome.count'), false, 'no capture while the marks were full');
  assert.equal(later.some(i => i.record.name === 'job.outcome.count'), true, 'capture resumes once the marks expired');
});

test('the stages of one span and the finished records waiting for housekeeping are bounded', () => {
  const view = {gen: 1, streams: ['counts', 'diagnostics', 'quota']};
  const self = [];
  const rollup = createRollup({now: () => START, identity: () => ({epoch: 'e-' + 'A'.repeat(20), session: 's-' + 'A'.repeat(20)}), bytes: seededBytes(6), onSelf: (...args) => self.push(args)});
  rollup.observe({op: 'span', family: 'job.run', key: 'k', step: 'open', stageName: 'waiting', abandon: {'job.role': 'borrower', outcome: 'abandoned'}}, view);
  for (let i = 0; i < 500; i++) rollup.observe({op: 'span', family: 'job.run', key: 'k', step: 'stage', stage: i % 2 ? 'run' : 'prepare'}, view);
  assert.ok(rollup.snapshot().spans[0].stages.length <= ROLLUP_LIMITS.stages);
  for (let i = 0; i < ROLLUP_LIMITS.ready + 100; i++) rollup.observe({op: 'record', name: 'quota.week', attrs: {n: i}}, view);
  assert.equal(rollup.stats().ready, ROLLUP_LIMITS.ready);
  assert.ok(self.some(([reason]) => reason === 'rollup_full'));
});

test('rollup state that could not be written is written again by a later tick', async () => {
  const h = makeTelemetry();
  h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare'});
  h.clock.advance(70000);
  rmSync(join(h.dir, 'rollup.json'), {force: true});
  mkdirSync(join(h.dir, 'rollup.json')); // a directory in its place: the save fails
  h.tel.tick();
  rmSync(join(h.dir, 'rollup.json'), {recursive: true, force: true});
  h.clock.advance(70000);
  h.tel.tick(); // nothing new was observed, but the state is still unsaved
  assert.ok(readdirSync(h.dir).includes('rollup.json'));
  h.cleanup();
});

test('a borrower request that was seen claimed and then ran out of retries is reported as retry_exhausted', () => {
  const digest = 'sha256:' + 'b'.repeat(64);
  const payload = {created_at: '2026-10-21T19:00:00.000Z', expires_at: '2026-10-22T01:00:00.000Z', requirements: {harness: ['codex']}};
  const claimed = project('event:job', {job_digest: digest, state: 'claimed', attempts_started: 1, current_attempt: {claimed_at: '2026-10-21T19:01:00.000Z'}, job: {payload}}, {});
  assert.equal(claimed.some(o => o.name === 'lending.request.outcome'), false, 'a claim alone is not the outcome');
  const failed = project('event:job', {job_digest: digest, state: 'failed', attempts_started: 3, waiting_reason: 'retry_exhausted', current_attempt: {}, job: {payload}}, {});
  assert.equal(failed.find(o => o.name === 'lending.request.outcome').attrs.outcome, 'retry_exhausted');
});

test('telemetry that cannot be set up leaves the app with a facade that does nothing', async () => {
  const dir = join(scratch(), 'a-file');
  writeFileSync(dir, 'not a directory');
  const tel = createTelemetry({dir, base: dir, env: {}, version: RELEASE, endpoint: ENDPOINT});
  assert.equal(tel.view().effective, 'off');
  assert.equal(tel.view().reason.kind, 'unavailable');
  tel.observe('lender-failure', {code: 'x'}); tel.response({}); tel.tick(); tel.start();
  assert.deepEqual(tel.preview().items, []);
  await tel.close();
  assert.throws(() => tel.choose({level: 'on'}), /telemetry_unavailable/);
});

test('every way of asking to be left out reaches the inner call as the one header it understands', () => {
  assert.deepEqual(forwardedHeaders({'sec-gpc': '1'}), {'faravan-telemetry': 'off'});
  assert.deepEqual(forwardedHeaders({'faravan-telemetry': 'off', 'faravan-surface': 'mcp'}), {'faravan-surface': 'mcp', 'faravan-telemetry': 'off'});
  assert.deepEqual(forwardedHeaders({'sec-gpc': '0'}), {});
  assert.deepEqual(forwardedHeaders({'faravan-surface': 'cli'}), {'faravan-surface': 'cli'});
});

// ---- Round 2 -----------------------------------------------------------------------------------------------------

test('a refused suppression mark keeps job capture off until it could expire, even after another mark is released', () => {
  let t = START;
  const view = {gen: 1, streams: ['counts', 'diagnostics', 'quota']};
  const rollup = createRollup({now: () => t, identity: () => ({epoch: 'e-' + 'A'.repeat(20), session: 's-' + 'A'.repeat(20)}), bytes: seededBytes(8)});
  const life = (key, ...steps) => steps.forEach(step => rollup.observe(step === 'open'
    ? {op: 'span', family: 'job.run', key, step: 'open', abandon: {'job.role': 'borrower', outcome: 'abandoned'}}
    : {op: 'span', family: 'job.run', key, step: 'close', attrs: {'job.role': 'borrower', outcome: 'finished'}}, view));
  for (let i = 0; i < ROLLUP_LIMITS.suppressed; i++) rollup.observe({op: 'suppress', key: 'borrower:m' + i}, view);
  life('borrower:x', 'open'); // X was already open when its mark is refused
  rollup.observe({op: 'suppress', key: 'borrower:x'}, view);
  life('borrower:m0', 'close'); // a marked job ends: its slot is free again
  life('borrower:x', 'close'); // X's lifecycle must still not be captured
  life('borrower:y', 'open', 'close'); // and neither is any other new job while the horizon lasts
  t += 3600000;
  assert.equal(rollup.closeDue(view).some(item => item.record.name.startsWith('job.')), false);
  // The horizon survives a restart.
  const again = createRollup({now: () => t, identity: () => ({epoch: 'e-' + 'A'.repeat(20), session: 's-' + 'A'.repeat(20)}), bytes: seededBytes(9)});
  again.restore(JSON.parse(JSON.stringify(rollup.snapshot())), {gen: 1});
  again.observe({op: 'span', family: 'job.run', key: 'borrower:z', step: 'close', attrs: {'job.role': 'borrower', outcome: 'finished'}}, view);
  t += 86400000;
  assert.equal(again.closeDue(view).some(item => item.record.name.startsWith('job.')), false);
  t += 3 * 86400000; // past the horizon
  again.observe({op: 'span', family: 'job.run', key: 'borrower:w', step: 'close', attrs: {'job.role': 'borrower', outcome: 'finished'}}, view);
  t += 86400000;
  assert.equal(again.closeDue(view).some(item => item.record.name === 'job.outcome.count'), true);
});

test('a response that arrives while the body is being cancelled, after consent changed, is not recorded', async () => {
  const dir = scratch(), now = () => START + 7200000;
  const consent = createConsent({dir, base: dir, uploadable: true, bytes: seededBytes(1), now});
  consent.choose({level: 'on', region: 'US'});
  const outbox = createOutbox({dir, base: dir, now, bytes: seededBytes(2)});
  let release;
  const transport = async () => ({status: 200, headers: new Headers(), body: {cancel: () => new Promise(resolve => { release = resolve; })}});
  const uploader = createUploader({allowed:()=>true, consent, outbox, transport, endpoint: ENDPOINT, version: RELEASE, platform: {osType: 'linux', arch: 'amd64'}, tripwire: async () => null, now, random: () => 0});
  outbox.append([{record: wire(diag), gen: consent.current().generation, notBefore: 0, at: START}]);
  const flush = uploader.flushNow();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  consent.restrict();
  outbox.purge(); // the transition
  release();
  await flush;
  assert.deepEqual(outbox.inspect({gen: consent.current().generation, at: now()}), [], 'nothing was written to the sent ledger');
  assert.deepEqual(readdirSync(join(dir, 'sent')), []);
  rmSync(dir, {recursive: true, force: true});
});

test('settle changes something only for the batch that is in flight, once', () => {
  const dir = scratch();
  const drops = [];
  const outbox = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(10), onDrop: (...args) => drops.push(args)});
  outbox.append([{record: wire(diag), gen: 1, notBefore: 0, at: START}]);
  const a = outbox.nextBatch({stream: 'diagnostics', gen: 1, at: START});
  assert.equal(outbox.settle(a, {body: '{}', outcome: 'sent', status: 200, at: START}), true);
  outbox.append([{record: wire({...diag, rid: 'r-BAAAAAAAAAAAAAAAAAAA', seq: 2}), gen: 1, notBefore: 0, at: START}]);
  const b = outbox.nextBatch({stream: 'diagnostics', gen: 1, at: START});
  assert.equal(outbox.settle(a, {body: '{}', outcome: 'sent', status: 200, at: START}), false, 'a repeated answer for A does nothing');
  assert.equal(outbox.inflight('diagnostics').id, b.id, 'and does not remove B');
  assert.equal(outbox.settle(b, {body: '{}', outcome: 'sent', status: 200, at: START}), true);
  assert.equal(outbox.settle(b, {body: '{}', outcome: 'sent', status: 200, at: START}), false);
  rmSync(dir, {recursive: true, force: true});
});

test('maintenance keeps a batch in flight when it only drops lines behind it, with its batch id and a correct cursor', () => {
  const dir = scratch(), DAY = 86400000;
  let t = START;
  const outbox = createOutbox({dir, base: dir, now: () => t, bytes: seededBytes(11)});
  const counts = value => wire({...problem, value});
  outbox.append([{record: counts(1), gen: 1, notBefore: 0, at: t}]);
  const batch = outbox.nextBatch({stream: 'counts', gen: 1, at: t});
  outbox.append([{record: counts(2), gen: 1, notBefore: 0, at: t - 8 * DAY}]); // already too old: the hourly pass drops it
  outbox.append([{record: counts(3), gen: 1, notBefore: 0, at: t}]);
  outbox.enforceBounds();
  const kept = outbox.inflight('counts');
  assert.equal(kept?.id, batch.id, 'the batch keeps its identity (a lost reply is retried under the same batch_id)');
  assert.deepEqual(kept.records.map(json => JSON.parse(json).value), [1]);
  assert.equal(outbox.settle(kept, {body: '{}', outcome: 'sent', status: 200, at: t}), true);
  const next = outbox.nextBatch({stream: 'counts', gen: 1, at: t});
  assert.deepEqual(next.records.map(json => JSON.parse(json).value), [3], 'the cursor passed the batch, not the record behind it');
  rmSync(dir, {recursive: true, force: true});
});

test('a rewrite that never committed leaves nothing behind after a restart', () => {
  const dir = scratch();
  const outbox = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(12)});
  outbox.append([{record: wire(problem), gen: 1, notBefore: 0, at: START}]);
  writeFileSync(join(dir, 'outbox', 'counts.hour.app-99.jsonl.tmp'), '1\t0\t0\t{}\n');
  createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(13)});
  assert.deepEqual(readdirSync(join(dir, 'outbox')).filter(name => name.endsWith('.tmp')), []);
  rmSync(dir, {recursive: true, force: true});
});

test('the size bound holds after every append, charged by the bytes actually written', () => {
  const dir = scratch();
  let dropped = 0, offeredBytes = 0;
  const outbox = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(14), onDrop: (reason, n) => { dropped += n; }});
  const record = wire(diag);
  // Fill past the real limit with valid records; arbitrary padding is now refused at the outbox boundary.
  const perBatch = Math.ceil(11 * 1024 * 1024 / Buffer.byteLength(JSON.stringify(record)) / 12);
  for (let batch = 0; batch < 12; batch++) {
    const items = Array.from({length: perBatch}, (_, i) => ({record: {...record, seq: batch * perBatch + i}, gen: 1, notBefore: 0, at: START}));
    offeredBytes += items.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.record)), 0);
    outbox.append(items);
    assert.ok(outbox.stats().bytes <= 10 * 1024 * 1024, `after batch ${batch}: ${outbox.stats().bytes}`);
  }
  assert.ok(offeredBytes > 10 * 1024 * 1024, 'the valid records really exceeded the bound');
  assert.ok(dropped > 0, 'eviction was exercised');
  rmSync(dir, {recursive: true, force: true});
});

test('a histogram that is saturated still reports at most its cap', () => {
  const view = {gen: 1, streams: ['counts']};
  const rollup = createRollup({now: () => START, identity: () => ({epoch: 'e-' + 'A'.repeat(20), session: 's-' + 'A'.repeat(20)}), bytes: seededBytes(15)});
  const attrs = {'job.role': 'lender', outcome: 'finished'};
  for (let i = 0; i < 100000; i++) rollup.observe({op: 'hist', name: 'job.duration', attrs, value: 0.5}, view);
  rollup.observe({op: 'hist', name: 'job.duration', attrs, value: 3}, view);
  rollup.observe({op: 'hist', name: 'job.duration', attrs, value: 7}, view);
  const [item] = rollup.flush(view);
  const counts = item.record.counts;
  assert.ok(counts.reduce((a, n) => a + n, 0) <= 100000 && counts[1] >= 1 && counts[2] >= 1);
  assert.ok(parseRecord(item.record, {origin: 'app'}), 'the saturated record is valid');
});

test('records that could not be handed to the outbox are offered again by the next pass', () => {
  const h = makeTelemetry();
  h.tel.observe('lender-failure', {code: 'sandbox_start_failed', phase: 'prepare'});
  h.clock.set(Date.UTC(2026, 9, 21, 20, 0, 1));
  rmSync(join(h.dir, 'outbox'), {recursive: true, force: true});
  writeFileSync(join(h.dir, 'outbox'), 'in the way'); // the outbox directory cannot be written
  h.tel.tick();
  assert.equal(h.tel.preview().items.length, 0);
  rmSync(join(h.dir, 'outbox'), {force: true});
  mkdirSync(join(h.dir, 'outbox'));
  mkdirSync(join(h.dir, 'sent'), {recursive: true});
  h.tel.tick();
  assert.ok(h.tel.preview().items.some(item => item.body.includes('problem.count')), 'the hour that closed is not lost');
  h.cleanup();
});

test('a call-local MCP opt-out reaches every request the call makes, including those of a handler', async () => {
  const { createOpsClient } = await import('../lib/v1/ops/execute.mjs');
  const home = scratch();
  mkdirSync(join(home, 'v1'), {recursive: true});
  writeFileSync(join(home, 'v1', 'app.json'), JSON.stringify({pid: process.pid, port: 1, token: 't'}));
  const seen = [];
  const fetchStub = async (url, init) => { seen.push({path: new URL(url).pathname, headers: init.headers}); return new Response('{"events":[],"next_after":0}', {status: 200, headers: {'content-type': 'application/json'}}); };
  const client = createOpsClient({home, env: {}, surface: 'mcp', fetch: fetchStub, autostart: false});
  await client.call('events.list', {}, {telemetryOff: true}).catch(() => {});
  await client.call('status.blockers', {}, {telemetryOff: true}).catch(() => {});
  assert.ok(seen.length >= 2);
  for (const request of seen) assert.equal(request.headers['faravan-telemetry'], 'off', request.path);
  await client.call('events.list', {}).catch(() => {});
  assert.equal(seen.at(-1).headers['faravan-telemetry'], undefined, 'the opt-out belongs to its call');
  rmSync(home, {recursive: true, force: true});
});

// ---- Round 3 -----------------------------------------------------------------------------------------------------

test('a response for the batch the uploader holds settles the batch as maintenance moved it, not as it was taken', () => {
  const dir = scratch(), DAY = 86400000;
  const outbox = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(16)});
  const counts = value => wire({...problem, value});
  outbox.append([{record: counts(1), gen: 1, notBefore: 0, at: START}]);
  const held = outbox.nextBatch({stream: 'counts', gen: 1, at: START}); // the caller keeps this object while its POST is out
  outbox.append([{record: counts(2), gen: 1, notBefore: 0, at: START - 8 * DAY}, {record: counts(3), gen: 1, notBefore: 0, at: START}]);
  outbox.enforceBounds(); // rewrites the lane under the batch
  assert.equal(outbox.settle(held, {body: '{}', outcome: 'sent', status: 200, at: START}), true);
  const next = outbox.nextBatch({stream: 'counts', gen: 1, at: START});
  assert.deepEqual(next.records.map(json => JSON.parse(json).value), [3], 'count(1) is consumed and is not sent again');
  rmSync(dir, {recursive: true, force: true});
});

test('a crash between the rewrite\'s cursor commit and the move of the batch in flight is finished at the next start', () => {
  const dir = scratch(), DAY = 86400000;
  const outbox = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(17)});
  const counts = value => wire({...problem, value});
  outbox.append([{record: counts(1), gen: 1, notBefore: 0, at: START}]);
  const batch = outbox.nextBatch({stream: 'counts', gen: 1, at: START});
  const before = JSON.parse(readFileSync(join(dir, 'outbox', 'inflight-counts.json'), 'utf8'));
  outbox.append([{record: counts(2), gen: 1, notBefore: 0, at: START - 8 * DAY}, {record: counts(3), gen: 1, notBefore: 0, at: START}]);
  outbox.enforceBounds();
  const after = JSON.parse(readFileSync(join(dir, 'outbox', 'inflight-counts.json'), 'utf8'));
  assert.notDeepEqual(after.lanes, before.lanes, 'the batch moved with the rewrite');
  // Put the disk in the state of the crash: the cursor and the new segment are committed, the batch still has its old spans.
  writeFileSync(join(dir, 'outbox', 'inflight-counts.json'), JSON.stringify(before));
  writeFileSync(join(dir, 'outbox', 'rewrite.json'), JSON.stringify({lane: 'counts.hour.app', seq: Object.values(after.lanes)[0].seq, survivor: after}));
  const again = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(18)});
  assert.deepEqual(again.inflight('counts').lanes, after.lanes);
  assert.equal(again.inflight('counts').id, batch.id);
  assert.equal(again.settle(again.inflight('counts'), {body: '{}', outcome: 'sent', status: 200, at: START}), true);
  assert.deepEqual(again.nextBatch({stream: 'counts', gen: 1, at: START}).records.map(json => JSON.parse(json).value), [3]);
  rmSync(dir, {recursive: true, force: true});
});

test('a failed survivor repair leaves the journal intact and prevents a stale batch from being sent', () => {
  const dir = scratch();
  const root = join(dir, 'outbox');
  const box = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(17)});
  box.append([{record: wire(problem), gen: 1, notBefore: 0, at: START}]);
  const original = box.nextBatch({stream: 'counts', gen: 1, at: START});
  const oldInflight = readFileSync(join(root, 'inflight-counts.json'), 'utf8');
  box.carry({fromGen: 1, gen: 2, streams: ['counts']});
  const survivor = box.inflight('counts');
  const lane = Object.keys(survivor.lanes)[0];
  const journal = join(root, 'rewrite.json');
  writeFileSync(journal, JSON.stringify({lane, seq: survivor.lanes[lane].seq, survivor}));
  const inflight = join(root, 'inflight-counts.json');
  renameSync(inflight, inflight + '.saved');
  writeFileSync(inflight + '.saved', oldInflight);
  mkdirSync(inflight); // rename of the survivor over a directory fails even when tests run as root
  assert.throws(() => createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(18)}));
  assert.ok(existsSync(journal), 'retry needs the journal');
  rmSync(inflight, {recursive: true});
  renameSync(inflight + '.saved', inflight);
  const recovered = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(19)});
  assert.equal(recovered.inflight('counts').id, original.id);
  assert.equal(recovered.settle(recovered.inflight('counts'), {body: '{}', outcome: 'sent', status: 200, at: START}), true);
  assert.equal(recovered.nextBatch({stream: 'counts', gen: 2, at: START}), null);
  rmSync(dir, {recursive: true, force: true});
});

test('records handed back after a failed hand-over stay within the same bound as every other queue', () => {
  const view = {gen: 1, streams: ['counts', 'diagnostics', 'quota']};
  const self = [];
  const rollup = createRollup({now: () => START, identity: () => ({epoch: 'e-' + 'A'.repeat(20), session: 's-' + 'A'.repeat(20)}), bytes: seededBytes(19), onSelf: (...args) => self.push(args)});
  const items = Array.from({length: ROLLUP_LIMITS.ready + 10}, (_, i) => ({stream: 'quota', gen: 1, record: {name: 'quota.week', attrs: {n: i}}}));
  rollup.restoreReady(items);
  assert.equal(rollup.stats().ready, ROLLUP_LIMITS.ready);
  assert.equal(self.filter(([reason]) => reason === 'rollup_full').length, 10);
});

test('the scheduled uploader retries a live batch but drops it once its records are too old', async t => {
  const dir = scratch();
  const clock = manualClock();
  const expiry = START + OUTBOX_LIMITS.ageMs;
  const transport = captureTransport({status: 503});
  const first = makeTelemetry({dir, clock, transport});
  let reopened;
  t.after(async () => {
    await reopened?.tel.close();
    await first.tel.close();
    first.cleanup();
  });
  const outbox = createOutbox({dir, base: dir, now: clock.now, bytes: seededBytes(13)});
  const gen = first.tel.status().generation;
  outbox.append([
    {record: wire(problem), gen, at: START},
    {record: wire({...problem, value: 2}), gen, at: START},
  ]);
  await first.tel.flushNow();
  assert.equal(transport.requests.length, 1);
  const inflightFile = join(dir, 'outbox', 'inflight-counts.json');
  const batch = JSON.parse(readFileSync(inflightFile, 'utf8'));
  await first.tel.close();

  clock.set(expiry - 1);
  const timers = [];
  const retried = captureTransport({status: 503});
  reopened = makeTelemetry({dir, clock, level: null, transport: retried,
    setTimer: callback => { timers.push(callback); return timers.length; }, clearTimer: () => {},
  });
  reopened.tel.start();
  const upload = timers.at(-1);
  upload();
  await new Promise(resolve => setImmediate(resolve));
  const sent = calls => calls.flatMap(request => JSON.parse(request.body).batch);
  assert.deepEqual(sent(retried.requests), sent(transport.requests), 'the same two records are retried');
  assert.equal(JSON.parse(readFileSync(inflightFile, 'utf8')).id, batch.id);

  clock.set(expiry + 60_000);
  upload();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(retried.requests.length, 1, 'the scheduler posts nothing after expiry');
  assert.equal(existsSync(inflightFile), false);
  assert.deepEqual(reopened.tel.preview().items, []);
});

test('an expired member of a retry is dropped while the fresh member keeps its wire identity', t => {
  const dir = scratch();
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const drops = [];
  const box = createOutbox({dir, base: dir, now: () => START, bytes: seededBytes(29), onDrop: (...args) => drops.push(args)});
  box.append([
    {record: wire(problem), gen: 1, at: START},
    {record: wire({...problem, value: 2}), gen: 1, at: START + 60_000},
  ]);
  const original = box.nextBatch({stream: 'counts', gen: 1, at: START + 60_000});
  const expiry = START + OUTBOX_LIMITS.ageMs;
  assert.equal(box.nextBatch({stream: 'counts', gen: 1, at: expiry}).id, original.id);
  const fresh = box.nextBatch({stream: 'counts', gen: 1, at: expiry + 1});
  assert.notEqual(fresh.id, original.id);
  assert.deepEqual(fresh.records, [original.records[1]]);
  assert.equal(box.settle(original, {body: '{}', outcome: 'sent', status: 200}), false);
  assert.equal(box.settle(fresh, {body: '{}', outcome: 'sent', status: 200}), true);
  assert.deepEqual(drops, [['dropped_age', 1, problem.name]]);
});

test('a batch aging out during the tripwire never reaches the transport', async t => {
  const dir = scratch();
  const clock = manualClock();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const tripwire = () => { entered.resolve(); return release.promise; };
  const fixture = makeTelemetry({dir, clock, tripwire});
  t.after(async () => { release.resolve(null); await fixture.tel.close(); fixture.cleanup(); });
  const box = createOutbox({dir, base: dir, now: clock.now, bytes: seededBytes(27)});
  box.append([{record: wire(problem), gen: fixture.tel.status().generation, at: START}]);
  clock.set(START + OUTBOX_LIMITS.ageMs);
  const flush = fixture.tel.flushNow();
  await entered.promise;
  clock.advance(1);
  release.resolve(null);
  await flush;
  assert.deepEqual(fixture.transport.requests, []);
  assert.deepEqual(readdirSync(join(dir, 'sent')), []);
});
