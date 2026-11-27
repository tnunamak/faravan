import {problemView} from './problem-catalog.mjs';
const SESSION_LOST_TEXT=problemView({code:'unauthorized'},{surface:'desktop',capabilities:{localApp:true}}).detail;
import {borrowRequestBody, validateBorrowDraft} from './helpers.mjs';
const borrowerDraft = {
  prompt: 'Fix the bug', title: '  Small fix  ', kind: 'repository',
  git: 'https://example.test/team/project.git', commit: 'a'.repeat(40),
  files: [], agent: '', model: '',
};
const borrowerCircle = {origin: 'https://circle.example.test'};
test('borrower defaults validate without an installed agent or chosen model', () => {
  assert.equal(validateBorrowDraft(borrowerDraft, 'friends', borrowerCircle), '');
  assert.equal(validateBorrowDraft({...borrowerDraft, specificAgent: true, agent: 'codex'}, 'friends', borrowerCircle), '');
  assert.equal(validateBorrowDraft({...borrowerDraft, kind: 'files', files: [{name: 'a.txt', size: 1}]}, 'friends', borrowerCircle), '');
});
test('recommended borrower request omits agent and model even with local defaults', () => {
  const source = {git: {url: borrowerDraft.git, commit: borrowerDraft.commit}};
  for (const draft of [borrowerDraft, {...borrowerDraft, agent: 'codex', model: 'local-model'},
    {...borrowerDraft, specificAgent: false, agent: 'codex', model: 'local-model'}]) {
    const body = borrowRequestBody(draft, 'friends', source);
    assert.deepEqual(body, {circle: 'friends', prompt: draft.prompt, title: 'Small fix', egress: JOB_EGRESS, ...source});
    assert.equal(Object.hasOwn(body, 'harness'), false);
    assert.equal(Object.hasOwn(body, 'model'), false);
  }
});
test('explicit borrower choices preserve the previous named and any-model request bodies', () => {
  const sources = [{git: {url: borrowerDraft.git, commit: borrowerDraft.commit}},
    {files: [{path: 'a.txt', base64: 'YQ=='}]}];
  for (const source of sources) for (const model of ['named-model', 'any']) {
    const draft = {...borrowerDraft, specificAgent: true, agent: 'codex', model};
    const previousBody = {circle: 'friends', prompt: draft.prompt, title: 'Small fix',
      harness: draft.agent, ...(model === 'any' ? {} : {model}), egress: JOB_EGRESS, ...source};
    assert.deepEqual(borrowRequestBody(draft, 'friends', source), previousBody);
  }
  const defaultModel = borrowRequestBody({...borrowerDraft, specificAgent: true, agent: 'codex', title: '  '}, 'friends', sources[0]);
  assert.equal(defaultModel.harness, 'codex');
  assert.equal(Object.hasOwn(defaultModel, 'model'), false);
  assert.equal(Object.hasOwn(defaultModel, 'title'), false);
});
test('borrower validation still checks prompt, circle, source and files', () => {
  assert.match(validateBorrowDraft({...borrowerDraft, prompt: ' '}, 'friends', borrowerCircle), /Describe/);
  assert.match(validateBorrowDraft(borrowerDraft, '', borrowerCircle), /Choose a circle/);
  assert.match(validateBorrowDraft(borrowerDraft, 'friends', {}), /Start a circle on this computer/);
  for (const git of ['invalid', 'http://example.test/repo', 'https://name:password@example.test/repo',
    'https://example.test/repo?token=value', 'https://example.test/repo#main']) {
    assert.match(validateBorrowDraft({...borrowerDraft, git}, 'friends', borrowerCircle), /HTTPS/);
  }
  assert.match(validateBorrowDraft({...borrowerDraft, commit: 'main'}, 'friends', borrowerCircle), /40-character/);
  assert.match(validateBorrowDraft({...borrowerDraft, kind: 'files'}, 'friends', borrowerCircle), /Choose files/);
  assert.match(validateBorrowDraft({...borrowerDraft, kind: 'files', files: [{name: 'a'}, {name: 'a'}]}, 'friends', borrowerCircle), /Two files/);
});
import test from 'node:test';
import {createActionGate, decisionTime, waitingJobLine, ALLOWANCE_FRESH_MS} from './helpers.mjs';
test('one-shot Action stays disabled after success and ignores repeated clicks',()=>{
  const gate=createActionGate();let calls=0;
  const click=()=>{if(gate.start(false,true))calls++;};
  click();click();
  assert.equal(calls,1,'in-flight click is ignored synchronously');
  assert.equal(gate.blocked(false,true),true);
  gate.succeed();gate.finish();
  assert.equal(gate.blocked(false,true),true,'success stays disabled while the old card remains');
  click();assert.equal(calls,1,'successful repeat sends nothing');
  assert.equal(createActionGate().start(false,true),true,'a refreshed new card has a fresh guard');
});
test('one-shot Action permits retry after failure and honors explicit disabling',()=>{
  const gate=createActionGate();
  assert.equal(gate.start(true,true),false);
  assert.equal(gate.start(false,true),true);
  gate.finish();
  assert.equal(gate.blocked(false,true),false);
  assert.equal(gate.start(false,true),true,'a failed request may be retried');
  gate.succeed();gate.finish();
  assert.equal(gate.start(false,true),false);
});
test('ordinary Actions remain repeatable after success',()=>{
  const gate=createActionGate();
  assert.equal(gate.start(),true);
  gate.succeed();gate.finish();
  assert.equal(gate.blocked(),false);
  assert.equal(gate.start(),true);
});
import assert from 'node:assert/strict';
import {jobIdentityHistory,takeSession,statusView,STATUS_KEYS,iconState,errorMessage,reviewCard,fileProblem,excludedFile,routeFromHash,ROUTES,jobsEmptyState,lendingView,lendingBadge,lendingBadgeText,NAV_ITEMS,navCurrent,jobsListPath,LAN_WARNING,joinPreviewView,createJoinReview,JOB_EGRESS,EGRESS_NOTICE,excludedNotice,jobFacts,waitingLine,enrollmentView,joinStatusView,diffLines,changeSummary,safeName,formatTime,formatBytes,protectionView,agentProduct,agentGroups,todayUse,homePlan,allowanceLine,localNameOf,memberIdentity,circleMembers} from './helpers.mjs';
import {savePetname,deletePetname} from './api.mjs';
import {JOB_DEFAULTS} from '../../../lib/v1/cli.mjs';
test('allowance shows fresh age and exact reset time in the lender zone',()=>{
  const now=Date.parse('2026-10-13T12:00:00Z');
  const value={provider:'claude',remaining:71,observedAt:now-120000,resetsAt:Date.parse('2026-10-15T06:00:00Z')};
  const utc=allowanceLine(value,{now,timeZone:'UTC'});
  assert.equal(utc,'Claude weekly allowance: 71% remaining. Read 2 minutes ago. Resets at Oct 15, 2026, 06:00:00 AM UTC.');
  assert.match(allowanceLine(value,{now,timeZone:'America/Los_Angeles'}),/Oct 14, 2026, 11:00:00 PM PDT/);
  assert.match(allowanceLine({...value,remaining:70.6},{now}),/71%/);
  for(const remaining of [0,100])assert.match(allowanceLine({...value,remaining},{now}),new RegExp(remaining+'%'));
  assert.match(allowanceLine({...value,observedAt:now},{now}),/Read less than a minute ago/);
  assert.doesNotMatch(allowanceLine({...value,observedAt:now-ALLOWANCE_FRESH_MS+1},{now}),/out of date/);
});
test('stale and passed-reset allowance amounts are clearly historical',()=>{
  const now=Date.parse('2026-10-13T12:00:00Z'),value={provider:'claude',remaining:71,observedAt:now-10800000,resetsAt:now+86400000};
  const stale=allowanceLine(value,{now,timeZone:'UTC'});
  assert.match(stale,/71% remaining at last read\. Last read 3 hours ago; may be out of date\./);
  assert.match(stale,/Recorded reset time:/);
  assert.match(allowanceLine({...value,observedAt:now-ALLOWANCE_FRESH_MS},{now}),/out of date/);
  assert.match(allowanceLine({...value,observedAt:now-60000,resetsAt:now},{now}),/out of date/);
  assert.doesNotMatch(stale,/unused|available now/);
});
test('unknown, malformed and future allowance readings do not present current capacity',()=>{
  const now=Date.parse('2026-10-13T12:00:00Z');
  const value={provider:'claude',remaining:71,observedAt:now-1000,resetsAt:now+86400000};
  for(const invalid of [null,undefined,{}, {...value,provider:'other'},{...value,remaining:NaN},
    {...value,remaining:-1},{...value,remaining:101},{...value,resetsAt:NaN},{...value,resetsAt:1e20},
    {...value,observedAt:undefined},{...value,observedAt:NaN},{...value,resetsAt:now-2000}])
    assert.equal(allowanceLine(invalid,{now}),'Allowance unknown.');
  const future=allowanceLine({...value,observedAt:now+1},{now});
  assert.equal(future,'Allowance unknown. The reading is dated in the future.');
  assert.doesNotMatch(future,/%|ago/);
  assert.equal(allowanceLine(value,{now,timeZone:'invalid-zone'}),'Allowance unknown.');
});
test('waiting jobs show elapsed waiting and exact expiry without a start promise',()=>{
  const now=Date.parse('2026-10-13T12:00:00Z');
  const job={state:'queued',waitingTiming:{submittedAt:'2026-10-13T11:58:00Z',expiresAt:'2026-10-13T13:00:00Z'}};
  assert.equal(waitingJobLine(job,{now,timeZone:'UTC'}),
    'Waiting for a lender. Expires at Oct 13, 2026, 01:00:00 PM UTC. Waiting for 2 minutes.');
  assert.match(waitingJobLine({...job,waitingTiming:undefined,created_at:job.waitingTiming.submittedAt,expires_at:job.waitingTiming.expiresAt},{now}),/Waiting for 2 minutes/);
  assert.doesNotMatch(waitingJobLine(job,{now}),/online|start by|available now/);
  assert.match(waitingJobLine({...job,waitingTiming:{...job.waitingTiming,submittedAt:now+1000}},{now}),/Waiting time unknown/);
  assert.equal(waitingJobLine({}, {now}),'Waiting for a lender. Expiry time unknown. Waiting time unknown.');
});
test('expiry boundary stops elapsed waiting and expired jobs never promise a lender',()=>{
  const now=Date.parse('2026-10-13T12:00:00Z');
  const job={state:'queued',waitingTiming:{submittedAt:now-120000,expiresAt:now}};
  assert.match(waitingJobLine(job,{now:now+3600000,timeZone:'UTC'}),/^Waiting for a lender\./,
    'the UI clock does not promote a still-waiting server projection to expired');
  const expired={...job,state:'expired'};
  const line=waitingJobLine(expired,{now:now+3600000,timeZone:'UTC'});
  assert.equal(line,'Expired at Oct 13, 2026, 12:00:00 PM UTC. Waited 2 minutes.');
  assert.doesNotMatch(line,/Waiting for a lender/);
  assert.match(waitingJobLine({...job,state:'expired',waitingTiming:null},{now}),/^Job expired\. Expiry time unknown/);
  assert.equal(decisionTime(null), '');
  assert.equal(decisionTime(1e20), '');
});
test('takeSession strips the token from the address bar and returns nothing',()=>{
  const calls=[],history={state:{safe:true},replaceState:(...args)=>calls.push(args)};
  assert.equal(takeSession({href:'http://127.0.0.1:8/?token=secret&view=jobs#jobs'},history),undefined);
  assert.deepEqual(calls,[[{safe:true},'','/?view=jobs#jobs']]);
  takeSession({href:'http://127.0.0.1/?token=one&token=two#/'},history);
  assert.equal(calls.at(-1)[2],'/#/');
  takeSession({href:'http://127.0.0.1/#token=three'},history);
  assert.equal(calls.at(-1)[2],'/');
  assert.equal(calls.length,3);
  takeSession({href:'http://127.0.0.1/#/'},history);
  assert.equal(calls.length,3,'no token means no address-bar rewrite');
});
test('takeSession never reads or writes storage, so a stale link cannot sign a tab in',()=>{
  const touched=[];const storage=new Proxy({},{get:(_,key)=>{touched.push(key);throw new Error('storage touched');}});
  const history={state:null,replaceState(){}};
  assert.doesNotThrow(()=>takeSession({href:'http://127.0.0.1:8/?token=first#/jobs'},history,storage));
  assert.doesNotThrow(()=>takeSession({href:'http://127.0.0.1:8/#/jobs'},history,storage));
  assert.deepEqual(touched,[]);
});
test('closed status vocabulary gives a remedy, never title-cases unknown wire states',()=>{
  for(const key of STATUS_KEYS){const value=statusView(key);assert.ok(value.label);assert.ok(value.remedy);assert.ok(value.message);}
  assert.equal(statusView('unrecognized_internal_error').label,'Status unavailable');
  assert.equal(statusView('settled').label,'Finished');
  assert.equal(statusView('running',{executionProof:false}).label,'Starting');
  assert.equal(statusView('cancelled').label,'Stop requested');
  assert.equal(statusView('cancelled',{computeStopped:false}).label,'Stop requested');
  assert.equal(statusView('cancelled',{computeStopped:true}).label,'Cancelled');
  assert.equal(statusView('cancelled',{neverStarted:true}).label,'Cancelled');
  assert.equal(statusView('cancelled',{neverStarted:true}).remedy,'Open the job');
  assert.equal(statusView('stopped_by_lender').remedy,'Open the job');
  assert.doesNotMatch(statusView('expired').message,/before it could start/);
  assert.equal(statusView('idle',{enabled:false}).label,'Lending off');
  assert.equal(statusView('Finished').label,'Finished');
});
test('stopped and finished job statuses use plain copy',()=>{
  assert.equal(statusView('returned').label,'Run stopped');
  for(const facts of [{computeStopped:true},{neverStarted:true}])
    assert.equal(statusView('cancelled',facts).message,'No more work will run for this job.');
  for(const state of ['settled','finished','result-accepted'])
    assert.equal(statusView(state).remedy,'View job details');
  assert.equal(statusView('cancelled').label,'Stop requested',
    'unconfirmed cancellation still waits for proof');
});
test('exactly three icon labels, separate expected pauses from attention',()=>{
  const values=new Set([iconState({enabled:false}),iconState({enabled:true,status:'idle'}),iconState({enabled:true,reason:'quota_unknown'})]);
  assert.deepEqual([...values].sort(),['Lending on','Needs attention','Off'].sort());
  assert.equal(iconState({enabled:true,reason:'daily_limit'}),'Paused');
  assert.equal(iconState({enabled:true,reason:'quota_reserve'}),'Paused');
  assert.equal(iconState({enabled:true,paused:true,circle:'friends'}),'Paused');
  for(const reason of ['policy_unenforceable','readiness_changed','lease_expired','unknown'])assert.equal(iconState({enabled:true,reason}),'Needs attention');
  assert.equal(iconState({enabled:true,reason:'user_active'}),'Lending on');
  assert.equal(iconState({enabled:true,reason:'daily_limit',label:'Cap'},[{label:'Cap'}]),'Paused');
});
test('review binds account to selected agent and never guesses protection',()=>{
  const card={requester:'member',prompt:'Full prompt',source:{kind:'archive',size_bytes:512},harness:'codex',model:['named'],runtimeSeconds:1200,network:'provider-only',credentialInGuest:true};
  const view=reviewCard(card,[{id:'other',account:'Wrong account'},{id:'codex',name:'Codex',account:'Correct account'}]);
  assert.equal(view.account,'Correct account');assert.equal(view.minutes,'20 minutes');assert.equal(view.credentialInGuest,true);
  assert.equal(view.protectionVerified,false);assert.equal(view.complete,true);
  assert.equal(reviewCard({...card,network:undefined}).complete,false);
  assert.equal(reviewCard({...card,requester:null}).complete,false);
  assert.equal(reviewCard({...card,prompt:''}).complete,false);
  // An unknown account is omitted, never printed as "Account not reported".
  assert.equal(reviewCard(card,[{id:'other',account:'Wrong account'}]).account,'');
  assert.equal(view.agent,'Codex');
  assert.equal(reviewCard({...card,model:[]}).model,'Any model');
  assert.equal(reviewCard({...card,runtimeSeconds:undefined}).minutes,'');
});
test('errors cannot leak backend messages, paths, invite secrets or wire codes',()=>{
  assert.equal(errorMessage({code:'unauthorized'}, {surface:'desktop',capabilities:{localApp:true}}),SESSION_LOST_TEXT,'a 401 names no cause it cannot know');
  assert.equal(errorMessage({code:'unknown',message:'SECRET /home/private'}),'Faravan could not confirm what happened. Check the current state before taking another action.');
  assert.match(errorMessage({code:'sandbox_not_ready'}),/protected workspace/);
});
test('files retain paths, detect collisions and exclude likely secrets',()=>{
  assert.match(fileProblem([{name:'a.txt'},{name:'a.txt'}]),/Two files/);
  assert.ok(fileProblem([{name:'../secret'}]));assert.ok(fileProblem([{name:'C:\\secret'}]));
  assert.equal(fileProblem([{webkitRelativePath:'project/a.txt'},{name:'b.txt'}]),'');
  for(const name of ['.env','.env.local','nested/id_rsa','node_modules/lib/a.js','dist/source.js','private.pem'])assert.equal(excludedFile(name),true,name);
  for(const name of ['src/main.js','.env.example']) assert.equal(excludedFile(name),false,name);
});
test('routes support durable job links and malformed input safely',()=>{
  assert.deepEqual(routeFromHash('#/job/sha256%3Aabc'),{page:'job',id:'sha256:abc'});
  assert.equal(routeFromHash('#/job/%XX').page,'not-found');
});

