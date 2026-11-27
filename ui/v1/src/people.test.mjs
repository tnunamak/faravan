import test from 'node:test';
import assert from 'node:assert/strict';
import {peopleVM,personJobs,personHref,parseCircleCode,computerAvailability,roleFormState,unblockMessage} from './people-view.mjs';
import {routeFromHash,navCurrent} from './helpers.mjs';

test('people group only verified person identities, even with duplicate names',()=>{
 const people=[{personId:'p1',name:'Morgan',role:'owner',computers:[{key_id:'a'},{key_id:'b'}]},
   {personId:'p2',name:'Morgan',role:'borrow-only',blocked:true,computers:[{key_id:'c'}]}];
 const rows=peopleVM(people,[{key_id:'b',device_name:'Desktop',localName:'Mo'}],'a');
 assert.equal(rows.length,2);assert.equal(rows[0].computers.length,2);assert.equal(rows[0].name,'Mo');
 assert.equal(rows[0].self,true);assert.equal(rows[1].self,false);assert.equal(rows[1].roleName,'Borrow only');
 assert.equal(rows[1].blocked,true);
});
test('member page includes requests and runs from every computer belonging to that person',()=>{
 const jobs=[{job_digest:'a',job:{author:'key1'}},{job_digest:'b',job:{payload:{author:'key2'}}},
 {job_digest:'c',current_attempt:{holder:'key2'}},{job_digest:'d',historyIdentity:{author:'other'}}];
 const view=personJobs(jobs,{computers:[{key_id:'key1'},{key_id:'key2'}]});
 assert.deepEqual(view.asked.map(job=>job.job_digest),['a','b']);assert.deepEqual(view.ran.map(job=>job.job_digest),['c']);
});
test('member pages have durable circle-specific links and belong to Circles',()=>{
 assert.equal(personHref('circle','person'),'#/person/person/circle');
 assert.deepEqual(routeFromHash('#/person/person/circle'),{page:'person',id:'person',circle:'circle'});
 assert.equal(navCurrent('person'),'circles');
});

