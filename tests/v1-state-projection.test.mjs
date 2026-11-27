import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JOB_PHASES, createJobProjection, createLendingProjection, adaptLegacyJob, projectLendingState, projectMembership,
  projectResourceFreshness, acknowledgedUpdateOperation, locallyStoppingJobProjection} from '../lib/v1/state-projection.mjs';

const observedAt = '2026-10-20T12:00:00.000Z';
const evidenceFor = phase => ({
  waiting: {rawState:'queued'},
  approval_pending: {rawState:'claimed', approval:'pending'},
  approved: {rawState:'claimed', approval:'approved'},
  starting: {rawState:'starting', approval:'approved'},
  running: {rawState:'running', executionStartedAt:observedAt},
  stopping: {rawState:'cancelled'},
  stopped: {rawState:'cancelled', computeStopped:true, executionStartedAt:observedAt, attemptPresent:true},
  failed: {rawState:'failed'},
  expired: {rawState:'expired'},
  result_accepted: {rawState:'result-accepted'},
  unknown: {},
}[phase]);
const reasonFor = phase => ({approval_pending:'approval_pending',stopping:'stop_unconfirmed',stopped:'compute_stopped',expired:'expired'})[phase] ?? null;
const projection = (phase, overrides = {}) => createJobProjection({schemaVersion:2,kind:'job',phase,reasonCode:reasonFor(phase),
  result:{available:false,digest:null},application:{outcome:null,appliedBranch:null},evidence:evidenceFor(phase),
  version:{jobDigest:'job-1',attemptId:null,generation:null},times:{observedAt,validUntil:null,nextTransitionAt:null},actionHints:[],...overrides});

test('v2 runtime constructor accepts each declared phase only with its matching evidence', () => {
  assert.deepEqual(JOB_PHASES, ['waiting','approval_pending','approved','starting','running','stopping','stopped','failed','expired','result_accepted','unknown']);
  for (const phase of JOB_PHASES) assert.equal(projection(phase).phase, phase, phase);
});

test('invalid constructors and contradictory generated combinations fail closed to unknown', () => {
  const cases = [
    projection('approved', {evidence:{rawState:'claimed',approval:'pending'}}),
    projection('starting', {evidence:{rawState:'starting'}}),
    projection('running', {evidence:{rawState:'running'}}),
    projection('stopped', {evidence:{rawState:'cancelled',computeStopped:false}}),
    projection('waiting', {evidence:{rawState:'claimed',approval:'pending'}}),
    projection('result_accepted', {evidence:{rawState:'failed'}}),
    projection('running', {evidence:{rawState:'running',executionStartedAt:'not-a-time'}}),
    projection('running', {actionHints:['authorize']}),
    projection('approved', {reasonCode:'approval_pending'}),
    projection('running', {evidence:{rawState:'failed',executionStartedAt:observedAt}}),
    projection('waiting', {evidence:{rawState:'queued',executionStartedAt:observedAt}}),
    projection('approved', {evidence:{rawState:'claimed',approval:'approved',computeStopped:true}}),
  ];
  for (const value of cases) assert.equal(value.phase, 'unknown');
  assert.equal(createJobProjection(null).phase, 'unknown');
});

test('generated projection tuples match an independent exact phase and reason oracle', () => {
  const states = ['queued','claimed','starting','running','stop-requested','cancelled','failed','expired','result-accepted'];
  const approvals = [null,'pending','approved'];
  const reasons = [null, 'approval_pending', 'stop_unconfirmed', 'compute_stopped', 'cancelled_before_start', 'expired'];
  let combinations = 0;
  for (const phase of JOB_PHASES) for (const rawState of states) for (const approval of approvals)
    for (const executionStartedAt of [null, observedAt]) for (const computeStopped of [false, true])
      for (const approvedAt of [null, observedAt]) for (const attemptPresent of [false, true])
        for (const reasonCode of reasons) {
      combinations++;
      const input = {schemaVersion:2,kind:'job',phase,reasonCode,result:{available:false,digest:null},
        application:{outcome:null,appliedBranch:null},evidence:{rawState,approval,approvedAt,executionStartedAt,computeStopped,attemptPresent},
        version:{jobDigest:null,attemptId:null,generation:null},times:{observedAt,validUntil:null,nextTransitionAt:null},actionHints:[]};
      const expected = expectedTuplePhase(input);
      assert.equal(createJobProjection(input).phase, expected, JSON.stringify({phase,rawState,approval,approvedAt,executionStartedAt,computeStopped,attemptPresent,reasonCode}));
    }
  assert.equal(combinations, JOB_PHASES.length * states.length * approvals.length * 2 * 2 * 2 * 2 * reasons.length);
});

