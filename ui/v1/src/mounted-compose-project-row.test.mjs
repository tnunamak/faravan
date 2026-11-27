import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {Compose} from './compose.jsx';

// Batch 9 (A): the Project row opens whenever the footer blames the missing project, including while the folder
// suggestion is still loading (the live Mac showed a closed row under "Send is off until you choose a project").
const START = Date.UTC(2026, 10, 1, 15, 0, 0);
const CIRCLE = {id:'circle-tessa',name:'Tessa',origin:'http://127.0.0.1:9',membershipProjection:{
  schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown',
}};
const SELF = {keyId:'self-key',self:true,label:'Tessa’s MacBook',agents:[{adapter:'codex',readiness:'ready'}]};
const compose = {circle:CIRCLE.id,name:'Tessa',hosted:true,networked:true,presence:'ok',host:{label:'Tessa’s MacBook',reachable:true},lenders:[SELF],offers:[],runRequestSupported:false};

beforeEach(() => { resetPage('#/jobs/new'); installClock(START); });
afterEach(teardown);

function api(suggest) {
  const fake = createFakeApi();
  fake.get = async path => path === 'folders?path=' ? {home:'/home/sam'} : path === 'folders/suggest' ? suggest
    : path.endsWith('/compose') ? compose : {};
  return fake;
}
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };

test('a fresh New job form opens the Project row while the folder suggestion is still loading, and keeps it open when none is found', async () => {
  let answer;
  const suggestion = new Promise(resolve => { answer = resolve; });
  const page = await mount(h(Compose, {circles:[CIRCLE], circle:CIRCLE.id, api:api(suggestion), refresh:() => {}, setCircle:() => {}}));
  assert.equal(page.$('h1')?.textContent, 'New job');
  assert.equal(page.$('h1')?.getAttribute('aria-label'), 'New job');
  await settle();
  const row = page.$('#cmp-project');
  assert.match(page.text(), /Send is off until you choose a project/, 'the footer blames the missing project');
  assert.equal(row.open, true, 'the Project row is open on first render, before the data arrives');
  assert.ok(page.$('#cmp-project-needed'), 'the row says what to choose');
  answer({recent:[], repos:[], truncated:false});
  await settle();
  assert.equal(page.$('#cmp-project').open, true, 'the row stays open when the suggestion finds nothing');
  const change = page.$('#cmp-project .project-field button');
  assert.equal(change.disabled, false, 'the project control is reachable');
  assert.equal(change.getAttribute('aria-disabled'), null);
  await page.unmount();
});
