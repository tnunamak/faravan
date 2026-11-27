import test from 'node:test';
import assert from 'node:assert/strict';
import { limitsSaveError, guardUnsavedLimits, scheduleChange, scheduleZoneHint, limitsSaveAmbiguous, sameLimits, pageDraft, validatePage } from './limits-model.mjs';

test('enabling hours saves the computer zone; other edits preserve the saved zone', () => {
  const draft = {timeZone:'UTC', schedule:{on:false, from:'22:00', days:[1]}};
  const on = scheduleChange(draft, {on:true}, 'America/Chicago');
  assert.equal(on.timeZone, 'America/Chicago');
  assert.deepEqual(on.schedule, {...draft.schedule, on:true});
  assert.equal(scheduleChange(draft, {from:'23:00'}, 'America/Chicago').timeZone, 'UTC');
  assert.equal(scheduleChange(draft, {on:false}, 'America/Chicago').timeZone, 'UTC');
  assert.equal(scheduleZoneHint('UTC', 'America/Chicago'), 'Your saved hours use UTC. Use your time (Chicago)? A running job may finish after.');
  assert.doesNotMatch(scheduleZoneHint('America/Chicago', 'America/Chicago'), /Chicago|Saved/);
});

test('server errors preserve the draft and give a safe next step without raw status', () => {
  assert.equal(limitsSaveError({status:500,code:'internal'}), 'Faravan could not confirm the save. Your changes are still here. Reload the saved settings before saving again.');
  assert.match(limitsSaveError({status:503}), /Reload the saved settings/);
  assert.match(limitsSaveError({code:'config_changed'}), /changed since you opened.*changes are still here/);
});
test('unsaved limits cancel links and hash navigation, protect reload, and remove guards when clean', () => {
  const win = new EventTarget(), doc = new EventTarget();
  win.location = {href:'https://local.test/#/lend/limits'};
  win.history = {replaceState(_state,_title,url){win.location.href=url;}};
  const stop = guardUnsavedLimits(win,doc,()=>false);
  const click = new Event('click',{cancelable:true});
  Object.defineProperty(click,'target',{value:{closest:()=>({href:'https://local.test/#/home'})}});
  doc.dispatchEvent(click);
  assert.equal(click.defaultPrevented,true);
  win.location.href = 'https://local.test/#/home';
  win.dispatchEvent(new Event('hashchange'));
  assert.equal(win.location.href,'https://local.test/#/lend/limits');
  const unload = new Event('beforeunload',{cancelable:true});
  Object.defineProperty(unload,'returnValue',{value:true,writable:true});
  win.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);
  stop();
  const clean = new Event('beforeunload',{cancelable:true});win.dispatchEvent(clean);
  assert.equal(clean.defaultPrevented,false);
});

test('only confirmed refusals claim no limits write', () => {
  for (const error of [{code:'network'}, {status:500}, {status:408}]) assert.equal(limitsSaveAmbiguous(error), true);
  for (const error of [{code:'config_changed'}, {code:'invalid_request'}, {status:403}]) assert.equal(limitsSaveAmbiguous(error), false);
});

test('limits reconciliation compares saved settings and the objective position, and ignores unused hours', () => {
  const draft = pageDraft({mode:'ask', limits:{dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, quotaReserve:30, idleOnly:true, timeZone:'UTC'}}, {});
  assert.equal(sameLimits(draft,{...draft,dailyJobs:'03',schedule:{...draft.schedule,from:'09:00'}}), true);
  assert.equal(sameLimits(draft,{...draft,dailyJobs:'4'}), false);
  assert.equal(sameLimits(draft,{...draft,policy:{...draft.policy,protectionPosition:'share_more'}}), false, 'a different protection position is a different saved state');
  assert.equal('personWeeklyPct' in draft.policy, false, 'per-person volume is not an allocator setting');
});

test('the page draft validates supported settings and saves the normalized objective policy', () => {
  const draft = pageDraft({limits:{dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, quotaReserve:95, idleOnly:true, timeZone:'UTC', lendingPolicy:{protectionPosition:'share_more'}}}, {});
  const result = validatePage(draft);
  assert.equal(result.ok, true);
  assert.equal(result.limits.quotaReserve, 95, 'the old reserve is kept as saved');
  assert.equal(result.limits.lendingPolicy.protectionPosition, 'share_more');
  assert.equal('preset' in result.limits.lendingPolicy, false);
  assert.equal('personWeeklyPct' in result.limits.lendingPolicy, false);
  assert.equal('approvalTimeoutMs' in result.limits, false, 'the answer timer is gone');
  const fresh = pageDraft({limits:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,quotaReserve:30,idleOnly:false,timeZone:'UTC'}}, {});
  assert.equal(validatePage(fresh).limits.maxWallSeconds, null, 'a fresh save keeps the wall time bound derived from reset margin');
  const bad = validatePage({...draft, policy:{...draft.policy, protectionPosition:'not_a_position'}});
  assert.equal(bad.ok, false); assert.equal(bad.limits, null); assert.match(bad.policyErrors.protectionPosition, /three lending settings/);
});
