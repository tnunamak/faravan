import {click, createFakeApi, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {act} from 'preact/test-utils';
import {LimitsPage} from './limits.jsx';
import {Circle, Circles} from './circles.jsx';
import {Home} from './home.jsx';
import {OnboardingEntry} from './onboarding.jsx';
import {onboardingVM} from './onboarding.mjs';
import {homePeopleVM} from './view-models.mjs';
import {circlesListVM} from './circles-view.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {NOW} from './lending-policy.fixture.mjs';

// Judge r7 notices N3, N7, N8, N9, N10, M2 (journey surfaces). Each test failed before its fix.
const START = Date.UTC(2026, 9, 20, 15, 0, 0);
beforeEach(() => { resetPage('#/'); installClock(START); });
afterEach(teardown);

const lending = {mode: 'ask', circle: 'weekend', limits: {timeZone: 'UTC', dailyJobs: 3, dailyMinutes: 60,
  maxWallSeconds: 1200, lendingPolicy: {protectionPosition: 'balanced'}}};

test('N3 after Save the confirmation sits in the sticky footer, not at the top, and keeps focus', async () => {
  const posts = [];
  const mutate = async (path, body) => { posts.push(path); return {}; };
  const view = await mount(h(LimitsPage, {lending, circle: 'weekend', now: NOW, mutate, api: createFakeApi(), data: {home: {lending}}}));
  const keepMore = view.$('input[name="protectionPosition"][value="keep_more_for_me"]');
  keepMore.checked = true;
  await act(() => { keepMore.dispatchEvent(new window.Event('change', {bubbles: true})); });
  await click(view.$('.limits-savebar .btn-primary'));
  assert.deepEqual(posts, ['lending/limits']);
  const status = view.$('.limits-footer [role="status"]');
  assert.ok(status, 'the confirmation is inside the sticky footer');
  assert.equal(status.textContent.trim(), 'Saved.');
  assert.ok(!view.$('.limits-form > .limits-confirmation:not(.limits-footer)'), 'no confirmation above the form');
  assert.ok(document.activeElement === status, 'focus moves to the confirmation; active is ' + document.activeElement?.outerHTML?.slice(0, 80));
});

test('N7 a member the facts show as online or active never reads "No recent activity"', () => {
  const rows = homePeopleVM([
    {key_id: 'a', localName: 'Ana', online: true, ready: true},
    {key_id: 'b', localName: 'Bo', online: true},
    {key_id: 'c', localName: 'Cy', intent: {state: 'ready'}, presence: {state: 'ready', last_poll_at: new Date(START - 20000).toISOString()}},
    {key_id: 'd', localName: 'Di'},
  ], {ownId: 'self', now: START, zone: 'UTC', circleId: 'x', jobs: [{circle: {id: 'x'}, state:'claimed', current_attempt: {holder: 'd', state: 'active', claimed_at: new Date(START - 30000).toISOString(), execution_started_at:new Date(START - 15000).toISOString()}}]});
  assert.deepEqual(rows.map(row => row.state), ['Ready to lend', 'Online', 'Lending now', 'Running a job now']);
  // Nothing known stays honest, and old facts never claim presence.
  assert.equal(homePeopleVM([{key_id: 'e', localName: 'Ed'}], {ownId: 'self', now: START})[0].state, 'No recent activity');
  assert.match(homePeopleVM([{key_id: 'f', localName: 'Fy', online: false, last_seen_at: new Date(START - 3600000).toISOString()}], {ownId: 'self', now: START, zone: 'UTC'})[0].state, /^Last seen/);
});

test('N8 Home never prints "This computer" as the computer name under the "This computer" heading', () => {
  const home = {lending, today: {jobs: 0, jobLimit: 3, minutes: 0, minuteLimit: 60}, intent: {on: true, state: 'ready'}};
  const out = renderFixture(Home, {api: {get: async () => []}, data: {home, lending, circles: [], agents: [], jobs: [], approvals: [], activity: [], devices: {fingerprint: 'self', circles: []}},
    lending, agents: [], circles: [], circle: '', members: [], mutate: async () => ({}), refresh() {}, setDialog() {}});
  assert.doesNotMatch(out, /home-lending-device[^>]*>This computer</);
});

const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true};
const circleProps = (mutate) => ({id: 'c1', circles: [circle], mutate, api: createFakeApi(), revision: 0, setDialog() {}, headingRef: {current: null}, refresh() {},
  data: {circles: [circle], devices: {name: 'sandpiper', fingerprint: 'self', circles: [{circle: 'c1', members: [{key_id: 'self'}, {key_id: 'm'}]}]}}});

