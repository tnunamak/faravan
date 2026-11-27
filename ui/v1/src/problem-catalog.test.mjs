import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeProblem, PROBLEM_CODES, retryAfterUntil, readState} from '../../../lib/v1/problem.mjs';
import {CATALOG_CODES, PROBLEM_SURFACES, problemView} from './problem-catalog.mjs';

const contexts = PROBLEM_SURFACES.flatMap(surface => [
  {surface, capabilities:{}},
  {surface, capabilities:{localApp:true, manageSettings:true}},
  {surface, capabilities:{localApp:true, manageSettings:false}},
  {surface, capabilities:{localApp:false, manageSettings:true}},
]);
const ordinaryText = view => [view.title, view.detail, view.action.label].join(' ');
const internal = /\b[1-5]\d\d\b|(?:sha256:|job_|key_|device_)[a-z0-9]+|\b[a-f0-9]{12,}\b|(?:^|\s)(?:\/|~\/|[A-Z]:[\\/]|\\\\)|\bHTTP\b|\b(?:payload|authority chain|idempotency|stack trace)\b/i;
const hostile = 'HTTP 409 job_deadbeef sha256:abcdef012345 /home/private/secret C:\\private\\file Error: at fail (app:23)';

test('every typed code has safe desktop and phone copy and a capability-valid next action', () => {
  assert.deepEqual([...CATALOG_CODES].sort(), [...PROBLEM_CODES].sort());
  for (const code of PROBLEM_CODES) for (const context of contexts) {
    const problem = normalizeProblem({code, message:hostile, members:[{name:hostile}], safeParams:{label:hostile}, field:hostile, error_id:hostile});
    const view = problemView(problem, context);
    const hint = code + ' ' + JSON.stringify(context);
    assert.ok(view.title && view.detail && view.action.kind && view.action.label, hint);
    assert.doesNotMatch(ordinaryText(view), internal, hint);
    assert.doesNotMatch(ordinaryText(view), /try again/i, hint);
    assert.ok(!ordinaryText(view).includes(hostile), hint);
    assert.equal(problem.field, undefined);
    assert.deepEqual(problem.safeParams, {});
    if (context.surface === 'phone' || !context.capabilities.localApp) {
      assert.ok(!['open-app','setup','sign-in','choose-files','choose-agent','review-result'].includes(view.action.kind), hint);
      assert.doesNotMatch(ordinaryText(view), /tray|terminal|run (?:faravan|faravan)|\bon this computer/i, hint);
    }
    if (!context.capabilities.manageSettings) assert.notEqual(view.action.kind, 'review-settings', hint);
  }
});

test('all codes in the pre-migration boundary still have catalog entries', () => {
  const legacy='mutation_pending mutation_uncertain device_busy clipboard unauthorized invalid_host invalid_origin invalid_request payload_too_large sandbox_not_ready signin_failed signin_unsupported signin_not_waiting_for_code signin_code_invalid agent_not_ready lending_busy circle_ambiguous offline config_changed lending_recovery_required identity_changed approval_expired petname_store_full action_unavailable not_found app_closing agent_check_timeout not_owner forbidden person_link_refresh_required invalid_person_link role_conflict person_blocked already_linked ownership_transfer_required ownership_transfer_pending circle_must_be_closed circle_closed publication_pending authority_chain authority_rollback invalid_transfer_code transfer_expired transfer_mismatch host_update_required enrollment_rejected invitation_revoked invitation_expired invite_used enrollment_conflict invalid_invite invite_unreachable invite_preview_required warning_not_acknowledged protection_not_ready invalid_petname petname_label_taken network network_error rate_limited read_timeout'.split(' ');
  for(const code of legacy) assert.ok(CATALOG_CODES.includes(code),code);
});

test('unknown code never admits server prose or infers a cause from status', () => {
  for (const status of [401,409,429,500,503]) for (const context of contexts) {
    const problem = normalizeProblem({code:'future_code', message:hostile}, {status});
    assert.equal(problem.code, status === 401 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'unknown');
    assert.doesNotMatch(ordinaryText(problemView(problem, context)), internal);
  }
  assert.equal(normalizeProblem({}, {status:409}).code, 'conflict');
  for (const code of ['__proto__', 'constructor', null, {}, 42]) assert.equal(normalizeProblem({code}).code, 'unknown');
  for (const input of [null, undefined, hostile, 42]) assert.equal(normalizeProblem(input).code, 'unknown');
});

test('a previous coordinator from another install gets its own recovery copy; other refusals keep the generic copy', () => {
  const older = problemView({code: 'previous_coordinator_other_install'});
  assert.equal(older.title, 'Previous hosting process needs review');
  assert.equal(older.detail, 'The recorded hosting process appears to use a different program path. Faravan could not verify it as this copy, so it was left running. Check the Faravan installation that started hosting and stop hosting there before trying again.');
  assert.equal(older.action.kind, 'check-status');
  // host_failed: the coordinator exited before it was ready. It has its own plain copy, not the generic unknown one.
  const failed = problemView({code: 'host_failed'});
  assert.equal(failed.title, 'Hosting didn’t start');
  assert.match(failed.detail, /stopped before it was ready/);
  assert.notDeepEqual(failed, problemView({code: 'unknown'}));
});

test('a stop that left hosting running says so instead of reading as stopped', () => {
  const still = problemView({code: 'host_still_running'});
  assert.equal(still.title, 'Hosting is still running');
  assert.match(still.detail, /so it was left running\. Members can still reach it\./);
  assert.equal(still.action.kind, 'check-status');
});

