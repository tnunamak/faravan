import './helpers/no-browser.mjs';
// Consent generation: nothing captured under one consent uploads under another (docs/design/TELEMETRY-WIRE.md §9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTelemetry, settle, captureTransport } from './helpers/telemetry-harness.mjs';
import { canonicalJson } from '../lib/v1/telemetry/catalog.mjs';
import { writeCrashFile, writeInboxRecord } from '../lib/v1/telemetry/crash.mjs';
import { createOutbox } from '../lib/v1/telemetry/outbox.mjs';
import { gunzipSync } from 'node:zlib';

const failure = {code: 'sandbox_start_failed', phase: 'prepare'};
const names = h => h.transport.records().map(r => r.name);
const hasDiagnostics = h => names(h).some(name => ['problem.observed.readiness', 'job.run', 'app.crash'].includes(name));
const lenderOpen = {account: 'codex:0', status: 'preparing'};
const lenderDone = {account: 'codex:0', status: 'finished'};

test('a carried in-flight counts batch retains its id across a consent transition', () => {
  const h = makeTelemetry();
  try {
    const outbox = createOutbox({dir: h.dir, base: h.dir,now:h.clock.now});
    const record = JSON.parse(readFileSync(new URL('./telemetry/golden/problem.count.record.json', import.meta.url), 'utf8'));
    const fromGen = h.tel.status().generation;
    outbox.append([{record, gen: fromGen}]);
    const first = outbox.nextBatch({stream: 'counts', gen: fromGen});
    outbox.carry({streams: ['counts'], fromGen, gen: fromGen + 1});
    const retry = outbox.nextBatch({stream: 'counts', gen: fromGen + 1});
    assert.equal(retry.id, first.id, 'the server can deduplicate an accepted response lost during the transition');
    assert.deepEqual(retry.records, first.records);
  } finally { h.cleanup(); }
});

test('withdrawing allowance removes its records without changing an in-flight batch id', () => {
  const h = makeTelemetry();
  try {
    const outbox = createOutbox({dir: h.dir, base: h.dir,now:h.clock.now});
    const count = JSON.parse(readFileSync(new URL('./telemetry/golden/problem.count.record.json', import.meta.url), 'utf8'));
    const allowance = JSON.parse(readFileSync(new URL('./telemetry/golden/quota.window.closed.record.json', import.meta.url), 'utf8'));
    const gen = h.tel.status().generation;
    outbox.append([{record: count, gen}, {record: allowance, gen}]);
    const first = outbox.nextBatch({stream: 'counts', gen});
    assert.equal(first.records.length, 2);
    outbox.carry({streams: ['counts'], fromGen: gen, gen: gen + 1});
    outbox.dropNamed(['quota.window.closed']);
    const retry = outbox.nextBatch({stream: 'counts', gen: gen + 1});
    assert.equal(retry.id, first.id);
    assert.deepEqual(retry.records.map(json => JSON.parse(json).name), ['problem.count']);
  } finally { h.cleanup(); }
});

test('purging one stream leaves another stream’s in-flight batch intact', () => {
  const h = makeTelemetry();
  try {
    const outbox = createOutbox({dir: h.dir, base: h.dir,now:h.clock.now});
    const count = JSON.parse(readFileSync(new URL('./telemetry/golden/problem.count.record.json', import.meta.url), 'utf8'));
    const gen = h.tel.status().generation;
    outbox.append([{record: count, gen}]);
    const first = outbox.nextBatch({stream: 'counts', gen});
    outbox.purge({streams: ['diagnostics']});
    assert.equal(outbox.nextBatch({stream: 'counts', gen}).id, first.id);
  } finally { h.cleanup(); }
});

test('an aborted upload retries the carried batch with the same server deduplication id', async () => {
  const requests = [];
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const transport = async (_url, init) => {
    requests.push(JSON.parse(gunzipSync(init.body)));
    if (requests.length === 1) {
      started();
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
    }
    return {status: 200, headers: new Headers(), body: {cancel: async () => {}}};
  };
  const h = makeTelemetry({level: 'on', transport});
  try {
    h.tel.observe('lender-failure', failure);
    h.clock.advance(3600000);
    h.tel.tick();
    const flushing = h.tel.flushNow();
    await entered;
    h.tel.choose({level: 'on'});
    await flushing;
    h.clock.advance(60000);
    await h.tel.flushNow();
    assert.ok(requests.length >= 2);
    assert.equal(requests[1].batch_id, requests[0].batch_id);
    assert.deepEqual(requests[1].records, requests[0].records);
  } finally { h.cleanup(); }
});