test('N9 after an invitation is created the button is not a second "Create invitation"', async () => {
  let n = 0;
  const mutate = async () => ({invite: 'https://x/join#' + (++n)});
  const view = await mount(h(Circle, circleProps(mutate)));
  await click(view.button('Invite someone'));
  await click(view.button('Create invitation'));
  assert.match(view.$('textarea, input[readonly]')?.value ?? view.text(), /https:\/\/x\/join#1/);
  assert.equal(view.button('Create invitation'), null, 'the used button is gone');
  const again = view.button('Create another invitation');
  assert.ok(again, 'the next action says what it does');
  await click(again);
  assert.match(view.$('textarea')?.value ?? '', /join#2/);
});

test('N10 Home "Join with an invitation" opens the join form on the Circles page at once', async () => {
  const entry = onboardingVM({home: {lending: {enabled: false}}, circles: [], jobs: []}).entry;
  const view = await mount(h(OnboardingEntry, {entry}));
  await click(view.button('Join with an invitation'));
  const out = renderFixture(Circles, {circles: [], data: {circles: []}, api: {}, mutate() {}, refresh() {}});
  assert.match(renderedText(out), /Join a circle/);
  // The intent is used once.
  assert.doesNotMatch(renderedText(renderFixture(Circles, {circles: [], data: {circles: []}, api: {}, mutate() {}, refresh() {}})), /Join a circle/);
});

test('M2 the circles list keeps the last known computer count when the device list is momentarily empty', () => {
  const c = [{id: 'c1', name: 'Book club', origin: 'http://x', owned: false, joinInfo: {ownerName: 'Tessa'}}];
  assert.match(circlesListVM(c, {circles: []}, null, {lastCounts: {c1: 2}})[0].meta, /2 computers/);
  assert.match(circlesListVM(c, {circles: [{circle: 'c1', members: []}]}, null, {lastCounts: {c1: 2}})[0].meta, /2 computers/);
  assert.doesNotMatch(circlesListVM(c, {circles: []}, null)[0].meta, /computers/);
  assert.match(circlesListVM(c, {circles: [{circle: 'c1', members: [{}, {}, {}]}]}, null, {lastCounts: {c1: 2}})[0].meta, /3 computers/);
  assert.match(circlesListVM(c, {circles: [{circle: 'c1', rosterHeld: true, members: []}]}, null, {lastCounts: {c1: 2}})[0].meta, /0 computers/);
  assert.match(circlesListVM(c, {circles: []}, null, {lastCounts: {c1: 0}})[0].meta, /0 computers/, 'a last-known zero is kept like any count');
});

test('Home mounting four legacy circles sends no transition or permission mutations', async () => {
 const circles=Array.from({length:4},(_,i)=>({...circle,id:'c'+(i+1),name:'Circle '+(i+1)}));
 const posts=[];
 const current={...lending,enabled:true,configVersion:7,presenceNotice:{kind:'pair',idleOnly:true,stopOnReturn:true}};
 const home={lending:current,intent:{on:true,state:'ready'},automaticNotices:circles.map(c=>({circle:c.id,name:c.name,kind:'automatic',dismissed:false}))};
 const before=JSON.stringify(home);
 const approval={id:'live-request',requester:'sam',requesterName:'Sam',identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true,requesterName:'Sam'},prompt:'Fix login',harness:'codex',model:[],runtimeSeconds:1200,source:{kind:'archive',size_bytes:1},network:'provider-only',protection:{satisfied:true},expiresAt:START+600000};
 const agents=[{id:'codex',installed:true,signedIn:true,useForLending:true}];
 const view=await mount(h(Home,{api:createFakeApi(),circles,agents,lending:current,circle:'c1',selected:circles[0],members:[],
  mutate:async(path,body)=>{posts.push({path,body});return {};},refresh(){},setDialog(){},
  data:{home,circles,agents,jobs:[],approvals:[approval],activity:[],devices:{name:'Test computer',fingerprint:'self',circles:[]},readiness:{ready:true,checks:[]}}}));
 await act(async()=>{await Promise.resolve();});
 assert.equal(view.button('Use the new default'),null);
 assert.equal(view.button('Keep current settings'),null);
 assert.doesNotMatch(view.text(),/Automatic is now|the new default removes/);
 assert.match(view.text(),/Sam asked to use your computer/);
 assert.ok(view.$('a[href="#/request/live-request"]'));
 assert.deepEqual(posts,[],'mount and effect settlement must not answer or dismiss any legacy notice');
 assert.equal(JSON.stringify(home),before);
});
