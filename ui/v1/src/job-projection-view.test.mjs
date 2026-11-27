import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {cancelledJobProjection, confirmedAppliedJob, formatJobProjection} from './job-projection-view.mjs';
import {formatDate} from './dates.mjs';
import {jobRowVM, jobStateKey, jobStateView, jobStatusVM, jobVM, waitingCopyVM} from './view-models.mjs';

const time = '2026-10-21T12:00:00.000Z';
const digest = 'sha256:' + 'a'.repeat(64);
const phases = [
  ['waiting', null, 'queued', {}, 'waiting'],
  ['approval_pending', 'approval_pending', 'claimed', {approval:'pending'}, 'waiting_approval'],
  ['approved', null, 'claimed', {approval:'approved'}, 'approved'],
  ['starting', null, 'starting', {approval:'approved'}, 'starting'],
  ['running', null, 'running', {executionStartedAt:time}, 'working'],
  ['stopping', 'stop_unconfirmed', 'stop-requested', {}, 'stop_requested'],
  ['stopped', 'compute_stopped', 'cancelled', {computeStopped:true}, 'stopped'],
  ['failed', 'wall_timeout', 'failed', {}, 'failed'],
  ['expired', 'expired', 'expired', {}, 'expired'],
  ['result_accepted', null, 'result-accepted', {}, 'no_changes'],
  ['unknown', 'observation_unavailable', 'new-state', {}, 'unknown'],
  ['failed', 'agent_exit_nonzero', 'failed', {}, 'failed'],
  ['failed', 'agent_group_not_ceased', 'failed', {}, 'failed'],
  ['failed', 'agent_run_failed', 'failed', {}, 'failed'],
];
function projection([phase, reasonCode, rawState, facts]) {
  const accepted = phase === 'result_accepted';
  const evidence = {rawState, attemptPresent:phase !== 'waiting', approval:null, approvedAt:null,
    executionStartedAt:null, computeStopped:false, ...facts};
  return {schemaVersion:2,kind:'job',phase,reasonCode,
    result:{available:accepted,digest:accepted?digest:null},
    application:{outcome:null,appliedBranch:null},evidence,version:{jobDigest:digest},
    times:{observedAt:time,validUntil:null,nextTransitionAt:null},actionHints:[]};
}

test('job list and detail format the same validated projection when raw lifecycle fields disagree', () => {
  for (const row of phases) {
    const [phase,,,, expected] = row;
    const job = {job_digest:digest,jobProjection:projection(row),state:'queued',status:'Waiting',approval:'pending',
      executionProof:false,compute_stopped:false,current_attempt:{state:'active',execution_started_at:null},
      applied:{branch:'misleading-branch'},resultSummary:{noChanges:true}};
    const status = jobStatusVM(job, {now:Date.parse(time)});
    assert.equal(jobStateKey(job), expected, phase + ' key');
    assert.equal(status.key, expected, phase + ' detail');
    assert.equal(jobStateView(job).key, expected, phase + ' state view');
    assert.equal(jobStateKey(job), status.key, phase + ' list/detail phase');
  }
});

for (const state of ['claimed','starting','running']) test(state + ' preparing copy survives actual projection and view mapping', () => {
  const input = {state,current_attempt:{execution_started_at:time,execution_observed_at:null},
    waiting_message:'Nobody can take it right now',statusContract:{lifecycle:'waiting',explanation:'Nobody can take it right now'},
    offerWaiting:{readyCount:0,dailyLimitCount:2},declined_count:1};
  const projected = formatJobProjection(input).projection;
  for (const job of [input,{...input,jobProjection:projected}]) {
    assert.equal(formatJobProjection(job).key,'waiting');
    assert.equal(waitingCopyVM(job).headline,'A computer took this job and is getting ready.');
    assert.equal(waitingCopyVM(job).text,'');
    assert.equal(waitingCopyVM(job).previousDecision,'');
    assert.equal(jobRowVM(job).reason,'A computer took this job and is getting ready.');
    assert.equal(jobStatusVM(job).executionStarted,false);
  }
  assert.equal(formatJobProjection({...input,approval:'pending'}).key,state === 'claimed' ? 'waiting_approval' : 'unknown');
  assert.equal(formatJobProjection({...input,current_attempt:{execution_observed_at:time}}).key,'working');
});
test('preparing copy does not replace queued or missing evidence', () => {
  assert.equal(formatJobProjection({state:'queued'}).preparing,false);
  assert.equal(formatJobProjection({}).key,'unknown');
});