test('Off repairs a corrupt policy and remains off after restart', async () => {
  const h = makeTelemetry();
  h.tel.observe('lender-failure', failure);
  h.tel.tick();
  writeFileSync(join(h.dir, 'policy.json'), '{ corrupt');
  const restarted = makeTelemetry({dir: h.dir, level: null, clock: h.clock, transport: h.transport});
  assert.equal(restarted.tel.status().reason.kind, 'policy_unreadable');
  restarted.tel.restrict();
  const again = makeTelemetry({dir: h.dir, level: null, clock: h.clock, transport: h.transport});
  assert.equal(again.tel.status().effective, 'off');
  again.tel.choose({level: 'on'});
  await settle(again);
  assert.equal(hasDiagnostics(again), false, 'the corrupt policy cannot revive old diagnostics');
  h.cleanup();
});

test('corrupt-policy recovery accepts an injected Uint8Array random source', () => {
  const h = makeTelemetry();
  try {
    writeFileSync(join(h.dir, 'policy.json'), '{ corrupt');
    const again = makeTelemetry({dir: h.dir, level: null, bytes: n => new Uint8Array(n).fill(7)});
    again.tel.restrict();
    assert.equal(again.tel.status().effective, 'off');
    assert.equal(again.tel.status().level, 'off');
  } finally { h.cleanup(); }
});

test('a fresh edge record uploads after corrupt policy Off then On repair', async () => {
  const h = makeTelemetry();
  try {
    writeFileSync(join(h.dir, 'policy.json'), '{ corrupt');
    const repaired = makeTelemetry({dir: h.dir, level: null, clock: h.clock, transport: h.transport, bytes: n => Buffer.alloc(n, 7)});
    repaired.tel.restrict();
    repaired.tel.choose({level: 'on'});
    assert.ok(repaired.tel.status().generation > 2 ** 31 - 1, 'the repaired generation retains its entropy');
    const record = {name: 'health.state', period: new Date(h.clock.now()).toISOString().slice(0, 13), value: 1,
      attrs: {check: 'coordinator_tunnel', reason: 'network_error', state: 'blocked'}};
    assert.equal(writeInboxRecord({dir: h.dir, now:h.clock.now, env: {}, origin: 'coordinator', record}), true, 'the edge accepts the repaired generation');
    repaired.tel.ingestInbox();
    await settle(repaired);
    assert.ok(names(repaired).includes('health.state'), 'the fresh edge event uploads');
  } finally { h.cleanup(); }
});

test('a crash recorded before disclosure never uploads after acknowledgement', async () => {
  const h = makeTelemetry({level: null});
  try {
    assert.equal(writeCrashFile({dir:h.dir,env:{},kind:'start_failed',error:new Error('before')}),false);
    h.tel.markNoticeShown();
    h.tel.ingestInbox();
    await settle(h);
    assert.equal(names(h).includes('app.crash'), false);
    assert.equal(names(h).includes('crash.count'), false);
    assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'panic', error: new Error('after')}));
    h.tel.ingestInbox();
    await settle(h);
    assert.ok(names(h).includes('app.crash'));
  } finally { h.cleanup(); }
});

test('off then on within one inbox sweep uploads nothing captured earlier', async () => {
  const h = makeTelemetry();
  h.tel.observe('lender-failure', failure);
  h.tel.restrict();
  h.tel.choose({level: 'on'});
  await settle(h);
  assert.deepEqual(names(h), [], 'what was captured before the off never uploads');
  h.tel.observe('lender-failure', failure);
  await settle(h);
  assert.ok(names(h).includes('problem.count'), 'what is captured after does');
});

