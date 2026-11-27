// Import first: installs DOM globals before the component modules.
import {mount, resetPage, teardown, createFakeApi, installClock, click, act, window} from './mounted.test-helper.mjs';
import test, {beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Circles} from './circles.jsx';
import {Job} from './jobs.jsx';

beforeEach(() => { resetPage('#/circles'); installClock(); });
afterEach(teardown);
const circle = {id:'c', name:'Weekend projects', origin:'http://fixture'};
const devices = {
  fingerprint:'owner', ownerName:'Alex Example',
  circles:[{circle:'c', members:[
    {key_id:'owner', device_name:'sandpiper', personName:'Alex Example'},
    {key_id:'friend', device_name:'kestrel', personName:'Maya Okafor'},
  ]}],
};
const record = state => ({
  job_digest:'j', circle, state,
  current_attempt:{holder:'friend', execution_started_at:'2026-10-20T14:59:00Z'},
  historyIdentity:{author:'owner', deviceName:'sandpiper'},
  local:{prompt:'Write a poem', title:'Write a poem'},
});
async function openJob(job, extra = {}) {
  const api = createFakeApi({
    'jobs/j':job,
    'jobs/j/progress':{entries:[]},
    'jobs/j/transcript':{
      text:JSON.stringify({type:'assistant', message:{content:[{type:'text', text:'Writing the poem.'}]}}),
      live:job.state === 'running',
    },
    'jobs/j/prompt':{text:'Write a poem'},
    'jobs/j/changes':{format:'diff', diff:'', files:[], receipt:{harness:'codex'}},
    'jobs/j/retention':{deletable:true},
    ...extra,
  });
  const view = await mount(h(Job, {
    id:'j', requestedCircle:'c', circle:'c', circles:[circle], api,
    data:{devices, jobs:[]}, revision:0, draft:{}, members:[],
    mutate:async () => {}, setDialog() {}, refresh:async () => {},
  }));
  // Same bounded release sequence as journey-job.test.mjs; no time/poll advance.
  for (let n = 0; n < 4; n++) await api.release();
  return {view, api};
}

test('team walk: paste Invitation and expose Review invitation without joining', async () => {
  const api = createFakeApi({hosting:{}});
  const view = await mount(h(Circles, {
    circles:[], data:{circles:[]}, api, revision:0,
    mutate:(path, body) => api.post(path, body), refresh:async () => {},
  }));
  const join = view.button('Join with an invitation');
  assert.ok(join, 'guide line 53: exact entry label');
  await click(join);
  assert.ok(view.$$('h2, h3').some(node => node.textContent.trim() === 'Join a circle'));
  const input = view.$('textarea[aria-describedby="invite-help"]');
  assert.ok(input);
  assert.equal(input.closest('label').textContent.trim(), 'Invitation');
  await act(() => {
    // Deliberately synthetic fixture; never a real invitation or credential.
    input.value = 'https://fixture.invalid/join#team-walk';
    input.dispatchEvent(new window.Event('input', {bubbles:true}));
  });
  assert.ok(view.button('Review invitation'), 'guide line 54: exact review control');
  assert.equal(view.button('Join circle'), null, 'Join only follows a successful review');
  assert.equal(api.posts.length, 0, 'opening/pasting does not review or join');
});

test('team walk: borrower sees the running person on the same job', async () => {
  const {view, api} = await openJob(record('running'));
  assert.ok(view.button('Jobs'), 'guide line 75: Jobs return link');
  // The running person is named, but without fresh host contact the page makes no present-execution claim (live-view F1).
  assert.match(view.text(), /Maya Okafor’s computer/);
  assert.doesNotMatch(view.text(), /’s agent is working/);
  assert.doesNotMatch(view.text(), /sandpiper|kestrel/);
  assert.equal(api.posts.length, 0, 'following a job does not submit another');
});

test('team walk: open finished No project response and offer Download Markdown', async () => {
  const {view, api} = await openJob({...record('result-accepted'), result_digest:'r'}, {
    'jobs/j/changes':{format:'message', message:{markdown:'Grey waves\nSad birds', url:'/message'}, files:[]},
  });
  assert.ok(view.button('Jobs'), 'guide line 75: Jobs return link');
  assert.match(view.text(), /Grey waves/);
  assert.match(view.text(), /Sad birds/);
  assert.ok(view.button('Download Markdown'), 'guide line 76: exact result action');
  assert.equal(view.$('[aria-label="Loading result"]'), null, 'terminal transcript and changes both resolved');
  assert.equal(api.posts.length, 0, 'reading returned text does not submit or apply it');
});
