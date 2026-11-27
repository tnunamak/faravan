import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {act, click, createFakeApi, flush, installClock, mount, resetPage, teardown, window} from './mounted.test-helper.mjs';
import {Compose} from './compose.jsx';
import {COMPOSE_DRAFT_PREFIX} from './compose-draft.mjs';

// Bug: Send a job opened on the last circle used even when its host had stopped answering, so Send stayed blocked
// until the person found the Circle row. The page now opens on a circle that answers and says why.
const START = Date.UTC(2026, 10, 5, 15, 0, 0);
const approved = {schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown'};
const DEMO = {id:'demo',name:'Faravan demo',origin:'http://127.0.0.1:9',membershipProjection:approved,selected:true,
  host:{reachable:false,lastReachedAt:new Date(START - 2 * 3600000).toISOString()}};
const FRIENDS = {id:'friends',name:'Friends',origin:'http://127.0.0.1:10',membershipProjection:approved,host:{reachable:true,lastReachedAt:new Date(START).toISOString()}};

beforeEach(() => { resetPage('#/jobs/new'); installClock(START); localStorage.setItem('faravan-compose-first-send-notice-seen', 'yes'); localStorage.setItem('faravan-compose-circle', 'demo'); });
afterEach(teardown);

// The compose read for a circle says what the circle list says about its host.
function api({hosted = false} = {}) {
  const fake = createFakeApi();
  const compose = id => ({circle:id,name:'',hosted:id === 'demo' && hosted,networked:true,presence:'ok',lenders:[],offers:[],
    host:id === 'demo' ? {reachable:false,label:'Ana’s laptop',lastReachedAt:DEMO.host.lastReachedAt} : {reachable:true}});
  fake.get = async path => path === 'folders?path=' ? {home:'/home/sam'} : path === 'folders/suggest' ? {recent:[],repos:[],truncated:false}
    : path.endsWith('/compose') ? compose(path.split('/')[1]) : {};
  return fake;
}
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
const open = async ({circles = [DEMO, FRIENDS], hosted} = {}) => { const page = await mount(h(Compose, {circles,circle:'demo',api:api({hosted}),refresh:()=>{},setCircle:()=>{}})); await settle(); return page; };
const choose = async (page, id) => {
  const select = page.$('select[aria-label="Circle"]');
  await act(() => { select.value = id; select.dispatchEvent(new window.Event('change', {bubbles: true})); });
  await settle();
};

test('Send a job opens on a circle that answers and says why it left the offline one', async () => {
  const page = await open();
  const circle = page.$('select[aria-label="Circle"]');
  assert.equal(circle.value, 'friends');
  assert.deepEqual([...circle.options].map(o => o.textContent), ['Faravan demo · offline', 'Friends']);
  assert.match(page.text(), /Faravan demo isn’t answering \(last seen today at \d{1,2}:\d{2} [AP]M\), so this request goes to Friends\. To send to Faravan demo anyway, choose it under Circle\./);
  assert.equal(localStorage.getItem('faravan-compose-circle'), 'friends', 'the next visit starts on the circle that answers');
});

// Bug: a person who picked an offline circle saw only "Send is enabled again when it answers"; the way out was to
// find the Circle row. The offline notice now offers the circle that answers.
test('an offline circle the person picked offers to send to a circle that answers instead', async () => {
  const page = await open();
  await choose(page, 'demo');
  assert.equal(page.$('select[aria-label="Circle"]').value, 'demo', 'a circle the person picks stays picked');
  assert.match(page.text(), /The circle “Faravan demo” is unreachable/);
  const instead = page.button('Send to Friends instead');
  assert.ok(instead, 'the offline notice offers the circle that answers');
  await click(instead);
  assert.equal(page.$('select[aria-label="Circle"]').value, 'friends');
  assert.doesNotMatch(page.text(), /is unreachable/);
});

// Bug: the notice for a circle hosted on this computer said "Start it again from Circles → Host a circle" with no link.
test('a stopped circle server on this computer links to where hosting starts again', async () => {
  const page = await open({circles:[DEMO], hosted:true});
  assert.match(page.text(), /The circle “Faravan demo” isn’t answering/);
  const start = page.button('Host a circle');
  assert.ok(start, 'the notice links to the host page');
  assert.equal(start.getAttribute('href'), '#/circles/host');
  assert.equal(page.button('Send to Friends instead'), null, 'no other circle, so no other destination is offered');
});

// Review P1: a circle list refresh must not move a page that is already open. Only the person's choice does.
const DEMO_BACK = {...DEMO, host:{reachable:true,lastReachedAt:new Date(START).toISOString()}};
const FRIENDS_DOWN = {...FRIENDS, host:{reachable:false,lastReachedAt:new Date(START - 3600000).toISOString()}};
const mountWith = async (circles, circle) => {
  const fake = api();
  const vnode = c => h(Compose, {circles:c,circle,api:fake,refresh:()=>{},setCircle:()=>{}});
  const page = await mount(vnode(circles));
  await settle();
  return {page, rerender: async next => { await page.rerender(vnode(next)); await settle(); }};
};

test('a circle that answers again does not move a page opened on another circle', async () => {
  const {page, rerender} = await mountWith([DEMO, FRIENDS], 'demo');
  assert.equal(page.$('select[aria-label="Circle"]').value, 'friends');
  await rerender([DEMO_BACK, FRIENDS]);
  assert.equal(page.$('select[aria-label="Circle"]').value, 'friends', 'the page stays on the circle it opened on');
});

test('a circle that stops answering does not move the page or its draft off it', async () => {
  localStorage.setItem('faravan-compose-circle', 'demo');
  const DEMO_UP = {...DEMO, host:{reachable:true,lastReachedAt:new Date(START).toISOString()}};
  const {page, rerender} = await mountWith([DEMO_UP, FRIENDS], 'demo');
  assert.equal(page.$('select[aria-label="Circle"]').value, 'demo');
  await rerender([{...DEMO_UP, host:{reachable:false,lastReachedAt:new Date(START).toISOString()}}, FRIENDS]);
  assert.equal(page.$('select[aria-label="Circle"]').value, 'demo', 'the page stays on the circle it was on');
});

test('a send still in flight keeps its circle when that host stops answering', async () => {
  localStorage.setItem('faravan-compose-circle', 'friends');
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + 'friends', JSON.stringify({id:'draft0001abcd', prompt:'Check the build', sending:true, sourceKind:'none'}));
  const {page, rerender} = await mountWith([DEMO_BACK, FRIENDS], 'demo');
  assert.equal(page.$('select[aria-label="Circle"]').value, 'friends');
  await rerender([DEMO_BACK, FRIENDS_DOWN]);
  assert.equal(page.$('select[aria-label="Circle"]').value, 'friends', 'the send that is still outstanding stays with its circle');
});

