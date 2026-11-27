import {mount,click,forceClick,flush,teardown,installClock,resetPage,createFakeApi} from './mounted.test-helper.mjs';
import {h} from 'preact';
import {useResource,Notices} from './shared.jsx';
import test from 'node:test';
import assert from 'node:assert/strict';
import {handoffChecks, prepareFollowupDraft, threadRows, handoffText, followupBaseVM} from './job-thread.mjs';
import {loadDraft,draftBody} from './compose-draft.mjs';
import {AgentActivity} from './transcript-feed.jsx';
import {transcriptFeedVM} from './transcript-feed.mjs';
import {JobThread,JobThreadPanel,plainPreview} from './job-thread.jsx';
import {renderFixture, renderedText, assertDomOrder, assertNoBannedWords} from './render.test-helper.mjs';

const memory=()=>{const map=new Map();return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),map};};
const continuation={
  handoff:{schema:'faravan.continuation.v1',mode:'summary',trust:'untrusted',objective:'Fix parsing',latest_instruction:'Keep the change small',changes:['Updated parser'],observed_checks:[{cmd:'npm test',exit:0,timed_out:false,observed_by:'sandbox'}],agent_claims:['Tests passed'],open_issues:[],next_steps:['Review the diff'],scan:{status:'passed'}},
  parentJob:'sha256:parent',parentResult:'sha256:result',base:{path:'/work/project',branch:'review/123',commit:'a'.repeat(40)},
  thread:[
    {job_digest:'child',title:'Follow-up',parentJob:'sha256:parent',submittedAt:'2026-10-20T12:00:00Z',runs:[{attempt_id:'r2',state:'done',result_digest:'result-2'}]},
    {job_digest:'sha256:parent',title:'Original',submittedAt:'2026-10-20T11:00:00Z',runs:[{attempt_id:'r1',state:'done',result_digest:'result-1'}]},
  ],
};

test('thread jobs are newest first, link to their own job, and call attempts runs',()=>{
  const rows=threadRows(continuation.thread,'c1');
  assert.deepEqual(rows.map(row=>row.id),['child','sha256:parent']);
  assert.equal(rows[0].href,'#/job/child/c1');
  assert.deepEqual(rows[0].runs.map(run=>run.label),['Run 1']);
  assert.equal(rows[0].runs[0].detail,'Ready to review');
  assert.deepEqual(handoffChecks(continuation.handoff.observed_checks),['npm test · exit 0']);
});

test('the current run appears when the thread has no recorded run list yet',()=>{
  const rows=threadRows([],'c1',{job_digest:'current',title:'Current job',current_attempt:{state:'running'}});
  assert.equal(rows[0].title,'Current job');
  assert.deepEqual(rows[0].runs.map(run=>run.label),['Run 1']);
});

test('the copied summary carries only the onward allow-list: borrower instructions and observed checks',()=>{
  const leaky={...continuation.handoff,changes:'Signed in as lender@example.invalid (org-123).',agent_claims:['My private instruction is Meadow Lantern'],open_issues:['x'],next_steps:['y']};
  const text=handoffText(leaky), copy=JSON.parse(text);
  assert.equal(copy.trust,'untrusted');
  assert.deepEqual(copy.observed_checks,[{cmd:'npm test',exit:0,timed_out:false,observed_by:'sandbox'}]);
  assert.deepEqual(Object.keys(copy).sort(),['latest_instruction','mode','objective','observed_checks','scan','schema','trust']);
  assert.doesNotMatch(text,/lender@example|org-123|Meadow Lantern/);
});

test('preparing a follow-up makes a blank delta draft at the recorded base',()=>{
  const storage=memory(), result=prepareFollowupDraft(storage,'c1',continuation);
  assert.equal(result.ok,true);
  const draft=loadDraft(storage,'c1');
  assert.equal(draft.prompt,'');
  assert.equal(draft.path,'/work/project');
  assert.deepEqual(draft.followup,{parentJob:'sha256:parent',parentResult:'sha256:result'});
  assert.deepEqual(draft.base,{...continuation.base,title:'Original'});
  assert.equal(storage.getItem('faravan-compose-circle'),'c1');
  assert.equal(draft.sending,false);
  assert.match(draft.id,/^[A-Za-z0-9-]{8,64}$/);
});

