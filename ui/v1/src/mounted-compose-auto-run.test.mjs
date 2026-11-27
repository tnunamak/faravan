import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {act, click, createFakeApi, installClock, mount, resetPage, teardown, flush, advance} from './mounted.test-helper.mjs';
import {Compose} from './compose.jsx';
import {COMPOSE_DRAFT_PREFIX} from './compose-draft.mjs';

// Choosing "Cheapest that fits" or "Strongest offered" sends one automatic choice. The screen offers them only while a
// lender that can make that choice is online, so an older lender is never asked.
const START = Date.UTC(2026, 10, 6, 15, 0, 0);
const CIRCLE = {id:'circle-auto', name:'Friends', origin:'https://friends.example', membershipProjection:{
  schemaVersion:2, kind:'membership', phase:'approved', evidence:{enrollmentState:'approved', origin:true}, invitationPolicy:'unknown'}};
const LENDER = {keyId:'lender', self:false, label:'Ana’s MacBook', agents:[{adapter:'codex', readiness:'ready'}]};
const BOTH = ['cheapest', 'strongest'];
const offer = (model, effort, auto_intents) => ({harness:'codex', model, effort, ...(auto_intents ? {auto_intents} : {})});

beforeEach(() => {
  resetPage('#/borrow'); installClock(START);
  localStorage.setItem('faravan-compose-first-send-notice-seen', 'yes');
  localStorage.setItem('faravan-compose-draft:' + CIRCLE.id, JSON.stringify({id:'draft-auto-mounted-1', sourceKind:'none', prompt:'Summarise the plan', path:'', workingDirectory:'',
    gitUrl:'', gitCommit:'', files:[], zip:null, includeUncommitted:false, agent:'codex', verifyCmd:'', verifyEdited:false, sending:false, uncertainSince:null, sendAnyway:false}));
});
afterEach(teardown);

function open(offers, {runRequestSupported=false, accountOffers=[], fail=false, retryAt} = {}) {
  const api = createFakeApi(), posted = [];
  api.composeReads = 0;
  api.get = async path => {
    if (path === 'folders?path=') return {home:'/home/sam'};
    if (path === 'folders/suggest') return {recent:[], repos:[], truncated:false};
    if (!path.endsWith('/compose')) return {};
    api.composeReads++;
    return {circle:CIRCLE.id, name:'Friends', networked:true, presence:'ok', host:{label:'Host', reachable:true}, lenders:[LENDER], offers, runRequestSupported, accountOffers};
  };
  api.post = async (path, body) => {
    if (path !== 'jobs') return {};
    posted.push(structuredClone(body));
    if (retryAt !== undefined && posted.length === 1) {
      throw Object.assign(new Error('synthetic busy host'), {
        code:'rate_limited', outcome:'not_applied', problem:{retryPolicy:{until:retryAt}},
      });
    }
    if (fail) throw new Error('synthetic lost response');
    return {jobDigest:'sha256:' + 'b'.repeat(64)};
  };
  api.posted = posted;
  return mount(h(Compose, {circles:[CIRCLE], circle:CIRCLE.id, api, refresh:() => {}, setCircle:() => {}})).then(page => { page.api = api; return page; });
}
const choose = async (page, value) => { await act(() => { const select = page.$('#cmp-model'); select.value = value; select.dispatchEvent(new Event('change', {bubbles:true})); }); await flush(); };

test('choosing a preset sends the automatic choice and no model or effort', async () => {
  const page = await open([offer('gpt-6-luna', 'low', BOTH), offer('gpt-6-sol', 'high', BOTH)]);
  const labels = [...page.$('#cmp-model').options].map(o => o.textContent);
  assert.deepEqual(labels.slice(0, 3), ['Let the lender choose', 'Cheapest that fits', 'Strongest offered']);
  await choose(page, 'auto:cheapest');
  assert.equal(page.$('#cmp-model').value, 'auto:cheapest');
  assert.equal(page.$('#cmp-effort').disabled, true, 'the lender picks the effort too');
  await click(page.button('Send'));
  assert.equal(page.api.posted.length, 1);
  assert.deepEqual(page.api.posted[0].auto_run_v1, {intent:'cheapest'});
  assert.equal(page.api.posted[0].model, undefined);
  assert.equal(page.api.posted[0].budget_v1, undefined);
  assert.equal(page.api.posted[0].harness, 'codex');
});

