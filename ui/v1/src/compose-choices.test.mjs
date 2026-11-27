import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {Compose, ComposeBody} from './compose.jsx';
import {composeVM} from './view-models.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

// A borrower starts with the request and must be able to see, change and understand every choice before Send:
// project, agent, circle, model and effort. A control that cannot be used says why, next to the control.
const START = Date.UTC(2026, 10, 1, 15, 0, 0);
const member = (id, name) => ({id, name, origin: 'http://127.0.0.1:9', membershipProjection: {
  schemaVersion: 2, kind: 'membership', phase: 'approved', evidence: {enrollmentState: 'approved', origin: true}, invitationPolicy: 'unknown'}});
const DEMO = member('demo', 'Faravan demo'), WEEKEND = member('weekend', 'Weekend projects');
const SELF = {keyId: 'self', self: true, label: 'My laptop', state: 'ready', agents: [{adapter: 'codex', readiness: 'ready'}, {adapter: 'claude', readiness: 'ready'}]};
const offers = [{harness: 'codex', model: 'm1', effort: 'low'}, {harness: 'codex', model: 'm1', effort: 'high'}, {harness: 'claude-code', model: 'opus', effort: 'medium'}];
const states = {
  demo: {circle: 'demo', name: 'Faravan demo', hosted: true, networked: true, presence: 'unavailable', host: {label: 'Faravan demo host', reachable: false, lastReachedAt: '2026-10-30T10:00:00Z'}, lenders: null, offers: []},
  weekend: {circle: 'weekend', name: 'Weekend projects', hosted: false, networked: true, presence: 'ok', host: {label: 'Ana’s computer', reachable: true}, lenders: [SELF], offers, runRequestSupported: false},
};
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };
const apiFor = () => {
  const api = createFakeApi();
  api.get = async path => path === 'folders?path=' ? {home: '/home/t'} : path === 'folders/suggest' ? {recent: [], repos: [], truncated: false}
    : path.endsWith('/compose') ? states[decodeURIComponent(path.split('/')[1])] : {};
  return api;
};
beforeEach(() => { resetPage('#/jobs/new'); installClock(START); });
afterEach(teardown);

test('a circle whose host is not answering is marked in the Circle list, and the page opens on a circle that answers', async () => {
  localStorage.setItem('faravan-compose-circle', 'demo');
  const demoOffline = {...DEMO, host: {reachable: false, lastReachedAt: '2026-10-30T10:00:00Z'}};
  const page = await mount(h(Compose, {circles: [demoOffline, WEEKEND], circle: 'demo', api: apiFor(), refresh() {}, setCircle() {}}));
  await settle();
  const select = page.$('select[aria-label="Circle"]');
  assert.equal(select.value, 'weekend', 'the page does not open on the circle that is not answering');
  const labels = [...select.options].map(option => option.textContent);
  assert.equal(labels[0], 'Faravan demo · offline', 'the circle that is not answering says so in the list');
  assert.equal(labels[1], 'Weekend projects', 'a circle with no known problem keeps its plain name');
  assert.match(document.body.textContent, /Faravan demo isn’t answering/, 'the page says why it moved');
  await page.unmount();
});

test('typing a request shows that the draft is saved on this computer', async () => {
  const page = await mount(h(Compose, {circles: [WEEKEND], circle: 'weekend', api: apiFor(), refresh() {}, setCircle() {}}));
  await settle();
  assert.equal(page.$('#cmp-saved'), null, 'an empty form claims nothing is saved');
  const prompt = page.$('#cmp-prompt');
  prompt.value = 'Fix the checkout bug';
  prompt.dispatchEvent(new window.Event('input', {bubbles: true}));
  await settle();
  assert.match(page.$('#cmp-saved')?.textContent ?? '', /draft is saved on this computer/i);
  await page.unmount();
});

const info = {path: '/home/sam/code/site', name: 'site', branch: 'main', head: 'a'.repeat(40), files: 3, changed: [], changed_count: 0};
const circle = {id: 'weekend', name: 'Weekend projects', state: {networked: true, host: {label: 'Ana’s computer', reachable: true}, lenders: [], offers}};
const draft = (over = {}) => ({id: 'draft-0001-aaaa', prompt: 'Fix it', path: info.path, includeUncommitted: false, agent: '', model: '', effort: '', sending: false, ...over});
const vmFor = (choice = {}) => composeVM({prompt: 'Fix it', repo: {status: 'ok', info}, circle, choice, draftSaved: true, now: START, zone: 'UTC'});
const body = (d, extra = {}) => renderFixture(ComposeBody, {vm: vmFor(), project: info, draft: d, circles: [WEEKEND, DEMO], circle: 'weekend', agents: [{id: 'codex'}, {id: 'claude-code'}], offers,
  onPrompt() {}, onPath() {}, onInclude() {}, onAgent() {}, onModel() {}, onEffort() {}, onCircle() {}, onCheck() {}, onSend() {}, onCancel() {}, ...extra});
