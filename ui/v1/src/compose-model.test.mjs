import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCircle, sendableCircles, circleAgents } from './compose-model.mjs';
import {composeVM, projectVM} from './view-models.mjs';
import {ComposeBody} from './compose.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
const approvedMembership={schemaVersion:3,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true,rosterMembershipVerified:true},invitationPolicy:'unknown'};
const circles = [{id:'private', name:'My devices'}, {id:'pending', origin:'https://c', enrollment:{state:'pending'}},
  {id:'rejected',origin:'https://r',enrollment:{state:'rejected'}}, {id:'expired',origin:'https://e',enrollment:{state:'expired'}},
  {id:'unverified',origin:'https://u'}, {id:'a', origin:'https://a',membershipProjection:approvedMembership},
  {id:'b', origin:'https://b',membershipProjection:approvedMembership}];
test('composer defaults to last sendable circle and excludes private and pending destinations', () => {
  assert.deepEqual(sendableCircles(circles).map(c => c.id), ['a', 'b']);
  assert.equal(composeCircle(circles, 'b', 'a'), 'b');
  assert.equal(composeCircle(circles, 'private', 'private'), 'a');
  assert.equal(composeCircle(circles, 'rejected', 'expired'), 'a');
  assert.equal(composeCircle([], 'b', 'a'), '');
});
test('agent choices come only from ready agents in the circle, with lender effort', () => {
  assert.deepEqual(circleAgents({lenders:[{agents:[{adapter:'codex',readiness:'ready',run:{effort:'high'}},{adapter:'claude',readiness:'signed_out'}]},{agents:[{adapter:'codex',readiness:'ready',run:{effort:'low'}}]}]}), [{id:'codex', effort:null, here:false}]);
  assert.deepEqual(circleAgents({lenders:[{keyId:'someone'}]}), []);
  assert.deepEqual(circleAgents(null), []);
});

test('a fresh composer uses the device-selected confirmed circle instead of the first list entry',()=>{
 const available=[{id:'a',origin:'https://a',membershipProjection:approvedMembership},
   {id:'b',origin:'https://b',selected:true,membershipProjection:approvedMembership}];
 assert.equal(composeCircle(available,'',''),'b');
 assert.equal(composeCircle(available,'a','b'),'a','the explicit last composer choice wins');
});

test('a join whose host outcome is unknown stays out of the composer',()=>{
 const circle={id:'joining',origin:'https://host',joinIntent:{outcome:'unknown'}};
 assert.deepEqual(sendableCircles([circle]),[]);
 assert.equal(composeCircle([circle],'',''),'');
});

test('the composer stays disabled until the host confirms the joined circle',()=>{
 const joining={id:'joining',name:'Friends',origin:'https://host',joinIntent:{outcome:'unknown'}};
 const selected=composeCircle([joining],'','');
 const pending=composeVM({prompt:'Write a checklist',repo:{status:'ok'},circle:selected?joining:{}});
 assert.deepEqual([selected,pending.send.disabled,pending.send.why],['',true,'You need an approved circle membership before sending. Open Circles to join or check your approval.']);

 const member={...joining,joinIntent:undefined,enrollment:{state:'approved'},rosterMembershipVerified:true};
 const approved=composeCircle([member],'','');
 const ready=composeVM({prompt:'Write a checklist',repo:{status:'ok'},circle:{...member,id:approved,state:{networked:true}}});
 assert.deepEqual([approved,ready.send.disabled],['joining',false]);
});