test('Strongest offered sends its own intent, and picking a model afterwards drops the preset', async () => {
  const page = await open([offer('gpt-6-luna', 'low', BOTH), offer('gpt-6-sol', 'high', BOTH)]);
  await choose(page, 'auto:strongest');
  assert.equal(page.$('#cmp-model').value, 'auto:strongest');
  await choose(page, 'gpt-6-sol');
  const effort = page.$('#cmp-effort');
  await act(() => { effort.value = 'high'; effort.dispatchEvent(new Event('change', {bubbles:true})); }); await flush();
  await click(page.button('Send'));
  assert.equal(page.api.posted[0].auto_run_v1, undefined);
  assert.equal(page.api.posted[0].model, 'gpt-6-sol');
  assert.deepEqual(page.api.posted[0].budget_v1, {effort:'high'});
});

test('no preset is offered while no online lender can make the choice', async () => {
  const page = await open([offer('gpt-6-luna', 'low'), offer('gpt-6-sol', 'high')]);
  const labels = [...page.$('#cmp-model').options].map(o => o.textContent);
  assert.ok(!labels.includes('Cheapest that fits') && !labels.includes('Strongest offered'), labels.join(' | '));
});

const labelsOf = page => [...page.$('#cmp-model').options].map(o => o.textContent);

test('Strongest offered is sent as its own choice, with no model and no effort', async () => {
  const page = await open([offer('gpt-6-luna', 'low', BOTH), offer('gpt-6-sol', 'high', BOTH)]);
  await choose(page, 'auto:strongest');
  await click(page.button('Send'));
  assert.equal(page.api.posted.length, 1);
  assert.deepEqual(page.api.posted[0].auto_run_v1, {intent:'strongest'});
  assert.equal(page.api.posted[0].model, undefined);
  assert.equal(page.api.posted[0].budget_v1, undefined);
});

test('each preset is offered only for the lenders that say they can make it', async () => {
  const cheapOnly = await open([offer('gpt-5.4-mini', 'low', ['cheapest'])]);
  assert.ok(labelsOf(cheapOnly).includes('Cheapest that fits'));
  assert.ok(!labelsOf(cheapOnly).includes('Strongest offered'), 'a model with no rank cannot be the strongest: ' + labelsOf(cheapOnly));
  await teardown();
  const neither = await open([offer('mystery', 'low')]);
  assert.ok(!labelsOf(neither).includes('Cheapest that fits') && !labelsOf(neither).includes('Strongest offered'));
});

test('a saved choice the lenders stop supporting turns Send off until the person picks again', async () => {
  localStorage.setItem('faravan-compose-draft:' + CIRCLE.id, JSON.stringify({...JSON.parse(localStorage.getItem('faravan-compose-draft:' + CIRCLE.id)), auto:'strongest'}));
  const page = await open([offer('gpt-5.4-mini', 'low', ['cheapest'])]);
  await click(page.button('Send'));
  assert.equal(page.api.posted.length, 0, 'nothing is posted for a choice no lender can make');
});

test('a saved choice this screen does not know sends nothing and shows what to do', async () => {
  localStorage.setItem('faravan-compose-draft:' + CIRCLE.id, JSON.stringify({...JSON.parse(localStorage.getItem('faravan-compose-draft:' + CIRCLE.id)), auto:'best'}));
  const page = await open([offer('gpt-6-luna', 'low', BOTH)]);
  await click(page.button('Send'));
  assert.equal(page.api.posted.length, 0, 'an unknown choice is never turned into the lender default');
  assert.match(page.text(), /“best”/);
  assert.equal(page.$('#cmp-model').value, 'auto:best', 'the saved value stays visible');
  await choose(page, '');
  await click(page.button('Send'));
  assert.equal(page.api.posted.length, 1, 'clearing the choice is the way out');
  assert.equal(page.api.posted[0].auto_run_v1, undefined);
});

