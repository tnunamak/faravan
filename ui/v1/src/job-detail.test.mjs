import test from 'node:test';
import assert from 'node:assert/strict';
import {jobDiffVM, jobDetailVM, howItRanVM, agentSummaryVM, jobStatusVM, startedLineVM, jobRoleVM, createdJobVM, applyCommandVM, runDurationVM, jobRetentionVM} from './view-models.mjs';
import {ChangesView} from './jobs.jsx';
import {ApplyBody} from './apply-sheet.jsx';
import {renderFixture, renderedText} from './render.test-helper.mjs';
const stopObservation = verified => ({schemaVersion:2,kind:'job',phase:'stopping',reasonCode:'stop_unconfirmed',
  result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},
  evidence:{rawState:'stop-requested',attemptPresent:true,approval:'approved',approvedAt:'2026-10-20T03:54:00Z',executionStartedAt:'2026-10-20T03:55:00Z',computeStopped:false,...(verified?{stopVerification:'failed'}:{})},
  version:{},times:{observedAt:'2026-10-20T04:00:00Z',validUntil:null,nextTransitionAt:null},actionHints:[]});

test('O-G: the lender stop page names the borrower it knows, and the fallback uses a curly apostrophe', () => {
  const job = {state:'failed', current_attempt:{holder:'me', state:'failed', reason:'stopped_by_lender', execution_started_at:'2026-10-20T03:55:00Z'}};
  assert.equal(jobStatusVM(job, {role:'ran', requester:'Alex Example', lender:'Maya Okafor'}).headline, 'You stopped Alex Example’s job.');
  const unnamed = jobStatusVM(job, {role:'ran'}).headline;
  assert.equal(unnamed, 'You stopped the borrower’s job.');
  assert.doesNotMatch(unnamed, /'/);
});

const patch = {diff: 'diff --git a/math.js b/math.js\nindex 123..456 100644\n--- a/math.js\n+++ b/math.js\n@@ -3,2 +3,2 @@\n export function add(a, b) {\n- return a - b;\n+ return a + b;\n', files: [{path: 'math.js', insertions: 1, deletions: 1}], diffstat: {files: 1, insertions: 1, deletions: 1}, command: 'faravan apply sha256:secret'};
test('single-file diff leaves metadata for the shared Job details disclosure', () => {
  const vm = jobDiffVM(patch), rows = vm.files[0].rows;
  assert.deepEqual(rows.slice(1).map(r => [r.kind, r.old, r.next]), [['ctx',3,3], ['del',4,''], ['add','',4]]);
  const html = renderFixture(ChangesView, {data: patch});
  assert.doesNotMatch(html, /aria-label="Changed files"/);
  assert.equal((html.match(/<code>math.js<\/code>/g) || []).length, 1);
  assert.match(html, /<div class="diff-row diff-add"/);
  assert.match(renderedText(html), /\+ return a \+ b;/);
  assert.doesNotMatch(html,/<summary>Details/);
  assert.match(vm.details,/diff --git/);
  assert.doesNotMatch(html, /faravan apply|Check result|Your verdict/);
  assert.equal(jobDiffVM({diff:'@@ -0,0 +1 @@\n+x\n'}).files[0].rows[1].next, 1);
});

test('multiple changed files keep the navigation list', () => {
  const html = renderFixture(ChangesView, {data:{...patch,files:[...patch.files,{path:'test.js',insertions:1,deletions:0}]}});
  assert.ok(html.indexOf('Changed files') < html.indexOf('diff-scroll'));
});

test('lender receipt uses recorded agent, completion time and explicit missing facts', () => {
  const receipt = {harness:'claude-code-subscription',duration_ms:840000,finished_at:'2026-10-20T02:41:00Z'};
  const page = jobDetailVM({state:'result-accepted',receipt}, {role:'ran',recipient:'faravan-borrower',agent:'Any agent',zone:'America/Chicago'});
  assert.equal(page.receiptTitle,'You ran faravan-borrower’s job');
  assert.equal(page.receiptContext,'Result sent back at 9:41 PM · 14 min of Claude Code');
  assert.match(howItRanVM({receipt},{role:'ran'}).missing,/Cleanup.*not recorded/);
  assert.match(howItRanVM({current_attempt:{execution_started_at:'2026-10-20T02:40:00Z'}},{role:'ran'}).missing,/agent, time used and cleanup.*not recorded/i);
});

const check = {cmd:'npm test', exit:0, timed_out:false, parser:'npm', summary:'49 passed', observed_by:'sandbox', changed_test_files:['tests/math.test.js']};
test('signed snake_case sandbox checks keep observer, summary and changed test files', () => {
  for (const job of [{checks:[check]}, {result:{checks:[check]}}, {receipt:{checks:[check]}}]) {
    const vm = howItRanVM(job);
    assert.equal(vm.checks.length, 1);
    assert.equal(vm.checks[0].text, 'Faravan ran `npm test` after the agent finished: exit 0 · 49 passed');
    assert.doesNotMatch(vm.checks[0].text, /The agent says it ran/);
    assert.deepEqual(vm.checks[0].changedTests, ['tests/math.test.js']);
  }
  assert.match(howItRanVM({checks:[{...check, timed_out:true, exit:null}]}).checks[0].text, /timed out/);
  assert.equal(howItRanVM({checks:[]}).checksEmpty, true);
  assert.equal(howItRanVM({}).checksEmpty, false);
  assert.deepEqual(howItRanVM({}).checks, []);
});

test('lender receipt has no result actions; terminal failures have no transcript controls', () => {
  const receipt = jobDetailVM({state:'result-accepted', receipt:{duration_ms:840000, harness:'codex'}}, {role:'ran', recipient:'Sam'});
  assert.equal(receipt.receipt, true); assert.equal(receipt.result, false);
  assert.equal(receipt.receiptTitle, 'You ran Sam’s job'); assert.match(receipt.receiptContext, /14 min/);
  for (const state of ['failed','expired','cancelled']) {
    const page = jobDetailVM({state, compute_stopped:true}, {role:'sent'});
    assert.equal(page.terminal, true); assert.equal(page.canReadTranscript, state==='failed'); assert.equal(page.canResend, true);
  }
  assert.equal(jobDetailVM({state:'queued'}, {role:'sent'}).canReadTranscript, false);
  assert.equal(jobDetailVM({state:'running',current_attempt:{execution_started_at:'2026-10-20T10:00:00Z'}}, {role:'sent'}).canReadTranscript, true);
});

test('only the actual executing device sees the lender receipt, and created-job state is route bound', () => {
  assert.equal(jobRoleVM({current_attempt:{holder:'lender'}},'third-member'),'viewer');
  assert.equal(jobRoleVM({current_attempt:{holder:'lender'}},'lender'),'ran');
  assert.equal(jobDetailVM({state:'result-accepted'},{role:'viewer'}).receipt,false);
  const seed={job_digest:'job',circle:{id:'circle'},title:'Fix the sum',prompt:'Fix it',submittedByMe:true};
  assert.equal(createdJobVM(seed,'other','circle'),null); assert.equal(createdJobVM(seed,'job','other'),null);
  const job=createdJobVM(seed,'job','circle'); assert.equal(jobRoleVM(job,'me'),'sent'); assert.equal(jobStatusVM(job).key,'waiting'); assert.equal(job.local.title,'Fix the sum');
  assert.equal(applyCommandVM({digest:'sha256:'+'a'.repeat(64),circle:'My friends',branch:'fix; echo bad'}),"faravan apply aaaaaaaaaaaa --branch 'fix; echo bad'");
});

test('source folder prefills from the recorded path; sheet command uses a short job id', () => {
  assert.equal(jobDetailVM({local:{sourcePath:'/home/sam/project'}}).sourceFolder, '/home/sam/project');
  const html = renderFixture(ApplyBody, {phase:'form', repo:'/home/sam/project', digest:'sha256:'+'a'.repeat(64)});
  assert.match(html, /value="\/home\/sam\/project"/);
  assert.match(renderedText(html), /Show the add-branch command \$ faravan apply a{12}/);
  assert.doesNotMatch(html, /sha256:/);
  assert.equal(startedLineVM({device:'sandpiper'}), 'Started on sandpiper.');
});

test('agent summary comes only from agent messages, never command output or sandbox checks', () => {
  assert.equal(agentSummaryVM('{"type":"item.completed","item":{"type":"command_execution","text":"49 passed"}}'), '');
  assert.equal(agentSummaryVM('{"type":"item.completed","item":{"type":"agent_message","text":"Fixed the sum."}}'), 'Fixed the sum.');
  assert.equal(agentSummaryVM('raw output'), '');
});

test('unconfirmed stop changes at two minutes and names the hard stop time', () => {
  const at=Date.parse('2026-10-20T04:00:00Z'), job={state:'cancelled',current_attempt:{execution_started_at:'2026-10-20T03:55:00Z',compute_stopped:false},runTiming:{stopRequestedAt:new Date(at).toISOString(),hardStopAt:'2026-10-20T04:15:00Z'}};
  assert.equal(jobStatusVM(job,{now:at+119999}).key,'stop_requested');
  const vm=jobStatusVM({...job,jobProjection:stopObservation(true)},{now:at+120000,zone:'UTC'});
  assert.equal(vm.key,'stop_unconfirmed'); assert.match(vm.text,/Its configured stop time is 4:15 AM/);
  assert.match(vm.text,/Faravan has not confirmed that it stopped/);
  assert.doesNotMatch(vm.text,/can’t run past|has stopped|stopped at/);
  assert.equal(vm.canStop,false);
  assert.equal(jobStatusVM({...job,current_attempt:{...job.current_attempt,compute_stopped:true}},{now:at+120000}).key,'stopped');
});



test('a viewer is never described as the sender in terminal and stop states', () => {
  assert.equal(jobStatusVM({state:'cancelled',compute_stopped:true},{role:'viewer'}).headline,'This job was cancelled before it started');
  assert.match(jobStatusVM({state:'failed'},{role:'viewer'}).text,/^No completed result came back\./);
  assert.match(jobStatusVM({state:'stop-requested'},{role:'viewer',lender:'Sam'}).headline,/^The sender asked/);
});


test('receipt time preserves zero and sub-minute runs instead of inflating a minute', () => {
 for (const [duration_ms,short,long] of [[0,'0 s','0 seconds'],[22314,'22 s','22 seconds'],[65000,'1 min 5 s','1 minute 5 seconds']]) {
  assert.deepEqual(runDurationVM(duration_ms),{short,long});
  const job={state:'result-accepted',receipt:{harness:'codex',duration_ms}};
  assert.match(jobDetailVM(job,{role:'ran'}).receiptContext,new RegExp(short));
  assert.ok(howItRanVM(job).lines.some(line=>line.text.includes('Used '+long+' of')));
 }
 assert.equal(runDurationVM(-1),null);assert.equal(runDurationVM(undefined),null);
});

test('run status reports recorded hard stops, stop events and failure causes without invented checks', () => {
 const job={state:'running',current_attempt:{execution_started_at:'2026-10-20T03:00:00Z'},runTiming:{hardStopAt:'2026-10-20T03:20:00Z'}};
 const vm=jobStatusVM(job,{now:Date.parse('2026-10-20T03:05:00Z'),zone:'UTC'});
 assert.ok(vm.facts.some(fact=>fact.includes('Time limit 3:20 AM')));
 assert.doesNotMatch(JSON.stringify(vm.progress),/checks/);
 const stopped={...job,state:'cancelled',compute_stopped:true,current_attempt:{...job.current_attempt,stopped_at:'2026-10-20T03:04:00Z'}};
 assert.equal(jobStatusVM(stopped,{now:Date.parse('2026-10-20T04:00:00Z')}).headline,'Stopped after 4 minutes');
 assert.equal(jobStatusVM({...stopped,current_attempt:{...stopped.current_attempt,stopped_at:null}}).headline,'Stopped');
 assert.doesNotMatch(jobStatusVM({...job,state:'expired'}).headline,/Nobody took/);
 assert.doesNotMatch(jobStatusVM({state:'unknown'}).text,/offline/);
 assert.doesNotMatch(jobStatusVM({state:'claimed',current_attempt:{}}).text,/preparing a sandbox|has your job/);
 assert.equal(jobStatusVM({state:'failed',failure:{code:'wall_timeout'}}).recovery,'followup');
 assert.equal(jobStatusVM({state:'failed',failure:{code:'execution_failed'}}).headline, "The agent couldn't finish.");
 assert.doesNotMatch(jobStatusVM({state:'failed',failure:{code:'unknown'}}).headline,/stopped answering/);
 assert.match(jobStatusVM({state:'failed',safety:{budget_minutes:20},current_attempt:{reason:JSON.stringify({code:'wall_timeout'})}}).headline,/20-minute limit/);
});

test('retention distinguishes loading, unknown, error and a recorded date', () => {
 assert.match(jobRetentionVM({}),/Loading/);
 assert.match(jobRetentionVM({data:{}}),/hasn’t reported/);
 assert.match(jobRetentionVM({error:{status:500}}),/couldn’t be loaded/);
 assert.match(jobRetentionVM({data:{retained_until:'2026-11-20T12:00:00Z'}},'UTC'),/November 20, 2026/);
});

test('receipt context keeps zero and short measured durations in seconds', () => {
 for(const [duration_ms,label] of [[0,'0 s'],[500,'1 s'],[59000,'59 s']]) assert.ok(jobDetailVM({state:'result-accepted',receipt:{duration_ms,harness:'codex'}},{role:'ran'}).receiptContext.includes(label+' of Codex'));
});

test('intermediate assistant narration is never a result summary',()=>{
 assert.equal(agentSummaryVM(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'I will inspect the parser.'}]}})), '');
});
test('lender headline uses this computer and the requester perspective',()=>{
 const vm=jobStatusVM({state:'claimed',historyIdentity:{deviceName:'Sam'},current_attempt:{execution_started_at:'2026-10-20T10:00:00Z'}},{role:'ran',lender:'Tessa',agent:'Claude Code'});
 assert.equal(vm.headline,'Your Claude Code is running Sam’s job');
});