function expectedTuplePhase({phase, reasonCode, evidence}) {
  const {rawState, approval, approvedAt, executionStartedAt, computeStopped, attemptPresent} = evidence;
  const started = executionStartedAt !== null;
  const approved = approval === 'approved' || approvedAt !== null;
  const validReason = reasonCode === null || typeof reasonCode === 'string' && reasonCode.length > 0;
  const accepted = phase === 'unknown' ||
    phase === 'waiting' && !started && !computeStopped &&
      (rawState === 'queued' && (reasonCode === null || !['approval_pending','stop_unconfirmed'].includes(reasonCode)) ||
       ['claimed','starting','running'].includes(rawState) && reasonCode === null && approval !== 'pending' &&
       (rawState === 'running' || !approved)) ||
    phase === 'approval_pending' && rawState === 'claimed' && reasonCode === 'approval_pending' && approval === 'pending' && !approved && !started && !computeStopped ||
    phase === 'approved' && rawState === 'claimed' && reasonCode === null && approved && approval !== 'pending' && !started && !computeStopped ||
    phase === 'starting' && rawState === 'starting' && reasonCode === null && approved && approval !== 'pending' && !started && !computeStopped ||
    phase === 'running' && ['claimed','starting','running'].includes(rawState) && reasonCode === null && started && !computeStopped && approval !== 'pending' ||
    phase === 'stopping' && ['stop-requested','cancelled'].includes(rawState) && reasonCode === 'stop_unconfirmed' && !computeStopped ||
    phase === 'stopped' && rawState === 'cancelled' &&
      (reasonCode === 'compute_stopped' && computeStopped || reasonCode === 'cancelled_before_start' && !started && attemptPresent === false) ||
    phase === 'failed' && rawState === 'failed' && validReason ||
    phase === 'expired' && rawState === 'expired' && reasonCode === 'expired' ||
    phase === 'result_accepted' && ['result-accepted','finished'].includes(rawState) && reasonCode === null;
  return accepted ? phase : 'unknown';
}

test('legacy adapter preserves approval as a distinct phase before execution proof', () => {
  const cases = [
    [{state:'queued'}, 'waiting'],
    [{state:'claimed',approval:'pending'}, 'approval_pending'],
    [{state:'claimed',approval:'approved'}, 'approved'],
    [{state:'starting',approval:'approved'}, 'starting'],
    [{state:'claimed',approval:'approved',current_attempt:{execution_started_at:observedAt,execution_observed_at:observedAt}}, 'running'],
    [{state:'claimed'}, 'waiting'],
  ];
  for (const [job, phase] of cases) assert.equal(adaptLegacyJob(job,{observedAt}).phase, phase);
});

test('running requires backend execution evidence; a start-request timestamp cannot invent it', () => {
  assert.equal(adaptLegacyJob({state:'running',executionProof:true},{observedAt}).phase, 'waiting');
  assert.equal(adaptLegacyJob({state:'running',executionProof:false,current_attempt:{execution_started_at:observedAt,execution_observed_at:null}},{observedAt}).phase, 'waiting');
  assert.equal(adaptLegacyJob({state:'running',current_attempt:{execution_started_at:observedAt,execution_observed_at:observedAt}},{observedAt}).phase, 'running');
  const hardStopAt='2026-10-20T12:20:00.000Z';
  assert.equal(adaptLegacyJob({state:'running',current_attempt:{execution_started_at:observedAt,execution_observed_at:observedAt},hardStopAt},{observedAt}).evidence.hardStopAt,hardStopAt);
});