// A saved choice that blocks Send must always be clearable, even when no lender offers anything to choose from.
const savedDraft = () => JSON.parse(localStorage.getItem('faravan-compose-draft:' + CIRCLE.id));
for (const [name, agent] of [['an agent is chosen', 'codex'], ['no agent is chosen', '']]) {
  test(`a saved choice nobody can make is cleared from the Model list when no lender offers anything and ${name}`, async () => {
    localStorage.setItem('faravan-compose-draft:' + CIRCLE.id, JSON.stringify({...savedDraft(), auto:'best', agent}));
    const page = await open([]);
    assert.equal(page.$('#cmp-model').disabled, false, 'the one list that holds “Let the lender choose” stays usable');
    assert.equal(page.$('#cmp-model').value, 'auto:best');
    const labels = [...page.$('#cmp-model').options].map(o => o.textContent);
    assert.ok(!labels.includes('Cheapest that fits') && !labels.includes('Strongest offered'), 'no new choice is offered: ' + labels);
    await choose(page, '');
    assert.equal(page.$('#cmp-model').value, '');
    assert.equal(savedDraft().auto, '', 'the choice is cleared');
    assert.equal(savedDraft().prompt, 'Summarise the plan', 'the prompt is kept');
  });
}


const ACCOUNT_OFFERS = [
  {providerId:'codex',modelId:'model-a',effortIds:['high']},
  {providerId:'claude',modelId:'model-a',effortIds:[]},
];
const signedOpen = (options={}) => open([], {runRequestSupported:true,accountOffers:ACCOUNT_OFFERS,...options});
const pairKey = provider => JSON.stringify([provider,'model-a']);
const expectedRequest = (models='any',effortId=null) => ({schemaVersion:1,models,effortId});
const chooseEffort = async (page,value) => {
  await act(() => { const select=page.$('#cmp-effort'); select.value=value; select.dispatchEvent(new Event('change',{bubbles:true})); }); await flush();
};
const assertSigned = body => {
  for (const key of ['model','budget_v1','auto_run_v1']) assert.equal(Object.hasOwn(body,key),false,key);
  assert.equal(body.circle,CIRCLE.id); assert.equal(body.harness,'codex'); assert.equal(body.noSource,true);
};
test('signed Any posts the exact runRequest envelope with normal submit fields',async()=>{
  const page=await signedOpen();
  assert.equal(page.$('#cmp-model').options[0].textContent,'Any');
  await click(page.button('Send'));
  assert.equal(page.api.posted.length,1);
  assert.deepEqual(page.api.posted[0].runRequest,expectedRequest()); assertSigned(page.api.posted[0]);
});
test('signed models distinguish providers and support explicit effort or Default-only',async()=>{
  const page=await signedOpen();
  assert.ok(labelsOf(page).includes('codex / model-a'));
  assert.ok(labelsOf(page).includes('claude / model-a'));
  await choose(page,pairKey('claude'));
  assert.deepEqual([...page.$('#cmp-effort').options].map(o=>o.textContent),['Default']);
  await choose(page,pairKey('codex')); await chooseEffort(page,'high');
  await click(page.button('Send'));
  assert.deepEqual(page.api.posted[0].runRequest,expectedRequest([{providerId:'codex',modelId:'model-a'}],'high'));
  assertSigned(page.api.posted[0]);
});
test('an unavailable signed choice stays visible and cannot post',async()=>{
  const runRequest=expectedRequest([{providerId:'gone',modelId:'model-a'}],'high');
  localStorage.setItem(COMPOSE_DRAFT_PREFIX+CIRCLE.id,JSON.stringify({...savedDraft(),requestMode:'signed',runRequest}));
  const page=await signedOpen();
  assert.equal(page.$('#cmp-model').value,pairKey('gone'));
  assert.match(page.text(),/unavailable/);
  await click(page.button('Send')); assert.equal(page.api.posted.length,0);
});
for (const capability of [false,null]) test(`saved signed request never falls back with capability ${capability}`,async()=>{
  localStorage.setItem(COMPOSE_DRAFT_PREFIX+CIRCLE.id,JSON.stringify({...savedDraft(),requestMode:'signed',runRequest:expectedRequest()}));
  const page=await signedOpen({runRequestSupported:capability});
  await click(page.button('Send')); assert.equal(page.api.posted.length,0);
  assert.equal(savedDraft().requestMode,'signed');
});
test('malformed saved signed request cannot be restored as a legacy default',async()=>{
  localStorage.setItem(COMPOSE_DRAFT_PREFIX+CIRCLE.id,JSON.stringify({...savedDraft(),requestMode:'signed',runRequest:{schemaVersion:1,models:[],effortId:null}}));
  const page=await signedOpen();
  assert.equal(page.api.posted.length,0);
  assert.equal(page.$('#cmp-model'),null,'malformed recovery is not an editable fresh draft');
});
test('a status poll cannot restart a busy signed send deadline',async()=>{
  const deadline=START+20000;
  const page=await signedOpen({retryAt:deadline});
  await choose(page,pairKey('codex')); await chooseEffort(page,'high');
  await click(page.button('Send'));
  assert.equal(Date.now(),START);
  assert.equal(page.api.posted.length,1);
  const body=page.api.posted[0], reads=page.api.composeReads;
  assert.ok(reads>0,'host support was confirmed before the first send');
  assert.deepEqual(body.runRequest,expectedRequest([{providerId:'codex',modelId:'model-a'}],'high'));
  assert.equal(savedDraft().id,body.draft_id);
  assert.equal(savedDraft().requestMode,'signed');
  await advance(15000);
  assert.equal(page.api.composeReads,reads+1,'the real Compose poll refreshed state during the wait');
  assert.equal(page.api.posted.length,1);
  await advance(4999);
  assert.equal(Date.now(),deadline-1);
  assert.equal(page.api.posted.length,1,'no retry before the original deadline');
  await advance(1);
  assert.equal(Date.now(),deadline);
  assert.equal(page.api.posted.length,2,'one retry at the original deadline');
  assert.equal(JSON.stringify(page.api.posted[1]),JSON.stringify(body));
  await advance(30000);
  assert.equal(page.api.posted.length,2,'no duplicate after the confirmed retry');
});