test('every screen resolves directly, including new-job aliases and encoded detail links',()=>{
  for(const page of Object.keys(ROUTES).filter(name=>!['limits','person'].includes(name))) {
    const id=['job','circle','request','signin'].includes(page)?'device name':null;
    assert.deepEqual(routeFromHash('#/'+page+(id?'/'+encodeURIComponent(id):'')),{page,id});
  }
  assert.deepEqual(routeFromHash('#/person/a/Weekend%20projects'),{page:'person',id:'a',circle:'Weekend projects'});
  for(const route of ['#/jobs/new','#jobs/new','#/new-job','#/borrow','#/new'])assert.deepEqual(routeFromHash(route),{page:'borrow',id:null});
  assert.deepEqual(routeFromHash('#/lending'),{page:'lend',id:null});
  assert.deepEqual(routeFromHash('#/you'),{page:'settings',id:null});
  assert.deepEqual(routeFromHash('#/you/notifications'),{page:'settings',id:'notifications'});
  assert.deepEqual(routeFromHash('#/setup/details'),{page:'setup',id:'details'});
  assert.equal(routeFromHash('#/you/missing').page,'not-found');
  assert.deepEqual(routeFromHash('#/job/sha256%3Aabc/My%20devices'),{page:'job',id:'sha256:abc',circle:'My devices'});
  assert.deepEqual(routeFromHash(''),{page:'home',id:null});
  assert.deepEqual(routeFromHash('#/lend/limits'),{page:'limits',id:null});
  assert.equal(navCurrent('limits'),'lend');
  for(const route of ['#/request','#/request/a/b','#/limits','#/lend/other','#/lend/limits/x','#/missing','#/job','#/circle','#/home/extra','#/jobs/new/extra','#/job/%XX','#/job/id/%XX'])assert.equal(routeFromHash(route).page,'not-found',route);
});
test('offline and origin-required jobs map to borrower remedy without requesting the offline service',()=>{
  const offline={id:'mine',origin:null};
  assert.equal(jobsListPath([offline]),null);
  assert.equal(jobsListPath([]),null);
  assert.equal(jobsListPath(),null);
  assert.equal(jobsListPath([offline,{id:'b',origin:'https://example.test'}]),'jobs');
  const expected={message:'Start a circle or join with an invitation to send your first job.',action:'Go to Circles',page:'circles'};
  assert.deepEqual(jobsEmptyState(offline),expected);
  assert.deepEqual(jobsEmptyState({origin:'https://example.test'},{code:'origin_required',status:409}),expected);
  assert.equal(jobsEmptyState(undefined),null);
  assert.equal(jobsEmptyState({origin:'https://example.test'},{code:'unauthorized'}),null);
  assert.equal(jobsEmptyState({origin:'https://example.test'},{code:'network'}),null);
});
test('the shell has its destinations in order (Setup last), and detail pages highlight their parent',()=>{
  assert.deepEqual(NAV_ITEMS.map(item=>[item.page,item.label,item.icon]),
    [['home','Home','home'],['jobs','Jobs','jobs'],['lend','Lending','lend'],['circles','Circles','circles'],['setup','Setup','check-circle']]);
  assert.equal(ROUTES.lend,'Lending');
  for(const [page,current] of [['home','home'],['jobs','jobs'],['lend','lend'],['circles','circles'],
    ['job','jobs'],['circle','circles'],['borrow','jobs'],['settings',null],['activity',null],['devices',null],['trust',null],['not-found',null]])
    assert.equal(navCurrent(page),current,page);
});
test('lending is reachable from the heading badge text',()=>{
  assert.equal(lendingBadgeText('Off'),'Lending: Off');
  assert.equal(lendingBadgeText('Needs attention'),'Lending: Needs attention');
  assert.equal(lendingBadgeText('Checking…'),'Lending: Checking…');
  assert.equal(lendingBadgeText('Lending on'),'Lending on');
});
test('first-run lending is Off; a previously enabled circle can be Paused',()=>{
  const first={enabled:false,circle:null,status:'paused',paused:true,reason:'paused'};
  assert.equal(lendingView(first).label,'Off');assert.equal(lendingBadge(first),'Off');
  const paused={...first,circle:'friends'};
  assert.equal(lendingView(paused).label,'Paused');assert.equal(lendingBadge(paused),'Paused');
  const on={enabled:true,circle:'friends',status:'idle',paused:false};
  assert.equal(lendingView(on).label,'Lending on');assert.equal(lendingBadge(on),'Lending on');
  assert.equal(lendingBadge({...first,reason:'sandbox_not_ready'}),'Off','a prerequisite does not replace off intent in the badge');
  assert.equal(lendingBadge(first,[{label:'Check setup'}]),'Off','attention remains in its separate list');
  assert.equal(lendingView({}).label,'Needs attention');
});

