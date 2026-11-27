// Home and shell defects from the 11-01 sweep (batch 2). Each test fails on the pre-fix code.
import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Home, ResultCard} from './home.jsx';
import {Shell, SKIP_TARGET} from './shell.jsx';
import {homePageVM, needsYouCount, needsYouItems, machineVM} from './view-models.mjs';
import {renderFixture, renderedText, assertDomOrder} from './render.test-helper.mjs';

const now = Date.parse('2026-10-20T05:00:00Z');
const circle = {id:'c1', name:'Weekend projects', origin:'http://fixture', owned:true, enrollment:{state:'approved'}, rosterMembershipVerified:true};
const agent = {id:'codex', installed:true, signedIn:true, useForLending:true};
const lending = {enabled:true, circle:'c1', mode:'ask', status:'idle', limits:{timeZone:'UTC', dailyJobs:3, dailyMinutes:60}};
const storedPass = {id:'test-run', state:'passed', at:'2026-10-20T03:00:00Z', current:{runId:'test-run', at:'2026-10-20T03:00:00Z',
  configuration:{versions:{faravan:'0.12.0', sbx:'0.48.0', probe:{version:1, digest:'fixture'}, adapters:{}}, agents:['claude-code-subscription', 'codex']}}};
const home = {lending,intent:{on:true, state:'ready'}};
const okChecks = [{name:'sbx_install', ok:true}, {name:'sbx_version', ok:true}, {name:'sbx_daemon', ok:true}, {name:'docker_login', ok:true}];
const readiness = {ready:true, checks:okChecks};
const data = {home, circles:[circle], agents:[agent], jobs:[], approvals:[], activity:[], devices:{name:'Ana’s MacBook', ownerName:'Ana', fingerprint:'own', circles:[]}, readiness};
const page = (patch = {}, props = {}) => renderFixture(Home, {api:{get:async () => []}, circles:[circle], agents:[agent], lending, circle:'c1', selected:circle,
  members:[], mutate:async () => ({}), refresh() {}, setDialog() {}, data:{...data, ...patch}, ...props});
const request = (id, digest) => ({id, jobDigest:digest, requester:'sam', requesterName:'Sam', identity:{memberPresent:true, rosterFresh:true, rootMatches:true, circleMatches:true, requesterName:'Sam'},
  prompt:'Fix login', harness:'codex', model:[], runtimeSeconds:1200, source:{kind:'archive', size_bytes:1}, network:'provider-only', protection:{satisfied:true}, expiresAt:Date.now() + 600000});
const sent = (id, extra = {}) => ({job_digest:id, role:'sent', status:'Finished', state:'result-accepted', local:{title:'Fix ' + id, prompt:'Fix the parser'}, circle, ...extra});

// 1. The Lending dot reads the same lending checks the Setup page reads.
const shell = (props = {}) => renderFixture(Shell, {route:{page:'home'}, home, devices:data.devices, approvals:[], jobs:[], circles:[circle], title:'Home',
  readiness, agents:[agent], children:h('main', null, 'body'), ...props});
const lendingChecks = {agents:[{id:'codex', checks:[{id:'signed_in', state:'pass'}]}]};
test('item 1: the Lending dot clears once the lending checks pass, and returns for a real blocker', () => {
  const homeAdmitted = {...home, lendingPolicy: {accounts:[{provider:'codex',decision:{availability:{admitted:true}}}]}};
  assert.doesNotMatch(shell({lendingReadiness:lendingChecks, home:homeAdmitted}), /progress-mark/);
  const failing = {agents:[{id:'codex', checks:[{id:'signed_in', state:'fail'}]}]};
  assert.match(shell({lendingReadiness:failing, home:homeAdmitted}), /progress-mark/);
  assert.match(shell({lendingReadinessError:true, home:homeAdmitted}), /progress-mark/, 'checks that could not be read are not a finished setup');
  assert.doesNotMatch(shell(), /progress-mark/, 'no dot is drawn while the lending checks are still being read');
});

