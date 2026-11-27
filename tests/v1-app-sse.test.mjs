import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import { appFixture, api, waitFor, adapters } from './helpers/v1-app-fixture.mjs';

import {EVENT_REPLAY_BYTES,eventFrame} from '../lib/v1/event-stream.mjs';

const options = {timeout: 120000};
// Timer-policy tests advance global timers; leave I/O waiting on real timers.
async function waitForIo(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for ' + label);
}
const change = app => api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: false}});
async function stream(t, app, headers = {}) {
  let response;
  const capture = (req, res) => {if (req.url.startsWith('/api/events')) response = res;};
  app.server.prependListener('request', capture);
  const controller = new AbortController();
  const received = await fetch(app.origin + '/api/events?after=0', {
    headers: {'x-faravan-session-token': app.token, ...headers}, signal: controller.signal});
  app.server.removeListener('request', capture);
  assert.equal(received.status, 200);
  assert.match(received.headers.get('content-type'), /^text\/event-stream/);
  const reader = received.body.getReader();
  const state = {response, text: '', events: [], ended: false, abort: () => controller.abort()};
  const reading = (async () => {
    let pending = '';
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) {state.ended = true; return;}
        const chunk = Buffer.from(value).toString();
        state.text += chunk; pending += chunk;
        let boundary;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
          const data = /^data: (.+)$/m.exec(frame);
          if (data) state.events.push(JSON.parse(data[1]));
        }
      }
    } catch (error) {state.ended = true; if (!controller.signal.aborted) state.error = error;}
  })();
  t.after(async () => {
    const error = state.error; controller.abort(); await reading;
    if (error && !state.expectedDisconnect) throw error;
  });
  return state;
}
async function fixture(t) {
  const f = await appFixture(t);
  return (await f.start()).app;
}

test('SSE replay above 16 KiB delivers every event and keeps receiving live events', options, async t => {
  const app = await fixture(t);
  for (let i = 0; i < 600; i++) await change(app);
  const replay = await api(app, '/api/activity?after=0');
  assert.ok(Buffer.byteLength(JSON.stringify(replay)) > 16384);
  const s = await stream(t, app);
  await waitFor(() => s.events.length === replay.length || s.ended, 'replay');
  assert.deepEqual(s.events, replay);
  assert.ok(s.text.startsWith(': connected\n\n'));
  await change(app);
  await waitFor(() => s.events.length > replay.length || s.ended, 'live event after replay');
  assert.equal(s.ended, false);
  assert.equal(s.events.at(-1).id, replay.at(-1).id + 1);
});

test('SSE live fan-out survives a buffered burst above 16 KiB and drains', options, async t => {
  const app = await fixture(t), s = await stream(t, app);
  // Cork models a temporarily slow transport with real ServerResponse buffering.
  s.response.cork();
  s.response.write(': ' + 'x'.repeat(131072) + '\n\n');
  assert.ok(s.response.writableLength > 16384);
  await change(app);
  assert.equal(s.response.writableEnded, false, 'backpressure must not end the stream');
  s.response.uncork();
  await waitFor(() => s.events.some(e => e.type === 'agents'), 'burst delivered');
  await change(app);
  await waitFor(() => s.events.filter(e => e.type === 'agents').length === 2, 'next live event');
});

test('SSE drops only the stalled stream above 4 MiB', options, async t => {
  const app = await fixture(t), stalled = await stream(t, app), healthy = await stream(t, app);
  stalled.response.cork();
  stalled.response.write(': ' + 'x'.repeat(4 * 1024 * 1024) + '\n\n');
  await change(app);
  assert.equal(stalled.response.writableEnded, true, 'over-cap stream must end');
  assert.equal(healthy.response.writableEnded, false);
  await change(app);
  await waitFor(() => healthy.events.filter(e => e.type === 'agents').length === 2, 'unaffected healthy stream');
});

test('SSE Last-Event-ID resumes missed events after a stalled stream is dropped', options, async t => {
  const app = await fixture(t), first = await stream(t, app);
  await change(app);
  await waitFor(() => first.events.some(e => e.type === 'agents'), 'initial cursor');
  const cursor = first.events.at(-1).id;
  first.response.cork();
  first.response.write(': ' + 'x'.repeat(4 * 1024 * 1024) + '\n\n');
  await change(app);
  assert.equal(first.response.writableEnded, true);
  await change(app);
  const missed = await api(app, '/api/activity?after=' + cursor);
  const resumed = await stream(t, app, {'Last-Event-ID': String(cursor)});
  await waitFor(() => resumed.events.length >= missed.length || resumed.ended, 'resumed replay');
  assert.deepEqual(resumed.events, missed);
  await change(app);
  await waitFor(() => resumed.events.length > missed.length, 'resumed live delivery');
});

test('SSE sends an idle heartbeat comment every 25 seconds', options, async t => {
  t.after(() => t.mock.timers.reset());
  const app = await fixture(t);
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const s = await stream(t, app);
  t.mock.timers.tick(24999);
  assert.ok(!s.text.includes(': heartbeat'));
  t.mock.timers.tick(1);
  await waitForIo(() => s.text.includes(': heartbeat\n\n'), 'idle heartbeat');
  assert.equal(s.response.writableEnded, false);
  t.mock.timers.tick(25000);
  await waitForIo(() => s.text.split(': heartbeat\n\n').length === 3, 'second heartbeat');
  const writes = t.mock.method(s.response, 'write');
  s.abort();
  await waitForIo(() => s.response.destroyed, 'client disconnect');
  t.mock.timers.tick(50000);
  assert.equal(writes.mock.callCount(), 0, 'no heartbeat after disconnect');
  t.mock.timers.reset();
});

