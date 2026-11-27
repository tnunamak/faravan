import './helpers/no-browser.mjs';
// The quota-week protocol: a week travels alone, with a reduced resource and no field that links it to another week.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTelemetry, settle, RELEASE } from './helpers/telemetry-harness.mjs';
import { ID_PATTERNS } from '../lib/v1/telemetry/catalog.mjs';

const week = overrides => ({provider: 'codex', windowId: 'seven_day', windowKind: 'seven_day', plan: 'plus', lendingOn: true, ownerUsedPct: 60, lentPoints: 5, unusedPct: 30,
  shortfall: false, coverage: 0.9, contaminated: false, history: 5, slots: Array.from({length: 28}, (_, i) => (i < 4 ? {o: null, l: null} : {o: 1, l: 0})), charges: [], ...overrides});
const DAY = 86400000;

test('ten quota weeks keep their values, each with a UUID and the same install identity',async()=>{
 const h=makeTelemetry();try{
  for(let i=0;i<10;i++){h.tel.observe('event:quota-window',week({ownerUsedPct:10*i,resetsAt:i}));h.clock.advance(7*DAY);}
  h.tel.tick();h.clock.advance(3*DAY);await h.tel.flushNow();
  const quota=h.transport.bodies().flatMap(body=>body.batch).filter(event=>event.event==='quota.week');assert.equal(quota.length,10);
  assert.equal(new Set(quota.map(event=>event.uuid)).size,10);assert.equal(new Set(quota.map(event=>event.distinct_id)).size,1);
  for(const event of quota){assert.equal(event.properties.app_version,RELEASE);assert.equal(event.properties.$geoip_disable,true);assert.equal(event.properties.slots.length,28);for(const key of ['epoch','session','trace'])assert.equal(event.properties[key],undefined);}
 }finally{h.cleanup();}
});

test('a quota week waits a random 0 to 48 hours after its window closes', async () => {
  const late = makeTelemetry({random: () => 0.999});
  late.tel.observe('event:quota-window', week());
  late.tel.tick();
  late.clock.advance(47 * 3600000);
  await late.tel.flushNow();
  const quotaRequests = h => h.transport.bodies().filter(body => body.batch.some(event=>event.event==='quota.week')).length;
  assert.equal(quotaRequests(late), 0, 'not yet at 47 h');
  late.clock.advance(2 * 3600000);
  await late.tel.flushNow();
  assert.equal(quotaRequests(late), 1, 'sent by 49 h');
  const soon = makeTelemetry({random: () => 0});
  soon.tel.observe('event:quota-window', week());
  await soon.tel.flushNow();
  assert.equal(quotaRequests(soon), 1, 'a zero delay sends at once');
});

test('unobserved slots stay null and a five-hour window is a count, not a week', async () => {
  const h = makeTelemetry({});
  h.tel.observe('event:quota-window', week());
  h.tel.observe('event:quota-window', week({windowKind: 'five_hour', windowId: 'five_hour', slots: undefined}));
  h.clock.advance(2 * DAY);
  h.tel.tick();
  await h.tel.flushNow();
  h.clock.advance(DAY);
  await h.tel.flushNow();
  const records = h.transport.records();
  const record = records.find(r => r.name === 'quota.week');
  assert.deepEqual(record.attrs.slots.slice(0, 4), Array(4).fill({l: null, o: null}));
  assert.ok(record.attrs.slots.slice(4).every(slot => slot.o === '1' && slot.l === '0'));
  assert.equal(records.filter(r => r.name === 'quota.week').length, 1);
  assert.equal(records.filter(r => r.name === 'quota.window.closed').length, 1);
});

test('a week is only made under a consent that allows the quota stream', async () => {
  const off = makeTelemetry({level: 'off'});
  off.tel.observe('event:quota-window', week());
  await settle(off);
  assert.equal(off.transport.requests.length, 0);
  const counts = makeTelemetry({level: 'on'});
  counts.tel.observe('event:quota-window', week());
  await settle(counts);
  assert.equal(counts.transport.records().filter(r => r.name === 'quota.week').length, 1, 'Counts with the allowance choice still sends the weekly summary');
});