// 2 and 3. Cards, count and the empty line come from one list.
test('item 2: an approval for this computer’s own job is not a card, a count or a contradiction', () => {
  const own = request('own-approval', 'j1'), other = request('r2', 'j2');
  const jobs = [sent('j1', {state:'waiting_approval', status:'Waiting', local:{title:'Mine', prompt:'Mine'}})];
  const ownOnly = homePageVM({jobs, approvals:[own], home, readiness, agents:[agent], now, zone:'UTC'});
  assert.equal(ownOnly.needs, 0);
  assert.equal(ownOnly.requestIds.has('own-approval'), false);
  const html = page({jobs, approvals:[own]});
  assert.doesNotMatch(html, /Review request/);
  assert.doesNotMatch(html, /You<\/b>|sent a job request/);
  assert.match(renderedText(html), /Nothing needs a decision right now/);
  const both = page({jobs, approvals:[own, other]});
  assert.equal((both.match(/Review request/g) || []).length, 1, 'the other person’s request stays, once');
  assert.match(both, /href="#\/request\/r2"/);
  assert.equal(both.includes('href="#/request/own-approval"'), false);
  assert.equal(needsYouCount({jobs, approvals:[own, other], home}), 1);
});
test('item 3: a listed result that is already handled leaves no count and no empty section', () => {
  const handled = sent('done', {borrowerOutcome:{verdict:'used'}});
  const listed = {...home, needs_you:[{kind:'result', job_digest:'done'}]};
  assert.equal(needsYouCount({jobs:[handled], approvals:[], home:listed}), 0);
  const vm = homePageVM({jobs:[handled], approvals:[], home:listed, readiness, agents:[agent], now, zone:'UTC'});
  assert.deepEqual([vm.needs, vm.result, vm.counts.results], [0, null, 0]);
  const text = renderedText(page({home:listed, jobs:[handled]}));
  assert.doesNotMatch(text, /Needs your attention\s*1/);
  assert.match(text, /Nothing needs a decision right now/);
  // The job list is the truth about results: a listed job it lacks has no card, so it is not counted either.
  assert.equal(needsYouCount({jobs:[], approvals:[], home:listed}), 0);
  // A result that is really waiting is still one card and one count.
  const waiting = sent('wait');
  const waitingVm = homePageVM({jobs:[waiting], approvals:[], home:{...home, needs_you:[{kind:'result', job_digest:'wait'}]}, readiness, agents:[agent], now, zone:'UTC'});
  assert.deepEqual([waitingVm.needs, waitingVm.result?.id], [1, 'wait']);
});

// 4. A failed jobs read marks the old rows as last known and offers a retry.
test('item 4: after a failed jobs read, running rows say last known and a retry is offered', async () => {
  const running = {job_digest:'running', role:'ran', state:'claimed', circle, historyIdentity:{author:'borrower', personName:'Alex Example'},
    current_attempt:{holder:'own', execution_started_at:new Date(now).toISOString()}, updated_at:new Date(now).toISOString()};
  const fresh = renderedText(page({approvals:[], jobs:[running]}));
  assert.match(fresh, /Running for Alex Example/);
  assert.doesNotMatch(fresh, /Last known: Running|Try jobs again/);
  const stale = renderedText(page({approvals:[], jobs:[running]}, {errors:{jobs:Error('offline')}, refreshRunJobs() {}}));
  assert.match(stale, /Last known: Running for Alex Example/);
  assert.match(stale, /Try jobs again/);
  assert.doesNotMatch(stale, /(?<!Last known: )Running for Tessa/);
});

// 5. Skip to content lands before the heading.
test('item 5: the skip target starts the main column, before the page heading and the banner', () => {
  const html = shell({banner:h('div', {class:'offline'}, 'banner'), headingRef:null});
  assertDomOrder(html, ['id="' + SKIP_TARGET + '"', '<header class="page-head"', 'class="offline"', 'body']);
  assert.match(html, new RegExp('id="' + SKIP_TARGET + '" tabindex="-1"'));
});

// 6. Try preview again only after an error.
test('item 6: Try preview again shows only after a failed preview or receipt read', () => {
  const vm = homePageVM({jobs:[sent('r')], approvals:[], home, readiness, agents:[agent], now, zone:'UTC'});
  const card = props => renderedText(renderFixture(ResultCard, {vm, retryPreview() {}, ...props}));
  assert.doesNotMatch(card({}), /Try preview again/);
  assert.doesNotMatch(card({previewPending:true}), /Try preview again/);
  assert.match(card({previewPending:true}), /Loading preview/);
  assert.match(card({previewError:true}), /Preview couldn’t be loaded.*Try preview again/);
  assert.match(card({receiptError:true}), /Run details couldn’t be loaded.*Try preview again/);
});

// 8. See foundation-status.test.mjs ('machine chip and Home headline agree…') for the chip dot.
test('item 8: a hold that clears on its own keeps the words and uses the waiting dot', () => {
  const held = {provider:'codex', label:'Codex', decision:{admitted:false, reason:'objective_evidence_unknown', status:{id:'stopped', line:'Stopped for new jobs.', recovery:{who:'automatic'}}}};
  const chip = machineVM({...home, lendingPolicy:{accounts:[held]}}, {name:'sandpiper'}, {agents:[agent], readiness});
  assert.deepEqual([chip.line, chip.kind], ['Lending on', 'wait']);
});