import {PeopleList,PersonDetail,CircleAuthority,CircleExits,ComputerLink} from './people.jsx';
import {renderFixture,renderedText,assertNoBannedWords} from './render.test-helper.mjs';
const member={key_id:'computer-a',device_name:'Office desktop',requesterLimits:{limits:{dailyJobs:3},usage:{jobs:1,milliseconds:60000}}};
const person={personId:'person-a',name:'Morgan',role:'member',roleName:'Member',blocked:false,computers:[member]};
const circle={id:'friends',name:'Weekend projects',owned:true,origin:'https://example.test'};
test('person list nests computers under the person and opens their circle-specific page',()=>{
 const html=renderFixture(PeopleList,{people:[person],members:[member],circleId:circle.id});
 assert.match(html,/href="#\/person\/person-a\/friends"/);assert.match(html,/Computers for Morgan/);
 assert.match(renderedText(html),/Office desktop/);assertNoBannedWords(html);
});
test('member list keeps current and unobserved computers visible and discloses older repeated computers',()=>{
 const now=Date.parse('2026-11-20T12:00:00Z');
 const lastWeek=new Date(now-7*86400000).toISOString(), today=new Date(now-60000).toISOString();
 const offline={online:false,presence:{last_heartbeat_at:lastWeek}};
 const computers=[
   {key_id:'old-a',device_name:'Shared desktop',...offline},
   {key_id:'old-b',device_name:'Shared desktop',...offline},
   {key_id:'self',device_name:'Current desktop',...offline},
   {key_id:'fresh',device_name:'Shared desktop',online:true,presence:{last_heartbeat_at:lastWeek}},
   {key_id:'poll',device_name:'Shared desktop',online:false,presence:{last_heartbeat_at:lastWeek,last_poll_at:today}},
   {key_id:'unknown',device_name:'Shared desktop',online:false},
   {key_id:'unique',device_name:'Separate laptop',...offline},
 ];
 const people=computers.map(computer=>({personId:computer.key_id,name:'Morgan',role:'member',computers:[computer]}));
 const html=renderFixture(PeopleList,{people,selfKey:'self',circleId:circle.id,now});
 const [details,summary,older]=html.match(/(<details[^>]*>)<summary>([^<]+)<\/summary>(.*?)<\/details>/)?.slice(1)??[];
 assert.equal(summary,'Older computers (2)');
 assert.doesNotMatch(details,/\bopen\b/);
 assert.equal(renderedText(older).match(/Shared desktop/g).length,2);
 assert.equal(renderedText(older).match(/Last seen/g).length,2);
 const visible=renderedText(html.slice(0,html.indexOf(details)));
 assert.match(visible,/Current desktop · This computer/);
 assert.doesNotMatch(visible,/Member · This computer/);
 assert.equal(visible.match(/This computer/g).length,1);
 assert.equal(visible.match(/Shared desktop/g).length,3);
 assert.match(visible,/Separate laptop/);
});
test('signed people sharing a name and computer label keep separate visible rows',()=>{
 const now=Date.parse('2026-11-20T12:00:00Z'), lastWeek=new Date(now-7*86400000).toISOString();
 const people=['a','b'].map(key=>({personId:key,name:'Morgan',role:'member',computers:[{
   key_id:key,person_id:key,device_name:'Office desktop',online:false,presence:{last_poll_at:lastWeek},
 }]}));
 const html=renderFixture(PeopleList,{people,circleId:circle.id,now});
 assert.match(html,/href="#\/person\/a\/friends"/);
 assert.match(html,/href="#\/person\/b\/friends"/);
 assert.equal(renderedText(html).match(/Office desktop/g).length,2);
 assert.doesNotMatch(html,/<details/);
});
test('member page distinguishes role, local lending limits, requests and runs, and reversible block',()=>{
 const html=renderFixture(PersonDetail,{person,circle,members:[member],selfKey:'other',jobs:[]});
 for(const text of ['Circle access','Save role','Block person','Computers and your lending limits','Asked for','Assigned to their computers','Remove person'])assert.ok(renderedText(html).includes(text),text);
 assert.match(renderedText(html),/3 jobs/);assertNoBannedWords(html);
 const nonOwner=renderFixture(PersonDetail,{person,circle:{...circle,owned:false},jobs:[]});
 assert.doesNotMatch(renderedText(nonOwner),/Save role|Block person|Remove person/);
});
test('authority controls explain acceptance, hosting, update and invitation effects',()=>{
 const html=renderFixture(CircleAuthority,{circle,members:[member],selfKey:'other'}),text=renderedText(html);
 for(const phrase of ['Everyone must update','unused invitations','Save backup steward','Create transfer code','stay owner until','Hosting stays'])assert.ok(text.includes(phrase),phrase);
 assertNoBannedWords(html);
 const recipient=renderedText(renderFixture(CircleAuthority,{circle:{...circle,owned:false},members:[member]}));
 assert.match(recipient,/Accept ownership/);assert.doesNotMatch(recipient,/Create transfer code/);
});
test('archive, reopen, close and local deletion have distinct lifecycle gates',()=>{
 const text=state=>renderedText(renderFixture(CircleExits,{circle:{...circle,lifecycle:state}}));
 assert.match(text('active'),/Archive circle/);assert.doesNotMatch(text('active'),/Delete local data/);
 assert.match(text('archived'),/Reopen circle/);assert.match(text('closed'),/Delete local data/);
 assert.doesNotMatch(text('closed'),/Reopen circle|Close circle/);
});
test('computer linking requires explicit proofs from the original and new computer',()=>{
 const html=renderFixture(ComputerLink,{circle,members:[member,{key_id:'b',device_name:'Travel laptop'}],selfKey:member.key_id});
 const text=renderedText(html);for(const phrase of ['Matching names alone do not link computers','Original computer’s proof'.replace('’',"'"),'New computer’s proof'.replace('’',"'"),'Verify and link computers'])assert.ok(text.includes(phrase),phrase);
});

test('malformed shared codes give a specific recovery without exposing parser internals',()=>{
 for(const value of ['{','null','[]','42'])assert.throws(()=>parseCircleCode(value,'invalid_transfer_code'),error=>error.code==='invalid_transfer_code');
 assert.deepEqual(parseCircleCode('{"payload":{}}'),{payload:{}});
});

