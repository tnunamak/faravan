import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import {click, createFakeApi, flush, forceClick, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {act} from 'preact/test-utils';
import {LimitsPage} from './limits.jsx';
import {Connection} from './shared.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
import {mockFixture, NOW} from './lending-policy.fixture.mjs';
import {lendingStatus, OWNER_LIMIT_LABEL, ownerLimitEffect} from '../../../lib/v1/lending-status-copy.mjs';

// The saved per-job limit has a control on the limits page. Saving asks first; a replacement of an unreadable file is sent only
// while the hold is active, and the hold's line links to the control. The status is the one the lender sends. Synthetic data only.
const lending = {mode:'ask', circle:'weekend', configVersion:3,
  limits:{timeZone:'UTC', dailyJobs:3, dailyMinutes:60, maxWallSeconds:1200, quotaReserve:30, idleOnly:true}};

function heldSnapshot() {
  const snapshot = mockFixture();
  const [claude, ...others] = snapshot.accounts;
  const status = lendingStatus({admitted: false, reason: 'owner_settings_unreadable'});
  const availability = {admitted:false, reason:'owner_settings_unreadable',
    objective:{admission:'held', reasonCode:'owner_settings_unreadable', reasonText:status.line}, status};
  return {...snapshot, accounts: [{...claude, decision: {...claude.decision,
    status:lendingStatus({admitted:true}), availability}}, ...others]};
}

function freshHoldWithoutPriorDecision() {
  const snapshot = mockFixture();
  const [claude, ...others] = snapshot.accounts;
  const status = lendingStatus({admitted:false, reason:'owner_settings_unreadable'});
  return {...snapshot, accounts:[{...claude, decision:{availability:{
    admitted:false, reason:'owner_settings_unreadable',
    objective:{admission:'held', reasonCode:'owner_settings_unreadable', reasonText:status.line}, status,
  }}}, ...others]};
}

const MINIMUMS = [
  {model:'claude-haiku-4-5',minimumMaxJobUsd:1.05},
  {model:'claude-haiku-5-5',minimumMaxJobUsd:1.33},
  {model:'claude-sonnet-4-5',minimumMaxJobUsd:3.13},
  {model:'claude-opus-4-5',minimumMaxJobUsd:5.21},
  {model:'claude-sonnet-5-5',minimumMaxJobUsd:5.29},
  {model:'claude-sonnet-4-6',minimumMaxJobUsd:7.93},
  {model:'claude-opus-5-5',minimumMaxJobUsd:10.57},
  {model:'claude-fable-5',minimumMaxJobUsd:26.41},
  {model:'claude-mythos-5',minimumMaxJobUsd:26.41},
];
const props = (snapshot, extra = {}) => ({lending, circle: 'weekend', now: NOW, mutate: async () => ({}), api: createFakeApi({
  'lending/owner-settings': {values:null,audit:[],defaultMaxJobUsd:4,minimums:MINIMUMS},
}), agents:[{id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true,
  models:['claude-haiku-5-5','claude-sonnet-4-5','claude-opus-5-5'],run:{model:'claude-haiku-5-5'},
  lendable_models:['claude-haiku-5-5','claude-sonnet-4-5']}],
  data: {home: {lending, lendingPolicy: snapshot}}, ...extra});

beforeEach(() => { resetPage('#/'); installClock(NOW); });
afterEach(teardown);

test('the saved limit has its own control, and the hold line links to it', () => {
  const out = renderFixture(LimitsPage, props(heldSnapshot()));
  assert.match(withoutMaskMarkers(out), /<section id="owner-limit"/);
  assert.ok(renderedText(out).includes(OWNER_LIMIT_LABEL), 'the control is labelled with the owner-facing name');
  assert.match(out, /<a href="#owner-limit">Set the limit<\/a>/, 'the hold line links to the control');
  assert.match(renderedText(out), /Saving replaces it after you confirm/, 'the hold says what saving does');
});

test('a fresh unreadable-settings hold applies without any prior decision', () => {
  const out = renderFixture(LimitsPage, props(freshHoldWithoutPriorDecision()));
  assert.match(renderedText(out), /Your saved limit cannot be read/);
  assert.match(renderedText(out), /Saving replaces it after you confirm/);
});

test('without the hold, the control is still there, and the explanation has no link to it', () => {
  const out = renderFixture(LimitsPage, props(mockFixture()));
  assert.match(withoutMaskMarkers(out), /<section id="owner-limit"/);
  assert.match(renderedText(out), /You approve each job before it starts\./);
  assert.doesNotMatch(out, /Set the limit<\/a>/);
  assert.doesNotMatch(renderedText(out), /Saving replaces it after you confirm/);
});

test('a fresh control keeps the $4 default and names models above the cap', {timeout: 30000}, async () => {
  const api = createFakeApi({'lending/owner-settings': {values:null,audit:[],defaultMaxJobUsd:4,minimums:MINIMUMS}});
  const view = await mount(h(LimitsPage, props(mockFixture(), {api})));
  await api.release('lending/owner-settings');
  const input = view.$(`input[aria-label="${OWNER_LIMIT_LABEL}"]`);
  assert.equal(input.value, '4');
  assert.equal(input.min, '1.05');
  assert.equal(input.disabled, false);
  assert.equal(view.$('.owner-limit-save').disabled, false);
  assert.equal(view.$('.owner-limit-models > p').textContent, 'If you save $4, these models fit the per-job limit: Haiku 5.5 and Sonnet 4.5.');
  assert.equal(view.$('.owner-limit-models details summary').textContent, 'Models that need a higher limit');
  assert.equal(view.$('.owner-limit-models details').open, false, 'higher-limit models start collapsed');
  assert.deepEqual([...view.$$('.owner-limit-models li')].map(row => row.textContent), ['Opus 5.5 needs at least $10.57 per job.']);
  assert.doesNotMatch(view.$('.owner-limit-models').textContent, /Fable|Mythos|Sonnet 5\.5/,
    'models outside this account are not shown');
  assert.doesNotMatch(view.$('[role="alert"]')?.textContent ?? '', /minimum/i);
});

test('a saved amount below the engine minimum is raised to the cheapest model minimum', {timeout: 30000}, async () => {
  const api = createFakeApi({'lending/owner-settings': {values:{maxJobUsd:0.9},defaultMaxJobUsd:4,minimums:MINIMUMS}});
  const view = await mount(h(LimitsPage, props(mockFixture(), {api})));
  await api.release('lending/owner-settings');
  const input = view.$(`input[aria-label="${OWNER_LIMIT_LABEL}"]`);
  assert.equal(input.min, '1.05');
  assert.equal(input.value, '1.05');
  assert.match(view.$('[role="alert"]').textContent, /saved limit was below the lowest allowed amount of \$1\.05/i);
  assert.equal(view.$('.owner-limit-models > p').textContent, 'If you save $1.05, these models fit the per-job limit: no Claude models.');
  assert.deepEqual([...view.$$('.owner-limit-models li')].map(row => row.textContent), [
    'Haiku 5.5 needs at least $1.33 per job.',
    'Sonnet 4.5 needs at least $3.13 per job.',
    'Opus 5.5 needs at least $10.57 per job.',
  ]);
  assert.equal(view.$('.owner-limit-save').disabled, false);
});

test('a lower cap can be saved and replaces an unreadable file after confirmation', {timeout: 30000}, async () => {
  const calls = [];
  const mutate = async (path, body) => { calls.push([path, body]); return {}; };
  const api = createFakeApi({'lending/owner-settings': {values:null,audit:[],defaultMaxJobUsd:4,minimums:MINIMUMS}});
  const view = await mount(h(LimitsPage, props(heldSnapshot(), {mutate,api})));
  await api.release('lending/owner-settings');
  const input = view.$(`input[aria-label="${OWNER_LIMIT_LABEL}"]`);
  assert.equal(input.min,'1.05');
  input.value = '1.33';
  await act(() => { input.dispatchEvent(new window.Event('input', {bubbles: true})); });
  assert.equal(view.$('.owner-limit-save').disabled,false,'the owner may choose the engine minimum');
  await click(view.$('.owner-limit-save'));
  assert.deepEqual(calls, [], 'nothing is saved before the confirmation');
  assert.equal(view.$('.owner-limit-effect').textContent, ownerLimitEffect({maxJobUsd: 1.33, replaceUnreadable: true}));
  await click(view.$('.owner-limit-confirm'));
  assert.deepEqual(calls, [['lending/owner-settings', {maxJobUsd: 1.33, reason: 'Set on the Lend page.', replaceUnreadable: true}]]);
});

test('without the hold, a confirmed save sends no replacement', {timeout: 30000}, async () => {
  const calls = [];
  const mutate = async (path, body) => { calls.push([path, body]); return {}; };
  const api = createFakeApi({'lending/owner-settings': {values:null,audit:[],defaultMaxJobUsd:4,minimums:MINIMUMS}});
  const view = await mount(h(LimitsPage, props(mockFixture(), {mutate,api})));
  await api.release('lending/owner-settings');
  const input = view.$(`input[aria-label="${OWNER_LIMIT_LABEL}"]`);
  input.value = '2';
  await act(() => { input.dispatchEvent(new window.Event('input', {bubbles: true})); });
  await click(view.$('.owner-limit-save'));
  assert.equal(view.$('.owner-limit-effect').textContent, 'Save $2 as the most one lent job may spend.');
  await click(view.$('.owner-limit-confirm'));
  assert.deepEqual(calls, [['lending/owner-settings', {maxJobUsd: 2, reason: 'Set on the Lend page.'}]]);
});

test('the limit cannot be saved when model minimums cannot be read', {timeout: 30000}, async () => {
  const api = createFakeApi({'lending/owner-settings': {values:null,audit:[],defaultMaxJobUsd:4,minimums:[]}});
  const view = await mount(h(LimitsPage, props(mockFixture(), {api})));
  await api.release('lending/owner-settings');
  assert.equal(view.$(`input[aria-label="${OWNER_LIMIT_LABEL}"]`).disabled,true);
  assert.equal(view.$('.owner-limit-save').disabled,true);
  assert.match(view.$('[role="alert"]').textContent,/The lowest allowed limit could not be read/);
});

test('the per-job limit cannot be submitted while offline, including an open confirmation', {timeout: 30000}, async () => {
  const calls = [];
  const mutate = async (...args) => { calls.push(args); return {}; };
  const api = createFakeApi({'lending/owner-settings': {values:null,defaultMaxJobUsd:4,minimums:MINIMUMS}});
  const page = value => h(Connection.Provider, {value}, h(LimitsPage, props(mockFixture(), {mutate, api})));
  const view = await mount(page({offline:false}));
  await api.release('lending/owner-settings');
  await click(view.$('.owner-limit-save'));
  assert.equal(view.$('.owner-limit-confirm').disabled, false);
  await view.rerender(page({offline:true}));
  assert.equal(view.$('.owner-limit-save').disabled, true);
  assert.equal(view.$('.owner-limit-confirm').disabled, true);
  await forceClick(view.$('.owner-limit-confirm'));
  assert.deepEqual(calls, [], 'going offline before confirmation prevents the write');
});

async function editOwner(view, value) {
  const input = view.$('#owner-limit-value');
  input.value = value;
  await act(() => input.dispatchEvent(new window.Event('input', {bubbles:true})));
  return input;
}
const ownerRead = (amount = 4, minimums = MINIMUMS) => ({values:{maxJobUsd:amount}, minimums});

test('F1 saved amount stays authoritative across edit, cancel and refused save', async () => {
  const api = {get:async () => ownerRead()};
  const mutate = async () => { throw {code:'invalid_request'}; };
  const view = await mount(h(LimitsPage, props(mockFixture(), {api,mutate})));
  await editOwner(view, '20');
  assert.equal(view.$('.owner-limit-saved').textContent, 'Saved per-job limit: $4.');
  assert.match(view.$('.owner-limit-models > p').textContent, /^If you save \$20,/);
  await click(view.$('.owner-limit-save'));
  await click(view.$('.owner-limit-confirm').nextElementSibling);
  assert.equal(view.$('.owner-limit-saved').textContent, 'Saved per-job limit: $4.');
  await click(view.$('.owner-limit-save'));
  await click(view.$('.owner-limit-confirm'));
  assert.equal(view.$('.owner-limit-saved').textContent, 'Saved per-job limit: $4.');
  assert.match(view.$('.owner-limit-models > p').textContent, /^If you save \$20,/);
});

test('F2 stale confirmation cannot write during loading, empty or higher minimum snapshots', async () => {
  const calls = [];
  let release;
  const api = {get:async () => ownerRead()};
  const p = props(mockFixture(), {api,mutate:async (...args) => calls.push(args)});
  const view = await mount(h(LimitsPage,p));
  await click(view.$('.owner-limit-save'));
  const delayed = {get:() => new Promise(resolve => { release = resolve; })};
  await view.rerender(h(LimitsPage,{...p,api:delayed,agents:[...p.agents]}));
  assert.equal(view.$('.owner-limit-confirm').disabled,true);
  await forceClick(view.$('.owner-limit-confirm'));
  assert.deepEqual(calls,[]);
  await act(async () => { release(ownerRead(4,[])); });
  await forceClick(view.$('.owner-limit-confirm'));
  assert.deepEqual(calls,[]);
  const higher = {get:async () => ownerRead(4,MINIMUMS.map(row => ({...row,minimumMaxJobUsd:30})))};
  await view.rerender(h(LimitsPage,{...p,api:higher,agents:[...p.agents]}));
  assert.match(view.$('.owner-limit-confirm').parentElement.textContent,/Model limits changed. Review the amount before saving./);
  await forceClick(view.$('.owner-limit-confirm'));
  assert.deepEqual(calls,[]);
  await click(view.$('.owner-limit-confirm').nextElementSibling);
  await click(view.$('.owner-limit-save'));
  await click(view.$('.owner-limit-confirm'));
  assert.equal(calls.length,1,'a fresh review of the newly valid amount permits one write');
  assert.equal(calls[0][1].maxJobUsd,30);
});

test('F3 newer authoritative reads synchronize clean drafts and preserve dirty drafts', async () => {
  const p = props(mockFixture(),{api:{get:async () => ownerRead()}});
  const view = await mount(h(LimitsPage,p));
  await view.rerender(h(LimitsPage,{...p,api:{get:async () => ownerRead(10)}}));
  assert.equal(view.$('#owner-limit-value').value,'10');
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved per-job limit: $10.');
  await editOwner(view,'20');
  await view.rerender(h(LimitsPage,{...p,api:{get:async () => ownerRead(4)}}));
  assert.equal(view.$('#owner-limit-value').value,'20');
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved per-job limit: $4.');
  assert.equal(view.$('.owner-limit-conflict').textContent,'The saved limit changed to $4. Your unsaved amount is still shown below.');
});

test('F4 cents precision agrees across field, confirmation and request without rounding', async () => {
  const calls = [];
  const view = await mount(h(LimitsPage,props(mockFixture(),{
    api:{get:async () => ownerRead()}, mutate:async (...args) => { calls.push(args); throw {code:'invalid_request'}; },
  })));
  for (const value of ['1.335','2e1','1000000.01']) {
    await editOwner(view,value);
    assert.equal(view.$('.owner-limit-save').disabled,true,value);
    await forceClick(view.$('.owner-limit-save'));
    // The Sheet keeps its confirmation button in a closed dialog, so check that it cannot submit.
    assert.equal(view.$('.owner-limit-confirm').disabled,true,value);
    await forceClick(view.$('.owner-limit-confirm'));
    assert.equal(calls.length,0,value);
  }
  for (const value of ['1.33','1000000']) {
    await editOwner(view,value);
    await click(view.$('.owner-limit-save'));
    assert.equal(view.$('.owner-limit-effect').textContent,ownerLimitEffect({maxJobUsd:Number(value),replaceUnreadable:false}));
    await click(view.$('.owner-limit-confirm'));
    assert.equal(calls.at(-1)[1].maxJobUsd,Number(value));
  }
});

test('F5 rejected amount errors are associated and clear on keyboard-edit recovery', async () => {
  const view = await mount(h(LimitsPage,props(mockFixture(),{api:{get:async () => ownerRead()}})));
  for (const value of ['', '-1', '1', '1000001','1.335']) {
    const input = await editOwner(view,value);
    input.focus();
    assert.equal(input.getAttribute('aria-invalid'),'true');
    assert.ok(input.getAttribute('aria-describedby').split(' ').includes('owner-limit-error'));
    assert.ok(view.$('#owner-limit-error').textContent.length);
    assert.equal(input.max,'1000000');
    assert.equal(document.activeElement,input);
  }
  const input = await editOwner(view,'2');
  assert.equal(input.getAttribute('aria-invalid'),'false');
  assert.equal(view.$('#owner-limit-error'),null);
  assert.equal(document.activeElement,input);
  assert.equal(view.$('.owner-limit-save').disabled,false);
});

test('F6 response loss requires authoritative readback while definite refusal remains retryable', async () => {
  let actual = 4, refusal = false, failRead = false;
  const calls = [];
  const api = {get:async () => { if (failRead) throw new Error('network'); return ownerRead(actual); }};
  const mutate = async (path, body) => {
    calls.push(body);
    if (refusal) throw {code:'invalid_request',status:400};
    actual = body.maxJobUsd;
    throw new Error('response lost');
  };
  const view = await mount(h(LimitsPage,props(mockFixture(),{api,mutate})));
  await editOwner(view,'20');
  await click(view.$('.owner-limit-save'));
  await click(view.$('.owner-limit-confirm'));
  assert.equal(view.$('.owner-limit-saved').textContent,'Last checked limit: $4; current limit unknown.');
  assert.match(view.$('#owner-limit').textContent,/We could not confirm whether your changes were saved. Check the saved settings before you change anything else./);
  assert.equal(view.$('#owner-limit-value').value,'20');
  assert.equal(view.$('.owner-limit-save').disabled,true);
  failRead = true;
  await click(view.$('.owner-limit-check'));
  assert.equal(view.$('.owner-limit-saved').textContent,'Last checked limit: $4; current limit unknown.');
  assert.equal(view.$('.owner-limit-save').disabled,true);
  failRead = false;
  await click(view.$('.owner-limit-check'));
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved per-job limit: $20.');
  assert.equal(view.$('.owner-limit-save').disabled,false);
  refusal = true;
  await editOwner(view,'2');
  await click(view.$('.owner-limit-save'));
  await click(view.$('.owner-limit-confirm'));
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved per-job limit: $20.');
  assert.equal(view.$('.owner-limit-check'),null);
  assert.equal(view.$('.owner-limit-save').disabled,false);
  assert.equal(calls.length,2);
});

test('review F1 unreadable and default snapshots never invent a persisted amount', async () => {
  const api = {get:async () => ({values:null,defaultMaxJobUsd:4,minimums:MINIMUMS})};
  const view = await mount(h(LimitsPage,props(heldSnapshot(),{api})));
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved limit unreadable; current limit unknown.');
  assert.equal(view.$('#owner-limit-value').value,'4','default remains available as a proposal');
  await view.unmount();
  const fresh = await mount(h(LimitsPage,props(mockFixture(),{api})));
  assert.equal(fresh.$('.owner-limit-saved').textContent,'Last checked default per-job limit: $4. A saved limit could not be confirmed.');
  assert.equal(fresh.$('.owner-limit-save').disabled,false,'legitimate default can still be confirmed');
});

test('review F2 replacement context qualifies last checked amount until its read settles', async () => {
  const p = props(mockFixture(),{api:{get:async () => ownerRead()}});
  const view = await mount(h(LimitsPage,p));
  let release;
  await view.rerender(h(LimitsPage,{...p,api:{get:() => new Promise(resolve => { release=resolve; })}}));
  assert.equal(view.$('.owner-limit-saved').textContent,'Last checked limit: $4; current limit unknown.');
  await act(async () => { release(ownerRead(8)); });
  await flush();
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved per-job limit: $8.');
});

test('review F3 old successful mutation cannot read through or replace a newer context', async () => {
  let resolveMutation, aReads=0, bReads=0;
  const apiA={get:async () => { aReads++; return ownerRead(4); }};
  const apiB={get:async () => { bReads++; return ownerRead(10); }};
  const p=props(mockFixture(),{api:apiA,mutate:() => new Promise(resolve => { resolveMutation=resolve; })});
  const view=await mount(h(LimitsPage,p));
  await editOwner(view,'20'); await click(view.$('.owner-limit-save')); await click(view.$('.owner-limit-confirm'));
  await view.rerender(h(LimitsPage,{...p,api:apiB,agents:[...p.agents]}));
  await act(async () => { resolveMutation({}); });
  assert.equal(aReads,1,'old save cannot issue an old-context readback');
  assert.equal(view.$('.owner-limit-saved').textContent,'Last checked limit: $10; current limit unknown.');
  assert.equal(view.$('#owner-limit-value').value,'20','unsaved intent survives');
  await click(view.$('.owner-limit-check'));
  assert.equal(bReads,2,'reconciliation reads current context');
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved per-job limit: $10.');
});

test('review F4 failed first read offers bounded in-place recovery', async () => {
  let fail=true, reads=0;
  const api={get:async () => { reads++; if(fail) throw new Error('offline'); return ownerRead(6); }};
  const view=await mount(h(LimitsPage,props(mockFixture(),{api})));
  assert.equal(view.$('.owner-limit-save').disabled,true);
  assert.ok(view.$('.owner-limit-check'),'initial failure exposes Check saved limit');
  fail=false; await click(view.$('.owner-limit-check'));
  assert.equal(reads,2); assert.equal(view.$('.owner-limit-save').disabled,false);
  assert.equal(view.$('.owner-limit-saved').textContent,'Saved per-job limit: $6.');
});

test('review F5 owner-only edits and unresolved saves participate in leave guard', async () => {
  const p=props(mockFixture(),{api:{get:async () => ownerRead()},mutate:async () => { throw new Error('response lost'); }});
  const view=await mount(h(LimitsPage,p));
  const blockedUnload=() => { const e=new window.Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; };
  assert.equal(blockedUnload(),false);
  await editOwner(view,'20');
  assert.equal(blockedUnload(),true,'owner-only edit installs guard');
  await editOwner(view,'4');
  assert.equal(blockedUnload(),false,'reverting edit clears guard');
  await click(view.$('.owner-limit-save')); await click(view.$('.owner-limit-confirm'));
  assert.equal(blockedUnload(),true,'unknown save guards even when draft equals old saved value');
  const confirm=window.confirm; let prompts=0;
  window.confirm=() => { prompts++; return false; };
  try {
    const event=new window.MouseEvent('click',{bubbles:true,cancelable:true});
    await act(() => view.$('.back-link').dispatchEvent(event));
    assert.equal(event.defaultPrevented,true); assert.equal(prompts,1);
  } finally { window.confirm=confirm; }
});

test('review successful save still requires successful readback before claiming saved', async () => {
  let reads=0;
  const api={get:async () => { if (++reads > 1) throw {status:401,code:'unauthorized'}; return ownerRead(); }};
  const view=await mount(h(LimitsPage,props(mockFixture(),{api,mutate:async () => ({})})));
  await editOwner(view,'20'); await click(view.$('.owner-limit-save')); await click(view.$('.owner-limit-confirm'));
  assert.equal(reads,2);
  assert.equal(view.$('.owner-limit-saved').textContent,'Last checked limit: $4; current limit unknown.');
  assert.equal(view.$('.owner-limit-save').disabled,true);
  assert.ok(view.$('.owner-limit-check'));
});

test('the saved $2 summary is shown even when the account runs Sonnet by default', async () => {
  const summary = 'At $2.00 Claude Haiku 4.5, Claude Haiku 5.5 jobs fit. Claude Sonnet 5.5 jobs need at least $5.29.';
  const api = createFakeApi({'lending/owner-settings':{values:{maxJobUsd:2},audit:[],defaultMaxJobUsd:9.28,minimums:MINIMUMS,modelLimitSummary:summary}});
  const agents = [{id:'claude-code-subscription',installed:true,signedIn:true,useForLending:true,models:['claude-sonnet-5-5'],run:{model:'claude-sonnet-5-5'}}];
  const view = await mount(h(LimitsPage, props(mockFixture(),{api,agents})));
  await api.release('lending/owner-settings');
  assert.equal(view.$('.owner-limit-summary').textContent,summary);
  assert.equal(view.$('.owner-limit-save').disabled,false);
  assert.equal(view.$(`input[aria-label="${OWNER_LIMIT_LABEL}"]`).value,'2');
});
