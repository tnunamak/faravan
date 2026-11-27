import './mounted.test-helper.mjs';
import test, {afterEach, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {createFakeApi, flush, installClock, mount, resetPage, teardown} from './mounted.test-helper.mjs';
import {Compose} from './compose.jsx';
import {resendResultDraft, SOURCE_UNKNOWN_LINE} from './resend-result.mjs';
import {saveDraft} from './compose-draft.mjs';

// Send again must never swap in a project the original job did not use. A draft with no known source stays empty
// and says so; a plain new job still takes the obvious project.
const START = Date.UTC(2026, 10, 1, 15, 0, 0);
const CIRCLE = {id:'circle-tessa',name:'Tessa',origin:'http://127.0.0.1:9',membershipProjection:{
  schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown',
}};
const SELF = {keyId:'self-key',self:true,label:'Tessa’s MacBook',agents:[{adapter:'codex',readiness:'ready'}]};
const compose = {circle:CIRCLE.id,name:'Tessa',hosted:true,networked:true,presence:'ok',host:{label:'Tessa’s MacBook',reachable:true},lenders:[SELF],offers:[]};
const suggest = {recent:[{path:'/code/payroll',name:'payroll',is_git:true}], repos:[{path:'/code/payroll'}], truncated:false};

beforeEach(() => { resetPage('#/jobs/new'); installClock(START); });
afterEach(teardown);

function api() {
  const fake = createFakeApi();
  fake.get = async path => path === 'folders?path=' ? {home:'/home/sam'} : path === 'folders/suggest' ? suggest
    : path.endsWith('/compose') ? compose : {};
  return fake;
}
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };
const mountComposer = () => mount(h(Compose, {circles:[CIRCLE], circle:CIRCLE.id, api:api(), refresh:() => {}, setCircle:() => {}}));

const missingFolders = [
  ['no source identity', {}, ''],
  ...['top-level', 'local'].flatMap(location =>
    [undefined, '', '   '].flatMap(sourceFolder =>
      [undefined, '', ' \t '].map(sourcePath => [
        location + ' folder kind / explicit ' + JSON.stringify(sourceFolder) + ' / local ' + JSON.stringify(sourcePath),
        location === 'top-level' ? {sourceKind:'folder', local:{sourcePath}} : {local:{sourceKind:'folder', sourcePath}},
        sourceFolder,
      ]))),
];
for (const [label, fields, sourceFolder] of missingFolders) {
  test('Send again with ' + label + ' does not pick a project and asks the person to choose', async () => {
    const older = {job_digest:'sha256:older-upload', state:'failed', borrowerCircle:CIRCLE.id, local:{agent:'codex', source:'Uploaded files · 3 files'}};
    const job = {...older, ...fields, local:{...older.local, ...fields.local}};
    assert.equal(saveDraft(localStorage, CIRCLE.id, resendResultDraft({current:null, prompt:'Again', sourceFolder, job})), true);
    localStorage.setItem('faravan-compose-circle', CIRCLE.id);
    const page = await mountComposer();
    await settle();
    assert.equal(page.$('#cmp-folder').value, '', 'no project was chosen for the person');
    assert.match(page.text(), new RegExp(SOURCE_UNKNOWN_LINE.replace(/[.]/g, '\\.')));
    assert.doesNotMatch(page.text(), /payroll/);
    await page.unmount();
  });
}

test('control: a new job with no draft still takes the last used project', async () => {
  const page = await mountComposer();
  await settle();
  assert.match(page.$('#cmp-folder').value, /payroll/);
  assert.doesNotMatch(page.text(), /could not tell/);
  await page.unmount();
});
