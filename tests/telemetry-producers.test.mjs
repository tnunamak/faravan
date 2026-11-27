import './helpers/no-browser.mjs';
// Edge producers against the app's inbox sweep (design §2.2 consent generation, §6). Each producer writes a file stamped
// with the generation it read. The app accepts a file only at that generation and projects it under the consent in force
// at the sweep. These tests run that path end to end: a producer's file, then the app's ingestInbox, then the upload.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../lib/v1/telemetry/catalog.mjs';
import { writeInboxRecord } from '../lib/v1/telemetry/crash.mjs';
import { makeTelemetry, settle,edgeCapture } from './helpers/telemetry-harness.mjs';
import { readGolden } from './helpers/telemetry-golden.mjs';

const healthRecord = {name: 'health.state', period: '2026-10-21T19', value: 1, attrs: {check: 'coordinator_tunnel', reason: 'network_error', state: 'blocked'}};
const installRecord = {name: 'install.run', kind: 'span', hour: '2026-10-21T19', duration_ms: 21000, status: 'error', attrs: {method: 'deb', outcome: 'restart_failed'}};

let serial = 0;
/** Writes a golden producer file (the tray's own output, frozen) with the generation the producer says it read. */
function trayFile(h, gen, golden = 'inbox.tray-panic.json', origin) {
  const file = JSON.parse(readGolden(golden));
  file.gen = gen;file.capture=edgeCapture(h);
  if (origin) file.origin = origin;
  mkdirSync(join(h.dir, 'inbox'), {recursive: true});
  writeFileSync(join(h.dir, 'inbox', `c-PRODUCER${String(++serial).padStart(4, '0')}.json`), canonicalJson(file) + '\n');
}
const inboxNames = h => (existsSync(join(h.dir, 'inbox')) ? readdirSync(join(h.dir, 'inbox')) : []);
async function uploadedRecords(h) {
  await settle(h);
  return h.transport.records();
}
const namesOf = records => records.map(record => record.name);

test('off then on within one inbox sweep uploads nothing a producer wrote before the off', async () => {
  const h = makeTelemetry({level: 'on'});
  try {
    const before = h.tel.status().generation;
    trayFile(h, before); // written before the off: the off itself removes it
    h.tel.choose({level: 'off', region: 'US'});
    assert.deepEqual(inboxNames(h), [], 'off empties the inbox');
    h.tel.choose({level: 'on', region: 'US'});
    trayFile(h, before); // a producer that read the old policy writes late: stale at the sweep
    h.tel.ingestInbox();
    assert.deepEqual(inboxNames(h), [], 'the stale file is dropped at the sweep');
    assert.ok(!namesOf(await uploadedRecords(h)).includes('crash.count'), 'nothing from before the off uploads');
  } finally {
    h.cleanup();
  }
});

test('a generation change before the sweep: the crash diagnostic never uploads', async () => {
  const h = makeTelemetry({level: 'on'});
  try {
    trayFile(h, h.tel.status().generation);
    h.tel.choose({level: 'on', region: 'US'}); // widened: the file's generation is stale now
    h.tel.ingestInbox();
    const names = namesOf(await uploadedRecords(h));
    assert.ok(!names.includes('app.crash'), `uploaded: ${names}`);
    assert.ok(!names.includes('crash.count'), 'a stale file yields no count either');
  } finally {
    h.cleanup();
  }
});

test('ON includes a crash diagnostic and its count', async () => {
  const h = makeTelemetry({level: 'on'});
  try {
    trayFile(h, h.tel.status().generation);
    h.tel.ingestInbox();
    const records = await uploadedRecords(h);
    const crashes = records.filter(record => record.name === 'crash.count' || record.name === 'app.crash');
    assert.deepEqual(namesOf(crashes).sort(), ['app.crash','crash.count']);
    assert.deepEqual(crashes.find(row=>row.name==='crash.count').attrs, {'crash.kind':'panic'});
  } finally {
    h.cleanup();
  }
});

test('a file written before disclosure is discarded; a later file can upload', async () => {
  const h = makeTelemetry({level: null});
  try {
    assert.equal(h.tel.status().generation, 0);
    trayFile(h, 0);
    h.tel.ingestInbox();
    assert.equal(inboxNames(h).length,1,'the next enabled sweep discards the pre-disclosure file');
    h.tel.choose({level: 'on', region: 'US'});
    h.tel.ingestInbox();
    assert.ok(!namesOf(await uploadedRecords(h)).includes('crash.count'), 'the pre-disclosure crash never uploads');
    trayFile(h, h.tel.status().generation);
    h.tel.ingestInbox();
    assert.ok(namesOf(await uploadedRecords(h)).includes('crash.count'), 'a crash captured after the choice uploads');
  } finally {
    h.cleanup();
  }
});

test('the coordinator and installer writers follow the policy the app wrote', async () => {
  const h = makeTelemetry({level: 'on'});
  try {
    assert.equal(writeInboxRecord({dir: h.dir, now:h.clock.now, env: {}, origin: 'coordinator', record: healthRecord}), true);
    assert.equal(writeInboxRecord({dir: h.dir, now:h.clock.now, env: {}, origin: 'installer', record: installRecord}), true);
    h.tel.ingestInbox();
    // install.count is a day count: it is due once the UTC day has closed (the harness's jitter is zero, so it goes at once).
    await settle(h, {hours: 30});
    const names = namesOf(h.transport.records());
    assert.ok(names.includes('health.state'), `names: ${names}`);
    assert.ok(names.includes('install.count'), 'the span derives its count under counts');
    assert.ok(names.includes('install.run'),'ON includes the validated installer diagnostic');
  } finally {
    h.cleanup();
  }
});

test('after off, the edge writers write nothing at all', () => {
  const h = makeTelemetry({level: 'on'});
  try {
    h.tel.choose({level: 'off', region: 'US'});
    assert.equal(writeInboxRecord({dir: h.dir, now:h.clock.now, env: {}, origin: 'coordinator', record: healthRecord}), false);
    assert.deepEqual(inboxNames(h), []);
  } finally {
    h.cleanup();
  }
});

test('a file that claims an origin its record does not have is removed and counted, and never uploads as its record', async () => {
  const h = makeTelemetry({level: 'on'});
  try {
    trayFile(h, h.tel.status().generation, 'inbox.tray-panic.json', 'installer');
    h.tel.ingestInbox();
    assert.deepEqual(inboxNames(h), [], 'the file is removed');
    const records = await uploadedRecords(h);
    assert.ok(!namesOf(records).includes('crash.count'), 'the claim does not survive');
    const self = records.filter(record => record.name === 'telemetry.self');
    assert.ok(self.some(record => record.attrs.reason === 'inbox_invalid'), 'the drop is counted');
  } finally {
    h.cleanup();
  }
});

test('phone friction is accepted under ON, and carries the phone as its surface', async () => {
  const h = makeTelemetry({level: 'on'});
  try {
    h.tel.ui([{kind: 'error_banner', route: 'request', op: 'approvals.accept', code: 'not_found'}], {origin: 'phone', headers: {}});
    const friction = (await uploadedRecords(h)).find(record => record.name === 'ui.friction');
    assert.ok(friction, 'a friction count reaches the upload');
    assert.equal(friction.attrs.surface, 'phone');
    assert.equal(friction.attrs.route, 'request');
  } finally {
    h.cleanup();
  }
});