test('SSE ends a pending queue after 30 seconds without drain', options, async t => {
  t.after(() => t.mock.timers.reset());
  const app = await fixture(t);
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const s = await stream(t, app);
  s.response.cork();
  s.response.write(': ' + 'x'.repeat(131072) + '\n\n');
  await change(app);
  t.mock.timers.tick(29999);
  assert.equal(s.response.writableEnded, false);
  t.mock.timers.tick(1);
  assert.equal(s.response.writableEnded, true);
  t.mock.timers.reset();
});

test('SSE reclaims a stalled socket if its clean end cannot flush', options, async t => {
  t.after(() => t.mock.timers.reset());
  const app = await fixture(t);
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const stalled = await stream(t, app), healthy = await stream(t, app);
  stalled.expectedDisconnect = true;
  const socket = stalled.response.socket;
  // Hold the transport callbacks, so end() cannot flush even with a reading peer.
  t.mock.method(socket, '_write', () => {});
  t.mock.method(socket, '_writev', () => {});
  stalled.response.write(': ' + 'x'.repeat(4 * 1024 * 1024) + '\n\n');
  await change(app);
  assert.equal(stalled.response.writableEnded, true, 'try a clean end first');
  assert.equal(stalled.response.writableFinished, false, 'transport remains blocked');
  t.mock.timers.tick(1000);
  assert.equal(socket.destroyed, true, 'reclaim the blocked socket after the grace period');
  await change(app);
  await waitForIo(() => healthy.events.filter(e => e.type === 'agents').length === 2, 'healthy delivery after eviction');
  t.mock.timers.reset();
});

test('SSE drain clears the old deadline and a new backlog gets 30 seconds', options, async t => {
  t.after(() => t.mock.timers.reset());
  const app = await fixture(t);
  t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
  const s = await stream(t, app);
  s.expectedDisconnect = true;
  const socket = s.response.socket, pending = [];
  let held = true, drains = 0;
  s.response.on('drain', () => drains++);
  for (const name of ['_write', '_writev']) {
    const original = socket[name];
    t.mock.method(socket, name, function (...args) {
      if (held) pending.push(() => original.apply(this, args));
      else original.apply(this, args);
    });
  }
  const backlog = () => s.response.write(': ' + 'x'.repeat(131072) + '\n\n');
  backlog(); await change(app);
  t.mock.timers.tick(10000);
  held = false; for (const flush of pending.splice(0)) flush();
  await waitForIo(() => drains > 0, 'real transport drain');
  t.mock.timers.tick(10000);
  held = true; backlog(); await change(app);
  t.mock.timers.tick(10000);
  assert.equal(s.response.writableEnded, false, 'old deadline was cleared');
  t.mock.timers.tick(19999);
  assert.equal(s.response.writableEnded, false, 'new backlog gets its own deadline');
  t.mock.timers.tick(1);
  assert.equal(s.response.writableEnded, true);
  t.mock.timers.reset();
});

test('SSE replay trimmed by bytes resets once and delivers subsequent events on the same socket',options,async t=>{
  const models=Array.from({length:1024},(_,i)=>('synthetic-'+i+'-').padEnd(80,'x'));
  const f=await appFixture(t);
  const {app}=await f.start('owner',{adapters:adapters().map(a=>({...a,models}))});
  // Refresh emits the full synthetic model inventory through the public API.
  // Eight ~84 KiB rows exceed the byte cap, far below the 2,000-row cap;
  // each row stays below app.mjs's 256 KiB per-event truncation threshold.
  const refresh=()=>api(app,'/api/agents/refresh',{method:'POST',body:{agents:['codex']}});
  await refresh();
  const initial=await api(app,'/api/activity');
  const first=initial.find(e=>e.type==='agents'&&e.data.agents);
  assert.ok(first,'refresh emitted an agent inventory');
  // The app also lists its configured model; the synthetic inventory must arrive whole and in order.
  assert.deepEqual(first.data.agents.find(a=>a.id==='codex').models.filter(m=>m.startsWith('synthetic-')),models);
  assert.ok(Buffer.byteLength(eventFrame(first))>EVENT_REPLAY_BYTES/8,'large rows exercise the byte cap');
  assert.ok(Buffer.byteLength(JSON.stringify(first))<262144,'inventory is not truncated');
  for(let i=1;i<8;i++)await refresh();
  const retained=await api(app,'/api/activity');
  assert.ok(retained.length>0,'keep a replay tail');
  assert.ok(retained.at(-1).id<2000,'never reach the count cap');
  assert.ok(retained[0].id>first.id,'byte bound trimmed the first inventory');
  assert.ok(retained.reduce((bytes,event)=>bytes+Buffer.byteLength(eventFrame(event)),0)<=EVENT_REPLAY_BYTES);
  const latest=retained.at(-1).id,s=await stream(t,app);
  await waitFor(()=>s.events.length>0||s.ended,'reset frame');
  assert.deepEqual(s.events,[{id:latest,type:'reset',data:{refresh:true}}]);
  assert.equal(s.ended,false);
  assert.ok(Buffer.byteLength(s.text)<512*1024);
  await change(app);
  await waitFor(()=>s.events.length===2||s.ended,'live event after reset');
  assert.equal(s.ended,false);
  assert.equal(s.events[1].type,'agents');assert.equal(s.events[1].id,latest+1);
});
