import './helpers/no-browser.mjs';
// The tripwire: a last look at the exact bytes before they leave. A hit is a catalog bug, so the batch is dropped and counted.
// This file plants such a bug in the loaded catalog; it runs in its own process, before anything caches enum members.
import { tempDir } from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CATALOG, parseRecord, canonicalJson } from '../lib/v1/telemetry/catalog.mjs';
import { createConsent } from '../lib/v1/telemetry/consent.mjs';
import { createOutbox } from '../lib/v1/telemetry/outbox.mjs';
import { createUploader } from '../lib/v1/telemetry/uploader.mjs';
import { createTripwire } from '../lib/v1/telemetry/tripwire.mjs';
import { captureTransport, seededBytes, RELEASE, ENDPOINT, START } from './helpers/telemetry-harness.mjs';

const PLANTED = ['/home/alice/.ssh/id_rsa', 'alice@example.com', 'git@github.com:alice/private.git', 'sk-ant-api03-Zq9XyW8vU7tS6rQ5pO4nM3lK2jI1hG0fEdCbAaZ', 'ghp_aB3dE5gH7jK9mN1pQ3sT5vX7zB9dF1hJ3kL5', 'C:\\Users\\Alice\\x'];
for (const value of PLANTED) CATALOG.enums.component.push({value, since: 1}); // the planted catalog bug

const problem = component => ({name: 'problem.count', period: '2026-10-21T19', attrs: {'error.type': 'unknown', 'problem.registry': 'problem', component, phase: 'none', outcome: 'requeue', surface: 'http'}, value: 1});

function rig() {
  const dir = tempDir('tel-wire-');
  const consent = createConsent({dir, base: dir, uploadable: true, bytes: seededBytes(1), now: () => START});
  consent.choose({level: 'on', region: 'US'});
  const outbox = createOutbox({dir, base: dir, now: () => START + 7200000, bytes: seededBytes(2)});
  const self = [], transport = captureTransport();
  const uploader = createUploader({allowed:()=>true, consent, outbox, transport, endpoint: ENDPOINT, version: RELEASE, platform: {osType: 'linux', arch: 'amd64'},
    tripwire: createTripwire({privateValues: async () => []}), onSelf: (reason, entry) => self.push([reason, entry]), now: () => START + 7200000, random: () => 0});
  return {consent, outbox, self, transport, uploader};
}

test('the planted values are accepted by the catalog, so the tripwire is the only thing between them and the wire', () => {
  for (const value of PLANTED) assert.ok(parseRecord(problem(value), {origin: 'app'}), value);
});

test('each planted value is caught: the batch is dropped, never sent, and counted', async () => {
  for (const value of PLANTED) {
    const r = rig();
    r.outbox.append([{record: parseRecord(problem(value), {origin: 'app'}), gen: r.consent.current().generation, notBefore: 0, at: START}]);
    await r.uploader.flushNow();
    assert.equal(r.transport.requests.length, 0, value + ' must not be sent');
    assert.deepEqual(r.self, [['tripwire', 'problem.count']], value);
    const rejected = r.outbox.inspect({gen: r.consent.current().generation, at: START + 7200000});
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].state, 'rejected');
    assert.equal(rejected[0].status, 'tripwire');
    assert.equal(r.outbox.stats().queued.counts, 0, 'the batch is gone from the queue');
  }
});

test('a clean batch passes: no false positive on any catalog value or on random IDs', async () => {
  const r = rig();
  r.outbox.append([{record: parseRecord(problem('app'), {origin: 'app'}), gen: r.consent.current().generation, notBefore: 0, at: START}]);
  await r.uploader.flushNow();
  assert.equal(r.transport.requests.length, 1);
  assert.deepEqual(r.self, []);
  const check = createTripwire({privateValues: async () => []});
  const { randomId } = await import('../lib/v1/telemetry/ids.mjs');
  const bytes = seededBytes(9);
  for (let i = 0; i < 3000; i++) assert.equal(await check(canonicalJson({rid: randomId('r', bytes), epoch: randomId('e', bytes), session: randomId('s', bytes), trace: randomId('t', bytes), batch_id: randomId('b', bytes)})), null);
  for (const [name, members] of Object.entries(CATALOG.enums)) {
    for (const m of members.filter(m => !PLANTED.includes(m.value))) assert.equal(await check(canonicalJson({attrs: {'error.type': m.value, x: m.value}})), null, name + ':' + m.value);
  }
});

test('a known secret value of this computer is caught even inside an otherwise valid string', async () => {
  const check = createTripwire({privateValues: async () => ['hunter2-hunter2-hunter2']});
  assert.equal(await check('{"attrs":{"component":"app"}}'), null);
  assert.equal(await check('{"attrs":{"component":"hunter2-hunter2-hunter2"}}'), 'credential');
});

test('the fixed public PostHog token passes while credentials elsewhere still fail',async()=>{
 const {POSTHOG_TOKEN}=await import('../lib/v1/telemetry/contract.mjs');
 const check=createTripwire({privateValues:async()=>['private-value-abcdef']});
 assert.equal(await check(JSON.stringify({api_key:POSTHOG_TOKEN,batch:[]})),null);
 assert.equal(await check(JSON.stringify({api_key:POSTHOG_TOKEN,batch:[{properties:{oops:'private-value-abcdef'}}]})),'credential');
});