test('an inbox file written before an off is gone after the next on', async () => {
  const h = makeTelemetry();
  const policyGen = h.tel.status().generation;
  assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'panic', error: new Error('x')}));
  assert.equal(readdirSync(join(h.dir, 'inbox')).filter(f => f.endsWith('.json')).length, 1);
  h.tel.restrict();
  h.tel.choose({level: 'on'});
  assert.notEqual(h.tel.status().generation, policyGen);
  h.tel.ingestInbox();
  await settle(h);
  assert.deepEqual(names(h), []);
});

test('an ON write carries completed app records but rejects unswept old-generation inbox files', async () => {
  const h = makeTelemetry({level: 'on'});
  // An unswept file captured under ON, by the crash marker (the tray and the installer write the same shape).
  assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'uncaught_exception', error: new TypeError('x')}));
  h.tel.observe('lender-failure', failure);
  h.tel.choose({level: 'on'}); // widen before the sweep
  h.tel.ingestInbox();
  await settle(h);
  assert.equal(names(h).includes('app.crash'),false,'the stale inbox crash is dropped');
  assert.equal(hasDiagnostics(h),true,'completed app diagnostics carry across an ON write');
  assert.ok(names(h).includes('problem.count'), 'the permitted counts carried over');
});

test('a span open across a widening yields its counts and no diagnostic', async () => {
  const h = makeTelemetry({level: 'on'});
  h.tel.observe('event:lending', lenderOpen);
  h.clock.advance(60000);
  h.tel.choose({level: 'on'});
  h.clock.advance(60000);
  h.tel.observe('event:lending', lenderDone);
  await settle(h);
  assert.equal(names(h).includes('job.run'), false);
  assert.ok(names(h).includes('job.outcome.count'), 'the derived counts still arrive');
});

test('a span opened and closed under diagnostics yields its diagnostic', async () => {
  const h = makeTelemetry();
  h.tel.observe('event:lending', lenderOpen);
  h.clock.advance(5000);
  h.tel.observe('event:lending', lenderDone);
  await settle(h);
  assert.ok(names(h).includes('job.run'));
});

test('same-level writes carry queued counts and quota values', async () => {
  for (const [from, to] of [['on','on']]) {
    const h = makeTelemetry({level: from});
    h.tel.observe('lender-failure', failure);
    h.tel.observe('event:quota-window', {provider: 'codex', windowKind: 'seven_day', plan: 'plus', lendingOn: true, ownerUsedPct: 60, lentPoints: 5, unusedPct: 30,
      shortfall: false, coverage: 0.9, contaminated: false, history: 5, slots: Array.from({length: 28}, () => ({o: 1, l: 0}))});
    h.clock.set(Date.UTC(2026, 9, 21, 20, 0, 1));
    h.tel.tick(); // the hour closes: counts are queued
    h.tel.choose({level: to});
    await settle(h);
    assert.ok(names(h).includes('problem.count'), `${from} -> ${to}: counts uploaded`);
    assert.ok(names(h).includes('quota.week'), `${from} -> ${to}: the quota week uploaded`);
    assert.equal(hasDiagnostics(h),true,'same-level writes preserve completed diagnostics');
  }
});

test('OFF discards queued diagnostics', async () => {
  const h = makeTelemetry();
  h.tel.observe('lender-failure', failure);
  h.tel.tick();
  assert.ok(h.tel.preview().items.some(item => item.stream === 'diagnostics'), 'a diagnostic is queued');
  h.tel.restrict();
  assert.equal(h.tel.preview().items.some(item => item.stream === 'diagnostics'), false);
  await settle(h);
  assert.equal(hasDiagnostics(h), false);
});

test('a kill between the policy write and the re-stamp revives nothing, also after another same-level write and after a new ID', async () => {
  const h = makeTelemetry();
  h.tel.observe('lender-failure', failure);
  h.tel.tick();
  const dir = h.dir;
  // Simulate the kill: the policy file advances (as choose() writes it first) but the outbox is never re-stamped.
  const policyFile = join(dir, 'policy.json');
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  writeFileSync(policyFile, JSON.stringify({...policy, generation: policy.generation + 1}));
  // A restart reads the new policy.
  const again = makeTelemetry({dir, level: null, clock: h.clock, transport: h.transport});
  await settle(again);
  assert.equal(hasDiagnostics(again), false, 'the old stamps no longer match: nothing is revived');
  again.tel.choose({level: 'on'}); // another same-level write
  await settle(again);
  assert.equal(hasDiagnostics(again), false);
  again.tel.resetIdentity();
  await settle(again);
  assert.deepEqual(readdirSync(join(dir, 'outbox')).filter(f => f.endsWith('.jsonl')), [], 'a new ID carries nothing');
});

