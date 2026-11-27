import {act, advance, click, createFakeApi, flush, installClock, mount, navigate, resetPage, teardown, window} from './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {App} from './main.jsx';
import {Home} from './home.jsx';
import {useState} from 'preact/hooks';
import {COMPOSE_DRAFT_PREFIX, HOME_TEXT_KEY} from './compose-draft.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';

// A tester typed "Eat fire" on Home and was asked about a saved request they could not see.
// The question must name the earlier draft, and opening it must not lose the new text.
const START = Date.UTC(2026, 9, 20, 15, 0, 0);
const circle = {id: 'c1', name: 'Weekend projects', origin: 'http://x', owned: true, selected: true};
const EARLIER = 'Tidy the release notes for 0.12\nand link the changelog';
beforeEach(() => {
  resetPage('#/home'); installClock(START);
  localStorage.setItem('faravan-compose-first-send-notice-seen', 'yes');
  localStorage.setItem('faravan-compose-circle', 'c1');
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + 'c1', JSON.stringify({id: 'earlier-draft-1', sourceKind: 'none', prompt: EARLIER, editedAt: START - 2 * 3600000}));
});
afterEach(teardown);

async function boot() {
  const api = createFakeApi({
    readiness: {ready: true, checks: []}, home: {lending: {enabled: false, circle: 'c1'}}, circles: [circle], agents: [],
    devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []}, approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
  });
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  return {api, view};
}
test('mounted App readiness event refreshes held Home only after a saved admitted response', async () => {
  const account = {provider: 'codex', decision: {availability: {
    admitted: false, reason: 'owner_reserve', objective: {strategyId: 'pace'},
    wait: {accountKey: 'codex', reason: 'owner_reserve', strategyId: 'pace',
      source: 'window_reset', nextEvaluationAtMs: START + 60_000},
  }}};
  const held = withLendingProjection({lending: {enabled: true, circle: 'c1'}, lendingPolicy: {accounts: [account]}});
  const admitted = {...held, lendingPolicy: {accounts: [{...account, decision: {availability: {admitted: true}}}]}};
  const api = createFakeApi({
    readiness: {ready: true, checks: []}, home: held, circles: [circle],
    agents: [{id: 'codex', installed: true, signedIn: true, useForLending: true}],
    devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []}, approvals: [], activity: [],
    jobs: [], hosting: {state: 'off'},
  });
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  const visible = () => {
    const line = view.$('.home-lending-line');
    assert.ok(line, 'Home renders its lending status');
    return line.textContent.trim();
  };
  const before = visible();
  assert.match(before, /Lending on|reserv|hold/i);
  assert.doesNotMatch(before, /\bReady\b/i);
  assert.ok(api.stream.count > 0, 'App is consuming its normal event stream');
  await advance(5_000);
  await api.release();
  assert.equal(api.openReads('home').length, 0, 'no background Home read can satisfy this event witness');
  const reads = api.count('home');
  await api.emit('readiness', {ready: true});
  assert.ok(api.count('home') > reads, 'the App event actually requested fresh Home data');
  assert.equal(api.openReads('home').length, 1);
  assert.equal(visible(), before, 'an in-flight read did not change admission');
  await api.answer('home', admitted);
  assert.match(visible(), /\bReady\b/i);
  assert.deepEqual(api.posts, [], 'readiness recovery neither resumes lending nor writes settings');
});