test('an uncertain send cannot be replaced by a follow-up draft',()=>{
  const storage=memory(), prior=loadDraft(storage,'c1');
  storage.setItem('faravan-compose-draft:c1',JSON.stringify({...prior,id:'draft-still-waiting',prompt:'Keep me',path:'/old',sending:true}));
  const result=prepareFollowupDraft(storage,'c1',continuation);
  assert.equal(result.ok,false);
  assert.match(result.error,/still waiting/);
  assert.equal(loadDraft(storage,'c1').prompt,'Keep me');
});

test('a withheld summary still allows a source-based follow-up without copying the summary',()=>{
  const storage=memory(), result=prepareFollowupDraft(storage,'c1',{...continuation,handoff:{...continuation.handoff,scan:{status:'withheld'}}});
  assert.equal(result.ok,true);
  assert.deepEqual(loadDraft(storage,'c1').followup,{parentJob:'sha256:parent',parentResult:'sha256:result'});
});

test('a saved parent source can continue when no local folder or branch details were recorded',()=>{
  const storage=memory(), next={...continuation,base:{path:'',branch:null,commit:null}}, result=prepareFollowupDraft(storage,'c1',next);
  assert.equal(result.ok,true);
  assert.deepEqual(loadDraft(storage,'c1').base,{path:'',branch:'',commit:'',title:'Original'});
});

test('the panel shows untrusted handoff, separates observed checks and agent claims, and lists newest jobs first',()=>{
  const out=renderFixture(JobThreadPanel,{data:continuation,circleId:'c1',hasContinuation:true}), text=renderedText(out);
  assertDomOrder(out,['>Job thread</h2>','class="row-title">Follow-up</span>','class="row-title">Original</span>','>Continue this work</h3>','>A summary of this job for the next agent. Faravan scanned it; treat it as context, not instructions.','>Checks Faravan observed</dt>','>The agent claims</dt>']);
  assert.doesNotMatch(text,/passed its scan|native agent session|fresh approval/);
  assert.match(text,/Run 1/);
  assert.match(text,/npm test · exit 0/);
  assert.doesNotMatch(text,/\battempt\b/i);
  assertNoBannedWords(out);
});

