import test from 'node:test';
import assert from 'node:assert/strict';
import {onboardingVM, ONBOARDING_EVENTS, EXAMPLE_RESULT, FIRST_TASKS} from './onboarding.mjs';
import {needsYouItems, homePageVM, jobStateKey} from './view-models.mjs';
import {jobProjectionFor} from './job-projection-view.mjs';

// PRODUCT-UX-FIELD-RESEARCH §8. Founder capture (evidence/shell/incumbent-*): no circles and lending off, yet Home's
// hero said "Checking sandpiper…" and attention said "choose agents" — a borrower framed as blocked by lender setup.
const home = {lending: {enabled: false}};
const own = {id: 'c1', origin: 'https://c.example', owned: true, name: 'Weekend projects'};
const joined = {id: 'c2', origin: 'https://c.example', owned: false, name: 'Ana’s circle', enrollment: {state: 'approved'}, rosterMembershipVerified:true};
const pending = {id: 'c3', origin: 'https://c.example', owned: false, name: 'Ana’s circle', enrollment: {state: 'pending'}, joinInfo: {ownerName: 'Ana', approval: 'each'}};
const sent = (state, extra = {}) => ({job_digest: 'sha256:' + 'a'.repeat(64), role: 'sent', state, circle: {id: 'c2'}, ...extra});

test('fresh computer: borrower first with a secondary lending setup choice', () => {
  const vm = onboardingVM({home, circles: [], jobs: [], device: 'sandpiper'});
  assert.equal(vm.entry.kind, 'fresh');
  assert.doesNotMatch(vm.entry.headline, /Checking|ready to lend|isn’t ready/);
  assert.deepEqual(vm.entry.actions.map(a => a.label), ['Join with an invitation', 'Start a circle', 'Set up lending', 'See an example']);
  assert.match(vm.entry.lendingNote, /optional/i);
});

test('a lending blocker never becomes a needs-you item before lending is started', () => {
  const status = {lending: {enabled: false}, lending_blockers: [{key: 'agent', status: 'needs_you', label: 'Choose agents to lend'}]};
  const agents = [{id: 'claude-code-subscription', installed: true, useForLending: false}];
  assert.equal(needsYouItems({home: status, agents, approvals: [], jobs: []}).filter(i => i.kind === 'blocker').length, 0);
  assert.equal(homePageVM({home: status, agents, approvals: [], jobs: []}).counts.setup, 0);
});

test('joining: the progress card says whose turn it is, by name', () => {
  const vm = onboardingVM({home, circles: [pending], jobs: []});
  assert.equal(vm.entry, null);
  const step = vm.progress.steps.find(s => s.id === 'joined');
  assert.equal(step.done, false);
  assert.equal(step.turn, 'Waiting for Ana to let this computer in');
  assert.equal(vm.progress.steps.find(s => s.id === 'ready').done, true);
});

test('onboarding follows explicit membership phase, not raw enrollment or invite mode', () => {
  const approved={...pending,membershipProjection:{schemaVersion:2,kind:'membership',phase:'approved',evidence:{enrollmentState:'approved',origin:true},invitationPolicy:'unknown'}};
  assert.equal(onboardingVM({home,circles:[approved],jobs:[]}).progress.steps.find(s=>s.id==='joined').done,true);
  const unknown={...joined,membershipProjection:{schemaVersion:2,kind:'membership',phase:'unknown',evidence:{enrollmentState:null,origin:false},invitationPolicy:'each'}};
  const vm=onboardingVM({home,circles:[unknown],jobs:[]});
  assert.equal(vm.progress.steps.find(s=>s.id==='joined').done,false);
  assert.notEqual(vm.progress.steps.find(s=>s.id==='joined').turn,'Waiting for Ana to let this computer in');
});

test('joined, nothing sent: first-task suggestions under a "your turn" step', () => {
  const vm = onboardingVM({home, circles: [joined], jobs: []});
  assert.equal(vm.progress.steps.find(s => s.id === 'joined').done, true);
  assert.equal(vm.progress.current.turn, 'Your turn: send a job');
  assert.equal(vm.suggestions.length, 3);
  assert.ok(vm.suggestions.some(s => /Explain this project/.test(s.label)));
  assert.equal(vm.suggestions, FIRST_TASKS);
});