test('review consumes realistic per-job app API protection, not legacy flags',()=>{
  const card={id:'approval',requester:'member',prompt:'Full prompt',source:{kind:'archive',size_bytes:512},harness:'codex',model:['named'],runtimeSeconds:1200,network:'provider-only',
    protection:{source:'read-only-preflight',backend_id:'docker-sbx',observed_at:'2026-10-09T10:00:00Z',
      sandbox_ready:true,version_gate:{ok:true,status:'supported'},
      egress:{requested:'provider-only',enforceable:true,source_enforceable:true,source_reason:''},
      limits:{required:['cpu','memory_bytes','wall_seconds','output_bytes'],preferred:['disk_bytes'],
        enforced:['cpu','memory_bytes','wall_seconds','output_bytes'],unenforced:['disk_bytes'],satisfied:true},
      satisfied:true,disclosure:'Observed preflight evidence for this requirement set, not an isolation guarantee.'}};
  const view=reviewCard(card);
  assert.equal(view.complete,true);assert.equal(view.protectionVerified,true);
  assert.equal(view.protection.summary,'Required readiness checks passed; CPU, memory, running time, output size limits reported enforced.');
  assert.deepEqual(view.protection.rows,[['Sandbox','Ready'],['Version','Supported'],['Internet','AI provider only · enforced'],
    ['Source-network rules','Reported enforceable'],['Enforced limits','CPU, memory, running time, output size'],['Not enforced','host storage']]);
  assert.equal(view.protection.sourceNetworkNote,'This is not a check that source is hidden from the lender or model provider.');
  for(const value of [undefined,null,{}, {satisfied:false},{satisfied:'true'}])
    assert.equal(reviewCard({...card,protection:value,protectionVerified:true}).protectionVerified,false);
  for(const patch of [{sandbox_ready:false},{version_gate:{ok:false}},{egress:{enforceable:false}},{limits:{satisfied:false}}]) {
    // The API computes the aggregate from these failures; app-wide readiness cannot override it.
    assert.equal(reviewCard({...card,protection:{...card.protection,...patch,satisfied:false},ready:true}).protectionVerified,false);
  }
  assert.deepEqual(reviewCard({...card,protection:{...card.protection,egress:{requested:'internet',enforceable:true}}}).protection.rows[2],['Internet','General internet · enforced']);
  // Accept requires protection evidence: an unverified card says so in one line and lists what failed.
  const failed=protectionView({sandbox_ready:false,egress:{requested:'internet',enforceable:false}});
  assert.equal(failed.summary,'Required checks for this job have not passed.');
  assert.deepEqual(failed.rows.slice(0,3),[['Sandbox','Not ready'],['Version','Update needed'],['Internet','General internet · not enforced']]);
  assert.equal(protectionView({}).rows.some(([label])=>label==='Internet'||label==='Enforced limits'),false);
});

test('signed LAN metadata shows exact warning before a separate enrollment action',async()=>{
  const calls=[],metadata={name:'Weekend projects',origin:'http://10.23.1.2:4000',
    lanMode:true,warning:LAN_WARNING,expiresAt:'2026-10-10T00:00:00Z'};
  const state=createJoinReview(async link=>{calls.push(['preview',link]);return metadata;},
    async body=>{calls.push(['join',body]);return {name:'Weekend projects',enrollment:{state:'pending'}};});
  const review=await state.inspect('private invitation');
  assert.deepEqual(calls,[['preview','private invitation']]);
  assert.equal(joinPreviewView(review.preview).warning,'This circle uses your local network without encryption; people on the same network could read code sent for jobs.');
  assert.equal(joinPreviewView(review.preview).name,'Weekend projects');
  await state.confirm(review);
  assert.deepEqual(calls[1],['join',{link:'private invitation',acknowledgedWarning:true}]);
  await assert.rejects(state.confirm(review),error=>error.code==='invite_preview_required');
  assert.equal(calls.length,2);
  assert.equal(joinPreviewView({name:'Secure circle',lanMode:false,warning:null}).warning,null);
  assert.equal(joinPreviewView({warning:LAN_WARNING}).warning,LAN_WARNING);
  assert.equal(joinPreviewView({lanMode:true}).warning,LAN_WARNING);
  assert.equal(joinPreviewView({warning:'untrusted alternate text'}).warning,null);
  assert.equal(joinPreviewView({}).name,'Unnamed circle');
});
test('editing, cancelling and leaving reject stale previews and never enroll',async()=>{
  let resolvePreview,joins=0;
  const state=createJoinReview(()=>new Promise(resolve=>{resolvePreview=resolve;}),async()=>{joins++;});
  const pending=state.inspect('old invitation');state.invalidate();
  resolvePreview({name:'Old',origin:'https://old.example',lanMode:false});assert.equal(await pending,null);
  await assert.rejects(state.confirm(null),error=>error.code==='invite_preview_required');
  const fresh=state.inspect('new invitation');resolvePreview({name:'New',origin:'https://new.example',lanMode:false});
  const review=await fresh;state.invalidate();
  await assert.rejects(state.confirm(review),error=>error.code==='invite_preview_required');
  assert.equal(joins,0);
});
test('overlapping previews keep only the latest invitation and block double acceptance',async()=>{
  const pending=[],joins=[];
  let finishJoin;
  const state=createJoinReview(link=>new Promise(resolve=>pending.push({link,resolve})),
    body=>{joins.push(body);return new Promise(resolve=>{finishJoin=resolve;});});
  const old=state.inspect('old'),latest=state.inspect('latest');
  pending[1].resolve({name:'New',origin:'https://new.example',lanMode:false});const review=await latest;
  pending[0].resolve({name:'Old',origin:'https://old.example',lanMode:false});assert.equal(await old,null);
  const joining=state.confirm(review);
  await assert.rejects(state.confirm(review),error=>error.code==='invite_preview_required');
  assert.deepEqual(joins,[{link:'latest'}]);
  finishJoin({});await joining;
});
test('failed or malformed preview cannot provide consent; unknown enrollment is not replayed',async()=>{
  const malformed=createJoinReview(async()=>({name:'Unconfirmed'}),async()=>assert.fail('must not enroll'));
  await assert.rejects(malformed.inspect('link'),error=>error.code==='invalid_invite');
  let calls=0;
  const state=createJoinReview(async()=>({name:'Circle',origin:'https://circle.example',lanMode:false}),async()=>{calls++;throw {code:'network'};});
  const review=await state.inspect('link');
  await assert.rejects(state.confirm(review),error=>error.code==='network');
  await assert.rejects(state.confirm(review),error=>error.code==='invite_preview_required');
  assert.equal(calls,1);
});