for (const state of ['claimed','starting','running']) test(state + ' without observed execution is preparing, not unknown or running', () => {
  const input = {state,current_attempt:{execution_started_at:observedAt,execution_observed_at:null}};
  const value = adaptLegacyJob(input,{observedAt});
  assert.equal(value.phase,'waiting');
  assert.equal(value.reasonCode,null);
  assert.equal(value.evidence.waitingExplanation,'A computer took this job and is getting ready.');
  assert.equal(value.evidence.executionStartedAt,null);
  assert.equal(value.result.available,false);
  assert.equal(createJobProjection(value).phase,'waiting');
  assert.equal(adaptLegacyJob({...input,current_attempt:{...input.current_attempt,execution_observed_at:observedAt}}).phase,'running');
  assert.equal(adaptLegacyJob({...input,approval:'pending'}).phase,state === 'claimed' ? 'approval_pending' : 'unknown');
  assert.equal(adaptLegacyJob({...input,waiting_reason:'approval_pending'}).phase,'unknown');
  assert.equal(adaptLegacyJob({...input,compute_stopped:true}).phase,'unknown');
});
test('missing lifecycle evidence stays unknown', () => {
  for (const input of [{},{state:'unrecognized'},{current_attempt:{execution_observed_at:null}}])
    assert.equal(adaptLegacyJob(input).phase,'unknown');
});

test('legacy attempts use their start time only when the observed-time field is absent', () => {
  const requested = {execution_started_at:observedAt};
  assert.equal(adaptLegacyJob({state:'claimed',approval:'approved',current_attempt:{...requested,execution_observed_at:null}},{observedAt}).phase,'approved');
  assert.equal(adaptLegacyJob({state:'claimed',approval:'approved',current_attempt:{...requested,execution_observed_at:observedAt}},{observedAt}).phase,'running');
  assert.equal(adaptLegacyJob({state:'claimed',approval:'approved',current_attempt:requested},{observedAt}).phase,'running');
});

test('a shared stop request projects Stopping only for its active attempt and does not claim cessation', () => {
  const digest='sha256:'+'a'.repeat(64),attempt={attempt_id:'attempt-1',job_digest:digest,generation:4,state:'active',
    execution_started_at:observedAt,execution_observed_at:observedAt,compute_stopped:false};
  const stopRequest={attempt_id:attempt.attempt_id,job_digest:digest,generation:attempt.generation,requested_at:observedAt};
  const pending=adaptLegacyJob({job_digest:digest,state:'claimed',current_attempt:attempt,stopRequest},{observedAt});
  assert.equal(pending.phase,'stopping');
  assert.equal(pending.reasonCode,'stop_unconfirmed');
  assert.equal(pending.evidence.computeStopped,false);
  assert.equal(pending.evidence.sharedStopRequestedAt,observedAt);
  assert.deepEqual(pending.actionHints,[]);
  for(const changed of [
    {...stopRequest,attempt_id:'other-attempt'},
    {...stopRequest,generation:attempt.generation+1},
  ]) assert.equal(adaptLegacyJob({job_digest:digest,state:'claimed',current_attempt:attempt,stopRequest:changed},{observedAt}).phase,'running');
  assert.equal(adaptLegacyJob({job_digest:digest,state:'claimed',current_attempt:{...attempt,state:'released'},stopRequest},{observedAt}).phase,'running');
  assert.equal(adaptLegacyJob({job_digest:digest,state:'claimed',current_attempt:{...attempt,compute_stopped:true},stopRequest},{observedAt}).phase,'unknown');
});

