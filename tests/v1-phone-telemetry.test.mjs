import './helpers/no-browser.mjs';
// A paired phone's friction (design §2.2 "UI and phone", §3.4 ui.friction, §4.5). Its error records reach the telemetry
// facade with the phone's origin; a phone that cannot read its inbox sends none; Sec-GPC: 1 drops the request; and the
// phone itself derives enums and code-shaped words only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSessionStore } from '../lib/v1/browser-sessions.mjs';
import { createPhoneAccess } from '../lib/v1/phone-access.mjs';
import { createFriction, frictionRecord } from '../public/phone/phone-view.mjs';

const loopback = () => ({eth0: [{address: '127.0.0.1', family: 'IPv4', internal: false}]});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-phone-telemetry-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const received = [];
  const sessions = await openSessionStore(join(dir, 'sessions.json'), {now: () => 1_000_000});
  const access = createPhoneAccess({directory: dir, sessions, now: () => 1_000_000, interfaces: loopback, computerName: () => 'Studio',
    inbox: async () => [], answer: async () => ({}), onTelemetry: (records, options) => received.push({records, headers: options.headers})});
  t.after(() => access.close());
  await access.start();
  await access.owner({method: 'POST', parts: ['settings'], input: {enabled: true, address: '127.0.0.1'}, browserSession: true});
  return {access, sessions, received, origin: access.origin};
}

async function paired(f, scopes) {
  const created = await f.sessions.create({kind: 'phone', label: 'Ana’s phone', scopes});
  return `faravan_phone_${f.sessions.instance}=${created.secret}`;
}

function post(origin, path, {cookie, body, headers = {}}) {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = request(url, {method: 'POST', headers: {host: url.host, origin: url.origin, 'content-type': 'application/json',
      ...(cookie ? {cookie} : {}), ...headers}}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString()}));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

const friction = [
  {kind: 'error_banner', route: 'home', code: 'network'},
  {kind: 'error_banner', route: 'request', op: 'approvals.accept', code: 'not_found'},
];

test('a paired phone’s friction reaches the telemetry facade, with the phone as origin', async t => {
  const f = await fixture(t);
  const cookie = await paired(f, ['inbox:read']);
  const response = await post(f.origin, '/phone/api/telemetry', {cookie, body: {records: friction}});
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(JSON.parse(response.text), {ok: true});
  assert.equal(f.received.length, 1);
  assert.deepEqual(f.received[0].records, friction);
});

test('Sec-GPC: 1 is answered and drops the request: nothing is recorded', async t => {
  const f = await fixture(t);
  const cookie = await paired(f, ['inbox:read']);
  const response = await post(f.origin, '/phone/api/telemetry', {cookie, body: {records: friction}, headers: {'sec-gpc': '1'}});
  assert.equal(response.status, 200);
  assert.equal(f.received.length, 0);
});

test('a phone that cannot read its inbox sends no friction, and an unpaired request is refused', async t => {
  const f = await fixture(t);
  // A phone session always holds inbox:read when it is paired, so this one is the answer-only scope set.
  const noInbox = await paired(f, ['requests:answer']);
  const forbidden = await post(f.origin, '/phone/api/telemetry', {cookie: noInbox, body: {records: friction}});
  assert.equal(forbidden.status, 403);
  const unpaired = await post(f.origin, '/phone/api/telemetry', {body: {records: friction}});
  assert.equal(unpaired.status, 401);
  assert.equal(f.received.length, 0);
});

test('the phone derives only enums and codes it has text for, never the text on screen', () => {
  assert.deepEqual(frictionRecord({route: 'home', problem: {code: 'network', message: 'Ana’s phone at 10.23.1.9 lost its way'}}),
    {kind: 'error_banner', route: 'home', code: 'network'});
  assert.deepEqual(frictionRecord({route: 'request', op: 'approvals.decline', problem: {code: 'Not Found!'}}),
    {kind: 'error_banner', route: 'request', op: 'approvals.decline'});
  assert.deepEqual(frictionRecord({route: 'home', problem: {code: 'alice_smith'}}), {kind: 'error_banner', route: 'home'},
    'an identifier the phone has no text for is not sent');
  assert.deepEqual(frictionRecord({route: 'request', op: 'jobs.submit', problem: {}}), {kind: 'error_banner', route: 'request'});
  assert.equal(frictionRecord({route: 'settings', problem: {code: 'network'}}), null, 'a screen the phone does not report');
});

test('friction goes out in batches of at most 20, at most one batch per interval', () => {
  const sent = [];
  const timers = [];
  const friction = createFriction({send: records => sent.push(records), setTimer: fn => timers.push(fn)});
  for (let i = 0; i < 25; i++) friction.add({kind: 'error_banner', route: 'home', code: 'network'});
  assert.equal(timers.length, 1, 'one timer for the whole queue');
  timers.shift()();
  assert.deepEqual(sent.map(batch => batch.length), [20]);
  assert.equal(timers.length, 1, 'the rest waits for the next interval');
  timers.shift()();
  assert.deepEqual(sent.map(batch => batch.length), [20, 5]);
});