test('application and result overlays decorate accepted results only', () => {
  const accepted = projection(phases.find(([phase])=>phase==='result_accepted'));
  accepted.application.appliedBranch = 'feature/verified';
  assert.equal(formatJobProjection({jobProjection:accepted,state:'running'}).key, 'added_branch');
  const branchVM=jobVM({jobProjection:accepted,resultSummary:{noChanges:true}},'sent');
  assert.equal(branchVM.key,'added_branch');
  assert.equal(branchVM.noChanges,false);
  assert.equal(formatJobProjection({jobProjection:projection(phases[4]),resultSummary:{noChanges:true}}).key, 'working');
  assert.equal(formatJobProjection({jobProjection:projection(phases.find(([phase])=>phase==='result_accepted')),resultSummary:{noChanges:true}}).key, 'no_changes');
});

test('a stopping projection stays pending without explicit failed-verification evidence', () => {
  const pending=projection(phases[5]);
  assert.equal(formatJobProjection({jobProjection:pending}).key,'stop_requested');
  pending.evidence.stopVerification='failed';
  assert.equal(formatJobProjection({jobProjection:pending}).key,'stop_unconfirmed');
});

test('a post-cancel authoritative stopped projection advances past the acknowledgement', () => {
  const at = observedAt => ({...projection(phases[5]),times:{observedAt,validUntil:null,nextTransitionAt:null}});
  const acknowledgement = {jobProjection:at('2026-10-21T12:00:00.000Z')};
  const olderRead = {jobProjection:{...projection(phases[4]),times:{observedAt:'2026-10-21T11:59:59.000Z',validUntil:null,nextTransitionAt:null}}};
  const stopped = {jobProjection:{...projection(phases[6]),times:{observedAt:'2026-10-21T12:00:02.000Z',validUntil:null,nextTransitionAt:null}}};

  assert.equal(cancelledJobProjection(olderRead,acknowledgement).phase,'stopping',
    'the acknowledgement remains visible while the detail resource is still the old read');
  assert.equal(cancelledJobProjection(stopped,acknowledgement,{hasNewerRead:true}).phase,'stopped',
    'a later valid server projection replaces the optimistic acknowledgement');
  assert.equal(cancelledJobProjection({jobProjection:{phase:'result_accepted'}},acknowledgement,{hasNewerRead:true}).phase,'stopping',
    'an invalid follow-up projection does not restore an earlier runnable or ready state');
  const unknownAcknowledgement={jobProjection:{...projection(phases[10]),times:{observedAt:'2026-10-21T12:00:00.000Z',validUntil:null,nextTransitionAt:null}}};
  assert.equal(cancelledJobProjection(stopped,unknownAcknowledgement,{hasNewerRead:true}).phase,'stopped',
    'a confirmed server read also recovers when the cancellation acknowledgement is unknown');
});

test('confirmed apply decorates accepted results only and keeps their execution phase', () => {
  const accepted={jobProjection:projection(phases[9])};
  const applied=confirmedAppliedJob(accepted,{branch:'faravan/fix-login',repo:'/work/project'});
  assert.equal(formatJobProjection(applied).key,'added_branch');
  assert.equal(confirmedAppliedJob({jobProjection:projection(phases[4])},{branch:'faravan/fix-login'}).jobProjection.phase,'running');
  assert.equal(confirmedAppliedJob({jobProjection:projection(phases[10])},{branch:'faravan/fix-login'}).jobProjection.phase,'unknown');
});

test('legacy cancellation needs attempt evidence before compute-stopped can override never-started', () => {
  assert.equal(formatJobProjection({state:'cancelled',compute_stopped:true}).key,'cancelled');
  assert.equal(formatJobProjection({state:'cancelled',current_attempt:{compute_stopped:false}}).key,'stop_requested');
  assert.equal(formatJobProjection({state:'cancelled',current_attempt:{compute_stopped:true}}).key,'stopped');
});