for (const [offerChange, accountOffers] of [
  ['offer reorder', [...ACCOUNT_OFFERS].reverse()],
  ['selected offer disappears', ACCOUNT_OFFERS.filter(offer => offer.providerId !== 'codex')],
]) test(`mounted uncertain retry restores the first signed request after remount and ${offerChange}`,async()=>{
    const first=await signedOpen({fail:true});
    await choose(first,pairKey('codex')); await chooseEffort(first,'high');
    await click(first.button('Send'));
    assert.equal(first.api.posted.length,1);
    const body=structuredClone(first.api.posted[0]), recovery=localStorage.getItem(COMPOSE_DRAFT_PREFIX+CIRCLE.id);
    assert.equal(JSON.parse(recovery).sending,true);
    assert.equal(JSON.parse(recovery).requestMode,'signed');
    assert.equal(JSON.parse(recovery).id,body.draft_id);
    assert.deepEqual(JSON.parse(recovery).runRequest,body.runRequest);
    await teardown(); resetPage('#/borrow'); installClock(START);
    localStorage.setItem('faravan-compose-first-send-notice-seen','yes');
    localStorage.setItem(COMPOSE_DRAFT_PREFIX+CIRCLE.id,recovery);
    const second=await signedOpen({accountOffers});
    assert.equal(second.$('#cmp-model').value,pairKey('codex'));
    assert.equal(second.$('#cmp-model').disabled,true);
    assert.equal(second.$('#cmp-effort').disabled,true);
    assert.equal(savedDraft().requestMode,'signed');
    assert.equal(second.api.posted.length,0,'remount does not post before the retry window');
    await advance(2999);
    assert.equal(second.api.posted.length,0,'no POST one millisecond before retry');
    await advance(1);
    assert.equal(second.api.posted.length,1,'exactly one retry at 3000 ms');
    assert.equal(JSON.stringify(second.api.posted[0]),JSON.stringify(body),'byte-equivalent serialized POST');
    assertSigned(second.api.posted[0]);
    assert.deepEqual(second.api.posted,[body],'same draft identity, mode and complete outgoing request');
});

test('remount keeps the original busy deadline and replays the same signed request', async () => {
  const deadline = START + 20_000;
  const first = await signedOpen({retryAt: deadline});
  await choose(first, pairKey('codex'));
  await chooseEffort(first, 'high');
  await click(first.button('Send'));
  assert.equal(first.api.posted.length, 1);
  const body = first.api.posted[0];
  const recovery = localStorage.getItem(COMPOSE_DRAFT_PREFIX + CIRCLE.id);

  await teardown();
  resetPage('#/borrow');
  installClock(START + 5_000);
  localStorage.setItem('faravan-compose-first-send-notice-seen', 'yes');
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + CIRCLE.id, recovery);
  const second = await signedOpen({accountOffers: ACCOUNT_OFFERS.filter(row => row.providerId !== 'codex')});
  await advance(14_999);
  assert.equal(second.api.posted.length, 0, 'the host deadline survives remount');
  await advance(1);
  assert.equal(Date.now(), deadline);
  assert.deepEqual(second.api.posted, [body]);
});