test('history failure preserves access controls and local lending limits',()=>{
 const html=renderFixture(PersonDetail,{person,circle,jobsError:{code:'unavailable'},jobs:[]});
 const text=renderedText(html);
 for(const phrase of ['Block person','Edit device limits','Morgan','Job history is unavailable. Access controls are still available.'])assert.ok(text.includes(phrase),phrase);
});

test('finding 2: historical assignment never claims this person ran or completed the job',()=>{
 const jobs=[{job_digest:'claimed',title:'Never started',status:'Starting',current_attempt:{holder:member.key_id}},
   {job_digest:'elsewhere',title:'Finished elsewhere',status:'Finished',attempts:[{holder:member.key_id}],current_attempt:{holder:'other',execution_started_at:'2026-10-31T00:00:00Z'}}];
 const text=renderedText(renderFixture(PersonDetail,{person,circle,jobs}));
 assert.match(text,/Assigned to their computers/);
 assert.match(text,/Assignment does not mean the job started/);
 assert.match(text,/Never started/);assert.match(text,/Finished elsewhere/);
 assert.match(text,/Execution on their computers unknown/);
 assert.doesNotMatch(text,/>Ran<|Starting/);
 const html=renderFixture(PersonDetail,{person,circle,jobs});
 assert.doesNotMatch(html,/<h2>Ran<\/h2>|<p[^>]*>Finished<\/p>/);
});
test('finding 3: list and detail share bounded availability with explicit unknown and access precedence',()=>{
 const checkedAt='2026-10-31T06:00:00Z',now=Date.parse(checkedAt)+1000;
 const labels=[
  [{checkedAt,online:true,lending:true},'Online · Lending enabled'],
  [{checkedAt,online:true,lending:false},'Online · Not lending'],
  [{checkedAt,online:false},'Offline'],
  [{checkedAt,online:true,lending:true,stale:true},'Last known: Online · Lending enabled'],
  [undefined,'Availability unknown'],
 ];
 for(const [status,label] of labels)assert.ok(computerAvailability(status,{now}).startsWith(label));
 assert.match(computerAvailability({checkedAt,online:true,lending:true},{now:now+60000}),/^Last known:/);
 assert.equal(computerAvailability({word:'Online'}),'Availability unknown');
 assert.equal(computerAvailability({checkedAt,online:true,lending:true},{blocked:true,now}),'Blocked · No new jobs');
 assert.equal(computerAvailability(undefined,{lifecycle:'closed'}),'Circle closed · No new jobs');
 for(const Component of [PeopleList,PersonDetail]) {
  const props={person,people:[person],members:[member],circle,circleId:circle.id,jobs:[]};
  assert.match(renderedText(renderFixture(Component,props)),/Availability unknown/);
  assert.match(renderedText(renderFixture(Component,{...props,person:{...person,blocked:true},people:[{...person,blocked:true}]})),/Blocked · No new jobs/);
  assert.match(renderedText(renderFixture(Component,{...props,availability:()=>({checkedAt:new Date().toISOString(),online:true,lending:false})})),/Online · Not lending/);
 }
});

