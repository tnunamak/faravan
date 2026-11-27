import test from 'node:test';
import assert from 'node:assert/strict';
import {watchUpdates} from './api.mjs';
import {restartBanner} from './update-restart.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sse = text => new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(text)); }}), {headers: {'content-type': 'text/event-stream'}});

// An update restart is usually faster than the 15 s grace, so the stream never reports `false`. The banner must
// still clear when the new app's stream opens, and must not clear on the connection that carried the event.
test('restarting → stream ends → quick reconnect within grace clears the banner, with no false report', async () => {
  let opened = 0, banner = null;
  const connections = [];
  const api = {request: async () => {
    opened++;
    if (opened === 1) return new Response(new ReadableStream({start(c) {
      c.enqueue(new TextEncoder().encode('id: 7\nevent: update\ndata: {"id":7,"type":"update","data":{"state":"restarting","version":"1.1.0"}}\n\n'));
      setTimeout(() => c.close(), 30);
    }}), {headers: {'content-type': 'text/event-stream'}});
    return sse(': connected\n\n');
  }};
  const seen = [];
  const handlers = restartBanner(value => { banner = value; seen.push(value); }, value => connections.push(value));
  const stop = watchUpdates(api, async () => {}, handlers.onConnection, {interval: 1000, retry: 15000, grace: 3000, retryBase: 10, onEvent: handlers.onEvent});
  for (let i = 0; i < 300 && opened < 2; i++) await pause(10);
  await pause(50); stop();
  assert.equal(opened, 2);
  assert.deepEqual(seen[0], {state: 'restarting', version: '1.1.0'}, 'the event shows the banner');
  assert.equal(banner, null, 'the reconnect cleared it');
  assert.ok(!connections.includes(false));
});

test('other update events and a first connection do not touch the banner', () => {
  const calls = [];
  const handlers = restartBanner(value => calls.push(value), () => {});
  handlers.onEvent({type: 'update', data: {state: 'staged'}});
  handlers.onEvent({type: 'job', data: {state: 'restarting'}});
  assert.deepEqual(calls, []);
  handlers.onConnection(true);
  assert.deepEqual(calls, [], 'no banner was shown, so nothing is cleared');
});