test('an unavailable shared stop read stays distinct from no request and from cessation',()=>{
  const digest='sha256:'+'d'.repeat(64),attempt={attempt_id:'attempt-3',job_digest:digest,generation:6,state:'active',
    execution_started_at:observedAt,execution_observed_at:observedAt,compute_stopped:false,stopped_at:null};
  const unknown=adaptLegacyJob({job_digest:digest,state:'claimed',current_attempt:attempt,stopRequestReadUnavailable:true},{observedAt});
  assert.equal(unknown.phase,'running');
  assert.equal(unknown.evidence.sharedStopRequestUnavailable,true);
  assert.equal(unknown.evidence.sharedStopRequestedAt,null);
  assert.equal(unknown.evidence.computeStopped,false);
  assert.deepEqual(unknown.actionHints,[]);
  const local=locallyStoppingJobProjection(unknown);
  assert.equal(local.phase,'stopping');
  assert.equal(local.evidence.localStopRequested,true);
  assert.equal(local.evidence.sharedStopRequestUnavailable,true);
  const knownAbsent=adaptLegacyJob({job_digest:digest,state:'claimed',current_attempt:attempt},{observedAt});
  assert.equal(knownAbsent.evidence.sharedStopRequestUnavailable,undefined);
  const stopRequest={attempt_id:attempt.attempt_id,job_digest:digest,generation:attempt.generation,requested_at:observedAt};
  const knownPending=adaptLegacyJob({job_digest:digest,state:'claimed',current_attempt:attempt,stopRequest,stopRequestReadUnavailable:true},{observedAt});
  assert.equal(knownPending.phase,'stopping');
  assert.equal(knownPending.evidence.sharedStopRequestedAt,observedAt);
  assert.equal(knownPending.evidence.sharedStopRequestUnavailable,undefined);
  const stopped=adaptLegacyJob({job_digest:digest,state:'cancelled',current_attempt:{...attempt,compute_stopped:true,stopped_at:observedAt},
    stopRequestReadUnavailable:true},{observedAt});
  assert.equal(stopped.phase,'stopped');
  assert.equal(stopped.evidence.computeStopped,true);
});

test('a waiting job with no current attempt stays readable when it has no shared stop request', () => {
  assert.equal(adaptLegacyJob({job_digest:'sha256:'+'b'.repeat(64),state:'queued',current_attempt:null,stopRequest:null},{observedAt}).phase,'waiting');
});

test('local stopping evidence remains visible when the shared request already marks the attempt stopping', () => {
  const digest='sha256:'+'c'.repeat(64),attempt={attempt_id:'attempt-2',job_digest:digest,generation:5,state:'active',
    execution_started_at:observedAt,execution_observed_at:observedAt,compute_stopped:false};
  const stopRequest={attempt_id:attempt.attempt_id,job_digest:digest,generation:attempt.generation,requested_at:observedAt};
  const shared=adaptLegacyJob({job_digest:digest,state:'running',current_attempt:attempt,stopRequest},{observedAt});
  const local=locallyStoppingJobProjection(shared);
  assert.equal(shared.phase,'stopping');
  assert.equal(local.phase,'stopping');
  assert.equal(local.evidence.localStopRequested,true);
  assert.equal(local.evidence.sharedStopRequestedAt,observedAt);
  assert.deepEqual(local.actionHints,[]);
});

test('cancellation remains stopping until compute_stopped is confirmed', () => {
  const pending = adaptLegacyJob({state:'cancelled',current_attempt:{execution_started_at:observedAt,compute_stopped:false}},{observedAt});
  const confirmed = adaptLegacyJob({state:'cancelled',current_attempt:{execution_started_at:observedAt,compute_stopped:true,stopped_at:observedAt}},{observedAt});
  assert.equal(pending.phase, 'stopping');
  assert.equal(confirmed.phase, 'stopped');
  const partialConfirmed = adaptLegacyJob({state:'cancelled',current_attempt:{compute_stopped:true}},{observedAt});
  assert.equal(partialConfirmed.phase, 'stopped');
  assert.equal(partialConfirmed.reasonCode, 'compute_stopped');
  // A missing attempt field is not proof of no attempt (dot server review P2): it stays unconfirmed.
  const unobserved = adaptLegacyJob({state:'cancelled'},{observedAt});
  assert.equal(unobserved.phase, 'stopping');
  assert.equal(unobserved.reasonCode, 'stop_unconfirmed');
  assert.equal(adaptLegacyJob({state:'cancelled',compute_stopped:true},{observedAt}).reasonCode,'cancelled_before_start');
  const beforeStart = adaptLegacyJob({state:'cancelled',current_attempt:null},{observedAt});
  assert.equal(beforeStart.reasonCode, 'cancelled_before_start');
  assert.equal(adaptLegacyJob({state:'cancelled',current_attempt:null},{observedAt}).phase, 'stopped');
  for (const current_attempt of [{}, {compute_stopped:false}, {execution_started_at:'malformed'}, 'malformed']) {
    const pendingAttempt = adaptLegacyJob({state:'cancelled',current_attempt},{observedAt});
    assert.equal(pendingAttempt.phase, 'stopping');
    assert.equal(pendingAttempt.reasonCode, 'stop_unconfirmed');
    assert.equal(pendingAttempt.evidence.attemptPresent, true);
    const stoppedAttempt = adaptLegacyJob({state:'cancelled',current_attempt,compute_stopped:true},{observedAt});
    assert.equal(stoppedAttempt.phase, 'stopped');
    assert.equal(stoppedAttempt.reasonCode, 'compute_stopped');
  }
});