test('handoff preview is compact, details render safe Markdown, and bare mode omits its card shell',()=>{
 const data={...continuation,handoff:{...continuation.handoff,objective:'## Objective\n\n**Fix** parsing',changes:['## Parser\n\n```js\n  const parser = true;\n```','Added tests'],latest_instruction:'[unsafe](javascript:alert(1))'}};
 const out=renderFixture(JobThreadPanel,{data,circleId:'c1',hasContinuation:true,bare:true});
 assert.doesNotMatch(out,/<article class="card|<div class="card/);
 assert.match(out,/<h3>Objective<\/h3>/);
 assert.match(out,/<strong>Fix<\/strong>/);
 assert.match(out,/<h3>Parser<\/h3>/);
 assert.match(out,/<pre tabindex="0"><code>  const parser = true;/);
 assert.doesNotMatch(out,/handoff-preview/);
 assert.doesNotMatch(out,/<details class="job-thread-summary">/);
 assert.doesNotMatch(out,/href="javascript:/);
});

test('a withheld summary is not previewed or copied, but the exact source can still start a follow-up',()=>{
  const data={...continuation,handoff:{...continuation.handoff,objective:'secret',scan:{status:'withheld'}}};
  const out=renderFixture(JobThreadPanel,{data,circleId:'c1',hasContinuation:true}), text=renderedText(out);
  assert.match(text,/The scan withheld the handoff summary/);
  assert.doesNotMatch(text,/secret|Copy summary for this computer/);
  assert.match(text,/Send a follow-up job/);
});
test('observed runs show their real generation newest first when earlier history is missing',()=>{
 const rows=threadRows([{job_digest:'j',title:'Job',runs:[{generation:2,state:'failed'},{generation:3,state:'completed'}]}],'c');
 assert.deepEqual(rows[0].runs.map(run=>run.label),['Run 3','Run 2']);
});

test('thread timestamps use short computer-zone calendar words without seconds',()=>{
 const now=Date.parse('2026-10-20T16:00:00Z');
 const thread=['2026-10-20T13:00:00Z','2026-10-19T13:00:00Z','2026-10-18T13:00:00Z'].map((submittedAt,index)=>({job_digest:String(index),submittedAt}));
 assert.deepEqual(threadRows(thread,'c',null,{now,zone:'America/Chicago'}).map(row=>row.submittedAt),['8:00 AM','Yesterday 8:00 AM','Oct 18, 8:00 AM']);
});
test('runs have exactly one shared state word and the current job is marked rather than linked',()=>{
 const thread=[{job_digest:'j',runs:[{generation:1,state:'completed',result_digest:'result'},{generation:2,state:'failed'}]}];
 const rows=threadRows(thread,'c',{job_digest:'j'});
 assert.equal(rows[0].current,true);
 assert.deepEqual(rows[0].runs.map(run=>run.detail),['Didn’t finish','Ready to review']);
 const out=renderFixture(JobThreadPanel,{threadData:{thread:[...thread,{job_digest:'other',title:'Other job'}]},circleId:'c',currentJob:{job_digest:'j'}});
 assert.match(renderedText(out),/This job/);assert.doesNotMatch(out,/href="#\/job\/j\/c"/);

});
test('follow-up base copy keeps the branch readable and exposes only a short commit',()=>{
 assert.deepEqual(followupBaseVM({branch:'faravan/result',commit:'c'.repeat(40)}),{label:'Continues: Earlier job',commit:'ccccccc'});
});

test('one-job threads hide the list and keep the continuation panel',()=>{
 const data={...continuation,thread:[continuation.thread[1]]};
 const out=renderFixture(JobThreadPanel,{data,circleId:'c1',hasContinuation:true});
 assert.doesNotMatch(out,/>Job thread<|job-thread-list/);
 assert.match(renderedText(out),/Continue this work/);
 assert.equal(renderFixture(JobThreadPanel,{threadData:{thread:data.thread},circleId:'c1'}),'');
});
test('finished current-job fallback uses the job state when its run has no state',()=>{
 const job={job_digest:'j',state:'result-accepted',result_digest:'result',current_attempt:{execution_started_at:'2026-10-20T11:19:00Z'}};
 const rows=threadRows([{job_digest:'j',runs:[]}],'c',job);
 assert.deepEqual(rows[0].runs,[{label:'Run 1',detail:'Ready to review'}]);
});

for(const previousKind of ['none','folder'])test(`no-project continuation replaces a stale ${previousKind} draft without acquiring a project`,()=>{
 const storage=memory();storage.setItem('faravan-compose-draft:c1',JSON.stringify({...loadDraft(storage,'c1'),sourceKind:previousKind,path:'/stale',verifyCmd:'npm test'}));
 const context={...continuation,sourceKind:'none',base:{path:'',branch:'',commit:''}};
 assert.equal(prepareFollowupDraft(storage,'c1',context).ok,true);
 const draft=loadDraft(storage,'c1');assert.equal(draft.sourceKind,'none');assert.equal(draft.path,'');assert.equal(draft.verifyCmd,'');
 assert.deepEqual(draftBody(draft,'c1'),{circle:'c1',prompt:'',draft_id:draft.id,followup:context.parentJob?{parentJob:context.parentJob,parentResult:context.parentResult}:null,result:{kind:'message'}});
});
test('a code continuation replaces an earlier no-project source choice',()=>{
 const storage=memory();storage.setItem('faravan-compose-draft:c1',JSON.stringify({...loadDraft(storage,'c1'),sourceKind:'none'}));
 assert.equal(prepareFollowupDraft(storage,'c1',continuation).ok,true);
 assert.equal(loadDraft(storage,'c1').sourceKind,'folder');
 assert.equal(draftBody(loadDraft(storage,'c1'),'c1').result,undefined);
});
test('a full-width bare handoff omits absent fields and redundant nested disclosure',()=>{
 const data={...continuation,handoff:{scan:{status:'passed'},objective:'A clear objective',changes:['A real change']}};
 const out=renderFixture(JobThreadPanel,{data,circleId:'c1',hasContinuation:true,bare:true});
 assert.doesNotMatch(out,/No latest instruction|No separate claims|No open issues|No next steps|job-thread-summary/);
 assert.match(out,/btn-secondary[^>]*>Copy summary/);
});
test('plain handoff preview preserves normal formatting and its output cap',()=>{
 assert.equal(plainPreview('## Objective\n\n**Fix** [parsing](https://example.test) ![diagram](image.png)\n- Next'),'Objective Fix parsing diagram Next');
 assert.equal(plainPreview('Before ```js\nhidden()\n``` after'),'Before after');
 assert.equal(plainPreview('x'.repeat(221)),'x'.repeat(219)+'…');
 assert.equal(plainPreview(null),'');
});
test('plain preview bounds 200000 adversarial characters before regexes',()=>{
 const input='['.repeat(200000);
 const start=performance.now(),preview=plainPreview(input),elapsed=performance.now()-start;
 assert.equal(preview,'['.repeat(219)+'…');
 assert.ok(elapsed<100,'preview took '+elapsed.toFixed(1)+' ms; expected under 100 ms');
});
// The authoritative projection for a job whose stop was requested but is not confirmed: its raw state is 'cancelled'.
const stopRequested = () => ({schemaVersion:2,kind:'job',phase:'stopping',reasonCode:'stop_unconfirmed',
  result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},
  evidence:{rawState:'cancelled',attemptPresent:true,approval:'approved',approvedAt:'2026-10-20T11:00:00Z',executionStartedAt:'2026-10-20T11:19:00Z',computeStopped:false},
  version:{},times:{observedAt:'2026-10-20T11:30:00Z',validUntil:null,nextTransitionAt:null},actionHints:[]});
