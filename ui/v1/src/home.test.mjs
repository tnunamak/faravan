import {currentCapacityWait} from '../../../lib/v1/lending-summary.mjs';
import {withoutMaskMarkers} from './telemetry-mask-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Home, ResultCard, copyHomeDraft, HomeDraftCopy, DraftCopyFeedback, homeHandoffCopy} from './home.jsx';
import {JobHead} from './job-view.jsx';
import {JobsList} from './jobs.jsx';
import {homePageVM, homePeopleVM, needsYouItems, lendPageVM, jobVM, jobsListVM} from './view-models.mjs';
import {renderFixture, assertDomOrder, assertNoBannedWords, renderedText} from './render.test-helper.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
import {handoffHomeDraft,COMPOSE_DRAFT_PREFIX,HOME_TEXT_KEY,draftExcerpt,readHomeText} from './compose-draft.mjs';
import {readFileSync} from 'node:fs';
import {projectLendingState, qualifyJobProjection} from '../../../lib/v1/state-projection.mjs';
const now=Date.parse('2026-10-20T05:00:00Z');
const circle={id:'c1',name:'Weekend projects',origin:'http://fixture',owned:true};
const agent={id:'codex',installed:true,signedIn:true,useForLending:true};
const lending={enabled:true,circle:'c1',mode:'ask',status:'idle',limits:{timeZone:'UTC',dailyJobs:3,dailyMinutes:60}};
const home={lending,intent:{on:true,state:'ready'}};
const data={home,circles:[circle],agents:[agent],jobs:[],approvals:[],activity:[],devices:{name:'Ana’s MacBook',ownerName:'Ana',fingerprint:'own',circles:[]},readiness:{ready:true,checks:[]}};
const page=(patch={},props={})=>renderFixture(Home,{api:{get:async()=>[]},circles:[circle],agents:[agent],lending,circle:'c1',selected:circle,members:[],mutate:async()=>({}),refresh(){},setDialog(){},data:{...data,...patch},...props});

const request=id=>({id,requester:'sam',requesterName:'Sam',identity:{memberPresent:true,rosterFresh:true,rootMatches:true,circleMatches:true,requesterName:'Sam'},prompt:'Fix login',harness:'codex',model:[],runtimeSeconds:1200,source:{kind:'archive',size_bytes:1},network:'provider-only',protection:{satisfied:true},expiresAt:Date.now()+600000});
const job=(id,status='Finished')=>({job_digest:id,status,local:{title:'Fix '+id,prompt:'Fix the parser'},circle,waitingTiming:{submittedAt:new Date(now-60000).toISOString()}});

test('Home has one attention queue followed by motion and recent jobs',()=>{
 const html=page({approvals:[request('r1'),request('r2')],jobs:[job('result')]});
 assertDomOrder(html,['Needs your attention','href="#/request/r1"','Fix the parser','href="#/job/result/c1"','In motion','Recently finished']);
 assert.equal((html.match(/btn-primary/g)||[]).length,1);
 assert.doesNotMatch(renderedText(html),/Your next step|Jobs needing your review/);
 assert.match(renderedText(html),/Sam asked to use your computer.*Answer by .*Fix login.*Codex .*Up to 20 min/);
 assert.match(renderedText(html),/Project files · 1 B.*AI provider only.*Safety details.*Not now.*Review request/);
 assertNoBannedWords(html);
});
test('an unchecked circle does not sit above requests and recent jobs on Home',()=>{
 const html=page({approvals:[request('r1')],uncheckedJobCircles:[{id:circle.id,reason:'unreachable'}]});
 assertDomOrder(renderedText(html),['Needs your attention','Recently finished','Couldn’t check jobs in','Check jobs again']);
});