test('a cancelled released attempt is before-start only with zero starts and explicit null execution times', () => {
  const unstarted=adaptLegacyJob({state:'cancelled',attempts_started:0,current_attempt:{state:'released',
    execution_started_at:null,execution_observed_at:null,compute_stopped:false}},{observedAt});
  assert.equal(unstarted.phase,'stopped');
  assert.equal(unstarted.reasonCode,'cancelled_before_start');
  const confirmed=adaptLegacyJob({state:'cancelled',attempts_started:0,current_attempt:{state:'released',
    execution_started_at:null,execution_observed_at:null,compute_stopped:true}},{observedAt});
  assert.equal(confirmed.phase,'stopped');
  assert.equal(confirmed.reasonCode,'compute_stopped');
  for(const job of [
    {state:'cancelled',attempts_started:1,current_attempt:{state:'released',execution_started_at:null,execution_observed_at:null}},
    {state:'cancelled',attempts_started:0,current_attempt:{state:'released',execution_started_at:observedAt,execution_observed_at:null}},
    {state:'cancelled',attempts_started:0,current_attempt:{state:'released',execution_started_at:null}},
    {state:'cancelled',attempts_started:0,current_attempt:{state:'active',execution_started_at:null,execution_observed_at:null}},
  ]) assert.equal(adaptLegacyJob(job,{observedAt}).phase,'stopping');
});

test('a cancelled attempt with no authorized start leaves Home motion', () => {
  const record={state:'cancelled',attempts_started:0,current_attempt:{state:'cancelled',
    execution_started_at:null,execution_observed_at:null,compute_stopped:false}};
  const project=job=>adaptLegacyJob(job,{observedAt});
  assert.equal(project(record).reasonCode,'cancelled_before_start');
  assert.equal(project({...record,attempts_started:1}).phase,'stopping');
  assert.equal(project({...record,current_attempt:{...record.current_attempt,execution_started_at:observedAt}}).phase,'stopping');
});

test('adapter rejects a claimed approval that carries a pending-approval reason', () => {
  const value = adaptLegacyJob({state:'claimed',approval:'approved',waiting_reason:'approval_pending'},{observedAt});
  assert.equal(value.phase, 'unknown');
  const finished=adaptLegacyJob({state:'result-accepted',waiting_reason:'agent_unavailable'},{observedAt});
  assert.equal(finished.phase,'result_accepted');
  assert.equal(finished.reasonCode,null);
});

test('result and borrower application outcomes stay outside execution phase', () => {
  const job = adaptLegacyJob({state:'result-accepted',result_digest:'result-1',resultSummary:{noChanges:true},
    borrowerOutcome:{verdict:'used',note:'Useful result',checks:'Reviewed'},applied:{branch:'agent/change'}},{observedAt});
  assert.equal(job.phase, 'result_accepted');
  assert.deepEqual(job.result, {available:true,digest:'result-1'});
  assert.deepEqual(job.application, {outcome:{verdict:'used',note:'Useful result',checks:'Reviewed'},appliedBranch:'agent/change'});
  assert.equal(adaptLegacyJob({state:'result-accepted',resultSummary:{noChanges:true}},{observedAt}).phase, 'result_accepted');
});