test('stop request never displays stopped before removal and report acknowledgement',()=>{
  const state=withLendingProjection({enabled:false,circle:'circle',status:'stopping',reason:'stopped_by_lender'},
    {intent:'off',intentState:'off',admission:'blocked',admissionReason:'stop_report_pending',execution:'stopping',executionJob:'attempt-1'});
  assert.equal(lendingView(state).label,'Stop report pending');
  const waiting=withLendingProjection({enabled:false,circle:'circle',status:'stopping',reason:'cessation_unverified'},
    {intent:'off',intentState:'off',admission:'blocked',admissionReason:'cessation_unverified',execution:'stopping',executionJob:'attempt-2'});
  assert.equal(lendingView(waiting).label,'Stopping');
  const stopped=withLendingProjection({enabled:false,circle:'circle',status:'stopped'},
    {intent:'off',intentState:'off',admission:'blocked',admissionReason:'stopped_by_lender'});
  assert.equal(lendingView(stopped).label,'Stopped');
});
test('review card names the requester and reports archive size',()=>{
  const key='sha256:'+'ab12'.repeat(16);
  const card={requester:key,source:{kind:'archive',artifact:{digest:'sha256:'+'0'.repeat(64),bytes:18874368,media_type:'application/gzip'}},
    prompt:'x',harness:'codex',network:'provider-only',runtimeSeconds:60};
  const view=reviewCard(card,[],[{key_id:key,device_name:'Maya’s laptop'}]);
  assert.equal(view.requesterName,'Maya’s laptop');
  assert.equal(view.requesterFingerprint,'ab12 ab12 ab12 ab12');
  assert.equal(view.requester,'Maya’s laptop');
  assert.equal(view.source,'Uploaded files · 18.0 MB');
  assert.equal(reviewCard({...card,source:{...card.source,file_count:12}}).source,'Uploaded files · 12 files · 18.0 MB');
  assert.equal(reviewCard({...card,sourceFiles:1}).source,'Uploaded files · 1 file · 18.0 MB');
  assert.equal(reviewCard({...card,sourceFiles:null}).source,'Uploaded files · 18.0 MB');
  assert.equal(reviewCard(card).requester,'A circle member');
});

test('the web form default egress matches the CLI and MCP default and is stated in the form',()=>{
  assert.equal(JOB_EGRESS,JOB_DEFAULTS.egress);
  assert.match(EGRESS_NOTICE,/general internet/);
  assert.equal(EGRESS_NOTICE.split('. ').length,1,'one sentence');
});
test('excludedNotice reports the files the service left out',()=>{
  assert.equal(excludedNotice(undefined),null);
  assert.equal(excludedNotice([]),null);
  const one=excludedNotice(['.env']);
  assert.equal(one.title,'1 file was not sent');assert.deepEqual(one.paths,['.env']);
  assert.equal(excludedNotice(['.env','id_rsa',7]).title,'2 files were not sent');
});
test('diff view classifies lines by first character and bounds what it renders',()=>{
  const {lines,omitted}=diffLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n context\n--- not a header but removed text\n',6);
  assert.deepEqual(lines.map(l=>l.kind),['meta','meta','meta','meta','del','add']);
  assert.equal(omitted,2);
  assert.equal(diffLines('').lines.length,0);
  assert.equal(diffLines('<script>alert(1)</script>').lines[0].text,'<script>alert(1)</script>','text stays text; rendering escapes it');
  assert.equal(changeSummary({files:1,insertions:2,deletions:1}),'1 file changed, +2 −1');
  assert.equal(changeSummary({files:3,insertions:0,deletions:0}),'3 files changed, +0 −0');
});

test('a job this device submitted never reads Not reported for what it submitted',()=>{
  const own=jobFacts({local:{title:'Fix login',prompt:'Fix login\nmore',source:'github.com/a/b.git @ 11111111',agent:'codex',model:'example-model',submittedAt:'2026-10-09T10:00:00Z'}});
  assert.equal(jobFacts({local:{agent:'claude-code-subscription'}}).agent,'Claude Code');
  assert.equal(jobFacts({local:{agent:'claude-code-api-key'}}).agent,'Claude Code (API key)');
  assert.deepEqual({title:own.title,agent:own.agent,model:own.model,source:own.source,own:own.own},{title:'Fix login',agent:'Codex',model:'example-model',source:'github.com/a/b.git @ 11111111',own:true});
  assert.ok(own.submitted&&own.submitted!=='Not reported');
  for(const value of Object.values(own))assert.notEqual(value,'Not reported');
  const open=jobFacts({local:{title:'T',prompt:'p',source:'s',agent:null,model:null,submittedAt:'2026-10-09T10:00:00Z'}});
  assert.equal(open.agent,'Any agent');assert.equal(open.model,'Any available model');
  const foreign=jobFacts({job_digest:'sha256:'+'a'.repeat(64)});
  assert.equal(foreign.own,false);assert.equal(foreign.title,'A member’s job');assert.equal(foreign.prompt,null);
});
test('waiting line names member activity only when it is known',()=>{
  assert.equal(waitingLine(undefined),'Waiting for a lender');
  assert.equal(waitingLine({online:0,total:3}),'Waiting for a lender');
  assert.equal(waitingLine({online:2,total:3}),'Waiting for a lender · 2 of 3 members active recently');
  assert.equal(waitingLine({online:1,total:1}),'Waiting for a lender · 1 of 1 member active recently');
  assert.equal(waitingLine({online:'2',total:3}),'Waiting for a lender');
});
test('owner request view shows the signed name and match code, and refuses an unverified proof',()=>{
  const ok=enrollmentView({enrollment_id:'e',proof_valid:true,device_name:'Maya’s laptop',device_code:'A1B2C3',created_at:'2026-10-09T10:00:00Z'});
  assert.deepEqual([ok.name,ok.code,ok.verified],['Maya’s laptop','A1B2C3',true]);
  const bad=enrollmentView({enrollment_id:'e',proof_valid:false,device_name:'Admin',device_code:'A1B2C3'});
  assert.deepEqual([bad.name,bad.verified],['Unverified request',false]);
  assert.equal(enrollmentView({proof_valid:true,device_code:'zzz'}).code,null);
});
test('joining computer waits for a named owner only in approve-each mode',()=>{
  const each=joinStatusView({name:'Critics',enrollment:{state:'pending'},joinInfo:{approval:'each',ownerName:'Tessa’s laptop',code:'A1B2C3'}});
  assert.deepEqual(each,{waiting:true,message:'Waiting for Tessa’s laptop to approve this computer',code:'A1B2C3'});
  const auto=joinStatusView({name:'Critics',enrollment:{state:'pending'},joinInfo:{approval:'automatic',ownerName:'Tessa’s laptop',code:'A1B2C3'}});
  assert.doesNotMatch(auto.message,/^Waiting for/);assert.equal(auto.code,null);
  assert.equal(joinStatusView({enrollment:{state:'approved'}}).waiting,false);
});