test('role drafts follow clean refreshes, retain dirty conflicts, and reset across bindings',()=>{
 const binding=JSON.stringify(['friends','person-a']);
 const initial=roleFormState(null,binding,'member');
 assert.equal(roleFormState(initial,binding,'borrow-only').value,'borrow-only');
 const dirty={...initial,value:'lend-only'};
 const conflict=roleFormState(dirty,binding,'borrow-only');
 assert.equal(conflict.value,'lend-only');assert.equal(conflict.conflict,true);
 assert.deepEqual(roleFormState(dirty,binding,'lend-only'),{binding,baseline:'lend-only',value:'lend-only',conflict:false});
 assert.equal(roleFormState(conflict,binding,'borrow-only').conflict,true);
 const acknowledged=roleFormState(dirty,binding,'lend-only');
 assert.deepEqual(roleFormState(acknowledged,binding,'borrow-only'),{binding,baseline:'borrow-only',value:'borrow-only',conflict:false});
 assert.equal(roleFormState(null,binding,'borrow-only').conflict,false);
 for(const next of [JSON.stringify(['other','person-a']),JSON.stringify(['friends','person-b'])]) {
  const reset=roleFormState(dirty,next,'borrow-only');
  assert.equal(reset.value,'borrow-only');assert.equal(reset.conflict,false);
 }
});
test('Asked-for uses shared status vocabulary with the viewer role and unknown fallback',()=>{
 const make=(overrides)=>({job_digest:'asked',title:'Request',historyIdentity:{author:member.key_id},state:'claimed',status:'Starting',current_attempt:{holder:'lender',execution_started_at:'2026-10-31T00:00:00Z'},...overrides});
 for(const role of ['sent','ran']) {
  const text=renderedText(renderFixture(PersonDetail,{person,circle,jobs:[make({role})]}));
  assert.match(text,role==='ran'?/Running/:/Working/);assert.doesNotMatch(text,/Starting/);
 }
 const text=renderedText(renderFixture(PersonDetail,{person,circle,jobs:[make({state:'unrecognized',status:'server-internal-code',current_attempt:null})]}));
 assert.match(text,/Status unavailable/);assert.doesNotMatch(text,/server-internal-code/);
});
test('unblock copy retains all restrictions and explicitly names inactive circles',()=>{
 for(const lifecycle of ['active','archived','closed']) {
  const text=unblockMessage(lifecycle);
  assert.match(text,/removes this person's block/);assert.match(text,/Circle lifecycle, role, approval, and lending restrictions still apply/);
  assert.doesNotMatch(text,/can ask for and run new jobs again/);
  if(lifecycle!=='active')assert.ok(text.includes('This circle is '+lifecycle+': no new jobs.'));
 }
});
test('one jobs request has one error or loading announcement and retains access controls',()=>{
 for(const [state,phrase] of [[{jobsError:{code:'unavailable'}},'Job history is unavailable. Access controls are still available.'],[{jobsLoading:true},'Loading job history…']]) {
  const text=renderedText(renderFixture(PersonDetail,{person,circle,jobs:[],...state}));
  assert.equal(text.split(phrase).length-1,1);assert.match(text,/Block person/);assert.match(text,/Edit device limits/);
  assert.doesNotMatch(text,/No jobs in the history/);
 }
});

import {readFileSync} from 'node:fs';
test('People delegates nicknames to the binding-aware editor that preserves edits after submit',()=>{
 const source=readFileSync(new URL('./people.jsx',import.meta.url),'utf8');
 const editor=readFileSync(new URL('./local-name.jsx',import.meta.url),'utf8');
 assert.match(source,/<LocalNameControl key=\{JSON.stringify\(\[circle.id,computer.key_id\]\)\}/);
 assert.match(source,/current=\{computer.localName\}/);
 assert.doesNotMatch(source,/function ComputerNickname/);
 assert.ok(editor.includes("key={circleId + '|' + keyId}"));
 assert.ok(editor.includes('textRef.current !== submitted'));
 assert.ok(editor.includes('Your new edit is not saved.'));
});
test('role conflicts gate save and expose explicit reset; person form identity includes circle',()=>{
 const source=readFileSync(new URL('./people.jsx',import.meta.url),'utf8');
 assert.ok(source.includes('disabled={form.conflict||role===person.role}'));
 assert.ok(source.includes('run={()=>!form.conflict&&mutate'));
 assert.ok(source.includes('Use current role'));
 assert.ok(source.includes('useLayoutEffect(()=>setDraft(form),[binding,person.role])'));
 assert.ok(source.includes('<PersonDetail key={JSON.stringify([circleId,id])}'));
});

// Item 6 (1102 review): the proof buttons say what is missing, not "This control is unavailable right now.", and the steps are numbered.
test('computer linking names the missing step on each disabled proof button and numbers the steps',()=>{
 const html=renderFixture(ComputerLink,{circle:{...circle,owned:true},members:[member,{key_id:'b',device_name:'Travel laptop'}],selfKey:member.key_id});
 const text=renderedText(html);
 assert.ok(text.includes('Step 1: create a proof on each computer. Step 2: give both proofs to the circle owner.'),'the steps are numbered');
 assert.ok(text.includes('Choose the computer to link first.'),'the proof button says the computer to link is missing');
 assert.ok(text.includes('Paste both proofs first.'),'the verify button says the proofs are missing');
 assert.doesNotMatch(text,/This control is unavailable right now/);
});