test('legacy terminal and unrecognized states map without inventing a ready result', () => {
  for (const [state, phase] of [['failed','failed'],['expired','expired'],['finished','result_accepted'],['surprise','unknown']]) {
    const job = adaptLegacyJob({state},{observedAt});
    assert.equal(job.phase, phase);
    assert.equal(job.result.available, false);
  }
});

test('legacy adapter parses canonical attempt reasons once and retains safe history facts', () => {
  const job=adaptLegacyJob({state:'failed',failure:{code:'execution_failed',phase:'run'},current_attempt:{reason:'{"code":"execution_failed"}',
    stopped_at:observedAt},previous_attempt:{state:'released',reason:'{"code":"stopped_by_lender"}'}},{observedAt});
  assert.equal(job.reasonCode,'execution_failed');
  assert.equal(job.evidence.failurePhase,'run');
  assert.equal(job.evidence.stoppedAt,observedAt);
  assert.equal(job.evidence.previousAttemptState,'released');
  assert.equal(job.evidence.previousReason,'stopped_by_lender');
  const queued=adaptLegacyJob({state:'queued',current_attempt:{state:'released',holder:'lender',reason:'{"code":"approval_denied"}'}},{observedAt});
  assert.equal(queued.phase,'waiting');
  assert.equal(queued.evidence.previousReason,'approval_denied');
  assert.equal(queued.evidence.previousAttemptHolder,'lender');
});

test('legacy waiting explanations use fixed safe copy instead of exposing raw reasons', () => {
  const limited=adaptLegacyJob({state:'queued',waiting_reason:'daily_limit'},{observedAt});
  const unexpected=adaptLegacyJob({state:'queued',waiting_reason:'private diagnostic text'},{observedAt});
  assert.equal(limited.evidence.waitingExplanation,'Available computers have reached their daily limit.');
  assert.equal(unexpected.reasonCode,null);
  assert.equal(unexpected.evidence.waitingExplanation,'Waiting for someone to run it.');
  for (const waiting_reason of ['constructor','toString','valueOf','unknown_reason']) {
    assert.equal(adaptLegacyJob({state:'queued',waiting_reason},{observedAt}).evidence.waitingExplanation,'Waiting for someone to run it.');
  }
});

test('lending axes keep daily-cap admission blocked while an existing job runs', () => {
  const value = projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running',job:'job-1'}},dailyLimitReached:true});
  assert.equal(value.intent, 'on');
  assert.equal(value.admission, 'blocked');
  assert.equal(value.admissionReason, 'daily_limit');
  assert.equal(value.execution, 'running');
  assert.equal(projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'idle'}},dailyLimitReached:false}).admission, 'allowed');
  assert.equal(projectLendingState({effective:{intent:{on:true},execution:{state:'idle'}},dailyLimitReached:false}).admission, 'unknown');
  assert.equal(projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running'}},dailyLimitReached:false}).execution, 'unknown');
  assert.equal(projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running'}},dailyLimitReached:false}).admission, 'unknown');
  const missingExecution=projectLendingState({effective:{intent:{on:true,state:'ready'}},dailyLimitReached:false});
  assert.deepEqual([missingExecution.admission,missingExecution.execution],['unknown','unknown']);
  const cappedUnprovenRun=projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running'}},dailyLimitReached:true});
  assert.deepEqual([cappedUnprovenRun.admission,cappedUnprovenRun.execution,cappedUnprovenRun.evidence.executionState],['blocked','unknown','unknown']);
  assert.equal(projectLendingState({effective:{intent:{on:true},execution:{state:'running'}},dailyLimitReached:true}).admission, 'blocked');
  assert.equal(projectLendingState(null).admission, 'unknown');
});

