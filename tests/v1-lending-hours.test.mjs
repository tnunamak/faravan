import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveState, lendingHours, validateSchedule } from '../lib/v1/lending-state.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';

// S6.1: lending hours are wall-clock times in the lender's IANA zone; an overnight window
// belongs to the day it starts. The state projection takes the next start from lendingHours().
const ready={intent:'on',agents:[{enabled:true,installed:true,signedIn:true}]};
const schedule={days:[1,2,3,4,5],from:'22:00',to:'06:00',weekends_all_day:false};
const project=(now,extra={})=>{
  const hours=lendingHours(schedule,now,'UTC');
  return effectiveState({...ready,now,outsideNextStart:hours.inside?null:hours.until,...extra});
};

test('lending hours time table: exact bounds, overnight days, next start and weekends',()=>{
  for(const [date,inside,until] of [
    ['2026-10-19T21:59:59Z',false,'2026-10-19T22:00:00Z'],
    ['2026-10-19T22:00:00Z',true,null],
    ['2026-10-20T05:59:59Z',true,null],
    ['2026-10-20T06:00:00Z',false,'2026-10-20T22:00:00Z'],
    ['2026-10-24T05:00:00Z',true,null], // Friday night belongs to Friday
    ['2026-10-24T06:00:00Z',false,'2026-10-26T22:00:00Z'],
    ['2026-10-26T05:00:00Z',false,'2026-10-26T22:00:00Z'], // Sunday night is not in the days
  ]) {
    const now=Date.parse(date);
    assert.deepEqual(lendingHours(schedule,now),{inside,until:until?Date.parse(until):null},date);
    assert.equal(project(now).intent.state,inside?'ready':'outside');
  }
  assert.deepEqual(lendingHours({...schedule,weekends_all_day:true},Date.parse('2026-10-24T12:00Z')),{inside:true,until:null});
  assert.deepEqual(lendingHours({...schedule,days:[1],from:'09:00',to:'17:00'},Date.parse('2026-10-19T17:00Z')),
    {inside:false,until:Date.parse('2026-10-26T09:00Z')});
});
test('hours use the configured zone, including DST gaps, repeated minutes and a 6:59 AM start',()=>{
  const spring={days:[0],from:'02:30',to:'04:00',weekends_all_day:false};
  assert.deepEqual(lendingHours(spring,Date.parse('2026-03-08T06:59Z'),'America/New_York'),
    {inside:false,until:Date.parse('2026-03-08T07:00Z')}); // 02:30 does not exist; the window opens at 03:00 EDT
  assert.deepEqual(lendingHours({...spring,from:'01:30',to:'01:45'},Date.parse('2026-11-01T05:50Z'),'America/New_York'),
    {inside:false,until:Date.parse('2026-11-01T05:30Z')+3600000}); // fall back: the first 01:30 EDT is 05:30Z
  const early={days:[1],from:'06:59',to:'08:00',weekends_all_day:false};
  assert.deepEqual(lendingHours(early,Date.parse('2026-10-19T06:58:59Z')),{inside:false,until:Date.parse('2026-10-19T06:59:00Z')});
  assert.deepEqual(lendingHours(early,Date.parse('2026-10-19T06:59:00Z')),{inside:true,until:null});
});
test('changing the zone moves the window; the answer follows the new zone at once',()=>{
  const day={days:[1],from:'09:00',to:'17:00',weekends_all_day:false};
  const now=Date.parse('2026-10-19T14:00Z'); // 10:00 in New York, 23:00 in Tokyo
  assert.equal(lendingHours(day,now,'America/New_York').inside,true);
  assert.deepEqual(lendingHours(day,now,'Asia/Tokyo'),{inside:false,until:Date.parse('2026-10-26T00:00Z')});
  assert.equal(lendingHours(day,now,'America/New_York').inside,true,'the cache is keyed by zone');
});
test('outside preserves higher priority states and running work',()=>{
  const now=Date.parse('2026-10-19T12:00Z');
  assert.equal(project(now,{intent:'off'}).intent.state,'off');
  assert.equal(project(now,{pause_until:now+1000}).intent.state,'paused');
  // A blocker no longer changes the intent (S1.1c): the blockers model reports it, and lending stays on.
  assert.equal(project(now,{safetyBlocked:true}).intent.on,true);
  const running=project(now,{current:'job',launched:true});
  assert.equal(running.state,'running');assert.equal(running.execution.state,'running');assert.equal(running.intent.state,'ready');
  assert.equal(project(now).intent.state,'outside');
  assert.equal(project(now).intent.until,Date.parse('2026-10-19T22:00Z'));
  assert.match(project(now,{timeZone:'UTC'}).headline,/^Outside lending hours · starts at 10:00 PM$/);
});
test('schedule validation rejects malformed values and copies days',()=>{
  assert.deepEqual(lendingHours(null,0),{inside:true,until:null});
  assert.equal(validateSchedule(null),null);
  for(const change of [{days:[]},{days:[7]},{days:[1,1]},{from:'24:00'},{to:'6:00'},
    {from:'06:00'},{from:['22:00']},{to:['06:00']},{weekends_all_day:1},{extra:true}])
    assert.throws(()=>validateSchedule({...schedule,...change}),{code:'invalid_request'});
  const copy=validateSchedule(schedule);copy.days.push(0);assert.deepEqual(schedule.days,[1,2,3,4,5]);
});

test('the app stores a schedule with its zone, shows outside hours and offers no new job',{timeout:60000},async t=>{
  const f=await appFixture(t),{lender,circle}=await f.connect();
  const home='America/New_York';
  // A window that is never open now: the only allowed day is the one that is not today in this zone.
  const today=new Date(Date.now()).toLocaleString('en-US',{timeZone:home,weekday:'short'});
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(today);
  const never={days:[(day+3)%7],from:'09:00',to:'10:00',weekends_all_day:false};
  const saved=await api(lender.app,'/api/lending/limits',{method:'POST',body:{timeZone:home,schedule:never}});
  assert.deepEqual(saved.limits.schedule,never);assert.equal(saved.limits.timeZone,home);
  await api(lender.app,'/api/lending/limits',{method:'POST',body:{schedule:{...never,days:[]}}}).then(
    ()=>assert.fail('empty schedule accepted'),error=>assert.match(String(error.message),/400|invalid_request/));
  await api(lender.app,'/api/agents/codex',{method:'POST',body:{useForLending:true}});
  await api(lender.app,'/api/lending/on',{method:'POST',body:{circle:circle.id}});
  const status=await waitFor(async()=>{const s=await api(lender.app,'/api/status');return s.intent?.state==='outside'?s:null;},'outside state');
  assert.ok(Number.isFinite(status.intent.until));
  assert.match(status.headline,/^Outside lending hours · starts at /);
  assert.equal(lender.backend.calls.some(([kind])=>kind==='run'||kind==='prepare'),false);
  const cleared=await api(lender.app,'/api/lending/limits',{method:'POST',body:{schedule:null}});
  assert.equal(cleared.limits.schedule,null);
});