test('sent and waiting: it is the lender’s turn; any result retires the card', () => {
  assert.equal(onboardingVM({home, circles: [joined], jobs: [sent('Waiting')]}).progress.current.turn, 'Waiting for a computer to accept your job.');
  assert.equal(onboardingVM({home, circles: [joined], jobs: [sent('Finished')]}).progress, null);
  assert.equal(onboardingVM({home, circles: [joined], jobs: [sent('Finished', {borrowerOutcome: {verdict: 'unused'}})]}).progress, null);
  assert.equal(onboardingVM({home, circles: [joined], jobs: [sent('Finished', {borrowerOutcome: {verdict: 'used'}})]}).progress, null);
  assert.deepEqual(onboardingVM({home, circles: [joined], jobs: [sent('Waiting')]}).suggestions, []);
});

test('a lender-only computer that has run jobs for others is not onboarded as a borrower', () => {
  const vm = onboardingVM({home: {lending: {enabled: true, circle: 'c2'}}, circles: [joined], jobs: [{...sent('Finished'), role: 'ran'}]});
  assert.equal(vm.progress, null);
});

test('accepting a friend job does not start the borrower onboarding journey', () => {
  const vm = onboardingVM({home:{lending:{enabled:true,circle:'c2'}},circles:[joined],
    jobs:[{...sent('claimed'),role:'received',approval:'approved'}]});
  assert.equal(vm.progress,null);
  const ran = onboardingVM({home:{lending:{enabled:true,circle:'c2'}},circles:[joined],
    jobs:[{...sent('claimed'),role:'ran'}]});
  assert.deepEqual(vm.suggestions,ran.suggestions,'preserve the existing lender-only suggestions contract');
});

test('the example result is labelled as an example and shows the whole contract', () => {
  assert.match(EXAMPLE_RESULT.label, /^Example/);
  for (const key of ['request', 'summary', 'check', 'diff', 'branch']) assert.ok(EXAMPLE_RESULT[key], key);
});

test('the onboarding event schema is definitions only, in funnel order', () => {
  assert.deepEqual(ONBOARDING_EVENTS.map(e => e.name), ['first_open', 'borrower_ready', 'lender_ready', 'requested', 'approved',
    'result_reviewed', 'useful_result', 'independent_circle_activated', 'repeat_exchange']);
  for (const event of ONBOARDING_EVENTS) assert.ok(event.definition.length > 10, event.name);
});

test('a suggestion fills an empty composer draft for the circle the composer opens, never over typed text', async () => {
  const {suggestFirstTask} = await import('./onboarding.mjs');
  const {loadDraft} = await import('./compose-draft.mjs');
  const map = new Map(), storage = {getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k)};
  assert.equal(suggestFirstTask(storage, [joined], 'c2', FIRST_TASKS[0].prompt), true);
  assert.equal(loadDraft(storage, 'c2').prompt, FIRST_TASKS[0].prompt);
  assert.equal(suggestFirstTask(storage, [joined], 'c2', FIRST_TASKS[1].prompt), false);
  assert.equal(loadDraft(storage, 'c2').prompt, FIRST_TASKS[0].prompt);
  assert.equal(suggestFirstTask(storage, [], '', 'x'), false);
});

// Dot UI review of the state projection: the fresh-computer lending note reads the projection, not older fields.
test('the fresh lending note follows the projection when older fields still say on', async () => {
  const {withLendingProjection} = await import('./lending-projection.fixture.mjs');
  const legacyOn = {intent: {on: true, state: 'ready'}, lending: {enabled: true}};
  const note = projection => onboardingVM({home: withLendingProjection(legacyOn, projection), circles: [], jobs: []}).entry.lendingNote;
  assert.equal(note({intent: 'paused', intentState: 'paused', admission: 'blocked', admissionReason: 'paused'}), 'Lending is paused. Joining does not resume it.');
  assert.match(note({intent: 'off', intentState: 'off', admission: 'blocked', admissionReason: 'off'}), /optional/i);
  assert.doesNotMatch(note({intent: 'unknown', intentState: null, admission: 'unknown', admissionReason: null}), /already on|set to on/);
});