test('lending projection constructor rejects contradictory admission, cap and execution evidence', () => {
  const base={schemaVersion:2,kind:'lending',intent:'on',admission:'allowed',admissionReason:null,
    execution:'idle',executionJob:null,evidence:{intentState:'ready',dailyLimitReached:false,executionState:'idle'},version:null};
  assert.equal(createLendingProjection(base).admission,'allowed');
  assert.equal(createLendingProjection({...base,evidence:{...base.evidence,dailyLimitReached:true}}).admission,'unknown');
  assert.equal(createLendingProjection({...base,admissionReason:'outside_hours'}).admission,'unknown');
  assert.equal(createLendingProjection({...base,admissionReason:'daily_limit'}).admission,'unknown');
  assert.equal(createLendingProjection({...base,evidence:{...base.evidence,dailyLimitReached:null}}).admission,'unknown');
  assert.equal(createLendingProjection({...base,execution:'unknown',evidence:{...base.evidence,executionState:null}}).admission,'unknown');
  assert.equal(createLendingProjection({...base,intent:'off'}).admission,'unknown');
  assert.equal(createLendingProjection({...base,evidence:{...base.evidence,intentState:'blocked'}}).admission,'unknown');
  assert.equal(createLendingProjection({...base,evidence:{...base.evidence,intentState:'invented'}}).admission,'unknown');
  assert.equal(createLendingProjection({...base,execution:'running',executionJob:'job-1'}).execution,'unknown');
  assert.equal(createLendingProjection({...base,execution:'unknown',evidence:{...base.evidence,executionState:'finishing'}}).execution,'unknown');
  const running=projectLendingState({effective:{intent:{on:true,state:'ready'},execution:{state:'running',job:'job-1'}},dailyLimitReached:true});
  assert.deepEqual([running.admission,running.evidence.dailyLimitReached,running.execution],['blocked',true,'running']);
});

test('lending tuple eligibility rejects allowed admission without known execution', () => {
  const intents=['on','off','paused','unknown'];
  const admissions=['allowed','blocked','unknown'];
  const executions=['idle','running','finishing','stopping','unknown'];
  for (const intent of intents) for (const admission of admissions) for (const execution of executions) {
    const intentState={on:'ready',off:'off',paused:'paused',unknown:null}[intent];
    const admissionReason={allowed:null,blocked:'sandbox_not_ready',unknown:null}[admission];
    const executionJob=['running','finishing','stopping'].includes(execution)?'job-1':null;
    const candidate={schemaVersion:2,kind:'lending',intent,admission,admissionReason,execution,executionJob,
      evidence:{intentState,dailyLimitReached:false,executionState:execution},version:null};
    const shouldBeAllowed=admission==='allowed'&&intent==='on'&&execution!=='unknown';
    const value=createLendingProjection(candidate);
    assert.equal(value.admission==='allowed',shouldBeAllowed,`${intent}/${admission}/${execution}`);
  }
});

test('an outside-hours wait keeps its own admission reason and next start through the projection', () => {
  const nextStart = Date.UTC(2026, 9, 19, 22);
  const outside = projectLendingState({effective: {intent: {on: true, state: 'outside', reason: null, until: nextStart}, execution: {state: 'idle'}}, dailyLimitReached: false});
  assert.deepEqual([outside.intent, outside.admission, outside.admissionReason, outside.evidence.intentState, outside.evidence.outsideUntil],
    ['on', 'blocked', 'outside_hours', 'outside', '2026-10-19T22:00:00.000Z']);
  assert.deepEqual(createLendingProjection(JSON.parse(JSON.stringify(outside))), outside, 'the wire form validates to the same projection');
  assert.equal(projectLendingState({effective: {intent: {on: true, state: 'ready'}, execution: {state: 'idle'}}, dailyLimitReached: false}).evidence.outsideUntil, null);
});

test('membership approval mode does not turn approved enrollment into pending membership', () => {
  const value = projectMembership({origin:'https://circle.example',approveEach:true,enrollment:{state:'approved'},rosterMembershipVerified:true,joinInfo:{approval:'each'}});
  assert.equal(value.phase, 'approved');
  assert.equal(value.invitationPolicy, 'each');
  assert.equal(projectMembership(null).phase, 'unknown');
});