test('explicit membership projection overrides raw pending state and invalid projection fails closed',()=>{
 const approved={schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown'};
 const invalid={schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'pending',origin:true},invitationPolicy:'unknown'};
 assert.deepEqual(sendableCircles([{id:'c',origin:'https://c',enrollment:{state:'pending'},membershipProjection:approved}]).map(c=>c.id),['c']);
 assert.deepEqual(sendableCircles([{id:'c',origin:'https://c',enrollment:{state:'approved'},membershipProjection:invalid}]),[]);
});
import {createdJobVM} from './compose-model.mjs';
test('new job state preserves the POST identity and immediately marks the author as this computer',()=>{
  assert.deepEqual(createdJobVM({jobDigest:'digest',replayed:false},{prompt:' Fix checkout. '},{id:'circle',name:'Friends'}),{
    jobDigest:'digest',replayed:false,job_digest:'digest',circle:{id:'circle',name:'Friends'},prompt:'Fix checkout.',title:'Fix checkout.',submittedByMe:true,status:'Waiting',state:'queued',
  });
});

test('the MVP agent picker combines either ready Claude adapter into Claude Code', () => {
 assert.deepEqual(circleAgents({lenders:[{agents:[{adapter:'gemini',readiness:'ready'},{adapter:'claude-code-api-key',readiness:'ready'}]}]}),[{id:'claude-code',effort:null,here:false}]);
 assert.deepEqual(circleAgents({lenders:[{agents:[{adapter:'claude-code-subscription',readiness:'ready'},{adapter:'claude-code-api-key',readiness:'ready'}]}]}),[{id:'claude-code',effort:null,here:false}]);
});

test('compose_plain_folder_summary_describes_a_snapshot_not_commits', () => {
  const draft = {sourceKind:'folder', path:'/work/project', prompt:'Review this', agent:'codex', includeUncommitted:false};
  const vm = {state:'compose.local', send:{label:'Send job', disabled:false}};
  const render = project => renderedText(renderFixture(ComposeBody, {vm, draft, project, circle:'weekend'}));
  assert.ok(render({kind:'folder', name:'project', path:draft.path, files:3}).includes('Your circle sees this prompt and a snapshot of the selected folder.'));
  assert.ok(render({kind:'git', name:'project', path:draft.path, files:3, head:'abcdef', branch:'main'}).includes('Your circle sees this prompt and 3 committed files.'));
});

test('compose_uncommitted_count_excludes_files_not_sent', () => {
  const vm = projectVM({changed_count:3, changed:[{path:'a.mjs'},{path:'b.mjs'},{path:'.env'}],
    sendableChangedCount:2, sourceOmissions:{workingTree:[{path:'.env',reason:'credentials'}]}}, {include:true});
  assert.equal(vm.note, 'Your uncommitted changes will be sent (2 files). 1 file excluded by the current file rules.');
  assert.equal(vm.sending, 'Also sending 2 files: a.mjs, b.mjs.');
});

test('compose_all_changed_files_excluded_never_promises_to_send_them', () => {
  const vm = projectVM({changed_count:1, changed:[{path:'.env'}], sendableChangedCount:0,
    sourceOmissions:{workingTree:[{path:'.env',reason:'credentials'}]}}, {include:true});
  assert.equal(vm.note, 'None of your changed files will be sent under the current file rules.');
  assert.equal(vm.sending, '');
});

// Bug: a circle whose host stopped answering stayed the composer's default, so Send stayed blocked until the person
// found the circle picker. A host not checked yet (reachable null) is not offline.
test('the composer does not default to a circle whose host is known not to answer', () => {
  const live = {id:'friends', origin:'https://f', membershipProjection:approvedMembership, host:{reachable:true}};
  const stale = {id:'demo', origin:'https://d', membershipProjection:approvedMembership, selected:true, host:{reachable:false, lastReachedAt:'2026-11-04T21:12:00.000Z'}};
  assert.equal(composeCircle([stale, live], 'demo', 'demo'), 'friends', 'the last circle used is skipped while its host is offline');
  assert.equal(composeCircle([stale, {...live, host:{reachable:null}}], '', ''), 'friends', 'an unchecked host is still a candidate');
  assert.equal(composeCircle([stale], 'demo', ''), 'demo', 'with no other circle it stays chosen, and its offline banner shows');
  assert.equal(composeCircle([stale, live], 'demo', '', {explicit:true}), 'demo', 'a circle the person picked on this page stays picked');
});