test('joining status follows explicit membership projection and invalid projection stays unknown',()=>{
  const approved={schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown'};
  const pending={schemaVersion:2,kind:'membership',phase:'pending',evidence:{enrollmentState:'pending',origin:true},invitationPolicy:'each'};
  const rawPending={origin:'https://c',enrollment:{state:'pending'},joinInfo:{approval:'each'},membershipProjection:approved};
  assert.deepEqual(joinStatusView(rawPending),{waiting:false,message:'This computer is a member.',code:null});
  assert.match(joinStatusView({...rawPending,enrollment:{state:'approved'},membershipProjection:pending}).message,/Waiting for/);
  const unknown=joinStatusView({...rawPending,membershipProjection:{schemaVersion:2}});
  assert.equal(unknown.waiting,false);
  assert.match(unknown.message,/membership is not confirmed/i);
});

test('user-facing copy never prints "Not reported"; unknown facts are omitted',()=>{
  for(const value of [undefined,null,'','  ','sha256:abc','a'.repeat(64)])assert.equal(safeName(value),'');
  assert.equal(safeName(undefined,'Unnamed device'),'Unnamed device');
  assert.equal(formatTime(undefined),'');assert.equal(formatTime('not a date'),'');
  assert.equal(formatBytes(undefined),'');assert.equal(formatBytes(512),'512 bytes');
  for(const key of STATUS_KEYS)for(const text of Object.values(statusView(key)))assert.doesNotMatch(text,/not reported|not available in this app|not verified/i,key);
  assert.equal(statusView('awaiting-approval').label,'Waiting for you');
});
test('agents show the product a person knows; the adapter ID stays a detail',()=>{
  assert.equal(agentProduct('claude-code-subscription').name,'Claude Code');
  assert.equal(agentProduct('claude-code-api-key').name,'Claude Code');
  assert.equal(agentProduct('codex').name,'Codex');
  assert.equal(agentProduct('gemini').name,'Gemini (API key)');
  assert.equal(agentProduct('opencode').name,'OpenCode');
  assert.equal(agentProduct('gh-cli').name,'GitHub CLI');
  assert.equal(agentProduct('my-local-llm').name,'my-local-llm');
  assert.match(agentProduct('claude-code-api-key').connect,/sbx secret set -g anthropic/);
  assert.match(agentProduct('my-local-llm').connect,/^Sign in to my-local-llm/);
  for(const id of ['claude-code-subscription','codex','opencode','gh-cli','x'])
    assert.doesNotMatch(Object.values(agentProduct(id)).join(' '),/terms|eligib|allowed by|violat/i,'no provider-terms warnings');
});
test('agents fall into Ready, Needs sign-in and Not installed',()=>{
  const groups=agentGroups([
    {id:'codex',installed:true,signedIn:true},
    {id:'claude-code-subscription',installed:true,signedIn:false},
    {id:'opencode',installed:null,signedIn:null},
    {id:'gemini',installed:false,signedIn:null},
  ]);
  assert.deepEqual(groups.ready.map(a=>a.product.name),['Codex']);
  assert.deepEqual(groups.signin.map(a=>[a.id,a.unchecked]),[['claude-code-subscription',false],['opencode',true]]);
  assert.deepEqual(groups.install.map(a=>a.id),['gemini']);
  assert.deepEqual(agentGroups(undefined),{ready:[],signin:[],install:[]});
});
test('today\'s lending use counts only today\'s counters',()=>{
  const now=new Date('2026-10-09T12:00:00Z'),limits={dailyJobs:3,dailyMinutes:60,timeZone:'UTC'};
  assert.equal(todayUse({limits,counters:{day:'2026-10-09',jobs:1,milliseconds:61000}},now),'Today: 1 of 3 jobs · 2 of 60 minutes');
  assert.equal(todayUse({limits,counters:{day:'2026-10-08',jobs:3,milliseconds:3600000}},now),'Today: 0 of 3 jobs · 0 of 60 minutes');
  assert.equal(todayUse({limits:{...limits,dailyJobs:1}},now),'Today: 0 of 1 job · 0 of 60 minutes');
  assert.equal(todayUse({},now),'');
});
test('Home picks one primary action per persona',()=>{
  const mine={id:'mine',origin:null,owned:true},owned={id:'team',origin:'https://q.example',owned:true},joined={id:'friends',origin:'https://q.example',owned:false};
  assert.deepEqual([homePlan({circles:[mine]}).fresh,homePlan({circles:[mine]}).primary],[true,'invite']);
  const borrower=homePlan({circles:[mine,owned],jobs:[{job_digest:'a',local:{submittedAt:'2026-10-09T09:00:00Z'}},{job_digest:'b',local:{submittedAt:'2026-10-09T10:00:00Z'}},{job_digest:'c'}]});
  assert.deepEqual([borrower.borrower,borrower.lender,borrower.primary,borrower.latest.job_digest],[true,false,'run','b']);
  const lender=homePlan({circles:[mine,joined]});
  assert.deepEqual([lender.lender,lender.borrower,lender.primary],[true,false,'lending']);
  assert.equal(homePlan({circles:[mine],lending:{enabled:false,circle:'friends'}}).lender,true);
  assert.equal(homePlan({circles:[mine],agents:[{useForLending:true}]}).lender,true);
  assert.equal(homePlan({circles:[mine,joined],signInNeeded:true}).primary,'signin');
  assert.equal(homePlan({circles:[mine,joined],attention:[{label:'Review'}]}).primary,'attention');
  assert.equal(homePlan({circles:[mine,owned,joined]}).primary,'run');
  // A job from another member does not make this device a borrower.
  assert.equal(homePlan({circles:[mine,joined],jobs:[{job_digest:'x'}]}).borrower,false);
});

test('join review names the inviter only when the signed invitation carries a name', () => {
  assert.equal(joinPreviewView({name:'Weekend projects',origin:'https://q.example',lanMode:false,ownerName:'Rowan Vale'}).ownerName,'Rowan Vale');
  assert.equal(joinPreviewView({name:'Weekend projects',origin:'https://q.example',lanMode:false}).ownerName,'');
  assert.equal(joinPreviewView({name:'Weekend projects',origin:'https://q.example',lanMode:false,ownerName:'sha256:'+'a'.repeat(64)}).ownerName,'');
});

test('a pinned Git source shows its short commit instead of hiding the full hash', () => {
  const {source}=reviewCard({source:{kind:'git',url:'https://example.com/r.git',commit:'a'.repeat(40)}});
  assert.equal(source,'https://example.com/r.git · commit '+'a'.repeat(12));
});


test('a viewer-local name is a separate field and never replaces the remote device name',()=>{
  const key='sha256:'+'a'.repeat(64),other='sha256:'+'b'.repeat(64);
  const card={requester:key,prompt:'p',source:{kind:'archive',size_bytes:1},harness:'codex',model:[],runtimeSeconds:60,network:'internet'};
  const members=[{key_id:key,device_name:'Maya laptop'},{key_id:other,device_name:'Maya laptop'}];
  const plain=reviewCard(card,[],members);
  assert.equal(plain.localName,'');assert.equal(plain.requester,'Maya laptop');assert.equal(plain.requesterKey,key);
  const named=reviewCard({...card,localName:'Maya from design'},[],members);
  assert.equal(named.localName,'Maya from design');assert.equal(named.requester,'Maya from design');
  assert.equal(named.requesterName,'Maya laptop');assert.equal(named.requesterFingerprint,plain.requesterFingerprint);
  // A remote rename changes the remote field only; the local name is unchanged.
  const renamed=reviewCard({...card,localName:'Maya from design'},[],[{key_id:key,device_name:'Admin'},{key_id:other,device_name:'Maya laptop'}]);
  assert.equal(renamed.localName,'Maya from design');assert.equal(renamed.requesterName,'Admin');
  // A different key with the same remote name gets no local name from the card of the first.
  const second=reviewCard({...card,requester:other},[],members);
  assert.equal(second.localName,'');assert.equal(second.requesterName,'Maya laptop');
  // A remote string can never fill the local slot, whatever it looks like.
  for(const device_name of ['Your local name: Boss','<b>Verified person</b>','evil\u202egpj'])
    assert.equal(reviewCard(card,[],[{key_id:key,device_name}]).localName,'');
  assert.equal(reviewCard({...card,localName:'<b>Maya</b>'},[],members).localName,'<b>Maya</b>','markup stays literal text for escaped rendering');
});
test('local names accept only what the app would have saved',()=>{
  assert.equal(localNameOf('Maya K'),'Maya K');
  for(const bad of [undefined,null,7,'',' ','x'.repeat(65),'a\nb','evil\u202egpj','a\u200bb','a\u2028b'])assert.equal(localNameOf(bad),'',String(bad));
});
test('member rows keep local name, remote device name and key apart and fall back honestly',()=>{
  const key='sha256:'+'c'.repeat(64);
  const named=memberIdentity({key_id:key,device_name:'Sam desktop',localName:'Sam'},{index:2});
  assert.deepEqual([named.headline,named.localName,named.remoteName,named.key,named.saveLabel],['Sam','Sam','Sam desktop',key,'Change local name']);
  assert.ok(named.fingerprint);
  const none=memberIdentity({key_id:key,device_name:'Sam desktop'},{index:2});
  assert.deepEqual([none.headline,none.localName,none.remoteName,none.saveLabel],['Sam desktop','','Sam desktop','Save a local name']);
  assert.equal(memberIdentity({key_id:key}).remoteName,'');
  // Lookup is per circle: the same key in another circle supplies nothing.
  const devices={circles:[{circle:'one',members:[{key_id:key,localName:'Sam'}]},{circle:'two',members:[{key_id:key,localName:null}]}]};
  assert.equal(circleMembers(devices,'one')[0].localName,'Sam');assert.equal(circleMembers(devices,'two')[0].localName,null);
  assert.equal(circleMembers(devices,'three'),null);assert.equal(circleMembers(undefined,'one'),null);
  assert.match(errorMessage({code:'petname_label_taken'}),/qualifier/);assert.match(errorMessage({code:'invalid_petname'}),/1 to 64/);
});
test('petname client calls name the exact circle and key and reach only the local API',async()=>{
  const calls=[],mutate=async(path,body)=>{calls.push([path,body]);return {};};
  await savePetname(mutate,'circle/1','sha256:'+'d'.repeat(64),'Sam');
  await deletePetname(mutate,'circle/1','sha256:'+'d'.repeat(64));
  assert.deepEqual(calls,[['circles/circle%2F1/petnames',{keyId:'sha256:'+'d'.repeat(64),label:'Sam'}],
    ['circles/circle%2F1/petnames/delete',{keyId:'sha256:'+'d'.repeat(64)}]]);
});

import { contributorNextStep, approvalDeadline, APPROVAL_EXPIRED, lendingRulesSummary } from './helpers.mjs';
import {adaptLegacyJob} from '../../../lib/v1/state-projection.mjs';
const contributorCircle={id:'friends',origin:'https://queue.example',owned:false,enrollment:{state:'approved'},rosterMembershipVerified:true};
const contributorLimits={dailyJobs:3,dailyMinutes:60,maxWallSeconds:1200};
const contributorBase={
  home:{observedAt:100},circles:[contributorCircle],selectedCircle:'friends',
  lending:{enabled:false,status:'paused',circle:null,mode:'ask',limits:contributorLimits},
};
const readyAgent={id:'codex',installed:true,signedIn:true,useForLending:false,stale:false};
test('each of the ten contributor states has exactly one concrete primary destination',()=>{
  const prepared={...contributorBase,readiness:{ready:true},agents:[readyAgent]};
  const selected={...prepared,agents:[{...readyAgent,useForLending:true}]};
  const on={...selected,lending:{...selected.lending,enabled:true,circle:'friends',status:'idle'}};
  const cases=[
    ['membership_pending',{...contributorBase,circles:[{...contributorCircle,enrollment:{state:'pending'}}]},'circle'],
    ['joined',contributorBase,'setup'],
    ['sandbox_not_ready',{...contributorBase,readiness:{ready:false}},'setup'],
    ['no_ready_agent',{...prepared,agents:[{...readyAgent,signedIn:false}]},'lend'],
    ['agent_not_chosen',prepared,'lend'],
    ['lending_off',selected,'lend'],
    ['lending_waiting',on,'lend'],
    ['approval_waiting',{...on,now:100,approvals:[{id:'review',expiresAt:30100,job:{circle:'friends'}}]},'request'],
    ['job_running',{...on,home:withLendingProjection(on.home,{intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'attempt'}),
      lending:{...on.lending,status:'contributing',current:'attempt'},deviceKey:'me',
      jobs:[{job_digest:'job',status:'Running',current_attempt:{attempt_id:'attempt',holder:'me',execution_started_at:'2026-10-13T12:00:00Z'}}]},'job'],
    ['result_delivered',{...on,deviceKey:'me',
      jobs:[{job_digest:'job',state:'result-accepted',current_attempt:{holder:'me'}}]},'job'],
  ];
  for(const [id,input,page] of cases) {
    const snapshot=structuredClone(input),result=contributorNextStep(input);
    assert.equal(result.id,id);assert.equal(result.action.page,page);assert.ok(result.action.label);
    assert.equal(Array.isArray(result),false);assert.equal(Object.hasOwn(result,'actions'),false);
    assert.deepEqual(input,snapshot,'derivation does not change any input');
  }
  assert.equal(contributorNextStep(selected).action.enable,true,'only an explicit click may turn lending on');
});
test('missing and older refreshes do not send an active contributor back through setup',()=>{
  const current=contributorNextStep({...contributorBase,home:{observedAt:200},
    lending:{enabled:true,status:'contributing',circle:'friends',current:'attempt'}});
  assert.equal(contributorNextStep({...contributorBase,home:{observedAt:100}},current),current);
  assert.equal(contributorNextStep({},current),current);
  assert.equal(contributorNextStep({home:{observedAt:300,circles:[contributorCircle]},circles:[]},current),current);
  assert.equal(contributorNextStep({...contributorBase,home:{observedAt:300},
    lending:{},agents:[{stale:true,installed:null,signedIn:null}]},current).id,current.id);
  const waiting=contributorNextStep({...contributorBase,lending:{enabled:true,circle:'friends',status:'idle'},
    readiness:{ready:false},agents:[{stale:true}]});
  assert.equal(waiting.id,'lending_waiting','active lending outranks an incomplete setup refresh');
  const joined=contributorNextStep({...contributorBase,home:{observedAt:300,circles:[contributorCircle]},
    circles:[{...contributorCircle,enrollment:{state:'pending'}}]});
  assert.equal(joined.id,'joined','coherent Home membership beats an older circle read');
});
test('pause and restart stay off, missing readiness cannot enable, and actual setup failure has a remedy',()=>{
  const previous=contributorNextStep({...contributorBase,lending:{enabled:true,circle:'friends',status:'idle'}});
  const off={...contributorBase,home:{observedAt:101},lending:{...contributorBase.lending,circle:'friends'}};
  assert.equal(contributorNextStep(off,previous).id,'lending_off');
  assert.equal(contributorNextStep(off,previous).action.enable,false);
  assert.equal(contributorNextStep({...off,readiness:{ready:false}},previous).id,'sandbox_not_ready');
  assert.equal(contributorNextStep({...contributorBase,home:{observedAt:101,circles:[]},circles:[]},previous),null,
    'a confirmed departure does not preserve a removed circle');
});
test('a result belongs to this lender and active work takes priority over an older result',()=>{
  const base={...contributorBase,lending:{enabled:true,circle:'friends',status:'idle'},deviceKey:'me',
    jobs:[{job_digest:'other',status:'Finished',current_attempt:{holder:'someone-else'}}]};
  assert.equal(contributorNextStep(base).id,'lending_waiting');
  base.jobs.push({job_digest:'mine',status:'Finished',current_attempt:{holder:'me'}});
  assert.equal(contributorNextStep(base).action.id,'mine');
  assert.equal(contributorNextStep({...base,now:100,approvals:[{id:'a',job:{circle:'friends'},expiresAt:200}]}).id,'approval_waiting');
  const actuallyRunning=withLendingProjection({...base,lending:{...base.lending,status:'contributing'}},
    {intent:'on',intentState:'ready',admission:'allowed',execution:'running',executionJob:'attempt-1'});
  assert.equal(contributorNextStep({...base,home:{...base.home,lendingProjection:actuallyRunning.lendingProjection},
    jobs:[{job_digest:'mine',status:'Running',current_attempt:{attempt_id:'attempt-1',holder:'me',execution_started_at:'2026-10-13T12:00:00Z'}}]}).id,'job_running');
  assert.equal(contributorNextStep({...base,lending:{...base.lending,enabled:false,status:'paused'}}).id,'lending_off');
  assert.equal(contributorNextStep({...base,jobs:[{job_digest:'old',status:'Running',current_attempt:{holder:'me'}}]}).id,
    'lending_waiting','a stale job list does not invent current execution');
  assert.equal(contributorNextStep({...base,jobs:[{job_digest:'reserved',state:'claimed',approval:'pending',current_attempt:{holder:'me',state:'active'}}]}).id,
    'lending_waiting','an active reservation without execution proof is not a running job');
});
test('delivered own-job status follows its projection and adapts legacy finished rows',()=>{
  const base={...contributorBase,
    home:withLendingProjection({...contributorBase.home,lending:{enabled:true,status:'idle',circle:'friends'}},
      {intent:'on',intentState:'ready',admission:'allowed',execution:'idle'}),
    lending:{enabled:true,circle:'friends',status:'idle'},deviceKey:'me'};
  const running=adaptLegacyJob({state:'running',current_attempt:{execution_started_at:'2026-10-13T12:00:00Z'}});
  const contradictory={job_digest:'mine',state:'result-accepted',jobProjection:running,
    current_attempt:{holder:'me'}};
  assert.equal(contributorNextStep({...base,jobs:[contradictory]}).id,'lending_waiting',
    'an explicit running phase overrides a contradictory raw finished state');

  const legacyFinished={job_digest:'legacy',status:'Finished',current_attempt:{holder:'me'}};
  const delivered=contributorNextStep({...base,jobs:[legacyFinished]});
  assert.equal(delivered.id,'result_delivered','legacy finished rows still pass through the compatibility adapter');
  assert.equal(delivered.action.id,'legacy');
});
test('conservative saved rules remain visible and helper evaluation never enables anything',()=>{
  const before=structuredClone(contributorBase);
  assert.equal(lendingRulesSummary(contributorBase.lending),
    'Ask before each job. Your account and computer concurrency limits apply. Up to 3 jobs a day. Up to 60 minutes a day. Up to 20 minutes per job.');
  for(let i=0;i<3;i++)contributorNextStep(contributorBase);
  assert.deepEqual(contributorBase,before);assert.equal(contributorBase.lending.enabled,false);
  assert.match(lendingRulesSummary({...contributorBase.lending,mode:'auto',limits:{dailyJobs:1,dailyMinutes:10,maxWallSeconds:60}}),
    /^Automatic lending.*1 job a day.*10 minutes.*1 minutes/);
  assert.match(lendingRulesSummary({...contributorBase.lending,mode:'auto',limits:{dailyJobs:null,dailyMinutes:null,maxWallSeconds:null}}),
    /^Automatic lending.*No daily job or minute cap.*must fit before reset/);
  assert.match(lendingRulesSummary({}),/Check them before turning lending on/);
});
test('approval countdown uses the absolute deadline and expires exactly at the boundary',()=>{
  const expiresAt=Date.parse('2026-10-13T12:00:30Z');
  assert.deepEqual(approvalDeadline({expiresAt},expiresAt-30000),
    {known:true,expired:false,seconds:30,label:'Accept within 30 seconds.'});
  assert.equal(approvalDeadline({expiresAt:new Date(expiresAt).toISOString()},expiresAt-1).label,'Accept within 1 second.');
  for(const now of [expiresAt,expiresAt+60000]) {
    assert.equal(approvalDeadline({expiresAt},now).expired,true);
    assert.equal(approvalDeadline({expiresAt},now).label,APPROVAL_EXPIRED);
    assert.equal(approvalDeadline({expiresAt},now).seconds,0);
  }
  for(const expiresAt of [undefined,null,'bad',Infinity])assert.equal(approvalDeadline({expiresAt}).known,false);
  assert.equal(errorMessage({code:'approval_expired'}),APPROVAL_EXPIRED);
});

test('legacy approval card labels its local review hold without calling it Job expiry',()=>{
  const expiresAt=Date.parse('2026-10-13T12:00:30Z');
  assert.equal(approvalDeadline({legacyHold:true,expiresAt},expiresAt-30000).label,'Review window closes in 30 seconds.');
  assert.equal(approvalDeadline({legacyHold:true,expiresAt},expiresAt).label,'This computer’s review window ended.');
});

test('missing or stale setup reads preserve the chosen step without offering activation',()=>{
  const observed='2026-10-13T12:00:00Z',older='2026-10-13T11:00:00Z';
  const base={...contributorBase,home:{observedAt:300},readiness:{ready:true,protection:{observed_at:observed}},
    agents:[{...readyAgent,checkedAt:observed}]};
  const ready=contributorNextStep(base);
  for(const agents of [undefined,[],[{...readyAgent,installed:null,signedIn:null,stale:true}],
    [{...readyAgent,signedIn:false,checkedAt:older}]]) {
    const next=contributorNextStep({...base,home:{observedAt:400},agents},ready);
    assert.equal(next.id,'agent_not_chosen');assert.notEqual(next.action.enable,true);
    assert.equal(next.observedAt,400);
  }
  const chosen=contributorNextStep({...base,agents:[{...base.agents[0],useForLending:true}]});
  const missing=contributorNextStep({...contributorBase,home:{observedAt:400}},chosen);
  assert.equal(missing.id,'lending_off');assert.notEqual(missing.action.enable,true);
  const stale=contributorNextStep({...base,home:{observedAt:400},
    readiness:{ready:false,protection:{observed_at:older}}},ready);
  assert.equal(stale.id,'agent_not_chosen');
});
test('an agent choice never proves membership or silently switches a lending circle',()=>{
  const selected={...contributorBase,readiness:{ready:true},agents:[{...readyAgent,useForLending:true}]};
  assert.equal(contributorNextStep({...selected,circles:[{...contributorCircle,enrollment:{state:'pending'}}]}).id,
    'membership_pending');
  const elsewhere=contributorNextStep({...selected,lending:{enabled:true,circle:'another-circle',status:'contributing'}});
  assert.equal(elsewhere.id,'lending_off');assert.equal(elsewhere.action.page,'lend');
  assert.notEqual(elsewhere.action.enable,true);
});

test('the guide shows the chosen circle approval mode before lending has ever been enabled',()=>{
  assert.match(lendingRulesSummary(contributorBase.lending,{lendingMode:'auto'}),/^Automatic lending\./);
  assert.match(lendingRulesSummary({...contributorBase.lending,mode:'auto'},{lendingMode:'ask'}),/^Ask before each job\./);
  assert.equal(contributorBase.lending.enabled,false);
});

test('review identity labels stay bound to the card and history separates current local labels',()=>{
  const key='sha256:'+'a'.repeat(64), card={requester:key,requesterName:'Original laptop',
    localName:'Original friend',identity:{memberPresent:true,rosterFresh:true}};
  const changed=[{key_id:key,device_name:'Replacement laptop',localName:'Replacement friend'}];
  assert.equal(reviewCard(card,[],changed).requesterName,'Original laptop');
  assert.equal(reviewCard(card,[],changed).localName,'Original friend');
  assert.equal(reviewCard({...card,requesterName:null},[],changed).requesterName,'A circle member');
  const signed={author:key,device_name:'Historical laptop'};
  const job={job:{payload:signed},historyIdentity:{author:key,deviceName:signed.device_name,localName:'Today'}};
  assert.deepEqual(jobIdentityHistory(job),[
    ['Your local name','Today'],['Signed author key',key],['Device name in the signed job','Historical laptop']]);
  assert.deepEqual(jobIdentityHistory({...job,historyIdentity:{...job.historyIdentity,localName:'Tomorrow'}}).slice(1),
    jobIdentityHistory(job).slice(1));
  assert.equal(jobIdentityHistory({job:{payload:{author:key}},localName:'Unsigned',device_name:'Current roster'})[2][1],'Not recorded');
  assert.match(errorMessage({code:'identity_changed'}),/details changed/);
});

import { contributionLine, contributionName, contributionMinutes } from './helpers.mjs';
test('contribution copy counts devices honestly and preserves raw minutes',()=>{
  assert.equal(contributionLine({devices:2,jobs:3,minutes:1.25}),
    'You helped 2 circle members with 3 jobs in the last 7 days.');
  assert.equal(contributionLine({devices:1,jobs:1,minutes:0}),
    'You helped 1 circle member with 1 job in the last 7 days.');
  const row=(k,run,extra)=>({keyId:'sha256:'+k,run,...extra});
  assert.equal(contributionLine({devices:2,jobs:2,rows:[row('self',1,{deviceName:'sandpiper'}),row('b',2,{deviceName:'faravan-borrower'})]},'sha256:self'),
    'You helped faravan-borrower with 2 jobs in the last 7 days.');
  assert.equal(contributionLine({devices:2,jobs:5,rows:[row('a',3,{localName:'Maya'}),row('b',2,{deviceName:'Sam laptop'}),row('b',1,{deviceName:'Sam laptop'})]}),
    'You helped Maya and Sam laptop with 5 jobs in the last 7 days.');
  assert.equal(contributionLine({devices:4,jobs:6,rows:[row('a',1,{localName:'Maya'}),row('b',1,{deviceName:'Sam'}),row('c',1,{deviceName:'Ana'}),row('d',3,{})]}),
    'You helped Maya, Sam and 2 others with 6 jobs in the last 7 days.');
  assert.equal(contributionLine({devices:2,jobs:2,rows:[row('a',1,{localName:'Maya'}),row('d',1,{})]}),
    'You helped Maya and 1 other with 2 jobs in the last 7 days.');
  assert.equal(contributionLine({devices:1,jobs:2,rows:[row('d',2,{})]}),'You helped 1 circle member with 2 jobs in the last 7 days.');
  assert.equal(contributionLine({devices:0,jobs:0,minutes:0}),'');
  assert.equal(contributionMinutes(null),'Unknown');
  assert.equal(contributionMinutes(-1),'Unknown');
});
test('contribution names remain exact-key device labels, including duplicate names',()=>{
  const row={localName:'Alex',deviceName:'Laptop',keyId:'sha256:'+'a'.repeat(64)};
  assert.equal(contributionName(row),'Alex · aaaaaaaaaaaa');
  assert.equal(contributionName({...row,localName:null}),'Laptop · aaaaaaaaaaaa');
  assert.equal(contributionName({...row,localName:null,deviceName:null}),'Device · aaaaaaaaaaaa');
  assert.notEqual(contributionName(row),contributionName({...row,keyId:'sha256:'+'b'.repeat(64)}));
});

import {approvalNotificationBody} from './helpers.mjs';
test('approval notification body never carries task text (lock screens, screen shares)', () => {
  const assert = {equal: (a, b) => { if (a !== b) throw new Error(JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }};
  assert.equal(approvalNotificationBody({job: {title: 'Secret launch plan'}, prompt: 'Rotate the prod keys'}), 'A job is waiting for your review.');
  assert.equal(approvalNotificationBody({}), 'A job is waiting for your review.');
});

import {waitingTime, waitingPresenceLine} from './helpers.mjs';
test('waiting presence gives exact honest zero, active and error lines',()=>{
  const now=Date.parse('2026-10-13T12:00:00Z'),options={now,timeZone:'UTC',circleName:'Friends'};
  const job={state:'queued',waitingTiming:{submittedAt:'2026-10-13T11:58:00Z',expiresAt:'2026-10-13T21:26:00Z'}};
  assert.equal(waitingPresenceLine(job,{online:0,total:3,basis:'recent-activity'},options),
    'No one in Friends has been active recently · expires today 21:26');
  assert.equal(waitingPresenceLine(job,{online:1,total:3,basis:'recent-activity'},options),
    'Waiting for a lender · 1 of 3 members active recently · expires today 21:26');
  assert.equal(waitingPresenceLine(job,null,options),
    'Waiting for a lender. Expires at Oct 13, 2026, 09:26:00 PM UTC. Waiting for 2 minutes.');
  for(const presence of [undefined,{}, {online:-1,total:3,basis:'recent-activity'},
    {online:4,total:3,basis:'recent-activity'}, {online:0,total:0,basis:'recent-activity'},
    {online:1,total:3,basis:'lending'}])
    assert.equal(waitingPresenceLine(job,presence,options),waitingJobLine(job,options));
  assert.equal(waitingPresenceLine(job,{online:1,total:1,basis:'recent-activity'},options),
    'Waiting for a lender · 1 of 1 member active recently · expires today 21:26');
  assert.match(waitingPresenceLine({...job,state:'expired'},{online:1,total:3,basis:'recent-activity'},options),/^Expired at/);
});
test('compact waiting times retain day and respect viewer time zone',()=>{
  const now=Date.parse('2026-10-13T12:00:00Z');
  assert.equal(waitingTime('2026-10-14T21:26:00Z',{now,timeZone:'UTC'}),'Wed, Oct 14 21:26');
  assert.equal(waitingTime('2026-10-14T02:26:00Z',{now,timeZone:'America/Los_Angeles'}),'today 19:26');
  assert.equal(waitingTime('bad',{now}),'');
  assert.equal(waitingTime(now,{now,timeZone:'not-a-zone'}),'');
});


import {agentSignedOutHeadline, agentSignedOutMessage} from './helpers.mjs';
import {withLendingProjection} from './lending-projection.fixture.mjs';
test('a signed-out agent is explained with its product name and one next step', () => {
  const message="Codex isn't signed in inside Faravan's sandbox anymore. Sign in again on the Lend page, then lending resumes.";
  assert.equal(agentSignedOutMessage('Codex'),message);
  assert.equal(agentSignedOutHeadline('Codex'),"Codex isn't signed in inside Faravan's sandbox anymore.");
  assert.equal(agentSignedOutMessage(''),"This agent isn't signed in inside Faravan's sandbox anymore. Sign in again on the Lend page, then lending resumes.");
  const lending={enabled:true,paused:false,status:'failed',reason:'agent_signed_out',agent:'codex',label:'PRIVATE_DIAGNOSTIC'};
  assert.deepEqual(lendingView(lending),{label:'Sign-in needed',message:'Codex is no longer signed in to Faravan’s sandbox. Sign in again on the Lend page, then lending can resume.',remedy:'Sign in'});
  assert.equal(statusView('agent_signed_out').label,'Sign-in needed');
  assert.ok(STATUS_KEYS.includes('agent_signed_out'));
  assert.equal(iconState(lending,[]),'Needs attention');
});

import {lendingControlBody} from './helpers.mjs';
test('reload then pause and resume keeps the server lending circle instead of the reset picker', () => {
  const reloaded = {circle: 'My devices'}, server = {circle: 'Faravan test'};
  for (const path of ['lending/pause', 'lending/resume', 'lending/on', 'lending/off'])
    assert.deepEqual(lendingControlBody(path, {...reloaded, until:'later'}, server), {circle:'Faravan test', until:'later'});
  assert.deepEqual(lendingControlBody('lending/on', reloaded, {}), reloaded, 'the first start still accepts the explicit choice');
  assert.deepEqual(lendingControlBody('lending/limits', reloaded, server), reloaded);
});

test('contributor setup guidance uses Open setup and opens the setup route',()=>{
 const next=contributorNextStep({circles:[{id:'c',origin:'https://example.invalid',owned:false,enrollment:{state:'approved'},rosterMembershipVerified:true}],home:{circles:[{id:'c',enrollment:{state:'approved'}}],lending:{}},readiness:{ready:false},agents:[]});
 assert.equal(next.action.label,'Open setup');assert.equal(next.action.page,'setup');
 for(const state of ['setup_required','sandbox_not_ready','waiting_for_sandbox','required_update'])assert.equal(statusView(state).remedy,'Open setup');
});

test('join review describes signed invitation use bounds without assuming unbounded links', () => {
 assert.equal(joinPreviewView({maxUses:1}).uses,'For one person.');
 assert.equal(joinPreviewView({maxUses:5}).uses,'For up to 5 people.');
 for(const maxUses of [undefined,0,-1,'5',Infinity])assert.equal(joinPreviewView({maxUses}).uses,'');
});

test('refused enrollment is terminal and never presented as waiting approval', () => {
 const state=joinStatusView({enrollment:{state:'rejected'},joinInfo:{approval:'each',ownerName:'Ana'}});
 assert.equal(state.waiting,false);assert.equal(state.terminal,true);assert.match(state.message,/not added/);assert.doesNotMatch(state.message,/Waiting/);
});

test('contributor next step uses the home membership projection and unknown never claims joined',()=>{
 const projection=(phase,enrollmentState)=>({schemaVersion:2,kind:'membership',phase,
   evidence:{enrollmentState,origin:true},invitationPolicy:phase==='pending'?'each':'unknown'});
 const current={...contributorCircle,enrollment:{state:'approved'}};
 const pending=contributorNextStep({...contributorBase,circles:[current],home:{...contributorBase.home,
   circles:[{id:'friends',membershipProjection:projection('pending','pending')}]}});
 assert.equal(pending.id,'membership_pending');
 const approved=contributorNextStep({...contributorBase,circles:[{...current,enrollment:{state:'pending'}}],home:{...contributorBase.home,
   circles:[{id:'friends',membershipProjection:projection('approved','approved')}]}});
 assert.equal(approved.id,'joined');
 assert.doesNotMatch(approved.title,/Waiting|membership/);
 const unknown=contributorNextStep({...contributorBase,circles:[current],home:{...contributorBase.home,
   circles:[{id:'friends',membershipProjection:{schemaVersion:2,kind:'membership',phase:'approved'}}]}});
 assert.equal(unknown.id,'membership_unknown');
 assert.doesNotMatch(unknown.title,/joined/i);
});

test('every non-approved membership phase beats lending and setup fallthroughs',()=>{
 const cases=[
  ['pending','approved','membership_pending',/Waiting/],
  ['expired','approved','membership_expired',/invitation has expired/i],
  ['rejected','pending','membership_rejected',/was not added/i],
  ['unknown','approved','membership_unknown',/membership is not confirmed/i],
 ];
 const originCircle={...contributorCircle,enrollment:{state:'approved'}};
 for(const [phase,rawState,id,message] of cases) for(const withSetup of [false,true]) {
  const membershipProjection=phase==='unknown'
   ? {schemaVersion:2,kind:'membership',phase,evidence:{enrollmentState:null,origin:false},invitationPolicy:'each'}
   : {schemaVersion:2,kind:'membership',phase,evidence:{enrollmentState:phase,origin:true},invitationPolicy:'each'};
  const home=withLendingProjection({...contributorBase.home,
    circles:[{id:'friends',membershipProjection}]},
    {intent:'off',intentState:'off',admission:'blocked',admissionReason:'off'});
  const result=contributorNextStep({
   ...contributorBase,
   home,
   circles:[{...originCircle,enrollment:{state:rawState}}],
   lending:{...contributorBase.lending,enabled:false,status:'paused'},
   ...(withSetup?{readiness:{ready:true},agents:[readyAgent]}:{}),
  });
  assert.equal(result.id,id,phase+' phase withSetup='+withSetup);
  assert.equal(result.circleId,'friends');
  assert.match(result.message,message);
 }
});

test('confirmed execution remains visible after membership expires',()=>{
 const membershipProjection={schemaVersion:2,kind:'membership',phase:'expired',
  evidence:{enrollmentState:'expired',origin:true},invitationPolicy:'each'};
 const home=withLendingProjection({...contributorBase.home,
  circles:[{id:'friends',membershipProjection}]},
  {intent:'off',intentState:'off',admission:'blocked',admissionReason:'off',execution:'running',executionJob:'attempt'});
 const result=contributorNextStep({...contributorBase,home,deviceKey:'me',jobs:[{
  job_digest:'job',current_attempt:{attempt_id:'attempt',holder:'me'},
 }]});
 assert.equal(result.id,'job_running');
});

test('retired information and legacy tray entry URLs resolve to one canonical destination', () => {
  for (const [hash,route] of [
    ['#/trust',{page:'setup',id:'details'}], ['#/activity',{page:'jobs',id:null}],
    ['#/review',{page:'home',id:null}], ['#/watch',{page:'jobs',id:null}],
    ['#/review/r1',{page:'request',id:'r1'}], ['#/watch/d1/c1',{page:'job',id:'d1',circle:'c1'}],
  ]) assert.deepEqual(routeFromHash(hash),route,hash);
});

test('an offer stays open until its deadline with the exact local time',()=>{
 const at=Date.parse('2026-10-20T12:00:00Z');
 assert.equal(approvalDeadline({offer:true,expiresAt:at},at-60000).label,'Open until '+decisionTime(at));
 assert.equal(approvalDeadline({offer:true,expiresAt:at},at).label,'This job expired.');
});

test('legacy person-link consent has an actionable refresh message',()=>{
  assert.match(errorMessage({code:'person_link_refresh_required'}),/Refresh.*both computers.*new.*linking codes/i);
});

test('missing conversion is an estimate, not an unsupported-plan hold',()=>{
  const detail={reason:'calibration_missing',scope:'plan',provider:'codex',plan:'plus',model:'gpt-6-sol',window:'weekly'};
  const view=statusView('conversion_unknown',{detail});
  assert.equal(view.message,'Usage estimate: lending uses available readings or the starting estimate; history improves it.');
  assert.equal(view.label,view.message);
  assert.equal(view.remedy,null);
  const model=statusView('conversion_unknown',{detail:{...detail,scope:'model_window',plan:'pro',window:'five_hour'}});
  assert.equal(model.message,view.message);
  assert.equal(model.remedy,null);
  assert.deepEqual(statusView('refresh_failed',{detail}),statusView('refresh_failed'));
});

test('unknown conversion offers an update without claiming a hold',()=>{
  const expected='Usage estimate: lending uses available readings or the starting estimate; history improves it.';
  for(const facts of [{},{detail:{}},{detail:{reason:'calibration_missing',scope:'invalid'}}]){
    const view=statusView('conversion_unknown',facts);
    assert.equal(view.remedy,'Check for updates');
    assert.equal(view.message,expected);
    assert.equal(view.label,expected);
  }
  // model_not_lendable is about the model a job asked for, which its sender chooses; it is not a readiness reason.
  for(const key of STATUS_KEYS.filter(key=>key!=='model_not_lendable'))
    assert.notEqual(statusView(key).remedy,'Choose another model',key+' has no lender model selector');
});

// The test Mac 11-01: a lending wait read "Check protected workspace setup" when the cause was an agent.
test('a lending wait follows its reason; only a sandbox reason says protected workspace',()=>{
  const view=(reason,agentName)=>statusView('waiting_for_sandbox',{reason,agentName});
  assert.deepEqual(view('agent_signed_out','Claude'),{label:'Sign-in needed',message:'Claude is signed out in Faravan.',remedy:'Sign in'});
  assert.deepEqual(view('agent_not_chosen','Codex'),{label:'Not lent',message:"Codex isn't chosen for lending.",remedy:'Choose agents'});
  assert.equal(view('agent_not_chosen').message,"This agent isn't chosen for lending.");
  assert.equal(view('no_ready_agent').remedy,'Set up an agent');
  assert.equal(view('lender_starting','Claude').message,'Checking whether Claude is signed in…');
  assert.equal(view('native_credentials_owner_only').remedy,'Open Lending');
  assert.match(view('host_disk_low').message,/low on disk space/);
  for(const reason of ['agent_signed_out','agent_not_chosen','no_ready_agent','lender_starting','native_credentials_owner_only','host_disk_low','host_disk_unreadable'])
    assert.doesNotMatch(view(reason,'Claude').message,/protected workspace/,reason);
  const generic={label:'Waiting for setup',message:"Lending is on, but this computer can't run jobs right now. Check protected workspace setup.",remedy:'Open setup'};
  assert.deepEqual(view('sandbox_not_ready'),generic);
  assert.deepEqual(view('some_future_reason'),generic,'unknown reasons keep the generic text');
  assert.deepEqual(statusView('waiting_for_sandbox'),generic);
  const notChosen=withLendingProjection({lending:{enabled:true}},{intent:'on',intentState:'blocked',admission:'blocked',admissionReason:'agent_not_chosen'});
  assert.equal(lendingView(notChosen).remedy,'Choose agents');
});

test('contribution copy counts a named person once across computers',()=>{
  const rows=[{keyId:'a',run:1,personName:'Tessa'}, {keyId:'b',run:1,personName:'Tessa'}, {keyId:'c',run:1,personName:'Maya'}];
  assert.equal(contributionLine({devices:3,jobs:3,rows}), 'You helped Tessa and Maya with 3 jobs in the last 7 days.');
});
