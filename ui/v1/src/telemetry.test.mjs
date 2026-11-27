import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createFriction, clean, opForWrite, instrumentApi, hasUnsentCompose, OPS_SENT, OP_BY_WRITE, KINDS, BATCH_MS, MAX_BATCH} from './telemetry.mjs';
import {createBrowserTelemetry} from './posthog.mjs';
import {connectBrowserPolicy} from './posthog-policy.mjs';
import {createTelemetryStore} from './telemetry-store.mjs';
import {ROUTES} from './helpers.mjs';
import {createApi} from './api.mjs';

const catalog = JSON.parse(readFileSync(new URL('../../../lib/v1/telemetry/catalog.json', import.meta.url), 'utf8'));
const members = name => new Set(catalog.enums[name].map(entry => entry.value));

// A clock and a timer queue the test controls.
function harness({level = 'on', ...rest} = {}) {
  const sent = [], timers = [];
  let time = 1_000_000, effective = level, unsent = false;
  const friction = createFriction({
    send: records => { sent.push({at: time, records}); return Promise.resolve(); },
    effective: () => effective, now: () => time, unsent: () => unsent,
    setTimer: (fn, delay) => { const timer = {fn, at: time + delay, live: true}; timers.push(timer); return timer; },
    clearTimer: timer => { timer.live = false; }, ...rest,
  });
  const advance = ms => {
    const end = time + ms;
    for (;;) {
      const due = timers.filter(timer => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.live = false; time = Math.max(time, due.at); due.fn();
    }
    time = end;
  };
  return {friction, sent, advance, queuedTimers:()=>timers.filter(timer=>timer.live).length, setLevel: value => { effective = value; }, setUnsent: value => { unsent = value; }, now: () => time};
}
const errorsOf = (...entries) => Object.fromEntries(entries.map(([name, code], i) => [name, Object.assign(new Error('boom'), {code})]));

test('the module only sends names the catalog knows: routes, ops and kinds', () => {
  for (const kind of KINDS) assert.ok(members('friction_kind').has(kind), kind);
  for (const op of OPS_SENT) assert.ok(members('op').has(op), op);
  for (const route of Object.keys(ROUTES).filter(key => key !== 'telemetry')) assert.ok(members('route').has(route), route + ' is in the catalog');
  assert.equal(OPS_SENT.size, OP_BY_WRITE.length);
});

test('error_banner: one record per new banner, none for a banner that stays up, again after it clears', () => {
  const t = harness();
  t.friction.setRoute('jobs');
  t.friction.errors(errorsOf(['jobs', 'network']));
  t.friction.errors(errorsOf(['jobs', 'network']));
  t.friction.errors({});
  t.friction.errors(errorsOf(['jobs', 'network']));
  t.advance(BATCH_MS);
  assert.deepEqual(t.sent.flatMap(batch => batch.records), [{kind: 'error_banner', route: 'jobs', code: 'network'}, {kind: 'error_banner', route: 'jobs', code: 'network'}]);
});

test('error_banner follows the app banner: a circle host that is offline is not a banner', () => {
  const t = harness();
  t.friction.setRoute('home');
  t.friction.errors({circles: Object.assign(new Error('x'), {status: 409, code: 'circle_unreachable'})});
  t.advance(BATCH_MS);
  assert.deepEqual(t.sent, []);
});

test('action_repeated: the third identical write within 10 s on one route, with the op when it is known', () => {
  const t = harness();
  t.friction.setRoute('home');
  t.friction.write('POST', 'lending/on'); t.advance(3000);
  t.friction.write('POST', 'lending/on'); t.advance(3000);
  t.friction.write('POST', 'lending/on');
  t.advance(BATCH_MS);
  assert.deepEqual(t.sent.flatMap(batch => batch.records), [{kind: 'action_repeated', route: 'home', op: 'lending.on'}]);
});

test('action_repeated: slow repeats, reads, different writes and other routes do not count; an unknown write has no op', () => {
  const t = harness();
  t.friction.setRoute('home');
  for (let i = 0; i < 4; i++) { t.friction.write('POST', 'lending/on'); t.advance(6000); }
  for (let i = 0; i < 5; i++) t.friction.write('GET', 'jobs');
  t.friction.write('POST', 'lending/on'); t.friction.write('POST', 'lending/off'); t.friction.write('POST', 'lending/pause');
  for (let i = 0; i < 5; i++) t.friction.write('POST', 'telemetry/choose');
  t.advance(BATCH_MS);
  assert.deepEqual(t.sent, []);
  for (let i = 0; i < 3; i++) t.friction.write('POST', 'circles/abc123/check');
  t.advance(BATCH_MS);
  assert.deepEqual(t.sent.flatMap(batch => batch.records), [{kind: 'action_repeated', route: 'home'}]);
});

test('flow_abandoned: leaving the composer with unsent text; staying, or leaving with nothing, is not', () => {
  const t = harness();
  t.friction.setRoute('borrow');
  t.friction.setRoute('borrow');
  t.setUnsent(false);
  t.friction.setRoute('jobs');
  t.friction.setRoute('borrow');
  t.setUnsent(true);
  t.friction.setRoute('home');
  t.advance(BATCH_MS);
  assert.deepEqual(t.sent.flatMap(batch => batch.records), [{kind: 'flow_abandoned', route: 'borrow'}]);
});

test('hasUnsentCompose reads only whether a prompt is waiting', () => {
  const storage = entries => ({length: entries.length, key: i => entries[i][0], getItem: key => entries.find(entry => entry[0] === key)?.[1] ?? null});
  const draft = over => JSON.stringify({id: 'x', prompt: 'a', sending: false, ...over});
  assert.equal(hasUnsentCompose(storage([['faravan-compose-draft:c1', draft({})]])), true);
  assert.equal(hasUnsentCompose(storage([['faravan-compose-draft:c1', draft({prompt: '  '})]])), false);
  assert.equal(hasUnsentCompose(storage([['faravan-compose-draft:c1', draft({sending: true})]])), false);
  assert.equal(hasUnsentCompose(storage([['other', draft({})]])), false);
  assert.equal(hasUnsentCompose(storage([['faravan-compose-draft:c1', '{not json']])), false);
  assert.equal(hasUnsentCompose({get length() { throw new Error('blocked'); }}), false);
});

test('batching: at most 20 records in a batch and one batch per 5 s, never awaited', () => {
  const t = harness();
  t.friction.setRoute('jobs');
  for (let i = 0; i < 45; i++) t.friction.record({kind: 'error_banner', route: 'jobs', code: 'x' + 'y'.repeat(i % 5 + 1)});
  t.advance(0);
  assert.equal(t.sent.length, 1, 'the first batch goes out at once');
  assert.equal(t.sent[0].records.length, MAX_BATCH);
  t.advance(BATCH_MS - 1);
  assert.equal(t.sent.length, 1, 'nothing more inside 5 s');
  t.advance(1);
  assert.equal(t.sent.length, 2);
  t.advance(BATCH_MS);
  assert.deepEqual(t.sent.map(batch => batch.records.length), [20, 20, 5]);
  assert.ok(t.sent.every((batch, i) => i === 0 || batch.at - t.sent[i - 1].at >= BATCH_MS));
});

test('errors never reach the interaction path: a send that throws or rejects is swallowed', async () => {
  const throwing = harness({send: () => { throw new Error('offline'); }});
  throwing.friction.setRoute('jobs');
  throwing.friction.record({kind: 'dead_end', route: 'jobs'});
  assert.doesNotThrow(() => throwing.advance(BATCH_MS));
  const rejecting = harness({send: () => Promise.reject(new Error('offline'))});
  rejecting.friction.setRoute('jobs');
  rejecting.friction.record({kind: 'dead_end', route: 'jobs'});
  rejecting.advance(BATCH_MS);
  await new Promise(resolve => setImmediate(resolve)); // an unhandled rejection would fail the run
});

test('off: nothing is queued or sent, and nothing queued before it is sent after', () => {
  const t = harness({level: null});
  t.friction.setRoute('jobs');
  t.friction.record({kind: 'dead_end', route: 'jobs'});
  t.advance(BATCH_MS * 3);
  assert.deepEqual(t.sent, [], 'level not known yet: held back');
  t.setLevel('on');
  t.friction.record({kind: 'dead_end', route: 'jobs'});
  t.setLevel('off');
  t.advance(BATCH_MS * 3);
  assert.deepEqual(t.sent, [], 'turned off before the batch: dropped');
  t.setLevel('on');
  t.advance(BATCH_MS * 3);
  assert.deepEqual(t.sent, [], 'and not revived by turning it on again');
  t.friction.record({kind: 'dead_end', route: 'jobs'});
  t.advance(0);
  assert.equal(t.sent.length, 1, 'new friction after the change does send');
});

test('clean rebuilds a record from its allowed fields and drops everything else', () => {
  assert.deepEqual(clean({kind: 'error_banner', route: 'jobs', code: 'jobs_unavailable', op: 'jobs.submit', title: 'Fix /home/me/secret', path: '/home/me', message: 'a@b.c', extra: {x: 1}}),
    {kind: 'error_banner', route: 'jobs', code: 'jobs_unavailable', op: 'jobs.submit'});
  for (const bad of [null, {}, {kind: 'nope', route: 'jobs'}, {kind: 'dead_end', route: '/jobs'}, {kind: 'dead_end', route: 'telemetry'}, {kind: 'dead_end', route: 'not-found'}]) assert.equal(clean(bad), null, JSON.stringify(bad));
  const odd = clean({kind: 'dead_end', route: 'jobs', op: 'my private op', code: 'Has Space'});
  assert.deepEqual(odd, {kind: 'dead_end', route: 'jobs'});
  for (const code of ['user@example.com', '/home/sam/code', 'Fix the login bug', 'x'.repeat(80), 'A', 7, '']) assert.equal(clean({kind: 'error_banner', route: 'jobs', code}).code, undefined, String(code));
  assert.equal(opForWrite('/api/jobs/sha256:abc/cancel?circle=x'), 'jobs.cancel');
  assert.equal(opForWrite('jobs/x/y/z'), null);
});

test('canary: no user string in any field of the app ever reaches the wire', () => {
  const CANARIES = ['CANARY_title Fix the login bug', '/home/sam/secret-project', 'sam@example.com', 'git@github.com:private/repo.git', 'sk-live-CANARY', 'https://internal.example/path?token=CANARY'];
  const t = harness();
  t.friction.setRoute('borrow');
  // Every field an error can carry, with a canary in it.
  const noisy = name => Object.assign(new Error(CANARIES[0]), {code: 'jobs_unavailable', status: 500, path: CANARIES[1], message: CANARIES[2], title: CANARIES[3], serverMessage: CANARIES[4], url: CANARIES[5],
    members: [{name: CANARIES[0], keyId: CANARIES[4]}], repoRefusal: {path: CANARIES[1], message: CANARIES[2]}, agentRefusal: {message: CANARIES[0], label: CANARIES[3]}, action: {label: CANARIES[0]}});
  t.friction.errors({jobs: noisy(), [CANARIES[0]]: noisy(), circles: Object.assign(new Error(CANARIES[2]), {code: CANARIES[2]})});
  // Writes whose paths carry user text, thrice each.
  for (const path of ['jobs/' + CANARIES[1] + '/cancel', 'circles/' + CANARIES[3] + '/check', 'approvals/' + CANARIES[4] + '/accept', 'jobs']) for (let i = 0; i < 3; i++) t.friction.write('POST', path);
  // Raw records with canaries in every field, as a careless caller might pass them.
  t.friction.record({kind: 'error_banner', route: 'jobs', code: CANARIES[0], op: CANARIES[1], action: CANARIES[2], title: CANARIES[3], path: CANARIES[4], message: CANARIES[5]});
  t.friction.record({kind: CANARIES[0], route: CANARIES[1]});
  t.friction.record({kind: 'dead_end', route: CANARIES[1], code: 'jobs_unavailable'});
  t.setUnsent(true);
  t.friction.setRoute('home');
  t.advance(BATCH_MS * 4);
  const wire = JSON.stringify(t.sent);
  assert.ok(t.sent.length > 0 && wire.length > 20, 'something was sent, so the check is not vacuous: ' + wire);
  for (const canary of CANARIES) assert.ok(!wire.includes(canary), canary);
  for (const word of ['CANARY', 'secret-project', 'example.com', 'github', 'login', 'internal']) assert.ok(!wire.includes(word), word);
  for (const {records} of t.sent) for (const record of records) {
    assert.deepEqual(Object.keys(record).filter(key => !['kind', 'route', 'op', 'code'].includes(key)), [], 'only the four allowed fields');
    assert.ok(KINDS.includes(record.kind)); assert.ok(Object.hasOwn(ROUTES, record.route));
    if (record.op) assert.ok(OPS_SENT.has(record.op));
    if (record.code) assert.match(record.code, /^[a-z][a-z0-9_]{1,47}$/);
  }
});

test('instrumentApi notes writes and changes nothing about the request or its result', async () => {
  const noted = [], calls = [];
  const api = {get: async () => 'g', post: async (path, body, signal) => { calls.push([path, body, signal]); return 'p'; }};
  const wrapped = instrumentApi(api, {write: (method, path) => noted.push([method, path])});
  assert.equal(await wrapped.post('jobs', {a: 1}, 'sig'), 'p');
  assert.deepEqual(calls, [['jobs', {a: 1}, 'sig']]);
  assert.deepEqual(noted, [['POST', 'jobs']]);
  assert.equal(await wrapped.get('x'), 'g');
  const broken = instrumentApi(api, {write: () => { throw new Error('x'); }});
  assert.equal(await broken.post('jobs'), 'p', 'a failing note never blocks a write');
});

test('every API request names its surface', async () => {
  const seen = [];
  const api = createApi('tok', async (url, options) => { seen.push(options.headers); return {ok: true, json: async () => ({})}; });
  await api.get('telemetry');
  await api.post('telemetry/choose', {level: 'off'});
  assert.equal(seen.length, 2);
  for (const headers of seen) { assert.equal(headers['faravan-surface'], 'ui'); assert.equal(headers['x-faravan-session-token'], 'tok'); }
});

test('policy changes discard friction across OFF to ON without an intervening flush',async()=>{
  const t=harness(),store=createTelemetryStore();let generation=1;
  const api={get:async()=>({consent:'on',generation}),post:async(_path,body)=>{generation++;t.setLevel(body.level);return {effective:body.level};}};
  const policy=connectBrowserPolicy({api,store,browser:{stop(){},tick(){},bootstrap(){}},onStop:()=>t.friction.stop(),setTimer:()=>1,clearTimer(){}});
  try{
    t.friction.setRoute('jobs');t.friction.record({kind:'dead_end',route:'jobs'});
    await store.post(api,'telemetry/choose',{level:'off'});
    await store.post(api,'telemetry/choose',{level:'on'});
    t.advance(BATCH_MS*3);assert.deepEqual(t.sent,[],'pre-OFF observations must never revive');
    t.friction.record({kind:'dead_end',route:'jobs'});t.advance(BATCH_MS);
    assert.equal(t.sent.length,1,'new observations still send after ON');
  }finally{policy.stop();}
});

test('a delayed OFF fences new friction observations and flush until authoritative ON',async()=>{
  const store=createTelemetryStore(),id='f7c9f198-f634-419e-8617-59f82466d719';
  let state={installId:id,consent:'on',generation:1,remoteEnabled:true,noticePending:false},finishOff;
  const browser=createBrowserTelemetry({sdk:{init(){},capture(){},stopSessionRecording(){},opt_out_capturing(){}},transport:{stop(){},setAllowed(){}},document:null});
  browser.connection(true);
  const t=harness({permitted:()=>browser.captureAllowed()});
  const api={get:async()=>({...state}),post:async(_path,body)=>{
    if(body.level==='off')await new Promise(resolve=>{finishOff=resolve;});
    state={...state,consent:body.level,generation:state.generation+1};
    t.setLevel(body.level);return {effective:body.level};
  }};
  const policy=connectBrowserPolicy({api,store,browser,onStop:()=>t.friction.stop(),setTimer:()=>1,clearTimer(){}});
  try{
    await policy.check();t.friction.setRoute('jobs');
    const off=store.post(api,'telemetry/choose',{level:'off'});
    assert.equal(typeof finishOff,'function');
    t.friction.record({kind:'dead_end',route:'jobs'});
    t.friction.errors(errorsOf(['jobs','network']));
    t.friction.write('POST','jobs');t.friction.write('POST','jobs');
    const queued=t.queuedTimers();
    t.friction.flush();t.advance(BATCH_MS*3);
    assert.deepEqual(t.sent,[],'new observations must not send while OFF is pending');
    assert.equal(queued,0,'no flush may be queued during the pending OFF');
    finishOff();await off;await new Promise(resolve=>setImmediate(resolve));
    // Rendering an old ON view is not permission to collect again.
    t.setLevel('on');t.friction.record({kind:'dead_end',route:'jobs'});t.friction.flush();
    assert.deepEqual(t.sent,[]);
    await store.post(api,'telemetry/choose',{level:'on'});await new Promise(resolve=>setImmediate(resolve));
    t.advance(BATCH_MS*3);assert.deepEqual(t.sent,[],'pending-OFF records must not revive after ON');
    t.friction.write('POST','jobs');t.advance(BATCH_MS);
    assert.deepEqual(t.sent,[],'repeat history must not accumulate while OFF');
    t.friction.errors(errorsOf(['jobs','network']));t.advance(BATCH_MS);
    assert.deepEqual(t.sent.map(batch=>batch.records),[[{kind:'error_banner',route:'jobs',code:'network'}]],'fresh observations work after authoritative ON');
  }finally{policy.stop();}
});

test('the friction permission gate covers flush, repeat history and error history',()=>{
  let permitted=true;const t=harness({permitted:()=>permitted});
  t.friction.setRoute('jobs');t.friction.record({kind:'dead_end',route:'jobs'});
  permitted=false;t.friction.flush();
  t.friction.write('POST','jobs');t.friction.write('POST','jobs');
  t.friction.errors(errorsOf(['jobs','network']));
  t.advance(BATCH_MS*3);assert.deepEqual(t.sent,[]);
  permitted=true;
  t.friction.write('POST','jobs');t.friction.errors(errorsOf(['jobs','network']));t.advance(BATCH_MS);
  assert.deepEqual(t.sent.map(batch=>batch.records),[[{kind:'error_banner',route:'jobs',code:'network'}]]);
});