const cancelledCurrent = () => ({job_digest:'sha256:current',title:'Follow-up',submittedAt:'2026-10-20T11:50:00Z',state:'cancelled',
  current_attempt:{attempt_id:'attempt-2',generation:2,state:'running',execution_started_at:'2026-10-20T11:19:00Z',compute_stopped:false},
  jobProjection:stopRequested()});
test('the current run of a job cancelled before its stop is confirmed reads from the job projection, not its raw state',()=>{
 assert.deepEqual(threadRows([],'c1',cancelledCurrent())[0].runs,[{label:'Run 2',detail:'Stop requested'}]);
 const recorded=threadRows([{job_digest:'sha256:current',runs:[
   {attempt_id:'attempt-1',generation:1,state:'completed',result_digest:'result-1'},
   {attempt_id:'attempt-2',generation:2,state:'running',execution_started_at:'2026-10-20T11:19:00Z',compute_stopped:false}]}],'c1',cancelledCurrent());
 assert.deepEqual(recorded[0].runs.map(run=>[run.label,run.detail]),[['Run 2','Stop requested'],['Run 1','Ready to review']]);
});
test('an older cancelled attempt is judged by its own stop evidence, and only a never-started cancel reads as Cancelled',()=>{
 const rows=threadRows([{job_digest:'sha256:older',runs:[
   {generation:1,state:'cancelled',execution_started_at:'2026-10-20T10:00:00Z',compute_stopped:false},
   {generation:2,state:'cancelled',execution_started_at:'2026-10-20T10:30:00Z',compute_stopped:true},
   {generation:3,state:'cancelled'}]}],'c1');
 assert.deepEqual(rows[0].runs.map(run=>run.detail),['Cancelled','Stopped','Stop not confirmed']);
});

