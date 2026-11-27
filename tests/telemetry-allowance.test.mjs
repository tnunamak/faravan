import './helpers/no-browser.mjs';
// The allowance totals (the weekly curve and the five-hour window count) are the owner's use of the whole agent account,
// outside Faravan too. The one ON setting covers these facts and app charges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTelemetry } from './helpers/telemetry-harness.mjs';
import { TELEMETRY_COPY } from '../lib/v1/telemetry/copy.mjs';

const DAY = 86400000;
const week = overrides => ({provider: 'codex', windowId: 'seven_day', windowKind: 'seven_day', plan: 'plus', lendingOn: true, ownerUsedPct: 60, lentPoints: 5,
  unusedPct: 30, shortfall: false, coverage: 0.9, contaminated: false, history: 5, slots: Array.from({length: 28}, (_, i) => (i < 4 ? {o: null, l: null} : {o: 1, l: 0})),
  charges: [{points: 3, stopReason: 'error'}], ...overrides});

/** Advance past the send intervals, flushing after each: counts drain on one flush and go out after their jitter on the next. Lists every record name sent. */
async function sentNames(h) {
  for (const days of [3, 3]) { h.clock.advance(days * DAY); await h.tel.flushNow(); }
  return h.transport.bodies().flatMap(body => body.records.map(record => record.name));
}

test('ON includes cross-account allowance curves, window counts and app charges', async () => {
 const h=makeTelemetry();try {
  h.tel.observe('event:quota-window',week({windowKind:'five_hour',windowId:'five_hour',charges:[]}));h.tel.observe('event:quota-window',week());
  const names=await sentNames(h);for(const name of ['quota.week','quota.window.closed','lending.job.charge'])assert.ok(names.includes(name),name);
 }finally{h.cleanup();}
});
test('OFF purges allowance data and a fresh ON includes new records',async()=>{
 const h=makeTelemetry({random:()=>0.999});try {
  h.tel.observe('event:quota-window',week());await h.tel.flushNow();assert.equal(h.tel.view().queued.quota,1);
  h.tel.restrict();assert.equal(h.tel.preview().items.length,0);h.tel.observe('event:quota-window',week());assert.ok(!(await sentNames(h)).includes('quota.week'));
  h.tel.choose({level:'on'});h.tel.observe('event:quota-window',week({ownerUsedPct:61}));assert.ok((await sentNames(h)).includes('quota.week'));
 }finally{h.cleanup();}
});
test('region does not create a second allowance choice',async()=>{
 for(const region of ['UK','EU']) {const h=makeTelemetry({region});try{assert.equal(h.tel.status().allowance,true);h.tel.observe('event:quota-window',week());assert.ok((await sentNames(h)).includes('quota.week'));}finally{h.cleanup();}}
});
test('copy discloses allowance use outside the app, with only ON and OFF choices',()=>{
 assert.ok(TELEMETRY_COPY.privacyDetails.some(line=>line.includes('outside this app')));assert.deepEqual(TELEMETRY_COPY.settings.choices.map(choice=>choice.level),['on','off']);
});