test('Retry-After seconds/date become a wait-until action, never an immediate retry', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  for (const retryAfter of ['30', 'Wed, 21 Oct 2026 12:00:30 GMT']) {
    const problem = normalizeProblem({}, {status:429, retryAfter, now});
    assert.deepEqual(problem.retryPolicy, {kind:'wait-until', until:now+30000});
    assert.strictEqual(normalizeProblem(problem), problem);
    for (const context of contexts) {
      const view = problemView(problem, {...context, now});
      assert.deepEqual(view.action, {kind:'wait', label:'Wait before checking', notBefore:now+30000, disabled:true});
      assert.equal(problemView(problem, {...context, now:now+30000}).action.kind, 'check-status');
    }
  }
  for (const value of [undefined, '', '-1', 'Infinity', {}, hostile, '2026-10-21']) {
    assert.equal(retryAfterUntil(value, now), null);
    const problem = normalizeProblem({}, {status:429, retryAfter:value, now});
    assert.equal(problemView(problem, {now}).action.disabled, true);
  }
  assert.equal(problemView({code:'rate_limited', retryPolicy:{kind:'wait-until',until:now-1}}, {now}).action.disabled, true, 'untrusted timing is ignored');
});

test('uncertain writes offer check state and normalization never schedules a write retry', () => {
  const problem = normalizeProblem({code:'network'}, {method:'POST', outcomeUncertain:true});
  assert.equal(problem.code, 'mutation_uncertain');
  assert.deepEqual(problem.retryPolicy, {kind:'check-status'});
  assert.equal(problemView(problem).action.kind, 'check-status');
  assert.equal(normalizeProblem({code:'network'}, {method:'GET', outcomeUncertain:true}).code, 'network');
  assert.equal(normalizeProblem({code:'invalid_request', field:'prompt'}).field, 'prompt');
});

test('read state never claims empty before a successful relevant list read', () => {
  assert.equal(readState().kind, 'loading');
  assert.equal(readState({loading:true,data:[]}).kind, 'loading');
  assert.equal(readState({error:{code:'network'}}).kind, 'unavailable');
  assert.equal(readState({error:{code:'network'},data:[]}).kind, 'stale-with-data');
  assert.equal(readState({data:[]}).kind, 'loaded-empty');
  assert.equal(readState({data:[],filtered:true}).kind, 'filtered-empty');
  assert.equal(readState({data:[],hasMembership:false}).kind, 'no-membership');
  assert.equal(readState({data:[{title:'A job'}]}).kind, 'loaded');
  assert.throws(() => readState({data:null}), TypeError);
});

// Historical ordinary-copy regressions, from visual-judge-r*/REPORT.md.
const judgeCases = [
  ['r4 O8', {status:409, message:'Faravan could not complete this action (error 409).'}, 'desktop', /Reload and review/],
  ['r4 O9', {code:'not_git', message:'/home/sam/sandbox is a folder but not a git repository'}, 'desktop', /folder snapshot/],
  ['r4 O11', {status:401}, 'phone', /Settings → Pairing/],
  ['r5 O12', {code:'unauthorized', status:401}, 'phone', /pair this device again/],
  ['r6 O10', {code:'network'}, 'phone', /awake and on the same network/],
  ['r7 O4', {status:429}, 'desktop', /Wait before checking/],
];
for (const [finding, input, surface, expected] of judgeCases) test(finding + ' has safe copy and an actionable recovery', () => {
  const view = problemView(normalizeProblem(input), {surface, capabilities:{localApp:surface==='desktop'}});
  assert.match(ordinaryText(view), expected);
  assert.doesNotMatch(ordinaryText(view), internal);
  assert.doesNotMatch(ordinaryText(view), /try again|tray|terminal/i);
  assert.ok(view.action.kind);
});

test('dot review: elapsed Retry-After is check-state, and explicit boundary status overrides a normalized value',()=>{
  const now=Date.parse('2026-10-21T12:00:31Z');
  const elapsed=normalizeProblem({}, {status:429,retryAfter:'Wed, 21 Oct 2026 12:00:30 GMT',now});
  assert.equal(problemView(elapsed,{now}).action.kind,'check-status');
  const prior=normalizeProblem({code:'invalid_request'});
  assert.equal(normalizeProblem(prior,{status:401}).code,'unauthorized');
  assert.equal(normalizeProblem(prior,{status:429}).retryPolicy.kind,'wait');
});

test('offline and failed fetch have distinguishable headlines on every surface', () => {
  for (const context of contexts) {
    const offline = problemView({code:'offline'}, context);
    const network = problemView({code:'network'}, context);
    assert.notEqual(network.title, offline.title);
    assert.equal(network.title, 'Faravan could not be reached');
  }
});

test('rate limit without trusted timing gives a bounded manual check path', () => {
  for (const context of contexts) {
    const view = problemView({code:'rate_limited'}, context);
    assert.match(view.detail, /Wait a minute, then reload to check the current state[.]/);
    assert.equal(view.action.disabled, true);
    assert.equal(view.action.notBefore, null);
  }
});

test('read timeout explanation agrees with its offered reload step', () => {
  const view = problemView({code:'read_timeout'});
  assert.equal(view.action.kind, 'reload');
  assert.match(view.detail, /Reload to load current information[.]/);
  assert.doesNotMatch(view.detail, /before reloading/);
});