test('F4 unsent prompt survives Keep, requires explicit Replace, and survives storage failure',()=>{
 const storage=memory(),key='faravan-compose-draft:c1';
 const original={...loadDraft(storage,'c1'),id:'draft-keep-123',prompt:'Do not lose my instructions'};
 storage.setItem(key,JSON.stringify(original));
 const blocked=prepareFollowupDraft(storage,'c1',continuation);
 assert.equal(blocked.ok,false);assert.equal(blocked.conflict,true);
 assert.equal(loadDraft(storage,'c1').prompt,original.prompt); // Keep/back performs no write.
 const failing={...storage,setItem(){throw new Error('quota');}};
 assert.equal(prepareFollowupDraft(failing,'c1',continuation,{replaceDraft:blocked.draftSnapshot}).ok,false);
 assert.equal(loadDraft(storage,'c1').prompt,original.prompt);
 assert.equal(prepareFollowupDraft(storage,'c1',continuation,{replaceDraft:blocked.draftSnapshot}).ok,true);
 assert.equal(loadDraft(storage,'c1').prompt,'');
 storage.setItem(key,JSON.stringify({...original,uncertainSince:123}));
 assert.equal(prepareFollowupDraft(storage,'c1',continuation,{replaceDraft:JSON.stringify(loadDraft(storage,'c1'))}).ok,false);
});
test('F10 thread failures and pending single-job snapshots remain visible with retry',()=>{
 for(const currentJob of [undefined,{job_digest:'current'}]){
  const html=renderFixture(JobThreadPanel,{threadError:new Error('offline'),currentJob,circleId:'c1',onRetry:()=>{}});
  assert.match(renderedText(html),/Couldn’t load this job thread. Try again./);
  assert.match(html,/<button[^>]*>Try again<\/button>/);
 }
 assert.match(renderedText(renderFixture(JobThreadPanel,{loading:true,currentJob:{job_digest:'current'}})),/Loading this job thread/);
 assert.equal(renderFixture(JobThreadPanel,{threadData:{thread:[{job_digest:'current'}]}}),'');
});

test('F6 rendered feed has one atomic polite region outside the keyboard transcript',()=>{
 const feed=transcriptFeedVM([{type:'assistant',timestamp:'1970-01-01T00:00:01Z',message:{content:[{type:'tool_use',id:'b',name:'Bash',input:{command:'sleep 2'}}]}}].map(record=>JSON.stringify(record)).join('\n'),{live:true});
 const html=renderFixture(AgentActivity,{feed,live:true,now:180000,bare:true});
 assert.equal((html.match(/aria-live="polite"/g)||[]).length,1);
 assert.match(html,/aria-atomic="true"/);
 assert.doesNotMatch(html,/feed-quiet[^>]*role="status"/);
 assert.match(html,/<ol[^>]*tabindex="0"[^>]*aria-label="What the agent is doing"/);
 assert.doesNotMatch(renderedText(html),/Still running|running for|Live/);
});

test('R1 historical running and unidentified current records do not claim present activity',()=>{
 const run={attempt_id:'old',state:'running',execution_started_at:'2026-10-20T10:00:00Z'};
 const historical=threadRows([{job_digest:'old',runs:[run]}],'c',null,{now:Date.parse('2026-10-31T09:00:00Z'),zone:'UTC'});
 assert.match(historical[0].runs[0].detail,/^Last reported .* — current activity unconfirmed$/);
 assert.match(historical[0].runs[0].detail,/working/i);
 const unidentified=threadRows([{job_digest:'j',runs:[{...run,attempt_id:undefined}]}],'c',{job_digest:'j',current_attempt:{state:'running'}});
 assert.match(unidentified[0].runs[0].detail,/current activity unconfirmed/);
});