test('Home stops showing Ready after a failed refresh and restores it from a fresh reply', async () => {
  const home = withLendingProjection({
    lending: {enabled: true, circle: 'c1'},
    lendingPolicy: {accounts: [{provider: 'codex', decision: {availability: {admitted: true}}}]},
  });
  const api = createFakeApi({
    readiness: {ready: true, checks: []}, home, circles: [circle],
    agents: [{id: 'codex', installed: true, signedIn: true, useForLending: true}],
    devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []},
    approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
  });
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  const machine = () => view.$('.machine');
  const statusWord = () => machine().querySelector('.st .sr').textContent;
  const expectReady = () => {
    assert.match(machine().textContent, /Ready for requests/);
    assert.equal(statusWord(), 'On');
  };
  const refreshFromEvent = async () => {
    assert.equal(api.openReads('home').length, 0);
    const count = api.count('home');
    await api.emit('readiness', {ready: true});
    assert.equal(api.count('home'), count + 1);
    assert.equal(api.openReads('home').length, 1);
  };

  expectReady();
  assert.ok(api.stream.count > 0);
  await advance(5_000);
  await api.release();
  await refreshFromEvent();
  await api.fail('home', new TypeError('Failed to fetch'));
  assert.match(machine().textContent, /Status needs an update/);
  assert.equal(statusWord(), 'Unknown');
  assert.doesNotMatch(machine().textContent, /Ready/);

  await refreshFromEvent();
  assert.equal(statusWord(), 'Unknown', 'an open refresh does not clear stale status');
  await api.answer('home', home);
  expectReady();
  assert.deepEqual(api.posts, []);
});

const settle = async api => { await act(() => { window.dispatchEvent(new window.Event('hashchange')); }); await advance(50, 10); await api.release(); await flush(); await api.release(); };
async function typeAndSend(view, text) {
  const input = view.$('#home-task');
  await act(() => { input.value = text; input.dispatchEvent(new window.Event('input', {bubbles: true})); });
  await act(() => { view.$('.home-compose-entry form').dispatchEvent(new window.Event('submit', {bubbles: true, cancelable: true})); });
  await flush();
}

test('offline circles without current work stay quiet on Home and Jobs', async () => {
  const inactive = {id:'c2', name:'Offline projects', origin:'http://other', enrollment:{state:'approved'}, rosterMembershipVerified:true};
  const active = {id:'c3', name:'Affected projects', origin:'http://active', enrollment:{state:'approved'}, rosterMembershipVerified:true};
  const job = {job_digest:'healthy-job',state:'queued',status:'Waiting',local:{title:'A reachable job'},circle};
  const queued = {job_digest:'offline-job',state:'queued',status:'Waiting',local:{title:'A job with an offline host'},circle:active};
  const checkedAt = new Date(START - 60_000).toISOString();
  const old = {job_digest:'old-job',state:'cancelled',current_attempt:null,local:{title:'An older job'},circle:inactive,savedAt:checkedAt,savedReason:'unreachable'};
  const api = createFakeApi({
    readiness:{ready:true,checks:[]}, home:{lending:{enabled:false,circle:'c1'}},
    circles:[circle,inactive,active], agents:[], devices:{name:'Laptop',circles:[]}, approvals:[], activity:[],
    jobs:{items:[job,queued,old],uncheckedCircles:[{id:inactive.id,reason:'unreachable'},{id:active.id,reason:'unreachable'}]},
    ['circles/' + inactive.id + '/compose']:{host:{reachable:false},name:inactive.name}, hosting:{state:'off'},
  });
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  assert.match(view.text(), /Couldn’t check jobs in Affected projects/);
  assert.doesNotMatch(view.text(), /Couldn’t check jobs in Offline projects|Offline projects.{0,15}unreachable/);
  assert.equal(api.count('circles/' + inactive.id + '/compose'), 0, 'Home does not poll an unused host for a banner');
  assert.ok(view.$('a[href="#/job/healthy-job/c1"]'));
  assert.ok(view.button('Check jobs again'));
  assert.doesNotMatch(view.text(), /Jobs could not be loaded/);

  await navigate('#/jobs'); await settle(api);
  assert.match(view.text(), /Couldn’t check jobs in Affected projects/);
  assert.doesNotMatch(view.text(), /Couldn’t check jobs in Offline projects|Offline projects.{0,15}unreachable/);
  assert.ok(view.$('a[href="#/job/old-job/c2"]'), 'saved history stays available');

  await navigate('#/circles'); await settle(api);
  const row = view.$('[aria-label="Your circles"] a[href="#/circle/c2"]').textContent;
  assert.equal(row.match(/Host offline/g)?.length, 1, row);
  assert.doesNotMatch(row, /Couldn’t check jobs/);

  await navigate('#/circle/c2'); await settle(api);
  await click(view.$('#circle-tab-settings'));
  assert.ok(view.button('Leave unreachable circle'));
});