test('carry re-stamps only records stamped with the immediately previous generation', async () => {
  const h = makeTelemetry({level: 'on'});
  h.tel.observe('lender-failure', failure);
  h.clock.set(Date.UTC(2026, 9, 21, 20, 0, 1));
  h.tel.tick(); // the hour closes: a counts record is queued under generation G
  assert.ok(h.tel.preview().items.some(item => item.stream === 'counts'));
  h.tel.choose({level: 'on', region: 'FR'}); // G+1: carried, as it was stamped G
  assert.ok(h.tel.preview().items.some(item => item.stream === 'counts'), 'one step: carried');
  // Now a policy write that skipped the re-stamp (a kill): the record still says G while the policy says G+2.
  const file = join(h.dir, 'policy.json'), policy = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({...policy, generation: policy.generation + 1}));
  const again = makeTelemetry({dir: h.dir, level: null, clock: h.clock, transport: h.transport});
  again.tel.choose({level: 'on', region: 'DE'}); // G+3: carries only records stamped G+2, so the one stamped G+1 goes
  assert.equal(again.tel.preview().items.length, 0, 'a record that missed one re-stamp is not revived by the next');
  await settle(again);
  assert.deepEqual(h.transport.records(), []);
});

test('no pre-notice crash file is collected and later acknowledgement revives nothing',async()=>{
 const h=makeTelemetry({level:null});try{
  assert.equal(writeCrashFile({dir:h.dir,env:{},kind:'start_failed',error:new Error('x')}),false);
  h.tel.markNoticeShown();h.tel.ingestInbox();await settle(h);assert.equal(names(h).includes('app.crash'),false);
 }finally{h.cleanup();}
});

test('a corrupt policy means off, and the edge writers write nothing', async () => {
  const h = makeTelemetry();
  h.tel.observe('lender-failure', failure);
  writeFileSync(join(h.dir, 'policy.json'), '{ not json');
  const again = makeTelemetry({dir: h.dir, level: null, clock: h.clock, transport: h.transport});
  assert.equal(again.tel.status().effective, 'off');
  assert.equal(again.tel.status().reason.kind, 'policy_unreadable');
  assert.equal(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'panic', error: new Error('x')}), false);
  again.tel.observe('lender-failure', failure);
  await settle(again);
  assert.equal(again.transport.records().length, 0);
  again.tel.choose({level: 'on'});
  assert.equal(again.tel.status().effective, 'on');
  await settle(again);
  assert.equal(hasDiagnostics(again), false, 'old records do not survive policy repair');
});

test('request scope covers the job a request created, and nothing else', async () => {
  const h = makeTelemetry();
  const digest = 'sha256:' + 'a'.repeat(64);
  h.tel.response({writer: 'app', req: {url: '/api/jobs', headers: {'faravan-telemetry': 'off'}}, status: 200, body: {job_digest: digest}});
  h.tel.observe('event:job', {job_digest: digest, state: 'queued', job: {payload: {created_at: new Date(h.clock.now()).toISOString(), expires_at: new Date(h.clock.now() + 3600000).toISOString(), requirements: {harness: ['codex']}}}});
  h.clock.advance(60000);
  h.tel.observe('event:job', {job_digest: digest, state: 'result-accepted', attempts_started: 1, job: {payload: {requirements: {harness: ['codex']}}}});
  h.tel.observe('lender-failure', failure); // other background work is not covered
  await settle(h);
  assert.equal(names(h).includes('job.run'), false, 'the created job has no lifecycle record');
  assert.equal(names(h).includes('job.outcome.count'), false);
  assert.ok(names(h).includes('problem.count'), 'unrelated work is governed by the stored level');
});
