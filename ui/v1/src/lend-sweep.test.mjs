import test from 'node:test';
import assert from 'node:assert/strict';
import {Lend, lendingOnNotice} from './lend.jsx';
import {LimitsPage} from './limits.jsx';
import {readFileSync} from 'node:fs';
import {guardUnsavedLimits} from './limits-model.mjs';
import {mockFixture, NOW} from './lending-policy.fixture.mjs';
import {renderFixture, renderedText} from './render.test-helper.mjs';

// Lending and Limits sweep: one regression test for each defect that was reproduced in the running app.
const stored = {id:'test-run', state:'passed', at:'2026-10-19T09:12:00Z'};
const circleB = {id:'B', name:'Booking site crew', origin:'http://x', rosterMembershipVerified:true};
const codex = {id:'codex', useForLending:true, installed:true, signedIn:true, run:{}, product:{}};
const baseLending = {enabled:false, circle:'A', mode:'ask', status:'idle', paused:false, current:null,
  limits:{timeZone:'UTC', dailyJobs:null, dailyMinutes:null, maxWallSeconds:null, quotaReserve:30}};
const lendPage = ({lending = baseLending, circles = [circleB], agents = [codex]} = {}) => renderFixture(Lend, {
  api:{}, agents, lending, circles, circle:undefined, selected:circles[0], members:[], refresh() {}, setDialog() {}, setCircle() {},
  mutate: async () => ({}), data:{agents, readiness:{ready:true, checks:[]}, home:{state:'ready',lending}, approvals:[], activity:[]}});

test('1: a sole eligible circle is "Selected" only when it is the saved target', () => {
  const stale = lendPage();
  assert.doesNotMatch(renderedText(stale), /Selected/);
  assert.match(stale, /<input[^>]*type="radio"[^>]*value="B"/, 'the sole eligible circle can still be chosen');
  assert.doesNotMatch(stale, /<input[^>]*type="radio"[^>]*value="B"[^>]*checked/);
  assert.match(renderedText(stale), /circle you chose earlier is no longer available/);
  assert.doesNotMatch(renderedText(stale), /New jobs from this circle use the agents and limits you chose/);
  const saved = lendPage({lending:{...baseLending, circle:'B'}});
  assert.match(renderedText(saved), /Selected/);
  assert.match(renderedText(saved), /New jobs from this circle use the agents and limits you chose/);
  assert.doesNotMatch(renderedText(saved), /no longer available/);
});

test('6: an inventory of agents the page does not show gets an explanation and no "Check again"', () => {
  const out = lendPage({agents:[{id:'gemini', installed:true, signedIn:true}, {id:'opencode', installed:true, signedIn:true}]});
  assert.doesNotMatch(renderedText(out), /Check again/);
  assert.match(renderedText(out), /None of the agents on this computer can be lent yet\. Faravan lends Claude Code and Codex\./);
  assert.match(lendPage(), /Check agents again/);
});

test('9: the Lending outline does not skip heading levels', () => {
  const out = lendPage({circles:[circleB], lending:{...baseLending, circle:'B'}});
  assert.doesNotMatch(out, /<h5/);
  assert.match(out, /<h3>Model and effort<\/h3>/);
  const levels = [...out.matchAll(/<h([1-6])[ >]/g)].map(m => +m[1]);
  levels.reduce((previous, level) => { assert.ok(level <= previous + 1, 'heading levels ' + previous + ' → ' + level); return level; }, 1);
});

const limits = {mode:'ask', circle:'shared', configVersion:3, enabled:true,
  limits:{timeZone:'UTC', dailyJobs:null, dailyMinutes:null, maxWallSeconds:null, quotaReserve:30, idleOnly:true}};
const rule = {id:'r1', circle:'shared', people:['sam'], agents:['codex'], maxWallSeconds:null, dailyJobs:null, dailyMinutes:null, expiresAt:NOW + 10 * 86400000};
const devices = {fingerprint:'me', name:'Laptop', circles:[{circle:'shared', members:[{key_id:'me', device_name:'Laptop'}, {key_id:'sam', localName:'Sam'}]}]};
const limitsPage = (standingRules) => {
  const l = {...limits, standingRules};
  return renderFixture(LimitsPage, {lending:l, circle:'shared', now:NOW, mutate:async()=>({}), circles:[{id:'shared', name:'Friends'}],
    data:{home:{lending:l, lendingPolicy:mockFixture()}, devices}});
};

test('3: ask mode with an active rule does not claim that every job is approved first', () => {
  const withRule = renderedText(limitsPage([rule]));
  assert.match(withRule, /Requests not covered by a rule ask you first\./);
  assert.doesNotMatch(withRule, /You approve each job before it starts/);
  const expired = renderedText(limitsPage([{...rule, expiresAt:NOW - 1}]));
  assert.match(expired, /You approve each job before it starts\./);
  assert.match(renderedText(limitsPage([])), /You approve each job before it starts\./);
});



test('7: a link to local help on the same page does not ask to discard changes', () => {
  const win = new EventTarget(), doc = new EventTarget();
  win.location = {href:'https://local.test/#/lend/limits'};
  win.history = {replaceState() {}};
  let asked = 0;
  const stop = guardUnsavedLimits(win, doc, () => { asked++; return false; });
  const click = href => {
    const event = new Event('click', {cancelable:true});
    Object.defineProperty(event, 'target', {value:{closest:() => ({href:new URL(href, win.location.href).href, getAttribute:() => href})}});
    doc.dispatchEvent(event);
    return event;
  };
  assert.equal(click('#starting-assumption').defaultPrevented, false);
  assert.equal(asked, 0);
  assert.equal(click('#/home').defaultPrevented, true);
  assert.equal(asked, 1);
  stop();
});

test('turn-on notices use current admission, not the pre-toggle view or unconditional success', () => {
  for (const [headline, reason] of [['Done for today', 'Today’s lending limit is reached.'],
    ['Outside lending hours', 'This computer is outside its lending hours.'],
    ['Jobs can’t start', 'Finish setting up the protected workspace before jobs can start.']]) {
    assert.equal(lendingOnNotice({lendingProjection:{intent:'on',admission:'blocked'},headline,reason}), headline + '. ' + reason);
  }
  assert.equal(lendingOnNotice({lendingProjection:{intent:'off',admission:'blocked'},headline:'Lending is off'}),
    'Lending is set to on. Updating lending status.');
  assert.equal(lendingOnNotice({lendingProjection:{intent:'on',admission:'allowed'}}),
    'Lending is on. Your approval mode and limits apply.');
  const source=readFileSync(new URL('./lend.jsx',import.meta.url),'utf8');
  assert.match(source,/latest = useRef\(vm\); latest.current = vm/);
  assert.match(source,/await run\(next\);\s*notices\?\.set\(next \? lendingOnNotice\(latest.current\)/);
});