test('freshness orders resource-local success and error times, independently of stream state', () => {
  assert.equal(projectResourceFreshness({hasData:true,lastSuccess:'2026-10-20T12:00:00Z',lastError:'2026-10-20T11:59:00Z',streamConnected:false}).state, 'fresh');
  assert.equal(projectResourceFreshness({hasData:true,lastSuccess:'2026-10-20T11:00:00Z',lastError:'2026-10-20T12:00:00Z',streamConnected:true}).state, 'stale');
  assert.equal(projectResourceFreshness({hasData:true,lastSuccess:'2026-10-20T12:00:00Z',lastError:null,streamConnected:false}).state, 'fresh');
  assert.equal(projectResourceFreshness({hasData:false,fetching:true,streamConnected:true}).state, 'loading');
  assert.equal(projectResourceFreshness({hasData:false,fetching:false}).state, 'initial');
  assert.equal(projectResourceFreshness({hasData:false,lastError:'2026-10-20T12:00:00Z'}).state, 'unavailable');
  assert.equal(projectResourceFreshness({hasData:false,lastSuccess:'2026-10-20T12:00:00Z'}).state, 'empty');
  assert.equal(projectResourceFreshness({hasData:false,lastSuccess:'2026-10-20T11:00:00Z',lastError:'2026-10-20T12:00:00Z'}).state, 'unavailable');
  assert.equal(projectResourceFreshness(null).state, 'unknown');
});

test('optional-resource errors cannot change a separately fresh job resource', () => {
  const job = projectResourceFreshness({hasData:true,lastSuccess:'2026-10-20T12:00:00Z',streamConnected:false});
  const optional = projectResourceFreshness({hasData:true,lastSuccess:'2026-10-20T11:00:00Z',lastError:'2026-10-20T12:01:00Z'});
  assert.equal(job.state, 'fresh');
  assert.equal(optional.state, 'stale');
});

test('update restart evidence requires an acknowledged operation ID and stage', () => {
  assert.equal(acknowledgedUpdateOperation({stage:'restarting',disconnected:true}), null);
  assert.equal(acknowledgedUpdateOperation({operationId:'update-1',acknowledged:false,stage:'restarting'}), null);
  assert.deepEqual(acknowledgedUpdateOperation({operationId:'update-1',acknowledged:true,stage:'restarting',version:'2.1.0',acknowledgedAt:observedAt}),
    {operationId:'update-1',acknowledged:true,stage:'restarting',version:'2.1.0',acknowledgedAt:observedAt});
});

// Dot server review P2: a missing current_attempt field is not proof that a cancelled job never had an attempt.
test('a cancelled job with no attempt field stays unconfirmed; only an observed null attempt is cancelled before start',async()=>{
  const {adaptLegacyJob,createJobProjection}=await import('../lib/v1/state-projection.mjs');
  const missing=createJobProjection(adaptLegacyJob({job_digest:'sha256:'+'a'.repeat(64),state:'cancelled'}));
  assert.notEqual(missing.reasonCode,'cancelled_before_start');assert.notEqual(missing.phase,'stopped');
  const observed=createJobProjection(adaptLegacyJob({job_digest:'sha256:'+'a'.repeat(64),state:'cancelled',current_attempt:null}));
  assert.deepEqual([observed.phase,observed.reasonCode],['stopped','cancelled_before_start']);
});

// Judge r9 (O-B cold page, O-E): a job a lender stopped goes back to the queue still naming that stopped attempt.
// Its execution facts belong to the previous attempt, so the job is waiting, never "unknown / contradictory".
test('a queued job whose previous attempt ran and was stopped projects as waiting, not unknown',()=>{
  const job={job_digest:'sha256:'+'a'.repeat(64),state:'queued',current_attempt:{attempt_id:'a1',generation:1,holder:'sha256:'+'b'.repeat(64),
    state:'released',execution_started_at:observedAt,compute_stopped:true,stopped_at:observedAt,reason:JSON.stringify({code:'stopped_by_lender'})}};
  const projection=adaptLegacyJob(job,{observedAt});
  assert.equal(projection.phase,'waiting');
  assert.equal(projection.evidence.previousReason,'stopped_by_lender');
  assert.equal(projection.evidence.executionStartedAt,null,'the previous attempt is not this job’s current execution');
});
