// Role-aware onboarding (PRODUCT-UX-FIELD-RESEARCH §8). Borrowing needs a circle and nothing else; lending needs
// Docker Sandboxes and an agent sign-in; each job checks isolation before starting. So a new computer is offered borrowing first, lending is
// named as optional, and a lending problem never reads as something that blocks asking for help.
import {composeCircle} from './compose-model.mjs';
import {loadDraft, saveDraft} from './compose-draft.mjs';
import {jobStateKey, lendingStarted as started} from './view-models.mjs';
import {formatMembership} from './membership-projection-view.mjs';
import {joinLendingNote} from './lending-projection-view.mjs';
import {borrowingReadiness} from '../../../lib/v1/borrowing-readiness.mjs';

// Definitions only: nothing is collected. When collection exists it is local-first and opt-in.
export const ONBOARDING_EVENTS = Object.freeze([
  {name: 'first_open', definition: 'The app opened for the first time on this computer.'},
  {name: 'borrower_ready', definition: 'This computer is a member of at least one circle and can send a job.'},
  {name: 'lender_ready', definition: 'Lending is on and every lending check passed.'},
  {name: 'requested', definition: 'This computer sent its first job to a circle.'},
  {name: 'approved', definition: 'A lender accepted one of this computer’s jobs.'},
  {name: 'result_reviewed', definition: 'The person recorded an outcome for a result they received.'},
  {name: 'useful_result', definition: 'The person marked a result as used.'},
  {name: 'independent_circle_activated', definition: 'A circle this person did not start exchanged its first job.'},
  {name: 'repeat_exchange', definition: 'The same pair of people exchanged a second job.'},
].map(Object.freeze));

// Under the empty composer and on the progress card. Small and checkable, so the first result is easy to judge.
export const FIRST_TASKS = Object.freeze([
  {label: 'Explain this project', prompt: 'Explain how this project is organised. Write the explanation to NOTES.md: the main parts, how they connect, and where to start reading. Do not change other files.'},
  {label: 'Add tests for one function', prompt: 'Find one important function without tests and add tests for it. Use the project’s existing test framework. Do not change the function.'},
  {label: 'Fix a failing test', prompt: 'Run the test suite. If a test fails, find the cause and fix it with the smallest change. Explain the cause in your summary.'},
].map(Object.freeze));

// The whole contract on one card, labelled as an example. It is never shown as live data.
export const EXAMPLE_RESULT = Object.freeze({
  label: 'Example result · not a real job',
  request: 'Stop checkout unless the departure date is after the arrival date.',
  summary: 'Added a date check before payment and a test for the reversed dates. Checkout now shows “Departure must be after arrival”.',
  check: 'Faravan ran your test command, npm test: 42 passed.',
  diff: Object.freeze([
    {kind: 'add', text: "if (departure <= arrival) return error('Departure must be after arrival');"},
    {kind: 'del', text: 'return pay(order);'},
    {kind: 'add', text: 'return validate(order) ?? pay(order);'},
  ]),
  diffSummary: '2 files changed, +14 −1',
  branch: 'faravan/fix-checkout-dates',
  next: 'You review the changes, then download them or apply them to your project. Nothing changes on your computer until you do.',
});

const IN_MOTION = new Set(['waiting', 'asked', 'waiting_approval', 'approved', 'starting', 'working', 'sending', 'delivery_delayed', 'stop_requested', 'stop_unconfirmed', 'uncertain', 'unknown']);

/**
 * `entry` is the first-run choice (null once the computer belongs to a circle or has sent a job). `progress` is the
 * persistent four-step card. The progress card is hidden once a result is available or this computer has moved into lending; useful-result tracking remains separate.
 * `suggestions` appear while nothing has been sent.
 */
