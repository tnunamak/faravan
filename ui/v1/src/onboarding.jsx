import {useState} from 'preact/hooks';
import {Button, Card, Icon} from './ds/index.mjs';
import {EXAMPLE_RESULT} from './onboarding.mjs';
import {markJoinIntent} from './join-intent.mjs';

// The first-run telemetry card (docs/design/TELEMETRY.md §4.6) lives with the other first-run cards.
export {FirstRunCard} from './telemetry-ui.jsx';

// The whole contract on one card: request, agent summary, Faravan's check, diff, branch. Labelled on every
// rendering, and it links nowhere, so it can never be mistaken for a live job.
export function ExampleResult() {
  const ex = EXAMPLE_RESULT;
  return <section class="example-result ph-no-capture" aria-label={ex.label} data-telemetry-private="onboarding">
    <p class="example-tag t-xs">{ex.label}</p>
    <div class="stack-3">
      <div><p class="t-xs t-2">What was asked</p><p class="t-sm">{ex.request}</p></div>
      <div><p class="t-xs t-2">The agent says</p><p class="t-sm">{ex.summary}</p></div>
      <div><p class="t-xs t-2">Faravan checked</p><p class="t-sm">{ex.check}</p></div>
      <div class="result-preview" aria-label="Example changes">
        <div class="preview-file"><Icon name="branch" size="sm" /><code>{ex.branch}</code><span class="grow" /><span class="t-xs t-2">{ex.diffSummary}</span></div>
        {ex.diff.map((line, i) => <div key={i} class={'preview-line ' + line.kind}><span aria-hidden="true">{line.kind === 'add' ? '+' : '−'}</span><code>{line.text}</code></div>)}
      </div>
      <p class="t-sm t-2">{ex.next}</p>
    </div>
  </section>;
}

// First run: borrowing first, lending named as optional. "See an example" opens the example in place.
export function OnboardingEntry({entry}) {
  const [example, setExample] = useState(false);
  if (!entry) return null;
  return <Card class="onboarding-entry ph-no-capture" data-telemetry-private="onboarding"><div class="card-pad stack-4">
    <div class="stack-2"><h2 class="t-title2">{entry.headline}</h2><p class="t-2">{entry.text}</p></div>
    <div class="onboarding-actions">
      {entry.actions.map(action => action.href
        ? <Button key={action.id} kind={action.primary ? 'primary' : 'secondary'} href={action.href} onClick={action.href === '#/circles' ? () => markJoinIntent() : undefined}>{action.label}</Button>
        : <button key={action.id} type="button" class="btn btn-quiet" aria-expanded={example ? 'true' : 'false'} aria-controls="onboarding-example"
          onClick={() => setExample(open => !open)}>{example ? 'Hide the example' : action.label}</button>)}
    </div>
    <div id="onboarding-example" hidden={!example}>{example && <ExampleResult />}</div>
    <p class="t-sm t-2">{entry.lendingNote}</p>
  </div></Card>;
}

// The four milestones, each naming whose turn it is. Done steps are words, not only a tick.
export function ProgressCard({progress}) {
  if (!progress) return null;
  return <Card class="onboarding-progress ph-no-capture" data-telemetry-private="onboarding"><div class="card-pad stack-3">
    <div class="hstack"><h2 class="t-title3" id="onboarding-progress-title">{progress.title}</h2><span class="grow" /><span class="t-xs t-2">{progress.count}</span></div>
    <ol class="onboarding-steps" aria-labelledby="onboarding-progress-title">
      {progress.steps.map(step => <li key={step.id} class={step.done ? 'done' : step.current ? 'current' : ''} aria-current={step.current ? 'step' : undefined}>
        {step.done ? <Icon name="check-circle" size="sm" /> : <span class="step-dot" aria-hidden="true" />}
        <div><span class="t-sm">{step.label}</span><span class="sr">{step.done ? ', done' : ''}</span>
          {step.current && step.turn && <p class="t-xs t-2">{step.turn}</p>}
          {step.current && step.actions?.length > 0 && <div class="hstack-2 wrap">{step.actions.map(action=><Button size="sm" href={action.href}>{action.label}</Button>)}</div>}</div>
      </li>)}
    </ol>
  </div></Card>;
}

// Three small, checkable first jobs. Choosing one fills the composer; it never sends anything.
export function FirstTasks({tasks, onChoose}) {
  if (!tasks?.length) return null;
  return <section class="first-tasks stack-2 ph-no-capture" aria-labelledby="first-tasks-title" data-telemetry-private="onboarding">
    <h2 class="t-title3" id="first-tasks-title">Try a first job</h2>
    <div class="chips">{tasks.map(task => <button key={task.label} type="button" class="chip" onClick={() => onChoose(task)}>{task.label}</button>)}</div>
    <p class="t-xs t-2">Choosing one fills in a new job for you to check. Nothing is sent until you send it.</p>
  </section>;
}