test('stopped duration uses the projection evidence timestamps', () => {
  const stopped=projection(phases[6]);
  stopped.evidence.executionStartedAt='2026-10-21T11:55:00.000Z';
  stopped.evidence.stoppedAt=time;
  assert.equal(jobStatusVM({jobProjection:stopped},{now:Date.parse(time)}).headline,'Stopped after 5 minutes');
});

test('job actions use the projected execution phase and exact attempt identity',()=>{
  const running=projection(phases[4]);
  running.version={jobDigest:digest,attemptId:'attempt-a',generation:4};
  const runningVM=jobStatusVM({jobProjection:running},{role:'ran'});
  assert.equal(runningVM.executionStarted,true);
  assert.deepEqual(runningVM.attemptTarget,{attemptId:'attempt-a',generation:4});

  const unknown=projection(phases[10]);
  unknown.version={jobDigest:digest,attemptId:'attempt-a',generation:4};
  const unknownVM=jobStatusVM({jobProjection:unknown},{role:'ran'});
  assert.equal(unknownVM.executionStarted,false);
  assert.deepEqual(unknownVM.attemptTarget,{attemptId:'attempt-a',generation:4});
  unknown.version={jobDigest:digest,attemptId:null,generation:null};
  assert.equal(jobStatusVM({jobProjection:unknown},{role:'ran'}).attemptTarget,null,
    'a lender action has no target without a complete projected identity');
});

test('waiting copy uses canonical prior-attempt and explanation evidence', () => {
  const waiting = projection(phases[0]);
  waiting.evidence = {...waiting.evidence, previousAttemptState:'released', previousReason:null,
    previousAttemptHolder:'holder-1', waitingExplanation:'Available computers have reached their daily limit.'};
  const job = {jobProjection:waiting, circle:{id:'friends'}, state:'running', waiting_message:'Contradictory raw copy'};
  const copy = waitingCopyVM(job, {devices:{circles:[{circle:'friends',members:[{key_id:'holder-1',localName:'Sam'}]}]}});
  assert.equal(copy.headline, 'Available computers have reached their daily limit.');
  assert.equal(copy.previousDecision, 'Sam couldn’t start it; it’s open again.');

  waiting.evidence.previousReason = 'approval_denied';
  waiting.evidence.previousAttemptState = 'released';
  assert.equal(waitingCopyVM({jobProjection:waiting}, {lender:'Ana'}).previousDecision,
    'Ana declined this request. It went back to the circle; another computer can pick it up.');
});

test('an invalid explicit v2 projection fails closed instead of adapting contradictory raw fields', () => {
  const job = {jobProjection:{schemaVersion:2,kind:'job',phase:'running',reasonCode:null},state:'result-accepted'};
  assert.equal(formatJobProjection(job).key, 'unknown');
});