test('Home request card uses its signed identity, deadline and job metadata',()=>{
 const card={...request('r1'),source:{kind:'archive',file_count:2,size_bytes:128}};
 const html=page({approvals:[card]});
 const text=renderedText(html);
 assert.match(withoutMaskMarkers(html),/class="swing-card swing-item-card home-request"/);
 assert.match(withoutMaskMarkers(html),/class="av c\d+" aria-hidden="true">S<\/span>/);
 for(const value of ['Sam asked to use your computer','Fix login','Answer by','Codex','Up to 20 min','2 project files · 128 B','AI provider only','Safety details','Not now','Review request']) {
  assert.ok(text.includes(value),`missing ${value}: ${text}`);
 }
 assert.match(html,/href="#\/request\/r1"/);
});
test('Home does not invent an answer deadline when the signed request has none',()=>{
 const card={...request('r1')};delete card.expiresAt;
 const text=renderedText(page({approvals:[card]}));
 assert.match(text,/We can’t tell how long you have to answer/);
 assert.match(text,/We can’t confirm the deadline\. Refresh this page before approving\./);
 assert.doesNotMatch(text,/Answer by /);
});
test('the featured result and other unreviewed results are excluded from recent history',()=>{
 const jobs=[job('one'),job('two'),{...job('done'),borrowerOutcome:{verdict:'used'}}];
 const vm=homePageVM({jobs,approvals:[],now,zone:'UTC'});
 assert.deepEqual(vm.results.map(r=>r.id),['one','two']);
 assert.deepEqual(vm.recent.map(r=>r.id),['done']);
 const html=page({jobs});assert.equal((html.match(/>Fix the parser</g)||[]).length,1);
});
test('a signed zero-file result is No changes in Home, its badge and recent history',()=>{
 const noChanges={...job('zero'),role:'sent',resultSummary:{noChanges:true,receipt:{receipt:{candidate_format:'diff',diffstat:{files:0,insertions:0,deletions:0}}}}};
 const args={jobs:[noChanges],approvals:[],home,readiness:data.readiness,agents:[agent],now,zone:'UTC'};
 const vm=homePageVM(args);
 assert.equal(vm.needs,0);
 assert.equal(needsYouItems(args).length,0);
 assert.equal(vm.subtitle,'You’re all caught up.');
 assert.equal(vm.result,null);
 assert.deepEqual(vm.recent.map(row=>[row.id,row.word]),[['zero','No changes']]);
 const text=renderedText(page({jobs:[noChanges]}));
 assert.doesNotMatch(text,/Ready to review|Your result is back|0 files changed/);
 assert.match(text,/Recently finished.*Fix zero No changes/);
});
test('Home, nav and machine chip count the same actionable items once',()=>{
 const approvals=[request('r1')], jobs=[job('one')], status={...home,needs_you:[{kind:'approval',approvalId:'r1'}]};
 const args={home:status,readiness:data.readiness,agents:data.agents,jobs,approvals};
 assert.equal(homePageVM({...args,now}).needs,needsYouItems(args).length);assert.equal(homePageVM({...args,now}).needs,2);
});
test('a pending approval renders its requester, answer deadline and both actions before Home status or jobs',()=>{
 const html=page({home:undefined,jobs:undefined,approvals:[request('r1')]});
 assert.match(html,/href="#\/request\/r1"/);
 assert.match(renderedText(html),/Sam asked to use your computer Answer by .*Fix login Codex Up to 20 min/);
 assert.match(renderedText(html),/Safety details.*Not now Review request/);
 assert.match(html,/aria-label="Loading this computer"/);
 assert.equal((html.match(/btn-primary/g)||[]).length,1);
 const failed=page({home:undefined,jobs:undefined,approvals:[request('r1')]},{errors:{home:{code:'network'},jobs:{code:'network'}}});
 assert.match(renderedText(failed),/Sam asked to use your computer/);
 assert.match(renderedText(failed),/This computer’s status could not be loaded/);
 assert.match(renderedText(failed),/Jobs could not be loaded/);
});
test('request cards use per-card admission for a 1200-second fit and a 1201-second overrun',()=>{
 const allowed={schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,
  evidence:{jobCap:{used:2,limit:3},minuteCap:{used:40,limit:60,usedMilliseconds:2400000,limitMilliseconds:3600000,requestedMilliseconds:1200000}}};
 const blocked={schemaVersion:2,kind:'request-admission',admission:'blocked',reasonCode:'request_does_not_fit',
  evidence:{jobCap:{used:2,limit:3},minuteCap:{used:40,limit:60,usedMilliseconds:2400000,limitMilliseconds:3600000,requestedMilliseconds:1201000}}};
 const html=page({home:{...home,today:{jobs:3,jobLimit:3,minutes:60,minuteLimit:60}},approvals:[
  {...request('fits-1200-seconds'),runtimeSeconds:1200,job:{requirements:{limits:{wall_seconds:1200}}},requestAdmission:allowed},
  {...request('over-by-one-second'),runtimeSeconds:1201,job:{requirements:{limits:{wall_seconds:1201}}},requestAdmission:blocked},
 ]});
 assert.match(html,/href="#\/request\/fits-1200-seconds"/,'the exact-fit card remains reviewable');
 assert.match(html,/href="#\/request\/over-by-one-second"/,'a capped card keeps Review request available');
 assert.match(html,/href="#\/lend\/limits"/,'the capped card also keeps the limit action');
 assert.match(renderedText(html),/This request doesn't fit today's minute limit/);
 assert.equal((renderedText(html).match(/Raise today's limit/g)||[]).length,1);
});
test('unknown and non-cap blocked requests stay reviewable without a false limit action',()=>{
 const off=projectLendingState({effective:{intent:{on:false,state:'off'},execution:{state:'idle'}},dailyLimitReached:false});
 const invalid={schemaVersion:2,kind:'request-admission',admission:'allowed',reasonCode:null,evidence:{}};
 const html=page({home:{...home,today:{jobs:3,jobLimit:3,minutes:60,minuteLimit:60},lendingProjection:off},approvals:[
  request('lending-off'),{...request('unknown-admission'),requestAdmission:invalid},
 ]});
 assert.match(html,/href="#\/request\/lending-off"/);
 assert.match(html,/href="#\/request\/unknown-admission"/);
 assert.match(renderedText(html),/This computer can’t run requests right now/);
 assert.match(renderedText(html),/Lending is off\. Review Lending settings\./);
 assert.match(renderedText(html),/can’t confirm whether this computer can run this request/);
 assert.doesNotMatch(renderedText(html),/Raise today's limit/);
});
test('loading keeps skeleton rows and offers no empty-state action',()=>{
 const html=page({jobs:undefined,approvals:undefined});
 assert.match(html,/aria-label="Loading jobs"/);assert.match(html,/aria-label="Loading requests and results"/);
 assert.doesNotMatch(renderedText(html),/Nothing needs a decision|No jobs in motion|Start a circle/);
 const loaded=renderedText(page());assert.match(loaded,/Nothing needs a decision right now|No jobs in motion/);
});
test('the empty attention state keeps the composer action',()=>{
 const html=page();
 assert.match(renderedText(html),/Nothing needs a decision right now/);
 assert.match(renderedText(html),/New job/);
 assert.equal((html.match(/href="#\/new"/g)||[]).length,0);
 assert.match(html,/name="task"[^>]*placeholder="Describe a task…"/);
});
test('Home shows incomplete borrower progress only while that role is in use',()=>{
 const borrowerHome={...home,intent:{on:false,state:'off'},lending:{...lending,enabled:false,circle:''}};
 const borrower=page({home:borrowerHome,jobs:[]},{agents:[{...agent,useForLending:false}]});
 assert.match(renderedText(borrower),/Getting started/);
 assert.match(renderedText(borrower),/Faravan is open on this computer/);

 const lender=page({home,jobs:[{...job('ran'),role:'ran',local:undefined}]},{circles:[{...circle,owned:false}]});
 assert.doesNotMatch(renderedText(lender),/Getting started|Faravan is open on this computer/);

 const complete=page({home:borrowerHome,jobs:[{...job('used'),borrowerOutcome:{verdict:'used'}}]},{agents:[{...agent,useForLending:false}]});
 assert.doesNotMatch(renderedText(complete),/Getting started|Faravan is open on this computer/);
});
test('an attention request takes priority over incomplete Home setup progress',()=>{
 const borrowerHome={...home,intent:{on:false,state:'off'},lending:{...lending,enabled:false,circle:''}};
 const html=page({home:borrowerHome,jobs:[],approvals:[request('r1')]},{agents:[{...agent,useForLending:false}]});
 assert.match(renderedText(html),/Sam asked to use your computer/);
 assert.doesNotMatch(renderedText(html),/Getting started|Faravan is open on this computer/);
});
test('a running lender stays in context while an incoming request leads the Home feed',()=>{
 const active={...home,execution:{state:'running',job:'attempt-1',person:'Alex'},lending:{...lending,status:'running',current:'attempt-1'}};
 const html=page({home:active,approvals:[request('r1')]});
 const text=renderedText(html);
 assert.ok(text.indexOf('Lending on') < text.indexOf('Needs your attention'));
 assert.ok(text.indexOf('Needs your attention') < text.indexOf('Sam asked to use your computer'));
 assert.ok(text.indexOf('Sam asked to use your computer') < text.indexOf('In motion'));
});
test('a first-run action waits for resources and does not claim Docker is ready when signed out',()=>{
 const html=page({circles:[],agents:[],jobs:[],home:{lending:{}},readiness:{ready:false,checks:[{name:'docker_login',ok:false}]}},{circles:[],agents:[],lending:{}});
 // Role-aware first run (onboarding.mjs): borrowing leads; lending readiness stays in the rail and never claims ready.
 assert.match(renderedText(html),/Get help from people you trust/);assert.match(renderedText(html),/Start a circle/);
 assert.doesNotMatch(renderedText(html),/is ready to lend/);
 assert.equal((html.match(/btn-primary/g)||[]).length,1);
 assert.match(renderedText(html),/Status unavailable/);
 assert.match(renderedText(html),/Lending settings/,'the optional setup path remains available without replacing unknown domain status');
});
test('people rows exclude this computer and never infer live presence from old activity',()=>{
 const people=homePeopleVM([{key_id:'own',localName:'Ana'},{key_id:'sam',localName:'Sam',presence:{state:'running',last_poll_at:new Date(now-1000).toISOString()}},{key_id:'mia',localName:'Mia',role:'borrower'},{key_id:'raj',localName:'Raj',last_seen_at:new Date(now-3600000).toISOString()}],{ownId:'own',now,zone:'UTC'});
 assert.deepEqual(people.map(p=>p.state),['Lending now','Borrows','Last seen 1 h ago']);
 assert.equal(homePeopleVM([{key_id:'sam',device_name:'Sam laptop'}],{now})[0].name,'Sam laptop');
});
test('Home leaves earlier check-ins and unreported duplicate computer labels in the circle',()=>{
 const presence=ago=>({last_heartbeat_at:new Date(now-ago).toISOString()});
 const rows=homePeopleVM([
   {key_id:'old',personName:'Sam',device_name:'Laptop',online:false,presence:presence(8*86400000)},
   {key_id:'live',personName:'Sam',device_name:'Laptop',online:true,presence:presence(1000)},
   {key_id:'new',personName:'Sam',device_name:'Laptop',reported:false},
   {key_id:'other',personName:'Sam',device_name:'Desktop',reported:false},
   {key_id:'distinct',personName:'Sam',person_id:'someone-else',device_name:'Laptop',reported:false},
 ],{now});
 assert.deepEqual(rows.filter(row=>!row.earlier).map(row=>row.id),['live','other','distinct']);
 assert.deepEqual(rows.filter(row=>row.earlier).map(row=>row.id),['old','new']);
});
test('pending requests and an explicit idle execution cannot appear as a running job',()=>{
 const args={agents:[agent],readiness:data.readiness,zone:'UTC',now};
 assert.equal(lendPageVM({...home,execution:{state:'idle'},runningJob:{requester:'Sam'},lending:{...lending,current:'approval',status:'waiting_for_approval'}},args).exec,null);
 assert.equal(lendPageVM({...home,runningJob:{requester:'Sam'}},args).exec,null);
 assert.match(lendPageVM({...home,execution:{state:'running',job:'attempt-1',person:'Sam',stops_by:now+60000}},args).exec.text,/Sam’s job is running/);
});
test('preview labels one file and never includes a second file’s patch',()=>{
 const vm=homePageVM({jobs:[job('one')],approvals:[],changes:{format:'diff',files:[{path:'one.js'},{path:'two.js'}],diff:'diff --git a/one.js b/one.js\n-old\n+new\ndiff --git a/two.js b/two.js\n+secret second file'},now});
 assert.equal(vm.preview.file,'one.js');assert.deepEqual(vm.preview.lines.map(l=>l.text),['old','new']);
});



test('Home returned lender jobs share their real title and kind glyph with Jobs',()=>{
 const returned={...job('returned'),role:'ran',title:'Internal task title',local:undefined,historyIdentity:{localName:'Sam'}};
 const vm=homePageVM({jobs:[returned],approvals:[],now,zone:'UTC'});
 assert.equal(vm.recent[0].title,'Internal task title');assert.equal(vm.recent[0].word,'Sent back');
 assert.equal(vm.recent[0].whoShort,'');assert.equal(vm.recent[0].circle,'');assert.equal(vm.recent[0].when,'1 min ago');
 const html=page({jobs:[returned]});const text=renderedText(html);
 assert.match(text,/Internal task title Sent back/);assert.doesNotMatch(text,/ran for|Sent to/);
 assert.match(html,/<use href="#laptop"/);
 assert.doesNotMatch(html,/<use href="#lend"/);
 assert.doesNotMatch(html,/class="row-meta dots"[^]*?<span><\/span>/);
});
test('listed requests have a visible fallback while their details are pending',()=>{
 const status={...home,needs_you:[{kind:'approval',approvalId:'pending-request'}]};
 const vm=homePageVM({home:status,jobs:[],approvals:[],readiness:data.readiness,agents:[agent],now});
 assert.equal(vm.needs,1);assert.equal(vm.pendingRequests.length,1);
 const html=page({home:status});assert.match(html,/href="#\/request\/pending-request"/);assert.match(renderedText(html),/Request needs review/);
});
test('pending circles and agents cannot show a completed first-run state',()=>{
 const html=page({circles:undefined,agents:undefined,jobs:undefined,approvals:undefined,home:{lending:{},circles:[circle]}},{circles:[],agents:[],lending:{}});
 assert.doesNotMatch(renderedText(html),/Start a circle|Jobs you send show here|Nothing needs a decision/);
 assert.match(html,/aria-label="Loading jobs"/);
});
test('a returned job without local submission data still shows its recorded execution time',()=>{
 const returned={job_digest:'returned',role:'ran',status:'Finished',circle,historyIdentity:{localName:'Sam'},current_attempt:{execution_started_at:new Date(now-60000).toISOString()}};
 assert.equal(homePageVM({jobs:[returned],approvals:[],now,zone:'UTC'}).recent[0].when,'1 min ago');
 assert.equal(homePageVM({jobs:[{...returned,current_attempt:null}],approvals:[],now,zone:'UTC'}).recent[0].when,'Time unavailable');
});


test('ChatGPT requests stay in the shared attention queue during setup and link to local review',()=>{
 const id='12345678-1234-4234-8234-123456789012';
 const item={kind:'chatgpt_action',id,chatgptAction:id,label:'ChatGPT asks to change lending limits.',remedy:'Review it on this computer'};
 for(const isolationFailure of [undefined,'The sandbox could reach your home network. Resume lending.']) {
  const html=page({home:{...home,isolationFailure,needs_you:[item],attention:[item]}});
  assert.ok(html.includes('href="/connect/chatgpt?action='+id+'"'));
  assert.match(renderedText(html),/ChatGPT asks to change lending limits/);
 }
});

test('Home preview fallback uses the real file summary including additions and deletions',()=>{
 const vm=homePageVM({jobs:[job('one')],approvals:[],changes:{format:'diff',files:[{path:'one.js'}],diffstat:{files:1,insertions:1,deletions:1},diff:''},now});
 assert.equal(vm.preview.summary,'1 file changed, +1 −1');assert.deepEqual(vm.preview.lines,[]);
 assert.equal(homePageVM({jobs:[],approvals:[],changes:{diffstat:{files:0,insertions:0,deletions:0}}}).preview.summary,'0 files changed, +0 −0');
 assert.equal(homePageVM({jobs:[],approvals:[],changes:null}).preview.summary,'');
});

test('a signed receipt supplies the Home file summary before the changes download',()=>{
 const receipt={receipt:{candidate_format:'diff',diffstat:{files:1,insertions:1,deletions:1}}};
 const vm=homePageVM({jobs:[job('one')],approvals:[],changes:null,receipt,now});
 assert.equal(vm.preview.summary,'1 file changed, +1 −1');assert.deepEqual(vm.preview.lines,[]);
 assert.equal(homePageVM({jobs:[],receipt:{receipt:{candidate_format:'tree',diffstat:{files:1}}}}).preview.summary,'');
});


test('returned job titles and laptop glyphs agree across Home, Jobs and the job header',()=>{
 const returned={...job('returned'),local:undefined,role:'ran',title:'Fix the leap-year date test',
   agent:'claude-code-subscription',historyIdentity:{localName:'Sam'}};
 const identity=jobVM(returned);
 const row=jobsListVM([returned],{now,zone:'UTC'}).groups[0].rows[0];
 const recent=homePageVM({jobs:[returned],approvals:[],now,zone:'UTC'}).recent[0];
 assert.equal(row.title,identity.title);assert.equal(recent.title,identity.title);
 assert.equal(row.glyph,'laptop');assert.equal(recent.glyph,row.glyph);
 const homeHTML=page({jobs:[returned]});
 const jobsHTML=renderFixture(JobsList,{vm:jobsListVM([returned],{now,zone:'UTC'}),onFilter(){}});
 const headHTML=renderFixture(JobHead,{vm:{pill:{kind:identity.kind,word:identity.word}},title:identity.title});
 for(const html of [homeHTML,jobsHTML,headHTML])assert.ok(renderedText(html).includes(identity.title));
 for(const html of [homeHTML,jobsHTML])assert.match(html,/<use href="#laptop"/);
 assert.match(renderedText(jobsHTML),/Claude Code/);
 assert.doesNotMatch(renderedText(jobsHTML),/Any agent/);
});

test('Home-only Dismiss does not count a result or remove it from Jobs',()=>{
 const result={...job('dismiss-demo'),state:'result-accepted',result_digest:'synthetic-revision',format:'message'};
 const initial=homePageVM({jobs:[result],approvals:[],now,zone:'UTC'});
 assert.ok(initial.resultDismissalKey);
 const dismissedResults=new Set([initial.resultDismissalKey]);
 const dismissed=homePageVM({jobs:[result],approvals:[request('separate-request')],dismissedResults,now,zone:'UTC'});
 assert.equal(dismissed.result,null);
 assert.equal(dismissed.counts.results,0);
 assert.equal(dismissed.counts.requests,1);
 const jobsVM=jobsListVM([result],{now,zone:'UTC'});
 assert.deepEqual(jobsVM.groups[0].rows[0].attention,{label:'Review result',href:'#/job/dismiss-demo/c1'});
 const jobsHTML=renderFixture(JobsList,{vm:jobsVM,onFilter(){}});
 assert.match(jobsHTML,/href="#\/job\/dismiss-demo\/c1"/);
});

test('the Home result names the agent from its loaded receipt, as the Jobs page does',()=>{
 const jobs=[{...job('one'),lenderName:'sandpiper'}];
 assert.equal(homePageVM({jobs,approvals:[],now,zone:'UTC'}).result.who,'sandpiper');
 const vm=homePageVM({jobs,approvals:[],now,zone:'UTC',receipt:{receipt:{harness:'claude'}}});
 assert.equal(vm.result.who,'sandpiper’s Claude Code');
 assert.equal(vm.result.id,'one');
});

test('a fresh borrower sees the onboarding action without three empty job sections',()=>{
 const html=page({circles:[],agents:[],jobs:[],home:{lending:{enabled:false}},readiness:{ready:false,checks:[]}},{circles:[],agents:[],lending:{enabled:false}});
 const text=renderedText(html);assert.match(text,/Join with an invitation/);
 assert.doesNotMatch(text,/Nothing needs a decision right now|No jobs in motion|Finished jobs will appear here/);
});

test('Home result card says when the person lending stopped the job early',()=>{
 const attempt={attempt_id:'a1',generation:1,holder:'k',state:'completed',execution_started_at:new Date(now-120000).toISOString()};
 const stopped={...job('stopped'),role:'sent',state:'result-accepted',result_digest:'sha256:r1',current_attempt:attempt,lenderName:'Ana',
  stopRequest:{attempt_id:'a1',generation:1,job_digest:'stopped',requested_at:new Date(now-60000).toISOString()},payload:{source:{kind:'none'},result:{kind:'message'}}};
 const text=renderedText(page({jobs:[stopped]}));
 assert.match(text,/Ana stopped this job early\. This is the work done until then\./);
 assert.doesNotMatch(text,/Your answer is back/);
});

test('Home result card speaks of the output: a poem is read, not reviewed as changes or files (r8 O8)',()=>{
 const poem={...job('poem'),role:'sent',payload:{source:{kind:'none'},result:{kind:'message'}}};
 const vm=homePageVM({jobs:[poem],approvals:[],changes:{format:'message',message:{markdown:'Grey waves'},files:[]},now,zone:'UTC'});
 assert.equal(vm.resultKind,'message');assert.equal(vm.resultCopy.lead,'Your answer is back. Read it.');
 const html=page({jobs:[poem]}),text=renderedText(html);
 assert.match(text,/Your answer is back\. Read it\./);
 assert.doesNotMatch(text,/Review the changes|review its files|changes before you use/i);
 assert.match(text,/Read ›?|Read/);
 const git=homePageVM({jobs:[job('g')],approvals:[],changes:{format:'diff',files:[{path:'a.js'}],diff:'diff --git a/a.js b/a.js\n+x'},now});
 assert.equal(git.resultCopy.lead,'Your result is back. Review the changes before you use them.');
 const files=homePageVM({jobs:[job('f')],approvals:[],changes:{format:'files',files:[{path:'a.png'}]},now});
 assert.match(files.resultCopy.lead,/Your files are back/);
 assert.doesNotMatch(homePageVM({jobs:[job('u')],approvals:[],now}).resultCopy.lead,/changes/);
});

test('F1 Home summary separates off intent from stopping and running execution',()=>{
  for(const [intent,execution] of [['off','stopping'],['off','running'],['on','running'],['on','idle'],['unknown','unknown']]){
    const machine=withLendingProjection({...home,execution:{state:execution,job:'attempt-1',person:'Alex'}},
      {intent,intentState:intent==='on'?'ready':intent,admission:intent==='on'?'allowed':'blocked',admissionReason:intent==='off'?'off':null,execution,executionJob:'attempt-1'});
    const html=page({home:machine});
    const summary=renderedText(html.slice(html.indexOf('class="home-lending-line"'),html.indexOf('class="home-grid"')));
    if(intent==='off'){assert.match(summary,/Lending off/);assert.doesNotMatch(summary,/Lending on/);}
    if(execution==='stopping')assert.match(summary,/Job stopping/);
    if(intent==='on' && execution==='running')assert.match(summary,/Lending on.*Running/i);
    if(intent==='unknown')assert.doesNotMatch(summary,/Lending on/);
  }
});
test('F2 Home handoff preserves blank, pending and refused drafts and requires replacement consent',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
  const key=COMPOSE_DRAFT_PREFIX+'c1',saved={id:'draft-123456',prompt:'Keep this',sourceKind:'none'};
  const reset=extra=>values.set(key,JSON.stringify({...saved,...extra}));
  reset();assert.equal(handoffHomeDraft(storage,'c1','').state,'open');assert.equal(JSON.parse(values.get(key)).prompt,'Keep this');
  assert.deepEqual(handoffHomeDraft(storage,'c1','New text'),{state:'replace',raw:values.get(key),text:'Keep this',excerpt:'Keep this',editedAt:null});assert.equal(JSON.parse(values.get(key)).prompt,'Keep this');
  assert.equal(handoffHomeDraft(storage,'c1','New text',{replace:true}).state,'open');
  const {editedAt,...replaced}=JSON.parse(values.get(key));
  assert.deepEqual(replaced,{...saved,prompt:'New text',files:[],zip:null});
  assert.ok(Number.isFinite(editedAt),'replacing the text records when it changed');
  for(const [extra,state] of [[{sending:true},'pending'],[{agentRefusal:{label:'Busy',message:'Wait'}},'refused']]){
    reset(extra);const before=values.get(key);
    assert.equal(handoffHomeDraft(storage,'c1','New text',{replace:true}).state,state);
    assert.equal(values.get(key),before);
    // Opening the earlier request keeps the new text for Home instead of asking for a manual copy.
    values.delete(HOME_TEXT_KEY);
    assert.equal(handoffHomeDraft(storage,'c1','New text',{keep:true}).state,'open');
    assert.equal(values.get(key),before);assert.equal(values.get(HOME_TEXT_KEY),'New text');
    assert.equal(handoffHomeDraft(storage,'c1','',{keep:true}).state,'open');
    assert.equal(values.get(key),before);
  }
  // Isolate storage failure from refusal and replacement guards.
  reset({prompt:''});
  for(const broken of [{getItem(){throw Error('denied');},setItem(){}},{getItem:storage.getItem,setItem(){throw Error('quota');}},null]){
    assert.equal(handoffHomeDraft(broken,'c1','Retain me').state,'failed');
  }
  const source=readFileSync(new URL('./home.jsx',import.meta.url),'utf8');
  assert.match(source,/value=\{homePrompt\}/);
  assert.match(source,/if\(result.state==='open'\)/);
  assert.doesNotMatch(source,/suggestFirstTask\(/);
  assert.doesNotMatch(source,/api\.(post|put|send)\(/);
});
test('Home names the earlier draft by its first line and age, and opens it without asking when nothing would be lost',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const key=COMPOSE_DRAFT_PREFIX+'c1',editedAt=Date.parse('2026-10-20T04:55:00Z');
  const long='Fix the flaky login test that fails on CI when the session cookie expires mid-run and the retry loop spins\nSecond line';
  values.set(key,JSON.stringify({id:'draft-123456',prompt:long,editedAt}));
  const asked=handoffHomeDraft(storage,'c1','Eat fire');
  assert.equal(asked.state,'replace');
  assert.equal(asked.excerpt,draftExcerpt(long));
  assert.ok(asked.excerpt.length<=80 && asked.excerpt.endsWith('…') && !asked.excerpt.includes('Second line'));
  assert.equal(asked.editedAt,editedAt);
  assert.equal(homeHandoffCopy(asked,now),`You have an unsent request from earlier: “${asked.excerpt}” (edited 5 minutes ago).`);
  assert.equal(homeHandoffCopy({...asked,editedAt:null},now),`You have an unsent request from earlier: “${asked.excerpt}”.`,'old drafts without a time still read');
  for(const prompt of [long,'  '+long+'\n']){
    values.set(key,JSON.stringify({id:'draft-123456',prompt:long,editedAt}));
    assert.equal(handoffHomeDraft(storage,'c1',prompt).state,'open','same text opens without a question');
    assert.equal(JSON.parse(values.get(key)).prompt,long);
  }
  for(const blank of ['','   \n ']){
    values.set(key,JSON.stringify({id:'draft-123456',prompt:blank}));
    assert.equal(handoffHomeDraft(storage,'c1','Eat fire').state,'open','a blank draft opens without a question');
    assert.equal(JSON.parse(values.get(key)).prompt,'Eat fire');
  }
  values.set(key,JSON.stringify({id:'draft-123456',prompt:'Ship the parser',sending:true}));
  const pending=handoffHomeDraft(storage,'c1','Eat fire');
  assert.deepEqual(pending,{state:'pending',raw:values.get(key),text:'Ship the parser',excerpt:'Ship the parser',editedAt:null});
  assert.equal(homeHandoffCopy(pending),'Your earlier request “Ship the parser” may already have been sent. Check it before starting another.');
  values.set(key,JSON.stringify({id:'draft-123456',prompt:'Ship the parser',agentRefusal:{label:'Busy',message:'Wait'}}));
  const refused=handoffHomeDraft(storage,'c1','Eat fire');
  assert.equal(refused.state,'refused');
  assert.equal(homeHandoffCopy(refused),'Review your earlier request “Ship the parser” before replacing it. Its agent wasn’t available.');
  // Keeping fails closed to the copy fallback only when the new text cannot be stored.
  const full={getItem:storage.getItem,setItem:(k,v)=>{if(k===HOME_TEXT_KEY)throw Error('quota');values.set(k,v);},removeItem:storage.removeItem};
  values.set(key,JSON.stringify({id:'draft-123456',prompt:'Ship the parser'}));
  assert.equal(handoffHomeDraft(full,'c1','Eat fire',{keep:true}).state,'preserve');
  assert.equal(handoffHomeDraft(storage,'c1','Eat fire',{keep:true}).state,'open');
  assert.equal(readHomeText(storage),'Eat fire');
  assert.equal(JSON.parse(values.get(key)).prompt,'Ship the parser','the earlier draft is unchanged');
  for(const text of Object.values({pending,refused,asked}).map(r=>homeHandoffCopy(r,now)))assertNoBannedWords(text);
});
test('F3 cached computer status is labelled stale even beside approvals and results',()=>{
  for(const intent of ['on','off']){
    const machine=withLendingProjection({...home,execution:{state:'running',job:'attempt-1',person:'Alex'}},
      {intent,intentState:intent==='on'?'ready':'off',admission:intent==='on'?'allowed':'blocked',execution:'running',executionJob:'attempt-1'});
    const html=page({home:machine,approvals:[request('r1')],jobs:[job('done')]},{errors:{home:Error('offline')}});
    assertDomOrder(html,['Computer status is out of date','Check current state','class="home-lending-line"','aria-labelledby="home-needs"']);
    const summary=html.slice(html.indexOf('class="home-lending-line"'),html.indexOf('class="home-grid"'));
    assert.match(renderedText(summary),/Last known:/);
    assert.match(html,/Review computer status/);
    assert.match(renderedText(html),/Fix the parser/);
    assert.doesNotMatch(html,/class="card home-lending-card/);
  }
});
test('F4 computer activity recovery precedes routine history and suggestions',()=>{
  const machine=withLendingProjection({...home,execution:{state:'stopping',job:'attempt-1',person:'Alex'}},
    {intent:'off',intentState:'off',admission:'blocked',admissionReason:'off',execution:'stopping',executionJob:'attempt-1'});
  const html=page({home:machine,approvals:[request('r1')],jobs:Array.from({length:12},(_,i)=>job('done'+i))});
  assertDomOrder(html,['class="home-lending-line"','aria-labelledby="home-needs"','aria-labelledby="home-recent"']);
  assert.doesNotMatch(html,/home-execution|View computer activity/);
  // The stopping state shows once in the pill row and once in the This computer card, not in a third block.
  assert.match(renderedText(html.slice(html.indexOf('class="home-lending-line"'),html.indexOf('class="home-grid"'))),/Job stopping/);
  assert.match(renderedText(html.slice(html.indexOf('class="card home-lending-card'))),/Stop requested\. Confirmation is still pending\./);
});
test('F6 preview and receipt failure keep one result with an explicit manual retry',()=>{
  const vm=homePageVM({jobs:[job('done')],approvals:[],now,zone:'UTC'});
  const html=renderFixture(ResultCard,{vm,previewError:true,receiptError:true,retryPreview(){}});
  assert.match(renderedText(html),/Preview couldn’t be loaded\. Open the result to review it\./);
  assert.match(renderedText(html),/Run details couldn’t be loaded/);
  assert.match(renderedText(html),/Try preview again/);
  assert.equal((withoutMaskMarkers(html).match(/class="card result-card"/g)||[]).length,1);
  assert.ok(html.includes(vm.result.href));
  const source=readFileSync(new URL('./home.jsx',import.meta.url),'utf8');
  assert.match(source,/previewPath,signedPreview,previewAttempt/);
  assert.match(source,/setPreviewAttempt\(attempt=>attempt\+1\)/);
});

test('R4 approvals failure remains visible beside an actionable result',()=>{
  const html=page({jobs:[job('waiting-result')]},{errors:{approvals:Error('offline')}});
  assert.match(renderedText(html),/Requests could not be loaded/);
  assert.match(renderedText(html),/Try requests again/);
  assert.match(renderedText(html),/Fix the parser/);
  assert.match(html,/href="#\/job\/waiting-result\/c1"/);
});

test('Home retains saved job wording through lender overrides and recent history', async () => {
 const {jobProjectionFor} = await import('./job-projection-view.mjs');
 const saved = item => ({...item,jobProjection:qualifyJobProjection(jobProjectionFor(item),{state:'last_known'})});
 const running={...job('saved-run'),role:'ran',state:'running',historyIdentity:{author:'sam',personName:'Sam'},
   current_attempt:{attempt_id:'a1',generation:1,state:'active',holder:'sam',execution_started_at:'2026-10-20T04:00:00Z',execution_observed_at:'2026-10-20T04:30:00Z'}};
 const ready={...job('saved-result'),role:'ran',format:'message'};
 const jobs=[saved(running),saved(ready)];
 assert.equal(jobsListVM(jobs).groups.flatMap(group=>group.rows).find(row=>row.id==='saved-run').lastKnown,true);
 assert.equal(homePageVM({jobs}).recent.find(row=>row.id==='saved-result').word,'Last known: Sent back');
 const html=page({jobs});
 assert.match(renderedText(html),/Last known: Running for Sam/);
 assert.match(renderedText(html),/Last known: Sent back/);
 const failed=renderedText(page({jobs},{errors:{jobs:{code:'network'}}}));
 assert.doesNotMatch(failed,/Last known: Last known:/);
 assert.match(failed,/Last known: Sent back/);
});

test('Home request-level staleness qualifies featured, additional and recent results', () => {
 const jobs=[job('first'),job('second'),{...job('recent'),borrowerOutcome:{verdict:'used'}}];
 const text=renderedText(page({jobs},{errors:{jobs:{code:'network'}}}));
 assert.equal((text.match(/Last known: Ready to review/g)||[]).length,3);
});

test('saved or transitional execution never becomes current people presence', async () => {
 const {jobProjectionFor} = await import('./job-projection-view.mjs');
 const running={...job('saved-person'),state:'running',updated_at:'2026-10-20T04:30:00Z',
   current_attempt:{attempt_id:'a1',generation:1,state:'active',holder:'sam',execution_started_at:'2026-10-20T04:00:00Z',execution_observed_at:'2026-10-20T04:30:00Z'}};
 for(const state of ['last_known','transitional']){
   const jobs=[{...running,jobProjection:qualifyJobProjection(jobProjectionFor(running),{state})}];
   const people=homePeopleVM([{key_id:'sam',personName:'Sam',presence:{last_poll_at:'2026-10-20T04:00:00Z'}}],{jobs,circleId:circle.id,now,zone:'UTC'});
   assert.match(people[0].state,/Last active/);
   assert.doesNotMatch(people[0].state,/Running a job now/);
 }
});

test('an unconfirmed stop remains visible in Home motion and links to recovery', async () => {
 const {jobProjectionFor} = await import('./job-projection-view.mjs');
 const stopping={...job('unconfirmed'),state:'stop-requested',current_attempt:{attempt_id:'a1',generation:1,state:'active'}};
 const projection=jobProjectionFor(stopping);
 const unresolved={...stopping,jobProjection:{...projection,evidence:{...projection.evidence,stopVerification:'failed'}}};
 const vm=homePageVM({jobs:[unresolved]});
 assert.equal(vm.inMotion[0]?.key,'stop_unconfirmed');
 const html=page({jobs:[unresolved]});
 assert.match(renderedText(html),/Stop not confirmed/);
 assert.match(html,/href="#\/job\/unconfirmed\/c1"/);
 assert.doesNotMatch(renderedText(html),/No jobs in motion/);
});

test('Home grace separates unresolved stops without implying completion or losing the link', () => {
 const requested=now-15*60*1000;
 const asTime=ms=>new Date(ms).toISOString();
 const pending={...job('aged-stop'),state:'stop-requested',
   stopRequest:{job_digest:'aged-stop',attempt_id:'a1',generation:1,requested_at:asTime(requested)},
   current_attempt:{attempt_id:'a1',generation:1,state:'active',execution_started_at:asTime(requested-60000)}};
 const unchanged=structuredClone(pending);
 const vm=(entry,at=now)=>homePageVM({jobs:[entry],now:at,zone:'UTC'});
 assert.equal(vm(pending,now-1).inMotion[0]?.word,'Stop requested');
 const elapsed=vm(pending);
 assert.equal(elapsed.inMotion.length,0);
 assert.equal(elapsed.recent.length,0);
 assert.equal(elapsed.unresolvedStops[0]?.href,'#/job/aged-stop/c1');
 const {stopRequest,...withoutRequest}=pending;
 assert.equal(vm(withoutRequest).inMotion[0]?.key,'stop_requested');
 assert.equal(vm(withoutRequest).unresolvedStops.length,0);
 const stopped={...pending,state:'cancelled',current_attempt:{...pending.current_attempt,
   compute_stopped:true,stopped_at:asTime(now)}};
 assert.equal(vm(stopped).unresolvedStops.length,0);
 assert.equal(vm(stopped).recent[0]?.key,'stopped');
 const returned={...pending,state:'result-accepted',result_digest:'synthetic-result',format:'files'};
 assert.equal(vm(returned).unresolvedStops.length,0);
 assert.equal(vm(returned).result?.id,'aged-stop');
 const html=page({jobs:[pending,...Array.from({length:6},(_,i)=>({...job('done-'+i),state:'expired'}))]});
 assertDomOrder(html,['In motion','Unresolved stop requests','Recently finished']);
 const unresolved = html.slice(html.indexOf('Unresolved stop requests'), html.indexOf('Recently finished'));
 assertDomOrder(unresolved,['Lender did not confirm','href="#/job/aged-stop/c1"']);
 assert.deepEqual(pending,unchanged);
});

test('Faravan home-stop-stale release witness', async () => {
 const {jobProjectionFor} = await import('./job-projection-view.mjs');
 const old = now - 60 * 60 * 1000;
 const iso = value => new Date(value).toISOString();
 const make = (where, requestedAt) => ({...job('shared-stop'),circle:where,state:'stop-requested',
   stopRequest:{job_digest:'shared-stop',attempt_id:'a1',generation:1,requested_at:iso(requestedAt)},
   current_attempt:{attempt_id:'a1',generation:1,state:'active',execution_started_at:iso(old-60000)}});
 const original = make(circle,old);
 const saved = {...original,jobProjection:qualifyJobProjection(jobProjectionFor(original),{state:'last_known'})};
 const other = make({...circle,id:'c2',name:'Other circle'},now-60000);
 const vm = jobs => homePageVM({jobs,now,zone:'UTC'});
 for (const jobs of [[saved,other],[other,saved]]) {
   const home = vm(jobs);
   assert.deepEqual(home.unresolvedStops.map(row=>row.href),['#/job/shared-stop/c1']);
   assert.equal(home.unresolvedStops[0]?.word,'Last known: Stop requested');
   assert.equal(home.unresolvedStops[0]?.lastKnown,true);
   assert.deepEqual(home.inMotion.map(row=>row.href),['#/job/shared-stop/c2']);
   assert.equal(home.inMotion[0]?.word,'Stop requested');
   assert.deepEqual(home.recent,[]);
 }
 const confirmed = {...original,state:'cancelled',current_attempt:{...original.current_attempt,
   compute_stopped:true,stopped_at:iso(now)}};
 const settled = vm([confirmed,other]);
 assert.deepEqual(settled.unresolvedStops,[]);
 assert.deepEqual(settled.inMotion.map(row=>row.href),['#/job/shared-stop/c2']);
 assert.deepEqual(settled.recent.map(row=>[row.href,row.key,row.lastKnown]),
   [['#/job/shared-stop/c1','stopped',false]]);
});

test('first-run invitation entry does not depend on home, agents or approvals loading', () => {
 const base={home:{lending:{enabled:false}},circles:[],jobs:[],agents:[],approvals:[]};
 for(const missing of ['home','agents','approvals']){
   const html=page({...base,[missing]:undefined},{circles:[],agents:[],lending:{enabled:false},errors:{[missing]:{code:'network'}}});
   assert.match(renderedText(html),/Join with an invitation/);
   assert.match(renderedText(html),/Set up lending/);
 }
});

test('uncertain membership or job history has local recovery without inventing a fresh user', () => {
 const base={home:{lending:{enabled:false}},circles:[],jobs:[],agents:[],approvals:[]};
 for(const missing of ['circles','jobs']){
   const html=page({...base,[missing]:undefined},{circles:[],agents:[],lending:{enabled:false},errors:{[missing]:{code:'network'}}});
   assert.match(renderedText(html),missing==='circles'?/Circle membership could not be loaded/:/Jobs could not be loaded/);
   assert.match(renderedText(html),missing==='circles'?/Try circle membership again/:/Try jobs again/);
   if(missing==='circles')assert.match(html,/href="#\/circles"/);
   assert.doesNotMatch(renderedText(html),/Get help from people you trust/);
 }
 const pending=page({...base,jobs:undefined},{circles:[],agents:[],lending:{enabled:false}});
 assert.match(renderedText(pending),/Checking job history/);
});

test('approved borrowers get an optional lending handoff without enabling lending', () => {
 const member={...circle,owned:false,enrollment:{state:'approved'},rosterMembershipVerified:true};
 const html=page({home:{lending:{enabled:false}},circles:[member],jobs:[],agents:[],approvals:[]},{circles:[member],agents:[],lending:{enabled:false}});
 assert.match(html,/href="#\/setup">Set up lending/);
 assert.match(renderedText(html),/Joining does not turn lending on/);
 assert.match(renderedText(html),/New job/);
});

test('P1 draft rescue copies the exact draft and handles unavailable or rejected clipboard access', async()=>{
  const text='Keep this request\nIncluding this line.';
  const writes=[];
  assert.equal(await copyHomeDraft(text,{writeText:async value=>writes.push(value)}),'copied');
  assert.deepEqual(writes,[text]);
  assert.equal(await copyHomeDraft(text,null),'failed');
  assert.equal(await copyHomeDraft(text,{writeText(){throw Error('denied');}}),'failed');
  assert.equal(await copyHomeDraft(text,{writeText:async()=>{throw Error('denied');}}),'failed');
  const control=renderFixture(HomeDraftCopy,{text});
  assert.match(renderedText(control),/Copy request text/);
  const fallback=renderFixture(DraftCopyFeedback,{state:'failed',text});
  assert.match(renderedText(fallback),/Copy failed\. Select and copy the text below before leaving/);
  assert.match(fallback,/aria-label="Request text to copy"/);
  assert.match(fallback,/readonly/i);
  assert.ok(fallback.includes(text),'manual-copy fallback preserves the exact draft');
  assert.doesNotMatch(renderedText(fallback),/Copied to clipboard/);
  assert.match(renderedText(renderFixture(DraftCopyFeedback,{state:'copied',text})),/Copied to clipboard/);
  const source=readFileSync(new URL('./home.jsx',import.meta.url),'utf8');
  assert.ok(source.includes("['preserve','failed'].includes(handoff.state) && <HomeDraftCopy"));
  assert.ok(source.includes('text={handoffPrompt??homePrompt}'),'suggested text being rescued is not replaced with the previous input');
  assert.ok(source.includes('setState(await copyHomeDraft(text))'));
  assert.ok(source.includes('onClick={copy}'));
  assert.ok(source.includes('event.currentTarget.select()'));
});

test('a job whose status cannot be read stays visible in Home motion', () => {
 const lost={...job('lost','Mystery state'),role:'sent'};
 const vm=homePageVM({jobs:[lost],now});
 assert.equal(jobsListVM([lost],{now}).groups.flatMap(g=>g.rows)[0].key,'unknown','fixture has an unreadable status');
 assert.deepEqual(vm.inMotion.map(r=>r.id),['lost']);
 assert.deepEqual(vm.recent.map(r=>r.id),[]);
 const html=page({jobs:[lost]});
 assert.match(html,/href="#\/job\/lost\/c1"/);
 assert.doesNotMatch(renderedText(html),/No jobs in motion/);
});

test('empty Home composer offers a new job',()=>{
 const out=page();
 assert.match(out,/<button[^>]*type="submit"[^>]*>New job/);
});

test('Home offers the automatic lending choice with both answers and dismissal',()=>{
 const html=page({home:{...home,lendingPrompts:[{circle:'c1',name:'Weekend projects'}]},devices:{...data.devices,circles:[{circle:'c1',members:[{key_id:'own'},{key_id:'sam'}]}]}});
 const text=renderedText(html);
 for(const line of ['Lend to Weekend projects automatically?','Let jobs from Weekend projects use your Codex on this computer and your subscription allowance.','While Automatic is on, Faravan renews permission when it confirms who’s in the circle. If it can’t confirm anyone for 30 days, lending automatically to this circle stops.','Daily caps across all circles: 3 jobs; 60 minutes a day. Other limits still apply.','Keep asking requires approval until you change it. Not now shows this card next launch.','Lend automatically','Keep asking','Not now'])assert.ok(text.includes(line),line);
 assert.match(html, /href="#\/lend\/limits"[^>]*>Review limits<\/a>/);
 assert.match(html, /href="#\/lend\/limits"[^>]*>Lending settings<\/a>/);
 assertNoBannedWords(html);
});

test('automatic lending card reads current saved limits and names its circle',()=>{
 const html=page({home:{...home,lending:{...lending,limits:{...lending.limits,dailyJobs:7,dailyMinutes:95}},lendingPrompts:[{circle:'c2',name:'Study group'}]},devices:{...data.devices,circles:[{circle:'c1',members:[{},{}]},{circle:'c2',members:[{}]}]}});
 assert.match(renderedText(html),/Let jobs from Study group use your Codex/);
 assert.match(renderedText(html),/7 jobs; 95 minutes a day/);
});

test('automatic lending card does not turn uncapped or unavailable limits into numbers',()=>{
 for(const limits of [{dailyJobs:null,dailyMinutes:null},{}]){
  const html=page({home:{...home,lending:{...lending,limits},lendingPrompts:[{circle:'c1',name:'Weekend projects'}]}});
  const text=renderedText(html);
  assert.ok(text.includes(limits.dailyJobs===null?'No daily job cap':'Daily job limit unavailable'));
  assert.ok(text.includes(limits.dailyMinutes===null?'no daily minute cap':'daily minute limit unavailable'));
  assert.doesNotMatch(text,/undefined|null|0 members/);
 }
});

test('automatic lending card names only the agents chosen for lending',()=>{
 const html=page({home:{...home,lendingPrompts:[{circle:'c1',name:'Weekend projects'}]}},{agents:[{id:'claude-code-subscription',useForLending:true},{id:'codex',useForLending:false}]});
 assert.match(renderedText(html),/use your Claude Code on this computer/);
 assert.doesNotMatch(renderedText(html),/use your Codex/);
});

test('Home ignores legacy transition fields for four circles while retaining real attention and consent', () => {
 const circles=Array.from({length:4},(_,i)=>({...circle,id:'c'+(i+1),name:'Circle '+(i+1)}));
 const hostile='<img src=x onerror=alert(1)><script>alert(2)</script>';
 circles[3].name=hostile;
 const automaticNotices=circles.map((c,i)=>({circle:c.id,name:c.name,kind:i%2?'automatic_blocked':'automatic',dismissed:false}));
 for(const presenceNotice of [{kind:'pair',idleOnly:true,stopOnReturn:true},{kind:'unmarked',fields:['idleOnly','stopOnReturn']}]){
  const legacy={...home,lending:{...lending,configVersion:7,presenceNotice},automaticNotices,lendingPrompts:[{circle:'c1',name:'Circle 1'}]};
  const before=JSON.stringify(legacy),mutations=[];
  const html=page({home:legacy,circles,approvals:[request('live-request')]},{circles,mutate:async(...args)=>{mutations.push(args);return {};}});
  const text=renderedText(html);
  assert.doesNotMatch(text,/Use the new default|Keep current settings|Automatic is now|could not set .* to Automatic|Turn both back on|Turn waiting back on|Turn stopping on return back on/);
  assert.doesNotMatch(html,/<img src=x|<script/);
  assert.match(text,/Needs your attention.*Sam asked to use your computer/);
  assert.match(html,/href="#\/request\/live-request"/);
  assert.match(text,/Lend to Circle 1 automatically\?/);
  assert.match(text,/Lend automatically.*Keep asking/);
  assert.match(html,/href="#\/lend\/limits"/);
  assert.deepEqual(mutations,[]);
  assert.equal(JSON.stringify(legacy),before,'rendering must not change saved settings or legacy evidence');
 }
});

test('reserve copy dates a future reset and suppresses an elapsed check', () => {
 const now=Date.parse('2026-11-21T18:16:00Z');
 const reset=Date.parse('2026-11-26T15:38:55Z');
 const availability={admitted:false,reason:'owner_reserve',wait:{accountKey:'codex',reason:'owner_reserve',
  strategyId:null,source:'window_reset',nextEvaluationAtMs:reset}};
 const account={provider:'codex',decision:{availability}};
 assert.match(currentCapacityWait(account,{now}).line,/Nov 26/);
 availability.wait.nextEvaluationAtMs=now-1;
 assert.equal(currentCapacityWait(account,{now}).state,'expired');
 assert.doesNotMatch(currentCapacityWait(account,{now}).line,/9:38/);
});
test('Home shows an automatic offer waiting for the owner reserve under In motion', () => {
 const at=Date.now();
 const pending={id:'queued-proof',circle:circle.id,agent:'claude-code-subscription',reason:'quota_reserve',expiresAt:at+600000};
 const decision={admitted:false,reason:'owner_reserve',wait:{accountKey:'claude',reason:'owner_reserve',
  strategyId:null,source:'window_reset',nextEvaluationAtMs:at+300000}};
 const snapshot={...home,activeCircle:circle.id,lending:{...lending,mode:'auto',heldOffers:[pending]},
  lendingPolicy:{accounts:[{provider:'claude',decision:{availability:decision}}]}};
 const html=page({home:snapshot});
 assertDomOrder(html,['In motion','Teammate request · Claude Code','Waiting','Recently finished']);
 assert.match(renderedText(html),/kept for you\. It resets at/);
 decision.wait.nextEvaluationAtMs=at+900000;
 assert.match(renderedText(page({home:snapshot})),/may expire before allowance becomes available/);
 assert.doesNotMatch(renderedText(html),/No jobs in motion/);
 assert.match(renderedText(html),/Nothing needs a decision right now/);
});