test('local timestamp fallback sorts in the same order as displayed dates',()=>{
 const now=Date.parse('2026-10-20T16:00:00Z');
 const rows=threadRows([{job_digest:'older',submittedAt:'2026-10-20T10:00:00Z'},{job_digest:'newer',local:{submittedAt:'2026-10-20T12:00:00Z'}}],'c',null,{now,zone:'UTC'});
 assert.deepEqual(rows.map(row=>row.id),['newer','older']);
 assert.deepEqual(rows.map(row=>row.submittedAt),['12:00 PM','10:00 AM']);
});
test('three-change summaries have no inaccurate hidden-change teaser in either mode',()=>{
 const data={...continuation,handoff:{...continuation.handoff,changes:['One','Two','Three']}};
 for(const bare of [true,false]){
  const out=renderFixture(JobThreadPanel,{data,hasContinuation:true,bare});
  assert.doesNotMatch(renderedText(out),/more changes in the handoff summary/);
 }
});
test('summary copy discloses its safe subset before the action',()=>{
 const out=renderFixture(JobThreadPanel,{data:continuation,hasContinuation:true});
 assertDomOrder(out,['Copy summary includes only instructions and observed checks','class="pair job-thread-actions"']);
 assert.match(renderedText(out),/not agent-written changes, claims, open issues or next steps/);
});

test('lagging history merges the authoritative current attempt without mutating or duplicating runs',()=>{
 const current=cancelledCurrent(), old={attempt_id:'attempt-1',generation:1,state:'completed',result_digest:'result-1'};
 const runs=[old], thread=[{job_digest:current.job_digest,runs}];
 assert.deepEqual(threadRows(thread,'c1',current)[0].runs.map(run=>[run.label,run.detail]),[['Run 2','Stop requested'],['Run 1','Ready to review']]);
 assert.deepEqual(runs,[old]);
 const matched=threadRows([{...thread[0],runs:[old,{attempt_id:'attempt-2',generation:1,state:'running'}]}],'c1',current)[0].runs;
 assert.deepEqual(matched.map(run=>[run.label,run.detail]),[['Run 2','Stop requested'],['Run 1','Ready to review']]);
});
test('handoff loading and errors never announce absence, and follow-up promises need a complete source',()=>{
 const render=props=>renderFixture(JobThreadPanel,{hasContinuation:true,circleId:'c1',...props});
 const pending=render({continuationLoading:true});
 assert.match(renderedText(pending),/Loading the handoff summary/);
 assert.doesNotMatch(renderedText(pending),/No handoff summary|follow-up can still/);
 const error=render({error:new Error('offline')});
 assert.match(error,/role="alert"/);assert.doesNotMatch(renderedText(error),/No handoff summary|follow-up can still/);
 for(const fallback of [undefined,{parentJob:'parent',parentResult:'result'}]){
  const absent=renderedText(render({fallback}));
  assert.match(absent,/No handoff summary is available/);
  assert.doesNotMatch(absent,/follow-up can still|Send a follow-up job/);
 }
 for(const sourceKind of ['none','folder']){
  const text=renderedText(render({fallback:{...continuation,sourceKind}}));
  assert.match(text,sourceKind==='none'?/start in an empty folder/:/start from the prior result’s code/);
  assert.match(text,/Send a follow-up job/);
 }
});
test('handoff copy describes its unchanged safe allowlist and drops the obsolete teaser',()=>{
 for(const bare of [false,true]){
  const data={...continuation,handoff:{...continuation.handoff,changes:['One','Two','Three']}};
  const html=renderFixture(JobThreadPanel,{data,circleId:'c1',hasContinuation:true,bare}), text=renderedText(html);
  assert.match(text,/Copy summary includes only instructions and observed checks, not agent-written changes/);
  assert.doesNotMatch(text,/more changes in the handoff summary/);
  assert.deepEqual(Object.keys(JSON.parse(handoffText(data.handoff))).sort(),['latest_instruction','mode','objective','observed_checks','scan','schema','trust']);
 }
});
test('thread ordering shares the displayed local submission fallback',()=>{
 const rows=threadRows([{job_digest:'old',submittedAt:'2026-10-20T11:00:00Z'},{job_digest:'new',local:{submittedAt:'2026-10-20T12:00:00Z'}}],'c1',null,{now:Date.parse('2026-10-20T13:00:00Z'),zone:'UTC'});
 assert.deepEqual(rows.map(row=>row.id),['new','old']);assert.equal(rows[0].submittedAt,'12:00 PM');
});
test('a continuation-only panel has a panel-level heading',()=>{
 const html=renderFixture(JobThreadPanel,{data:{...continuation,thread:[]},hasContinuation:true,circleId:'c1'});
 assert.match(html,/<h2 class="t-title3">Continue this work<\/h2>/);
 assert.doesNotMatch(html,/<h3[^>]*>Continue this work/);
});
test('rendered transcript labels the user and names the actual tool disclosure content',()=>{
 const userFeed=transcriptFeedVM(JSON.stringify({type:'user',message:{content:[{type:'text',text:'Please update the README'}]}}));
 const user=renderFixture(AgentActivity,{feed:userFeed,bare:true});
 assert.match(user,/>User message<\/span>/);assert.match(renderedText(user),/Please update the README/);
 for(const [command,output,label] of [['echo one\necho two','','show command'],['echo one','one','show output'],['echo one\necho two','one\ntwo','show command and output']]){
  const records=[{type:'assistant',message:{content:[{type:'tool_use',id:'b',name:'Bash',input:{command}}]}},{type:'user',message:{content:[{type:'tool_result',tool_use_id:'b',content:output}]}}];
  const feed=transcriptFeedVM(records.map(record=>JSON.stringify(record)).join('\n'));
  const html=renderFixture(AgentActivity,{feed,bare:true});
  assert.ok(html.includes(', '+label+'"'));
 }
});