test('lender properties speak about this computer and its owner',()=>{
 const ran=howItRanVM({receipt:{harness:'codex',duration_ms:48000}},{role:'ran',compact:true});
 const text=ran.lines.map(line=>line.text).join(' ');
 assert.match(text,/Ran here with Codex/);assert.match(text,/your Codex time/);
 assert.doesNotMatch(text,/lender’s|Removal of the sandbox wasn’t confirmed/);
});

test('a locally submitted job keeps its borrower role without optional presentation metadata or roster identity',()=>{
  const job={state:'result-accepted',borrowerCircle:'circle',current_attempt:{holder:'other-computer'}};
  for(const device of [undefined,'this-computer']){
    const role=jobRoleVM(job,device);
    assert.equal(role,'sent');
    assert.equal(jobDetailVM(job,{role}).result,true);
    assert.equal(jobDetailVM(job,{role}).receipt,false);
  }
});

// Judge r9 O-E: the lender's own pending stop reads as stopping on the job page, with no fresh Stop button.
test('the lender’s pending stop reads as stopping with no fresh Stop', async () => {
  const {adaptLegacyJob, locallyStoppingJobProjection} = await import('../../../lib/v1/state-projection.mjs');
  const running = adaptLegacyJob({state:'claimed', current_attempt:{execution_started_at:'2026-10-22T09:00:00Z'}});
  const job = {state:'claimed', jobProjection:locallyStoppingJobProjection(running)};
  const vm = jobStatusVM(job, {role:'ran', requester:'Alex Example'});
  assert.equal(vm.headline, 'Stopping Alex Example’s job');
  assert.equal(vm.canStop, false);
  assert.doesNotMatch(vm.headline + vm.text, /Running|asked to stop/);
});