test('migrated lifecycle formatters and pages do not interpret raw lifecycle fields', () => {
  const source = readFileSync(new URL('./view-models.mjs', import.meta.url), 'utf8');
  const body = name => {
    const start = source.indexOf('export function ' + name + '(');
    assert.notEqual(start, -1, name + ' exists');
    let parens=0, close=-1;
    for(let i=source.indexOf('(',start);i<source.length;i++){
      if(source[i]==='(')parens++;
      if(source[i]===')'&&--parens===0){close=i;break;}
    }
    assert.notEqual(close,-1,name+' parameters close');
    let depth = 0, opened = false;
    for (let i = source.indexOf('{', close); i < source.length; i++) {
      if (source[i] === '{') { depth++; opened = true; }
      if (source[i] === '}' && --depth === 0 && opened) return source.slice(start, i + 1);
    }
    throw new Error('unclosed function ' + name);
  };
  const forbidden = /\b(?:job|attempt)\.(?:state|status|current_attempt|executionProof|compute_stopped|applied)\b|statusContract/;
  for (const name of ['jobRowVM','jobStateKey','jobStateView','jobStatusVM'])
    assert.doesNotMatch(body(name), forbidden, name + ' must consume the projection formatter');
  for (const name of ['jobRowVM','jobStateKey','jobStateView','jobStatusVM','waitingCopyVM'])
    assert.doesNotMatch(body(name), /job\.waiting_(?:message|reason)/, name + ' must use the central compatibility formatter');
  for (const file of ['jobs.jsx','job-view.jsx']) {
    const page = readFileSync(new URL('./' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(page, /job\.status\b|job\.state\b|statusContract|current_attempt\?\.(?:state|execution_started_at|compute_stopped)/,
      file + ' must not classify lifecycle from raw fields');
  }
  const helpers = readFileSync(new URL('./helpers.mjs', import.meta.url), 'utf8');
  const genericStatus = helpers.slice(helpers.indexOf('export function statusView('), helpers.indexOf('// The agent\'s product name'));
  assert.match(genericStatus, /executionProof === false/);
  assert.match(genericStatus, /computeStopped !== true && facts\.neverStarted !== true/);
  assert.doesNotMatch(helpers, /String\(job\.(?:status|state)/, 'waiting copy uses the centralized projection adapter');
  const main = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
  const staleExclusions = main.match(/shellDataStale\s*=\s*stale\s*&&\s*!\[([^\]]+)\]\.includes\(route\.page\)/);
  assert.ok(staleExclusions, 'the shell freshness guard lists routes handled by their own resource readers');
  const excludedPages = [...staleExclusions[1].matchAll(/'([^']+)'/g)].map(([, page]) => page);
  assert.ok(excludedPages.includes('job') && excludedPages.includes('jobs'), 'job pages own their resource freshness');
});

// A launch whose run can no longer be confirmed: the sender sees why the job waits and when Faravan retries.
test('a fenced launch explains itself to the sender, with the time it retries', () => {
  const job = {state: 'claimed', job_digest: digest, approval: 'approved', expiry: Date.parse('2026-10-20T14:00:00Z') / 1000,
    current_attempt: {attempt_id: '11111111-1111-4111-8111-111111111111', job_digest: digest, generation: 1,
      holder: 'sha256:' + 'c'.repeat(64), state: 'released', claimed_at: '2026-10-20T11:55:00Z',
      lease_expires_at: '2026-10-20T12:05:00Z', execution_started_at: '2026-10-20T12:01:00Z', execution_observed_at: null,
      reason: 'lease_expired', compute_stopped: false, stopped_at: null}};
  const view = formatJobProjection({
    ...job,
    statusContract: {lifecycle: 'waiting', reasonCode: null, explanation: 'Waiting for the lender to confirm the last try stopped.'},
  });
  const retry = formatDate('2026-10-20T14:00:00.000Z', 'clock');
  assert.equal(view.preparing, false, 'a fenced launch is not "getting ready"');
  assert.equal(view.sharedWaitingSummary, `Waiting to confirm the earlier run stopped; it retries by itself at ${retry}.`);
  assert.equal(view.waitingHeadline, view.sharedWaitingSummary);
});

// The sender's job view names an own-job identity hold and the one action that clears it.
test('an own job on identity hold shows its reason and clearing action on the sender view', () => {
  const job = {state: 'claimed', job_digest: digest, approval: 'pending', approvalHold: {code: 'identity_changed',
    reason: 'This computer’s details changed after the job was sent, so it is on hold.',
    action: 'Review the job again in Approvals before it runs.'}, current_attempt: null};
  const view = formatJobProjection(job);
  assert.deepEqual(view.hold, {reason: job.approvalHold.reason, action: job.approvalHold.action});
  assert.equal(formatJobProjection({...job, approvalHold: null}).hold, null);
});

test('the job page names an own-job hold before any queue wording', () => {
  const job = {state: 'claimed', job_digest: digest, approval: 'pending', current_attempt: null, approvalHold: {code: 'identity_changed',
    reason: 'This computer’s details changed after the job was sent, so it is on hold.',
    action: 'Review the job again in Approvals before it runs.'}};
  const copy = waitingCopyVM(job, {circle: 'Friends', now: Date.parse(time)});
  assert.equal(copy.headline, 'On hold');
  assert.equal(copy.text, job.approvalHold.reason + ' ' + job.approvalHold.action);
});