export function onboardingVM({home = null, circles = [], jobs = [], agents = []} = {}) {
  const lendingStarted = started(home, agents);
  const connected = (Array.isArray(circles) ? circles : []).filter(circle => circle?.origin);
  const list = Array.isArray(jobs) ? jobs : [];
  const sent = list.filter(job => !['ran','received'].includes(job.role));
  const membership = circle => formatMembership(circle, {surface: 'onboarding'});
  // The same answer the status.borrowing operation gives: a joined circle, and nothing about lending setup.
  const joined = borrowingReadiness({circles: connected}).can_borrow;
  const waitingCircle = connected.find(circle => membership(circle).waiting);
  const waiting = waitingCircle ? membership(waitingCircle) : null;
  const fresh = !connected.length && !sent.length;
  const entry = fresh ? {
    kind: 'fresh',
    headline: 'Get help from people you trust',
    text: 'Ask a friend’s agent for help with a question, writing, or a coding task, then review what comes back before you use it. Join a circle with an invitation, or start one and invite people.',
    actions: [
      {id: 'join', label: 'Join with an invitation', href: '#/circles', primary: true},
      {id: 'start', label: 'Start a circle', href: '#/circles/new'},
      {id: 'lending', label: 'Set up lending', href: '#/setup'},
      {id: 'example', label: 'See an example'},
    ],
    lendingNote: joinLendingNote(home ?? {}, {surface:'fresh'}),
  } : null;

  const reviewed = sent.some(job => job.borrowerOutcome);
  const useful = sent.some(job => job.borrowerOutcome?.verdict === 'used');
  const lenderWork = list.some(job => ['ran','received'].includes(job.role));
  const lenderOnly = lendingStarted && !sent.length && (lenderWork || joined);
  // A result in hand (or lending already under way) means the computer is past getting started.
  const hasResult = sent.some(job => job.borrowerOutcome || ['ready', 'added_branch', 'no_changes'].includes(jobStateKey(job)));
  const movingJob = sent.find(job => IN_MOTION.has(jobStateKey(job)));
  const moving = movingJob ? jobStateKey(movingJob) : null;
  const stage = {
    waiting: ['Waiting for acceptance', 'Waiting for a computer to accept your job.'],
    asked: ['Waiting for acceptance', 'Waiting for a computer to accept your job.'],
    waiting_approval: ['Waiting for approval', 'Someone in the circle still has to approve your job.'],
    approved: ['Job accepted', 'Your job was accepted. Open it for its latest status.'],
    starting: ['Job starting', 'Your job is starting. Open it for its latest status.'],
    working: ['Job running', 'Your job is running. Open it for progress or stop controls.'],
    sending: ['Sending your result', 'Your result is being sent back.'],
    delivery_delayed: ['Result delayed', 'Your result is delayed. Open the job for its latest status.'],
    stop_requested: ['Stop requested', 'A stop was requested. Open the job to check whether it has stopped.'],
    stop_unconfirmed: ['Stop not confirmed', 'Faravan has not confirmed that this job stopped. Open the job to check its status before sending another.'],
    unknown: ['Check the previous job', 'The current status of this job could not be read. Open it to check before sending another.'],
    uncertain: ['Job interrupted', 'This job was interrupted and its outcome is not confirmed. Open the job to check what happened before sending another.'],
  }[moving];
  const recovery = Boolean(movingJob?.job_digest);
  const recoveryActions = recovery && movingJob.job_digest ? [{label: 'Open job',
    href: '#/job/' + encodeURIComponent(movingJob.job_digest) + (movingJob.circle?.id ? '/' + encodeURIComponent(movingJob.circle.id) : '')}] : [];
  const steps = [
    {id: 'ready', label: 'Faravan is open on this computer', done: home != null, turn: ''},
    {id: 'joined', label: 'Joined a circle', done: joined,
      actions: waiting ? [{href:'#/circle/' + encodeURIComponent(waitingCircle.id),label:'View join request'}] : [{href:'#/circles',label:'Join with an invitation'},{href:'#/circles/new',label:'Start a circle'}],
      turn: waiting ? waiting.turn : 'Your turn: join or start a circle'},
    {id: 'reviewed', label: stage ? stage[0] : 'Send a job', done: reviewed,
      ...(recovery ? {actions: recoveryActions} : {}),
      turn: stage ? stage[1] : 'Your turn: send a job'},
    {id: 'useful', label: 'First useful result', done: useful,
      turn: 'When a result helps, mark it as used on its page'},
  ];
  const current = steps.find(step => !step.done) ?? null;
  const progress = useful || lenderOnly || hasResult || lenderWork || !current ? null : {
    title: 'Getting started', current, steps: steps.map(step => ({...step, current: step === current})),
    count: steps.filter(step => step.done).length + ' of ' + steps.length + ' done',
  };
  return {entry, progress, lendingSetup: joined && !lendingStarted, suggestions: joined && !sent.length && !lenderWork ? FIRST_TASKS : []};
}

/**
 * A first-task suggestion fills the composer's saved draft for the circle the composer will open on. It never
 * replaces text the person already wrote, and never touches a draft that is being sent.
 */
export function suggestFirstTask(storage, circles, current, prompt) {
  let last = null;
  try { last = storage?.getItem('faravan-compose-circle') ?? null; } catch { /* no saved choice */ }
  const circle = composeCircle(circles, last, current);
  if (!circle) return false;
  const draft = loadDraft(storage, circle);
  if (draft.sending || draft.agentRefusal || draft.prompt.trim()) return false;
  saveDraft(storage, circle, {...draft, prompt});
  return true;
}