test('the requester projection of a job running on another computer carries the observed start and hard stop into the status line', () => {
  // The shape the requester app receives from the coordinator for a job the lender started (captured from the two-computer journey).
  const jobProjection = {schemaVersion:2,kind:'job',phase:'running',reasonCode:null,result:{available:false,digest:null},
    application:{outcome:null,appliedBranch:null},
    evidence:{rawState:'claimed',approval:'approved',approvedAt:null,executionStartedAt:'2026-11-02T01:30:12Z',executionStartRequestedAt:'2026-11-02T01:30:12Z',
      hardStopAt:'2026-11-02T01:50:12.000Z',sharedStopRequestedAt:null,computeStopped:false,stoppedAt:null,failurePhase:null,previousAttemptState:null,previousReason:null,
      previousAttemptHolder:null,waitingExplanation:null,attemptPresent:true,resultDigest:null,applicationPresent:false},
    version:{jobDigest:'sha256:6ac82cab9080b104ed03691685755e6f957666e5c5299d58141dc950673ad84d',attemptId:'e923a3c5-3858-4e1c-a90c-0d3717ad6069',generation:1,semanticDigest:'f97272d1ea749ca1b1723b6b8ce3322eaf635aa15602dbe086d349292352374e'},
    times:{observedAt:'2026-11-02T01:30:17.406Z',validUntil:null,nextTransitionAt:null},actionHints:['cancel']};
  const vm = jobStatusVM({jobProjection, runTiming:{stopRequestedAt:null,hardStopAt:'2026-11-02T01:50:12.000Z'}},
    {now:Date.parse('2026-11-02T01:31:00Z'), zone:'UTC', role:'sent', lender:'Alex Rivera', agent:'codex'});
  assert.equal(vm.key, 'working');
  assert.deepEqual(vm.facts, ['Started 1:30 AM (48 s ago) · Time limit 1:50 AM']);
});