test('pending Home progress follows the existing join request without inviting again', () => {
  const step = onboardingVM({home,circles:[pending],jobs:[]}).progress.steps.find(s=>s.id==='joined');
  assert.equal(step.done,false);
  assert.deepEqual(step.actions,[{href:'#/circle/c3',label:'View join request'}]);
  assert.equal(onboardingVM({home,circles:[joined],jobs:[]}).progress.steps.find(s=>s.id==='joined').done,true);
});

test('Setup distinguishes pending, absent, unknown and terminal membership without inventing approval', async () => {
  const {setupVM} = await import('./view-models.mjs');
  const row = circle => setupVM({circle}).steps.find(s=>s.id==='circle');
  assert.equal(row(null).detail,'You haven’t joined or started a circle yet. Open Circles to get started.');
  const projected = phase => ({...pending,membershipProjection:{schemaVersion:2,kind:'membership',phase,evidence:{enrollmentState:phase==='unknown'?null:phase,origin:true},invitationPolicy:'each'}});
  assert.equal(row(projected('pending')).detail,'Your join request is waiting for approval. Open Circles to compare the match code and check its status.');
  assert.equal(row(projected('unknown')).detail,'Faravan hasn’t confirmed your circle membership. Open Circles to check its status before trying another invitation.');
  assert.doesNotMatch(row({...pending,enrollment:{state:'rejected'}}).detail,/waiting for approval/);
  assert.equal(row(joined).state,'ok');
  assert.equal(row(joined).detail,joined.name);
});

test('onboarding_running_and_returning_jobs_use_current_stage', () => {
  // Real job shapes: the stage comes from the job projection, never from a bare state word.
  const at = '2026-01-01T00:00:00Z';
  const attempt = (extra = {}) => ({attempt_id: 'a1', generation: 1, state: 'active', ...extra});
  const stages = [
    ['waiting', sent('waiting'), 'Waiting for acceptance', 'Waiting for a computer to accept your job.'],
    ['waiting_approval', sent('claimed', {approval: 'pending', current_attempt: attempt()}), 'Waiting for approval', 'Someone in the circle still has to approve your job.'],
    ['approved', sent('claimed', {approval: 'approved', current_attempt: attempt({approved_at: at})}), 'Job accepted', 'Your job was accepted. Open it for its latest status.'],
    ['starting', sent('starting', {approval: 'approved', current_attempt: attempt({approved_at: at})}), 'Job starting', 'Your job is starting. Open it for its latest status.'],
    ['working', sent('running', {current_attempt: attempt({execution_started_at: at, execution_observed_at: at})}), 'Job running', 'Your job is running. Open it for progress or stop controls.'],
    ['stop_requested', sent('stop-requested', {current_attempt: attempt()}), 'Stop requested', 'A stop was requested. Open the job to check whether it has stopped.'],
  ];
  for (const [name, job, label, turn] of stages) {
    const step = onboardingVM({home, circles: [joined], jobs: [job]}).progress.current;
    assert.equal(step.label, label, name);
    assert.equal(step.turn, turn, name);
  }
});