test('Home refreshes the owner-reserve guidance at the allowance deadline without resuming', async () => {
  const deadline = START + 30_000;
  const home = withLendingProjection({
    lending: {enabled: true, circle: 'c1'},
    lendingPolicy: {accounts: [{
      provider: 'codex', accountKey: 'codex',
      decision: {availability: {
        admitted: false, reason: 'owner_reserve', objective: {strategyId: 'pace'},
        wait: {reason: 'owner_reserve', accountKey: 'codex', strategyId: 'pace',
          source: 'window_reset', nextEvaluationAtMs: deadline},
        status: {line: 'Saved wait text', recovery: {who: 'automatic'}},
      }},
    }]},
  }, {intent: 'on', intentState: 'ready', admission: 'allowed', execution: 'idle'});
  const api = createFakeApi({
    readiness: {ready: true, checks: []}, home, circles: [circle],
    agents: [{id: 'codex', installed: true, signedIn: true, useForLending: true}],
    devices: {name: 'MacBook', fingerprint: 'fp-1', circles: []},
    approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
  });
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release();
  const card = () => view.$('.home-lending .home-lending-card');
  const reason = () => card().querySelector('p.t-sm').textContent;
  const held = () => {
    assert.equal(card().querySelector('p.t-title3').textContent, 'Lending on');
    assert.doesNotMatch(card().textContent, /Ready for requests/);
    const controls = [...card().querySelectorAll('button, a, [role="button"]')];
    assert.ok(!controls.some(node => /^(?:start|resume)\\b/i.test((node.getAttribute('aria-label') ?? node.textContent).trim())));
  };
  assert.match(reason(), /^Codex: .*resets at/);
  held();
  await advance(30_000);
  assert.equal(Date.now(), deadline);
  assert.equal(reason(), 'Codex: The wait time has passed. A fresh allowance check is needed before another job can start.');
  held();
  assert.deepEqual(api.posts, []);
});

test('mounted Home stays held until a fresh admitted allowance read', async () => {
  const lending = {enabled: true, circle: circle.id};
  const agents = [{id: 'codex', useForLending: true, installed: true, signedIn: true}];
  const account = {provider: 'codex', accountKey: 'fixture-codex'};
  const home = availability => withLendingProjection({lending, lendingPolicy: {
    accounts: [{...account, decision: {availability}}],
  }});
  const expired = home({admitted: false, reason: 'owner_reserve',
    objective: {strategyId: 'fixture-reserve'},
    wait: {reason: 'owner_reserve', accountKey: account.accountKey, strategyId: 'fixture-reserve',
      source: 'window_reset', nextEvaluationAtMs: START},
  });
  const admitted = home({admitted: true});
  const api = createFakeApi({home: expired});
  let refresh;
  function Harness() {
    const [snapshot, setSnapshot] = useState(expired);
    refresh = () => api.get('home').then(setSnapshot);
    return h(Home, {api, lending, agents, circle: circle.id, circles: [circle], members: [], refresh,
      mutate: (route, payload) => api.post(route, payload), setDialog() {},
      data: {home: snapshot, agents, circles: [circle], approvals: [], activity: [], jobs: [],
        devices: {name: 'MacBook', fingerprint: 'fixture', circles: []}, readiness: {ready: true, checks: []}},
    });
  }
  const view = await mount(h(Harness));
  const card = () => view.$('.home-lending .home-lending-card');
  const headline = () => card().querySelector('p.t-title3').textContent;
  const assertHeld = () => {
    assert.match(card().textContent, /A fresh allowance check is needed/);
    assert.doesNotMatch(headline(), /Ready for requests/);
  };
  assertHeld();
  const pending = refresh();
  await advance(30_000);
  assertHeld();
  await api.answer('home', admitted);
  await pending;
  await flush();
  assert.equal(headline(), 'Ready for requests');
  assert.doesNotMatch(card().textContent, /A fresh allowance check is needed/);
  assert.deepEqual(api.posts, []);
});

