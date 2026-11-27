import './helpers/no-browser.mjs';
// Golden payloads: for every catalog entry, the fixture's observations go through the whole pipeline (projection,
// rollup, outbox) and the record that comes out equals the frozen file. IDs and `seq` are masked: they are random.
// A change to a serialized record needs a catalog bump and new golden files (design §6, docs/design/TELEMETRY-WIRE.md §12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeTelemetry, manualClock,edgeCapture } from './helpers/telemetry-harness.mjs';
import { canonicalJson, entryNamesAt } from '../lib/v1/telemetry/catalog.mjs';
import { writeCrashFile } from '../lib/v1/telemetry/crash.mjs';
import { goldenNames, readGolden } from './helpers/telemetry-golden.mjs';

const IDENTITY = new Set(['rid', 'epoch', 'session', 'trace', 'seq']);
const mask = value => {
  if (Array.isArray(value)) return value.map(mask);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, IDENTITY.has(k) ? '<assigned>' : mask(v)]));
  return value;
};
const stripIdentity = record => Object.fromEntries(Object.entries(record).filter(([k]) => !IDENTITY.has(k)));
const BASE = Date.parse('2026-10-21T19:42:11Z');

/** Every record that was queued for upload, in order. */
const queued = h => h.tel.preview().items.filter(item => item.state === 'queued').map(item => {const {_posthog,...record}=JSON.parse(item.body);return record;});
const inboxFileOf = name => (goldenNames('.inbox.json').includes(name + '.inbox.json') ? JSON.parse(readGolden(name + '.inbox.json')) : null);

/** A stack of shipped frames and a user path, as a crash would carry (the message and the user path must never be sent). */
const crashError = ({errorClass, stack}) => Object.assign(new globalThis[errorClass]('boom in /home/alice/secret'), {stack: errorClass + ': boom in /home/alice/secret\n    ' + stack.join('\n    ')});

/** Drive one fixture through the real pipeline; return every record it queued. */
async function run(name) {
  const input = JSON.parse(readGolden(name + '.input.json'));
  const h = makeTelemetry({clock: manualClock(BASE), health: input.health ? () => input.health : undefined});
  if (input.health) h.tel.tick(); // the first housekeeping pass pulls health, as the app's start does
  const inboxFile = inboxFileOf(input.inboxOf ?? name);
  const origin = ['ui', 'phone'].includes(input.ctx.origin) ? input.ctx.origin : undefined;
  if (input.crash) {
    assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: input.crash.kind, error: crashError(input.crash), uptimeMs: input.crash.uptimeMs}));
    // The crash file carries the generation it was written under.
    h.tel.ingestInbox();
  } else if (input.marker) {
    writeFileSync(join(h.dir, 'running.json'), '{}');
    h.tel.start();
    await h.tel.close();
  } else if (inboxFile) {
    mkdirSync(join(h.dir, 'inbox'), {recursive: true});
    writeFileSync(join(h.dir, 'inbox', 'one.json'), canonicalJson({...inboxFile, gen: h.tel.status().generation,capture:edgeCapture(h)}));
    h.tel.ingestInbox();
  } else {
    for (const o of input.observations) {
      h.clock.set(BASE + (o.atMs ?? 0));
      h.tel.observe(o.kind, o.data, {origin});
    }
  }
  // Close every open period: the end of the day covers hour and day cells.
  h.clock.set(Math.ceil((h.clock.now() + 1) / 86400000) * 86400000 + 1000);
  h.tel.tick();
  return {h, records: queued(h), inbox: Boolean(inboxFile)};
}

test('every catalog entry has a fixture that the pipeline reproduces byte for byte', async () => {
  const failures = [];
  for (const name of entryNamesAt()) {
    const expected = JSON.parse(readGolden(name + '.record.json'));
    const {records, inbox} = await run(name);
    // The record for this entry that has the fixture's attributes (a fixture may also produce neighbours, e.g. each readiness check).
    const found = records.filter(record => record.name === name && canonicalJson(record.attrs) === canonicalJson(expected.attrs));
    if (found.length !== 1) { failures.push(`${name}: expected one record with the fixture attributes, got ${found.length} of ${records.filter(r => r.name === name).length}`); continue; }
    // An inbox fixture is the producer's file: no identity, and the origin sits in the file wrapper.
    const got = inbox ? Object.fromEntries(Object.entries(stripIdentity(found[0])).filter(([k]) => k !== 'origin')) : found[0];
    const want = inbox ? Object.fromEntries(Object.entries(expected).filter(([k]) => k !== 'origin')) : expected;
    if (canonicalJson(mask(got)) !== canonicalJson(mask(want))) failures.push(`${name}:\n  got      ${canonicalJson(mask(got))}\n  expected ${canonicalJson(mask(want))}`);
  }
  assert.deepEqual(failures, []);
});