test('unresolved first jobs direct the borrower to the existing job before sending another', () => {
  // The projection reports stop_unconfirmed only when stop verification failed; 'uncertain' has no projection path today.
  const stopping = jobProjectionFor(sent('stop-requested'));
  const unconfirmed = sent('stop-requested', {jobProjection: {...stopping, evidence: {...stopping.evidence, stopVerification: 'failed'}}});
  for (const [state, label, words, job] of [
    ['stop_unconfirmed', 'Stop not confirmed', /has not confirmed that this job stopped/, unconfirmed],
  ]) {
    assert.equal(jobStateKey(job), state, 'fixture must project the unresolved state');
    const step = onboardingVM({home, circles: [joined], jobs: [job]}).progress.current;
    assert.equal(step.label, label, state);
    assert.match(step.turn, words, state);
    assert.doesNotMatch(step.turn, /Your turn: send another job/, state);
    assert.deepEqual(step.actions, [{label: 'Open job',
      href: '#/job/' + encodeURIComponent(job.job_digest) + '/c2'}], state);
  }
  // A raw 'stopped' state string has no projection and reads as unknown; build a real stopped projection.
  const stoppedJob = sent('cancelled', {current_attempt: {compute_stopped: true}});
  assert.equal(jobStateKey(stoppedJob), 'stopped', 'fixture must project a stopped job');
  for (const [state, job] of [['stopped', stoppedJob], ['failed', sent('failed')]]) {
    const step = onboardingVM({home, circles: [joined], jobs: [job]}).progress.current;
    assert.equal(step.label, 'Send a job', state);
    assert.equal(step.turn, 'Your turn: send a job', state);
    assert.equal(step.actions, undefined, state);
  }
});

test('onboarding_prior_attempt_does_not_claim_no_job_was_sent', () => {
  const step = onboardingVM({home, circles: [joined], jobs: [sent('failed')]}).progress.current;
  assert.equal(step.label, 'Send a job');
  assert.equal(step.turn, 'Your turn: send a job');
});

test('home_loaded_without_membership_does_not_claim_ready_to_ask', () => {
  for (const circles of [[], [pending]]) {
    const vm = onboardingVM({home, circles});
    const step = vm.progress.steps.find(s => s.id === 'ready');
    assert.equal(step.label, 'Faravan is open on this computer');
    assert.equal(step.done, true);
    assert.equal(vm.progress.current.id, 'joined');
  }
});

test('example_request_matches_equal_date_validation', () => {
  assert.equal(EXAMPLE_RESULT.request, 'Stop checkout unless the departure date is after the arrival date.');
  assert.ok(EXAMPLE_RESULT.diff.some(line => line.text.includes('departure <= arrival')));
});

test('an unknown first-job outcome offers recovery, never another submission', () => {
 const unknown=sent('unrecognised');
 assert.equal(jobStateKey(unknown),'unknown');
 const step=onboardingVM({home,circles:[joined],jobs:[unknown]}).progress.current;
 assert.equal(step.label,'Check the previous job');
 assert.match(step.turn,/could not be read/);
 assert.doesNotMatch(step.turn,/Your turn: send another job|interrupted/i);
 assert.deepEqual(step.actions,[{label:'Open job',href:'#/job/'+encodeURIComponent(unknown.job_digest)+'/c2'}]);
});

test('approved membership offers optional lending setup, never while approval is pending or lending started', () => {
 assert.equal(onboardingVM({home,circles:[joined]}).lendingSetup,true);
 assert.equal(onboardingVM({home,circles:[pending]}).lendingSetup,false);
 assert.equal(onboardingVM({home,circles:[]}).lendingSetup,false);
 assert.equal(onboardingVM({home:{lending:{enabled:true}},circles:[joined]}).lendingSetup,false);
});

test('every in-motion first job with a digest offers its existing job page', () => {
 const at='2026-01-01T00:00:00Z';
 const attempt={attempt_id:'a1',generation:1,state:'active'};
 const jobs=[
   sent('waiting'),
   sent('claimed',{approval:'approved',current_attempt:{...attempt,approved_at:at}}),
   sent('starting',{approval:'approved',current_attempt:{...attempt,approved_at:at}}),
   sent('running',{current_attempt:{...attempt,execution_started_at:at,execution_observed_at:at}}),
   sent('stop-requested',{current_attempt:attempt}),
 ];
 for(const job of jobs){
   const step=onboardingVM({home,circles:[joined],jobs:[job]}).progress.current;
   assert.deepEqual(step.actions,[{label:'Open job',href:'#/job/'+encodeURIComponent(job.job_digest)+'/c2'}],job.state);
 }
 const noDigest={...jobs[0],job_digest:undefined};
 const step=onboardingVM({home,circles:[joined],jobs:[noDigest]}).progress.current;
 assert.equal(step.actions,undefined,'no broken job URL when the identifier is unavailable');
});