test('Home shows the earlier draft and Continue editing keeps the new text in the Home box', async () => {
  const {api, view} = await boot();
  await typeAndSend(view, 'Eat fire');
  const asked = view.text();
  assert.match(asked, /You have an unsent request from earlier: “Tidy the release notes for 0\.12” \(edited 2 hours ago\)\./);
  assert.doesNotMatch(asked, /Copy it now|saved request\. Replace/);
  assert.ok(view.button('Use my new text') && view.button('Continue editing'));
  await click(view.button('Continue editing'));
  await settle(api);
  assert.equal(location.hash, '#/new');
  assert.equal(JSON.parse(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1')).prompt, EARLIER, 'the earlier draft is unchanged');
  assert.equal(localStorage.getItem(HOME_TEXT_KEY), 'Eat fire');
  await navigate('#/home'); await settle(api);
  assert.equal(view.$('#home-task').value, 'Eat fire', 'the new text is back in the Home box');
  assert.match(view.text(), /Your new text is still here\. Send it when the earlier request is done\./);
});

test('Use my new text replaces the earlier draft text and opens the composer', async () => {
  const {api, view} = await boot();
  await typeAndSend(view, 'Eat fire');
  await click(view.button('Use my new text'));
  await settle(api);
  assert.equal(location.hash, '#/new');
  const saved = JSON.parse(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1'));
  assert.equal(saved.prompt, 'Eat fire');
  assert.equal(saved.id, 'earlier-draft-1');
  assert.equal(localStorage.getItem(HOME_TEXT_KEY), null);
});

test('typing the earlier draft text again opens it without a question', async () => {
  const same = 'Tidy the release notes for 0.12';
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + 'c1', JSON.stringify({id: 'earlier-draft-1', sourceKind: 'none', prompt: same}));
  const {api, view} = await boot();
  await typeAndSend(view, same + ' ');
  await settle(api);
  assert.equal(location.hash, '#/new');
  assert.equal(JSON.parse(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1')).prompt, same);
});

test('Send a job shows the saved request text and circle before continuing', async () => {
  const {api, view} = await boot();
  await typeAndSend(view, ''); await settle(api);
  const prompt = view.$('[aria-label="Saved request"]');
  assert.ok(prompt, 'the saved-request prompt is visible');
  assert.ok(prompt.textContent.includes(EARLIER));
  assert.match(prompt.textContent, /Weekend projects/);
  assert.ok(view.button('Continue editing') && view.button('Discard'));
  await click(view.button('Continue editing'));
  assert.equal(view.$('[aria-label="Saved request"]'), null);
  assert.equal(view.$('#cmp-prompt').value, EARLIER);
});

test('saved request preview is clipped and can show all of the text', async () => {
  const text = 'First line\n' + 'A long saved request. '.repeat(30) + 'Last line.';
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + 'c1', JSON.stringify({id:'earlier-draft-1',sourceKind:'none',prompt:text}));
  const {api, view} = await boot();
  await navigate('#/new'); await settle(api);
  const preview = view.$('[data-saved-request-text]');
  assert.ok(preview, 'a readable preview is rendered');
  assert.ok(preview.textContent.startsWith('First line'));
  assert.ok(preview.textContent.length < text.length);
  assert.equal(view.button('Show full request').getAttribute('aria-expanded'), 'false');
  await click(view.button('Show full request'));
  assert.equal(view.$('[data-saved-request-text]').textContent, text);
  assert.equal(view.button('Show less').getAttribute('aria-expanded'), 'true');
});

test('discarding a saved request offers visible Undo and restores its text', async () => {
  const {api, view} = await boot();
  await navigate('#/new'); await settle(api);
  assert.ok(view.$('[aria-label="Saved request"]'));
  await click(view.button('Discard'));
  assert.equal(view.$('#cmp-prompt').value, '');
  assert.equal(JSON.parse(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1')).prompt, '');
  assert.match(view.text(), /Saved request discarded/);
  await click(view.button('Undo'));
  assert.equal(view.$('#cmp-prompt').value, EARLIER);
  assert.equal(JSON.parse(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1')).prompt, EARLIER);
});

test('saved-request discard does not remove a newer draft from another tab', async () => {
  const {api, view} = await boot();
  await navigate('#/new'); await settle(api);
  assert.ok(view.$('[aria-label="Saved request"]'));
  const newer = JSON.stringify({id:'newer-draft-123',sourceKind:'none',prompt:'Keep this newer text'});
  localStorage.setItem(COMPOSE_DRAFT_PREFIX + 'c1', newer);
  await click(view.button('Discard'));
  assert.equal(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1'), newer);
  assert.match(view.text(), /changed in another tab/);
});

test('Home conflict shows the saved text and circle with discard and Undo', async () => {
  const {view} = await boot();
  await typeAndSend(view, 'Eat fire');
  const prompt = view.$('[aria-label="Saved request"]');
  assert.ok(prompt, 'the conflict question includes a readable saved request');
  assert.ok(prompt.textContent.includes(EARLIER));
  assert.match(prompt.textContent, /Weekend projects/);
  assert.ok(view.button('Continue editing'));
  await click(view.button('Discard'));
  assert.equal(view.$('#home-task').value, 'Eat fire');
  assert.equal(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1'), null);
  assert.ok(view.button('Undo'));
  await click(view.button('Undo'));
  assert.equal(JSON.parse(localStorage.getItem(COMPOSE_DRAFT_PREFIX + 'c1')).prompt, EARLIER);
  assert.equal(view.$('#home-task').value, 'Eat fire');
});

test('Undo keeps newer blank-text draft settings even when its id is unchanged', async () => {
  const {api, view} = await boot();
  await navigate('#/new'); await settle(api);
  assert.ok(view.$('[aria-label="Saved request"]'));
  await click(view.button('Discard'));
  const key = COMPOSE_DRAFT_PREFIX + 'c1';
  const newer = JSON.stringify({...JSON.parse(localStorage.getItem(key)), model:'new-model', effort:'high'});
  localStorage.setItem(key, newer);
  await click(view.button('Undo'));
  assert.equal(localStorage.getItem(key), newer, 'Undo must compare all saved fields, not only prompt and id');
  assert.equal(view.$('#cmp-prompt').value, '');
  assert.match(view.text(), /changed or could not be restored/);
});

// Item 4 (1102 review): the Home entry button only opens the job form; nothing is sent until the form's own Send.
// The label must say that, so Home does not read as a second send.
test('Home names its entry button for what it does: it continues to the job form and never says Send', async () => {
  localStorage.removeItem(COMPOSE_DRAFT_PREFIX + 'c1');
  const {view} = await boot();
  assert.ok(view.button('New job'), 'the empty entry offers a new job');
  await act(() => { const input=view.$('#home-task'); input.value='Draft task'; input.dispatchEvent(new window.Event('input',{bubbles:true})); });
  assert.ok(view.button('Continue to job'), 'a task can continue to the job form');
  assert.equal(view.button('Send a job'), null, 'Home has no button labelled Send a job');
  await typeAndSend(view, 'Eat fire');
  assert.equal(location.hash, '#/new', 'pressing it opens the job form with the text');
});

// Mount the production Home entry with one shared jobs-read error. Keep retry
// completion separate so clicking cannot make stale data look current early.
async function homeJobsFailure(initialJobs, {firstUse = false, circleError = false} = {}) {
  let update, jobsRetries = 0, circleRetries = 0;
  const circles = firstUse ? [] : [circle];
  const props = {api:{get:async()=>[]}, circles, agents:[], lending:{enabled:false}, circle:circle.id,
    selected:firstUse?null:circle, members:[], mutate:async()=>({}), setDialog(){},
    refresh(){circleRetries++;}, refreshRunJobs(){jobsRetries++;}};
  function Harness() {
    const [snapshot,setSnapshot] = useState({jobs:initialJobs, errors:{jobs:Error('offline'),
      ...(circleError?{circles:Error('circle offline')}:{})}});
    update = setSnapshot;
    return h(Home, {...props, errors:snapshot.errors, data:{home:{lending:props.lending},
      circles, agents:[], approvals:[], activity:[], jobs:snapshot.jobs,
      devices:{name:'Laptop',fingerprint:'self',circles:[]}, readiness:{ready:true,checks:[]}}});
  }
  const view = await mount(h(Harness));
  await flush();
  return {view, counts:()=>({jobsRetries,circleRetries}),
    recover:async jobs=>{await act(()=>update(snapshot=>({jobs,errors:{...snapshot.errors,jobs:null}})));await flush();},
    recoverMembership:async()=>{await act(()=>update(snapshot=>({...snapshot,errors:{...snapshot.errors,circles:null}})));await flush();}};
}
const jobsFailureCount = view => (view.text().match(/Jobs could not be loaded\./g) ?? []).length;
const assertOneJobsFailure = view => {
  assert.equal(jobsFailureCount(view), 1);
  assert.equal(window.document.querySelectorAll('[data-home-jobs-error]').length, 1);
  assert.equal([...window.document.querySelectorAll('button')].filter(button=>button.textContent.trim()==='Try jobs again').length, 1);
  assert.equal(view.button('Try membership and history again'), null);
  assert.doesNotMatch(view.text(), /Job history could not be loaded|Jobs could not be refreshed|No jobs in motion|Finished jobs will appear here|Nothing needs a decision right now/);
};

test('Home Dismiss survives remount, keeps the job, and shows a new result revision', async () => {
  const makeResult = revision => ({job_digest:'dismiss-result', state:'result-accepted', result_digest:revision,
    status:'Finished', format:'files', local:{title:'Ready draft'}, circle});
  const result = makeResult('revision-one');
  const snapshot = structuredClone(result);
  const props = {api:{get:async()=>[]}, circles:[circle], agents:[], lending:{enabled:false}, circle:circle.id,
    selected:circle, members:[], mutate:async()=>assert.fail('Dismiss must not call a job mutation'), refresh(){}, setDialog(){}};
  let update;
  function Harness() {
    const [state,setState] = useState({jobs:[], instance:0});
    update = setState;
    return h(Home, {...props, key:state.instance, data:{home:{lending:props.lending},
      circles:[circle], agents:[], approvals:[], activity:[], jobs:state.jobs, devices:{name:'Laptop',fingerprint:'self',circles:[]}, readiness:{ready:true,checks:[]}}});
  }
  const view = await mount(h(Harness));
  const openResult = () => view.$('.result-card a[href="#/job/dismiss-result/c1"]');
  assert.equal(openResult(), null, 'no result before the fixture supplies it');
  await act(()=>update({jobs:[result], instance:0})); await flush();
  assert.match(openResult()?.textContent.trim() ?? '', /^Open\b/, 'the hydrated result card offers Open');
  const dismiss = view.button('Dismiss');
  assert.ok(dismiss, 'Dismiss is visible before activation');
  await click(dismiss);
  assert.equal(openResult(), null);
  await act(()=>update({jobs:[result], instance:1})); await flush();
  assert.equal(openResult(), null);
  assert.equal(view.button('Dismiss'), null);
  assert.deepEqual(result, snapshot);
  await act(()=>update({jobs:[makeResult('revision-two')], instance:2})); await flush();
  assert.match(openResult()?.textContent.trim() ?? '', /^Open\b/);
  assert.ok(view.button('Dismiss'));
});

test('mounted Home gives one jobs read failure one retry and preserves stale results until recovery', async () => {
  const result = {job_digest:'saved-result',status:'Finished',local:{title:'Saved result',prompt:'Keep this result'},circle};
  const {view, counts, recover} = await homeJobsFailure([result]);
  assertOneJobsFailure(view);
  assert.match(view.text(), /Last known:/);
  assert.ok(view.$('a[href="#/job/saved-result/c1"]'), 'result navigation survives the error');
  assert.ok(view.$('#home-task'), 'the composer remains available');
  assert.equal(view.button('Try circle membership again'), null);
  await click(view.button('Try jobs again'));
  assert.deepEqual(counts(), {jobsRetries:1,circleRetries:0});
  assertOneJobsFailure(view);
  assert.match(view.text(), /Last known:/);
  await recover([result]);
  assert.equal(jobsFailureCount(view), 0);
  assert.equal(view.button('Try jobs again'), null);
  assert.doesNotMatch(view.text(), /Last known:/);
  assert.ok(view.$('a[href="#/job/saved-result/c1"]'));
});

test('mounted first-use jobs error is unknown rather than an empty history', async () => {
  const {view,recover} = await homeJobsFailure(undefined, {firstUse:true});
  assertOneJobsFailure(view);
  assert.doesNotMatch(view.text(), /Get help from people you trust/);
  assert.equal(view.$('#home-needs'), null, 'a failed history read is not a request for a decision');
  await recover([]);
  assert.equal(jobsFailureCount(view), 0);
  assert.match(view.text(), /Join with an invitation/);
});

test('mounted zero-jobs error keeps independent circle recovery separate', async () => {
  const {view,counts,recover,recoverMembership} = await homeJobsFailure([], {circleError:true});
  assertOneJobsFailure(view);
  assert.match(view.text(), /Circle membership could not be loaded/);
  await click(view.button('Try circle membership again'));
  assert.deepEqual(counts(), {jobsRetries:0,circleRetries:1});
  await click(view.button('Try jobs again'));
  assert.deepEqual(counts(), {jobsRetries:1,circleRetries:1});
  await recover([]);
  assert.equal(jobsFailureCount(view), 0);
  assert.match(view.text(), /Circle membership could not be loaded/, 'jobs recovery cannot clear membership failure');
  assert.ok(view.button('Try circle membership again'));
  assert.deepEqual(counts(), {jobsRetries:1,circleRetries:1});
  await recoverMembership();
  assert.doesNotMatch(view.text(), /Circle membership could not be loaded/);
  assert.equal(view.button('Try circle membership again'), null);
  assert.equal(view.button('Try jobs again'), null);
  assert.doesNotMatch(view.text(), /Last known:/);
  assert.ok(view.$('#home-task'));
});

test('mounted membership recovery cannot clear a jobs read failure', async () => {
  const {view,counts,recoverMembership} = await homeJobsFailure(undefined, {circleError:true});
  assertOneJobsFailure(view);
  await click(view.button('Try circle membership again'));
  await recoverMembership();
  assert.deepEqual(counts(), {jobsRetries:0,circleRetries:1});
  assert.doesNotMatch(view.text(), /Circle membership could not be loaded/);
  assert.equal(view.button('Try circle membership again'), null);
  assertOneJobsFailure(view);
  await click(view.button('Try jobs again'));
  assert.deepEqual(counts(), {jobsRetries:1,circleRetries:1});
  assertOneJobsFailure(view);
});

test('mounted App green readiness keeps a current Home owner reserve hold until admitted', async () => {
  const account={provider:'codex',decision:{availability:{
    admitted:false,reason:'owner_reserve',objective:{strategyId:'pace'},
    wait:{accountKey:'codex',reason:'owner_reserve',strategyId:'pace',
      source:'window_reset',nextEvaluationAtMs:START+60_000},
  }}};
  const home=withLendingProjection({lending:{enabled:true,circle:'c1'},lendingPolicy:{accounts:[account]}});
  const sameAccountHeld=structuredClone(home);
  sameAccountHeld.lendingPolicy.accounts[0].decision.availability.wait.nextEvaluationAtMs=START+600_000;
  const sameAccountAdmitted={...home,lendingPolicy:{accounts:[{...account,decision:{availability:{admitted:true}}}]}};
  const api=createFakeApi({home,readiness:{ready:true,checks:[]},circles:[circle],
    agents:[{id:'codex',installed:true,signedIn:true,useForLending:true}],
    devices:{name:'MacBook',fingerprint:'fp-1',circles:[]},approvals:[],activity:[],jobs:[],hosting:{state:'off'}});
  const view=await mount(h(App,{api,takeJoinLink:()=>''}));
  await api.release();
  const line=()=>{
    const node=view.$('.home-lending-line');
    assert.ok(node,'Home renders its lending status');
    return node.textContent.trim();
  };
  const assertNoStartOrResume=()=>{
    for (const control of view.$$('button,a')) {
      assert.doesNotMatch(control.textContent.trim(),/^(Start|Resume)\b/i);
    }
    assert.deepEqual(api.posts,[]);
  };
  const greenEvent=async()=>{
    await advance(5_000);
    await api.release();
    assert.equal(api.openReads('home').length,0,'background reads cannot satisfy this event witness');
    assert.ok(api.stream.count>0,'App consumes its normal event stream');
    const before=api.count('home');
    await api.emit('readiness',{ready:true});
    assert.ok(api.count('home')>before,'the event requested a fresh Home response');
    assert.equal(api.openReads('home').length,1);
  };

  const allowanceReason=()=>view.$('.home-lending .home-lending-card p.t-sm').textContent;
  const originalReason=allowanceReason();
  await greenEvent();
  assert.doesNotMatch(line(),/\bReady\b/i);
  await api.answer('home',sameAccountHeld);
  api.table.home=sameAccountHeld;
  assert.match(allowanceReason(),/remaining allowance is being kept/i,'the new Home response still holds this account');
  assert.notEqual(allowanceReason(),originalReason,'Home renders the changed retry time from the fresh response');
  assert.doesNotMatch(line(),/\bReady\b/i);
  assertNoStartOrResume();

  await greenEvent();
  assert.doesNotMatch(line(),/\bReady\b/i,'a second green event cannot itself admit the account');
  await api.answer('home',sameAccountAdmitted);
  assert.match(line(),/\bReady\b/i);
  assert.doesNotMatch(view.text(),/remaining allowance is being kept/i);
  assertNoStartOrResume();
});

// Contributions can arrive before the devices read that names this person. Without that identity, the owner's own other
// computers look like friends, so the help summary waits for it and never counts them.
const OWN_ROWS = {devices: 1, jobs: 2, rows: [{circle: 'c1', keyId: 'other-own', personName: 'Tessa', run: 2, delivered: 2}]};
const ana = {circle: 'c1', keyId: 'friend', personName: 'Ana', run: 1, delivered: 1};
async function bootContributions(rows) {
  const jobsWindow = {devices: new Set(rows.map(r => r.keyId)).size, jobs: rows.reduce((n, r) => n + r.delivered, 0), rows};
  const api = createFakeApi({
    readiness: {ready: true, checks: []}, home: {lending: {enabled: false, circle: 'c1'}}, circles: [circle], agents: [],
    devices: {name: 'MacBook', ownerName: 'Tessa', fingerprint: 'fp-1', circles: []}, approvals: [], activity: [], jobs: [], hosting: {state: 'off'},
    contributions: {windows: {7: jobsWindow}},
  });
  const view = await mount(h(App, {api, takeJoinLink: () => ''}));
  await api.release(path => !/devices/.test(path));
  return {api, view};
}
const helped = view => view.$('.home-contributions')?.textContent ?? '';
test('Home withholds the help summary for the owner’s other computer until owner identity arrives', async () => {
  const {api, view} = await bootContributions(OWN_ROWS.rows);
  assert.doesNotMatch(helped(view), /You helped/, 'no identity yet: the owner’s own jobs are not help');
  await api.release(); await flush();
  assert.doesNotMatch(helped(view), /You helped/, 'identity arrived: both self jobs are excluded');
});
test('Home keeps the help summary hidden while the devices read fails', async () => {
  const {api, view} = await bootContributions(OWN_ROWS.rows);
  await api.fail(/devices/, new TypeError('Failed to fetch'));
  assert.doesNotMatch(helped(view), /You helped/);
});
test('Home shows a friend’s contribution once owner identity arrives, and still excludes the owner’s own jobs', async () => {
  const {api, view} = await bootContributions([...OWN_ROWS.rows, ana]);
  assert.doesNotMatch(helped(view), /You helped/);
  await api.release(); await flush();
  assert.match(helped(view), /You helped Ana with 1 job/);
});
