import './mounted.test-helper.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {h} from 'preact';
import {Setup} from './setup.jsx';
import {mount, resetPage, teardown} from './mounted.test-helper.mjs';

// Batch 9 (P2-9): when the current setup step changes, focus follows the flow only if the person was already in the
// checklist (or nothing had focus). Focus elsewhere on the page stays where it was.
const circle={id:'weekend',name:'Weekend projects',origin:'https://circle.test',enrollment:{state:'approved'},rosterMembershipVerified:true};
const agent={id:'codex',installed:true,signedIn:false,useForLending:true};
const commandPath={installed:false,path:'/home/ana/.local/bin/faravan',launcher:'/Applications/Faravan.app/Contents/MacOS/faravan',profile:'/home/ana/.zprofile',managed:true};
const readyChecks=['sbx_install','sbx_daemon','docker_login'].map(name=>({name,ok:true}));
const dockerNotReady={ready:false,checks:[{name:'sbx_install',ok:true},{name:'sbx_daemon',ok:false},{name:'docker_login',ok:true}]};
const props=readiness=>({api:{get:async()=>({agents:[{id:'codex',checks:[{id:'signed_in',state:'pass'}]}]}),post:async()=>({})},
  data:{readiness,agents:[agent],commandPath,home:{lending:{enabled:false,circle:circle.id}},devices:{name:'Ana’s computer'}},
  agents:[agent],circles:[circle],circle:circle.id,lending:{circle:circle.id,limits:{dailyJobs:3,dailyMinutes:60}},
  mutate:async()=>({}),refresh:async()=>{},phone:false});

test('a step change does not take focus from a control elsewhere on the page',async t=>{
  t.after(teardown); resetPage();
  const view=await mount(h(Setup,props(dockerNotReady)));
  const summary=view.container.querySelector('.setup-summary h2');
  const before=view.$('.setup-current h2').textContent;
  summary.focus();
  await view.rerender(h(Setup,props({ready:true,checks:readyChecks})));
  assert.notEqual(view.$('.setup-current h2').textContent,before,'the current step did change');
  assert.equal(document.activeElement, summary, 'focus stays on the summary');
});

test('a step change moves focus to the new step when focus was in the checklist',async t=>{
  t.after(teardown); resetPage();
  const view=await mount(h(Setup,props(dockerNotReady)));
  view.button('Check again').focus();
  await view.rerender(h(Setup,props({ready:true,checks:readyChecks})));
  assert.equal(document.activeElement?.closest('.setup-current') !== null, true, 'focus follows the flow into the new current step');
});