function RetryThreadParent({api,path='jobs/one/thread',continuationPath,invocations}) {
  const thread=useResource(api,path,0);
  const owned={...thread,reloadAndWait:()=>{
    invocations.push(path);
    return thread.reloadAndWait();
  }};
  return h(JobThread,{api,thread:owned,continuationPath,revision:0,circleId:'c1'});
}
async function retryThreadFixture(t,props={}) {
  installClock();resetPage();
  const api=createFakeApi(), invocations=[], notices=[];
  t.after(async()=>{
    await teardown();
    // Settle only owned ignored-abort responses, also when an assertion fails.
    for(const call of api.openReads(()=>true))call.settle('ok',{});
    await flush();
  });
  const original=Object.getOwnPropertyDescriptor(globalThis,'location');
  let reloads=0;
  const locationProxy=new Proxy(globalThis.location,{get(target,key){
    if(key==='reload')return ()=>{reloads++;};
    const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }});
  Object.defineProperty(globalThis,'location',{configurable:true,value:locationProxy});
  t.after(()=>Object.defineProperty(globalThis,'location',original));
  const notice={set:value=>notices.push(value),page:()=>1};
  const vnode=next=>h(Notices.Provider,{value:notice},
    h(RetryThreadParent,{api,invocations,...props,...next}));
  const view=await mount(vnode({}));
  return {api,invocations,notices,view,render:next=>view.rerender(vnode(next)),reloads:()=>reloads};
}
const retryFailure=()=>Object.assign(new Error('Read unavailable'),{status:400,code:'invalid_request'});
const retryRows=title=>({thread:[{job_digest:'one',title},{job_digest:'two',title:'Other thread job'}]});

test('mounted main thread retries its owning resource, waits for settlement and permits another failed retry',async t=>{
  const f=await retryThreadFixture(t), path='jobs/one/thread';
  await f.api.fail(path,retryFailure());
  assert.match(f.view.text(),/Couldn’t load this job thread/);
  const button=f.view.button('Try again');assert.ok(button);
  await click(button);await forceClick(button);await forceClick(button);
  assert.deepEqual(f.invocations,[path],'local Action gate, not transport dedup');
  assert.equal(f.api.count(path),2);
  assert.equal(button.getAttribute('aria-busy'),'true');
  await flush();
  assert.equal(button.getAttribute('aria-busy'),'true','must wait for the causal read');
  await f.api.fail(path,retryFailure());
  assert.match(f.view.text(),/Couldn’t load this job thread/);
  const again=f.view.button('Try again');assert.ok(again);
  assert.notEqual(again.getAttribute('aria-busy'),'true');
  await click(again);
  assert.deepEqual(f.invocations,[path,path],'failure settlement permits a later retry');
  await f.api.answer(path,retryRows('Recovered main'));
  assert.match(f.view.text(),/Recovered main/);
  assert.doesNotMatch(f.view.text(),/Couldn’t load|Saved\./);
  assert.equal(f.reloads(),0);
  assert.deepEqual(f.api.posts,[]);
  assert.ok(f.notices.every(value=>!value),'read recovery never announces Saved');
});