// Review P2: the skip is explained even when no circle was chosen before this page opened.
test('a fresh composer says why it skipped the circle that is not answering', async () => {
  localStorage.removeItem('faravan-compose-circle');
  const page = await mount(h(Compose, {circles:[DEMO, FRIENDS],circle:'',api:api(),refresh:()=>{},setCircle:()=>{}}));
  await settle();
  assert.equal(page.$('select[aria-label="Circle"]').value, 'friends');
  assert.match(page.text(), /Faravan demo isn’t answering \(last seen today at \d{1,2}:\d{2} [AP]M\), so this request goes to Friends\./);
});

// Review P2: a saved follow-up opens in its own circle even when that host is not answering and another circle is.
test('a saved follow-up for an offline circle opens in that circle, not in the circle that answers', async () => {
  localStorage.setItem('faravan-compose-circle', 'demo');
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + 'demo', JSON.stringify({id:'draft0002abcd', prompt:'Fix the parser', sending:false, sourceKind:'none',
    followup:{parentJob:'job-1', parentResult:'result-1'}, base:{path:'/work/p', title:'Fix parsing', branch:'main', commit:'a'.repeat(40)}}));
  const page = await open();
  assert.equal(page.$('select[aria-label="Circle"]').value, 'demo', 'the follow-up stays in its circle');
  assert.match(page.text(), /Continues: Fix parsing/);
  assert.equal(page.$('textarea').value, 'Fix the parser');
  assert.equal(JSON.parse(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'demo')).followup.parentJob, 'job-1');
  assert.equal(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'friends'), null, 'no draft is made in the other circle');
});

// Review P2: a restored pending request is pinned when the page opens; another tab's circle choice does not move it.
test('a restored pending request keeps its circle when another tab changes the stored circle', async () => {
  localStorage.setItem('faravan-compose-circle', 'demo');
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + 'demo', JSON.stringify({id:'draft0003abcd', prompt:'Check the build', sending:true, sourceKind:'none'}));
  const {page, rerender} = await mountWith([DEMO_BACK, FRIENDS], 'demo');
  assert.equal(page.$('select[aria-label="Circle"]').value, 'demo');
  localStorage.setItem('faravan-compose-circle', 'friends');
  await rerender([DEMO_BACK, FRIENDS]);
  assert.equal(page.$('select[aria-label="Circle"]').value, 'demo', 'the pending request stays with its circle');
  assert.equal(page.$('textarea').value, 'Check the build');
});