const field = (html, label) => html.match(new RegExp(`<(label|div) class="cmp-route-field"><span>${label}</span>[\\s\\S]*?</\\1>`))?.[0] ?? '';

test('every disabled choice says why next to the control', () => {
  const sending = body(draft({sending: true, agent: 'codex'}));
  for (const name of ['Circle', 'Agent', 'Model', 'Effort']) {
    assert.match(withoutMaskMarkers(field(sending, name)), /class="hint"[^>]*>Wait until the current request is confirmed\./, `${name} while sending`);
  }
  const followup = body(draft({followup: true, base: {path: info.path}}));
  assert.match(withoutMaskMarkers(field(followup, 'Circle')), /class="hint"[^>]*>A follow-up stays in the same circle\./, 'Circle on a follow-up');
});

test('the Model and effort summary says an agent must be chosen first, so the reason is visible while it is closed', () => {
  const closed = body(draft({agent: ''}));
  assert.match(renderedText(closed.match(/<summary class="cmp-setting-row"><span class="cmp-setting-label">Model and effort<\/span>[\s\S]*?<\/summary>/)[0]), /choose an agent to change/i);
  const chosen = body(draft({agent: 'codex'}));
  assert.doesNotMatch(chosen.match(/<summary class="cmp-setting-row"><span class="cmp-setting-label">Model and effort<\/span>[\s\S]*?<\/summary>/)[0], /choose an agent/i);
});

test('with no circle to send to, the form still shows a Circle row that says what to do', () => {
  const out = renderFixture(ComposeBody, {vm: composeVM({prompt: 'Fix it', repo: {status: 'ok', info}, circle: {}, draftSaved: true, now: START}), project: info, draft: draft(), circles: [], circle: '', agents: [], offers: [],
    onPrompt() {}, onPath() {}, onInclude() {}, onAgent() {}, onModel() {}, onEffort() {}, onCircle() {}, onCheck() {}, onSend() {}, onCancel() {}});
  assert.match(field(out, 'Circle'), /No circle yet/);
  assert.match(field(out, 'Circle'), /href="#\/circles"/);
});

test('a follow-up stays in its circle, so an offline Send does not offer another circle', async () => {
  localStorage.setItem('faravan-compose-circle', 'weekend');
  localStorage.setItem('faravan-compose-draft:weekend', JSON.stringify({id: 'draft-0001-aaaa', prompt: 'Fix it', sourceKind: 'none',
    followup: {parentJob: 'job-1', parentResult: 'result-1'}, base: {path: info.path, title: 'Fix parsing', branch: 'main', commit: 'a'.repeat(40)}}));
  const offline = {...states.weekend, host: {label: 'Ana’s computer', reachable: false}};
  const api = createFakeApi();
  api.get = async path => path === 'folders?path=' ? {home: '/home/t'} : path === 'folders/suggest' ? {recent: [], repos: [], truncated: false}
    : path.endsWith('/compose') ? offline : {};
  const page = await mount(h(Compose, {circles: [WEEKEND, DEMO], circle: 'weekend', api, refresh() {}, setCircle() {}}));
  await settle();
  assert.match(page.$('#cmp-why').textContent, /Send is enabled again when Ana’s computer answers\./);
  assert.doesNotMatch(page.$('#cmp-why').textContent, /choose another circle/i, 'the follow-up cannot move to another circle');
  await page.unmount();
});

test('an offline new job still names the other circles as the way out', async () => {
  const offline = {...states.weekend, host: {label: 'Ana’s computer', reachable: false}};
  const api = createFakeApi();
  api.get = async path => path === 'folders?path=' ? {home: '/home/t'} : path === 'folders/suggest' ? {recent: [], repos: [], truncated: false}
    : path.endsWith('/compose') ? offline : {};
  const page = await mount(h(Compose, {circles: [WEEKEND, DEMO], circle: 'weekend', api, refresh() {}, setCircle() {}}));
  await settle();
  assert.match(page.$('#cmp-why').textContent, /Or choose another circle\./);
  await page.unmount();
});

test('with no agent and no lender offers, the closed Model and effort row still says why it cannot change', () => {
  const closed = body(draft({agent: ''}), {offers: []});
  assert.match(renderedText(closed.match(/<summary class="cmp-setting-row"><span class="cmp-setting-label">Model and effort<\/span>[\s\S]*?<\/summary>/)[0]), /choose an agent to change/i);
});