test('mounted continuation failure preserves main rows and retries only continuation',async t=>{
  const path='jobs/one/thread', continuationPath='jobs/one/continuation';
  const f=await retryThreadFixture(t,{continuationPath});
  await f.api.answer(path,retryRows('Main stays visible'));
  await f.api.fail(continuationPath,retryFailure());
  assert.match(f.view.text(),/Main stays visible/);
  const button=f.view.$('section[aria-label="Continue this work"] button');
  assert.ok(button);assert.equal(button.textContent.trim(),'Try again');
  await click(button);await forceClick(button);
  assert.equal(button.getAttribute('aria-busy'),'true');
  assert.equal(f.api.count(path),1);assert.equal(f.api.count(continuationPath),2);
  assert.deepEqual(f.invocations,[]);
  assert.match(f.view.text(),/Main stays visible/);
  await f.api.fail(continuationPath,retryFailure());
  await click(f.view.$('section[aria-label="Continue this work"] button'));
  assert.equal(f.api.count(continuationPath),3);
  await f.api.answer(continuationPath,continuation);
  assert.match(f.view.text(),/Main stays visible/);
  assert.match(f.view.text(),/Fix parsing/);
  assert.doesNotMatch(f.view.text(),/Saved\./);
  assert.ok(f.notices.every(value=>!value));
  assert.equal(f.reloads(),0);assert.deepEqual(f.api.posts,[]);
});

for(const target of ['main','continuation'])test('mounted '+target+' pending retry cannot publish after route switch or unmount',async t=>{
  const oldMain='jobs/one/thread',oldContinuation='jobs/one/continuation';
  const f=await retryThreadFixture(t,{continuationPath:oldContinuation});
  await f.api.answer(target==='main'?oldContinuation:oldMain,target==='main'?continuation:retryRows('Old main'));
  const failed=target==='main'?oldMain:oldContinuation;
  await f.api.fail(failed,retryFailure());
  await click(f.view.button('Try again'));
  const late=f.api.openReads(failed)[0];assert.ok(late);late.ignoreAbort=true;
  await f.render({path:'jobs/new/thread',continuationPath:'jobs/new/continuation'});
  assert.equal(late.signal.aborted,true);
  await f.api.answer('jobs/new/thread',retryRows('Successor main'));
  await f.api.answer('jobs/new/continuation',{...continuation,handoff:{...continuation.handoff,objective:'Successor summary'}});
  late.settle('ok',target==='main'?retryRows('Late old main'):
    {...continuation,handoff:{...continuation.handoff,objective:'Late old summary'}});
  await flush();
  assert.match(f.view.text(),/Successor main/);
  assert.match(f.view.text(),/Successor summary/);
  assert.doesNotMatch(f.view.text(),/Late old|Saved\./);
  // Start a separately owned failed resource, retry it, and leave before its response.
  await f.render({path:'jobs/last/thread',continuationPath:undefined});
  await f.api.fail('jobs/last/thread',retryFailure());
  await click(f.view.button('Try again'));
  const abandoned=f.api.openReads('jobs/last/thread')[0];abandoned.ignoreAbort=true;
  await f.view.unmount();
  assert.equal(abandoned.signal.aborted,true);
  abandoned.settle('ok',retryRows('Unmounted response'));await flush();
  assert.equal(document.body.textContent,'');
  assert.ok(f.notices.every(value=>!value));
  assert.deepEqual(f.api.posts,[]);assert.equal(f.reloads(),0);
});
