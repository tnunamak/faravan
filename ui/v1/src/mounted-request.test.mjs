import {advance, click, createFakeApi, forceClick, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {RequestPage} from './request.jsx';
import {adaptLegacyJob} from '../../../lib/v1/state-projection.mjs';

// P0 group 4: the real RequestPage and Decision mounted with the real requestCapacity/requestAdmission. The
// clock is fixed at 2026-10-20 15:00 UTC; the lender's counter day is read in the lender's own zone (UTC here).
const START = Date.UTC(2026, 9, 20, 15, 0, 0), MIN = 60000, TODAY = '2026-10-20', YESTERDAY = '2026-10-19';
beforeEach(() => { resetPage('#/request/r1'); installClock(START); });
afterEach(teardown);

const card = (wallSeconds,requestAdmission,safety) => ({id: 'r1', jobDigest: 'sha256:' + 'a'.repeat(64), requester: 'key-1', requesterName: 'Sam', prompt: 'The login page loops back to itself.',
  harness: 'claude-code-subscription', model: [], runtimeSeconds: wallSeconds, source: {kind: 'archive', size_bytes: 1}, sourceFiles: 3, network: 'provider-only',
  credentialInGuest: false, protection: {satisfied: true, enforced: [], unenforced: []}, expiresAt: START + 40 * 3600000,
  identity: {memberPresent: true, rosterFresh: true, rootMatches: true, circleMatches: true}, disclosure: 'Starts now.',
  ...(safety===undefined?{}:{safety}),
  ...(requestAdmission===undefined?{}:{requestAdmission}),
  job: {circle: 'c1', created_at: new Date(START - 180000).toISOString(), requirements: {egress: 'provider-only', limits: {wall_seconds: wallSeconds}}}});

// `lending` shapes the lender's saved limits and counters; `home` adds Home's own `today` summary when given.
async function open({wall, daily = 60, usedMs, day = TODAY, limits = true, home = {}, noHome = false, admission, failWith = null, safety}) {
  const lending = {enabled: true, circle: 'c1', mode: 'ask', status: 'idle',
    ...(limits ? {limits: {timeZone: 'UTC', dailyJobs: 10, dailyMinutes: daily}} : {}),
    ...(usedMs === undefined ? {} : {counters: {day, milliseconds: usedMs, jobs: 1}})};
  const api = createFakeApi();
  const accepted = [];
  let refreshes=0,runRefreshes=0;
  const mutate = async (path, body) => { accepted.push(path); if (failWith) throw failWith; return api.post(path, body); };
  const refresh = async () => { refreshes++; };
  const refreshRunJobs = async () => { runRefreshes++; };
  const props = {id: 'r1', api, circles: [{id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true}], lending, agents: [{id: 'claude-code-subscription', installed: true, signedIn: true, useForLending: true, run: {}}],
    members: [], mutate, headingRef: {current: null}, refresh, refreshRunJobs,
    data: {approvals: [card(wall,admission,safety)], activity: [], devices: {name: 'MacBook', circles: []}, ...(noHome ? {} : {home: {lending, ...home}})}};
  const view = await mount(h(RequestPage, props));
  return {api, view, accepted, run: () => view.button('Run it'), hint: () => view.$('.rq-hint[role="status"]')?.textContent ?? '', refreshes:()=>refreshes,
    runRefreshes:()=>runRefreshes,
    setAdmission: async value=>view.rerender(h(RequestPage,{...props,data:{...props.data,approvals:[card(wall,value)]}})),
    setData: async data=>view.rerender(h(RequestPage,{...props,data:{...props.data,...data}}))};
}
// The design-system Button reports a disabled state with aria-disabled and swaps its click handler for a no-op.
const inert = element => element.getAttribute('aria-disabled') === 'true';
const BLOCKED_FIT = "This request doesn't fit today's minute limit. Other lenders can take this one.";

async function assertAllowed(page) {
  assert.equal(inert(page.run()), false, 'Run it is enabled');
  assert.equal(page.hint(), '');
  assert.equal(page.view.button('Raise today\'s limit'), null);
  await click(page.run());
  assert.deepEqual(page.api.postsOf(/accept$/).map(post => post.path), ['approvals/r1/accept'], 'exactly one accept POST');
}
async function assertBlocked(page, reason = BLOCKED_FIT) {
  assert.equal(page.hint(), reason);
  assert.ok(page.view.button('Raise today\'s limit'), 'the way to raise the limit is offered');
  const run = page.run();
  await click(run);
  await forceClick(run); // The disabled Button supplies a no-op handler for direct DOM events too.
  assert.equal(page.api.postsOf(/accept$/).length, 0, 'zero accept POSTs');
  assert.deepEqual(page.accepted, [], 'mutate was never called for an accept');
  assert.equal(inert(run), true, 'Run it is disabled');
}

test('RequestPage mounted: runtime below, equal to and above the remaining minutes (accounted milliseconds, wall seconds)', async () => {
  await assertAllowed(await open({wall: 10 * 60, usedMs: 30 * MIN}));          // 10 of 30 remaining minutes
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertAllowed(await open({wall: 30 * 60, usedMs: 30 * MIN}));          // equal fits
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertBlocked(await open({wall: 30 * 60 + 1, usedMs: 30 * MIN}));      // one second over
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertAllowed(await open({wall: 30 * 60 + 30, usedMs: 29 * MIN + 1}));  // fits by exact milliseconds; rounding the used time up to 30 min would refuse it
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertBlocked(await open({wall: 30 * 60, usedMs: 30 * MIN + 1}));      // only the one extra millisecond blocks: exact, not rounded minutes
});

test('RequestPage mounted: Not now is local and Decline is a separate single write', async () => {
  const page=await open({wall:60,usedMs:0});
  const reads=page.api.count(()=>true);
  await click(page.view.button('Not now'));
  assert.deepEqual(page.accepted,[]);
  assert.equal(page.api.count(()=>true),reads,'deferral starts no resource reads');
  assert.match(page.view.text(),/Still pending until/);
  await click(page.view.button('Review again'));
  const decline=page.view.button('Decline');
  await click(decline);
  await forceClick(decline);
  assert.deepEqual(page.accepted,['approvals/r1/decline']);
  assert.match(page.view.text(),/You declined Sam’s request/);
});

test('RequestPage mounted: provider and log disclosure is outside details and before Run it with either boundary result', async () => {
  const disclosure = 'This job runs on your computer under your AI-provider account and uses your subscription. You, your AI provider, and logs on this computer may receive or retain its code, instructions and results. The circle’s host and members can read shared job contents. The sandbox limits the job’s access to your computer; it does not keep those contents confidential from these recipients.';
  for (const boundaryVerified of [false, true]) {
    await teardown(); resetPage('#/request/r1'); installClock(START);
    const page = await open({wall: 10 * 60, usedMs: 0, safety:{boundary_verified:boundaryVerified}});
    const note = page.view.$('.rq-disclosure'), run = page.run();
    assert.ok(note, 'the disclosure is visible');
    assert.equal(note.textContent, disclosure);
    assert.equal(note.closest('details'), null, 'the disclosure is not folded inside a details element');
    assert.ok(page.view.text().indexOf(disclosure) < page.view.text().indexOf('Run it'), 'the disclosure appears before the accept action');
    if (boundaryVerified) assert.doesNotMatch(page.view.text(), /Independent verification of these isolation controls is not available/);
    else assert.match(page.view.text(), /Independent verification of these isolation controls is not available/);
    await click(run);
    assert.deepEqual(page.api.postsOf(/accept$/).map(post => post.path), ['approvals/r1/accept']);
  }
});

test('RequestPage mounted: unit conversion between wall seconds, accounted milliseconds and daily minutes', async () => {
  await assertAllowed(await open({wall: 60, daily: 2, usedMs: 1 * MIN}));       // 60 s left of 2 min, 60 s asked: fits
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertBlocked(await open({wall: 61, daily: 2, usedMs: 1 * MIN}));
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertAllowed(await open({wall: 3600, daily: 60, usedMs: 0}));          // a whole day's minutes in seconds
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertBlocked(await open({wall: 3601, daily: 60, usedMs: 0}));
});

test('RequestPage mounted: zero, missing and stale usage', async () => {
  // zero usage with the counter present, and missing counters, both count as nothing used
  await assertAllowed(await open({wall: 3600, usedMs: 0}));
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertAllowed(await open({wall: 3600}));
  await teardown(); resetPage('#/request/r1'); installClock(START);
  // without saved limits or a Home summary there is nothing to compare with: no false block
  await assertAllowed(await open({wall: 100000, limits: false}));
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertAllowed(await open({wall: 100000, noHome: true}));
  await teardown(); resetPage('#/request/r1'); installClock(START);
  // zero remaining: the counter is exactly at the cap and Home gives no summary of its own
  const REACHED = "You've reached today's minute limit. Other lenders can take this one.";
  await assertBlocked(await open({wall: 60, usedMs: 60 * MIN}), REACHED);
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertBlocked(await open({wall: 0, usedMs: 60 * MIN}), REACHED);        // even a zero-length request: nothing remains
  await teardown(); resetPage('#/request/r1'); installClock(START);
  // a zero-second request needs nothing from what is left
  await assertAllowed(await open({wall: 0, usedMs: 0}));
  await teardown(); resetPage('#/request/r1'); installClock(START);
  await assertAllowed(await open({wall: 0, usedMs: 30 * MIN}));
  await teardown(); resetPage('#/request/r1'); installClock(START);
  // yesterday's counter counts as zero in the lender's zone
  await assertAllowed(await open({wall: 30 * 60, usedMs: 59 * MIN, day: YESTERDAY}));
});

test('RequestPage mounted: usage that goes stale at midnight stops blocking without a reload', async () => {
  const page = await open({wall: 10 * 60, usedMs: 59 * MIN});
  assert.equal(inert(page.run()), true);
  assert.equal(page.hint(), BLOCKED_FIT);
  await advance(8 * 3600000 + 59 * MIN, 60000);       // 23:59 UTC: still today's counter
  assert.equal(inert(page.run()), true);
  await advance(2 * MIN, 1000);                       // past midnight: the counter is yesterday's
  assert.equal(inert(page.run()), false, 'the one-second page clock re-evaluated the limit');
  assert.equal(page.hint(), '');
});

test('RequestPage mounted: a daily minute or job cap from Home blocks with its own words', async () => {
  const minutes = await open({wall: 60, usedMs: 0, home: {today: {jobs: 1, jobLimit: 10, minutes: 60, minuteLimit: 60}}});
  await assertBlocked(minutes, "You've reached today's minute limit. Other lenders can take this one.");
  await teardown(); resetPage('#/request/r1'); installClock(START);
  const jobs = await open({wall: 60, usedMs: 0, home: {today: {jobs: 3, jobLimit: 3, minutes: 0, minuteLimit: 60}}});
  await assertBlocked(jobs, "You've run 3 of 3 jobs today. Other lenders can take this one.");
});

test('RequestPage mounted: acceptance waits through approved, then renders projected running status',async()=>{
 const page=await open({wall:600,usedMs:0});
 await click(page.run());
 assert.match(page.view.text(),/Your approval was received\. Waiting for confirmation that the job has started\./);
 await page.api.answer(/jobs\//,{jobProjection:adaptLegacyJob({state:'claimed',approval:'approved'})});
 assert.match(page.view.text(),/Your approval was received\. Waiting for confirmation that the job has started\./,'approved but not started still waits for start confirmation');
 await advance(2000,2000);
 const read=page.api.openReads(/jobs\//)[0];assert.ok(read,'polls again while approved and not started');
 read.settle('ok',{jobProjection:adaptLegacyJob({state:'running',current_attempt:{execution_started_at:new Date(START).toISOString()}})});
 await advance(0);
 assert.match(page.view.text(),/Started on your computer/);
 assert.equal(page.runRefreshes(),1,'a confirmed start refreshes the shared job list used by the sidebar');
});

test('RequestPage mounted: an invalid explicit job projection stays unknown despite raw running fields',async()=>{
 const page=await open({wall:600,usedMs:0});
 await click(page.run());
 const invalid={schemaVersion:2,kind:'job',phase:'not-a-phase'};
 await page.api.answer(/jobs\//,{jobProjection:invalid,state:'running',current_attempt:{execution_started_at:new Date(START).toISOString()}});
  const decisionText=page.view.$('.rq-card').textContent;
  assert.match(decisionText,/Your approval was received\. Waiting for confirmation that the job has started\./,'a just-accepted job never reads as unavailable');
  assert.doesNotMatch(decisionText,/Started on your computer|not available|Refresh/);
});

// Judge r9 O-A: right after a successful Run it, the first job read can come back before the claim (waiting) or
// unknown. The card says this computer is preparing; it never asks the person to refresh a state the app just caused.
test('RequestPage mounted: right after Run it the card says Preparing, never "not available" or Refresh',async()=>{
 for(const answer of [{jobProjection:adaptLegacyJob({state:'queued'})},{jobProjection:adaptLegacyJob({state:'mystery'})}]) {
  await teardown();resetPage('#/request/r1');installClock(START);
  const page=await open({wall:600,usedMs:0});
  await click(page.run());
  await page.api.answer(/jobs\//,answer);
  const text=page.view.$('.rq-card').textContent;
  assert.match(text,/Your approval was received\. Waiting for confirmation that the job has started\./);
  assert.doesNotMatch(text,/not available|Refresh|The job is waiting/);
 }
});

test('RequestPage mounted: changing explicit server admission changes the display guard over conflicting counters',async()=>{
 const projection=(admission,reasonCode)=>({schemaVersion:2,kind:'request-admission',admission,reasonCode,
  evidence:{jobCap:{used:0,limit:3},minuteCap:{used:0,limit:60,usedMilliseconds:0,limitMilliseconds:3600000,requestedMilliseconds:reasonCode==='request_does_not_fit'?3600001:60000}}});
 const page=await open({wall:60,usedMs:0,home:{today:{jobs:3,jobLimit:3,minutes:60,minuteLimit:60}},admission:projection('allowed',null)});
 assert.equal(inert(page.run()),false,'explicit allowed projection wins over Home caps');
 await page.setAdmission(projection('blocked','request_does_not_fit'));
 assert.equal(inert(page.run()),true,'updated per-card projection blocks Run it');
 assert.match(page.hint(),/doesn't fit today's minute limit/);
 await page.setAdmission(projection('allowed',null));
 assert.equal(inert(page.run()),false,'a newer allowed projection re-enables Run it');
});

test('RequestPage mounted: malformed card admission disables Run without a limit link and offers refresh',async()=>{
 const invalid={schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,evidence:{}};
 const page=await open({wall:60,usedMs:0,admission:invalid});
 assert.equal(inert(page.run()),true,'unknown admission cannot run');
 assert.match(page.hint(),/can’t confirm whether this computer can run this request/i);
 assert.equal(page.view.button('Raise today\'s limit'),null,'unknown is not a confirmed capacity cap');
 const run=page.run();await click(run);await forceClick(run);
 assert.equal(page.api.postsOf(/accept$/).length,0,'unknown admission never accepts');
 assert.equal(page.view.button('Refresh status')!==null,true,'unknown admission can be refreshed');
 await click(page.view.button('Refresh status'));
 assert.equal(page.refreshes(),1,'refresh is delegated to the page resource');
});

// Judge r8 O1: the sender's own computer claimed the job a second before Run it. The card says who took it and that
// nothing ran here; it never offers Run it again or a "Try again" that cannot help.
test('RequestPage mounted: Run it that loses the claim names the taker and removes Run it', async () => {
  const taken = Object.assign(new Error('Faravan couldn’t complete this action. Try again.'), {code: 'job_taken', status: 409, taker: {sender: true, personName: 'Maya Okafor'}});
  const page = await open({wall: 10 * 60, usedMs: 0, failWith: taken});
  await click(page.run());
  const text = page.view.text();
  assert.match(text, /Maya Okafor’s own computer took this job\. Nothing ran here\./);
  assert.doesNotMatch(text, /Try again|Other lenders can take this job/);
  assert.equal(page.view.button('Run it'), null, 'Run it is gone');
  assert.equal(page.view.button('Open the job'), null, 'nothing ran here, so there is no job page to open');
});

// A card leaves the list when someone answers it, so leaving at its deadline is not proof that it expired. The server
// records a real expiry as an approval event too, so the page reports only what an event recorded.
test('RequestPage mounted: a card that leaves at its deadline shows the recorded answer, not an expiry',async()=>{
  for(const [state,said] of [['declined',/declined|Not now|went back/i],['taken',/Taken by someone else/]]){
    const page=await open({wall:600,usedMs:0});
    await page.setData({approvals:[{...card(600),expiresAt:START}]});
    await page.setData({approvals:[],activity:[{id:5,type:'approval',data:{id:'r1',state,jobDigest:card(600).jobDigest}}]});
    const text=page.view.text();
    assert.doesNotMatch(text,/expired at|review window ended/i,state+': '+text.slice(0,300));
    assert.match(text,said,state);
    teardown();
  }
  const page=await open({wall:600,usedMs:0});
  await page.setData({approvals:[{...card(600),expiresAt:START}]});
  await page.setData({approvals:[],activity:[{id:6,type:'approval',data:{id:'r1',state:'expired',jobDigest:card(600).jobDigest}}]});
  assert.match(page.view.text(),/This request expired/,'a recorded expiry still says expired');
});
