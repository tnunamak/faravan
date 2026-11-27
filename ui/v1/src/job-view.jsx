import {CheckLines} from './check-line.jsx';
export {CheckLine, CheckLines} from './check-line.jsx';
import { Avatar, Card, Command, Facts, Icon, JobSteps, Spinner, Status } from './ds/index.mjs';
import { appliedLineVM } from './view-models.mjs';
import { EditorLinks } from './result-actions.jsx';
import {useContext, useEffect, useRef} from 'preact/hooks';
import {Notices} from './shared.jsx';

// The tab title belongs to what the page shows. Loading and error pages, which have no JobHead, own it through this
// (r8 O16), so a keyed navigation from job A never leaves A's words on job B's tab.
export function TabTitle({text}) {
  useEffect(()=>{document.title=text+' · Faravan';},[text]);
  return null;
}

// The job page's head: back link, the one status word, the title as the page heading, one line of context.
// Every word comes from jobStatusVM (view-models.mjs).
export function JobHead({ vm, title, sub, headingRef }) {
  const notices = useContext(Notices), spoken = useRef(null), word = vm.loading ? null : vm.pill.word;
  useEffect(()=>{document.title=title+' · '+(vm.loading?'Loading result':vm.pill.word)+' · Faravan';},[title,vm.loading,vm.pill.word]);
  // The open job announces its own status changes from the same word as the pill, so the notice never lags the page.
  useEffect(()=>{ if (word && spoken.current && spoken.current !== word) notices?.set(title + ': ' + word + '.'); if (word) spoken.current = word; },[word]);
  return (
    <header class="jh ph-no-capture" data-telemetry-private="job-view">
      <a class="back" href="#/jobs"><Icon name="chev-l" size="sm" />Jobs</a>
      {vm.loading ? <span class="skel job-status-loading" role="status" aria-label="Loading result" /> : <Status kind={vm.pill.kind} word={vm.pill.word} />}
      <h1 class="t-page" ref={headingRef} tabIndex="-1">{title}</h1>
      {sub && <div class="t-sm t-2 dots">{sub.map((part) => <span>{part}</span>)}</div>}
    </header>
  );
}

// The four steps and what is happening now. `waiting` is the existing waiting block (who is asked and when it expires);
// `ready` has no body here, because the changes are the page.
export function JobStatusCard({ vm, person, personName, waiting }) {
  const lit = vm.step === null || vm.step === undefined ? null : vm.step;
  return (
    <Card data-telemetry-private="job-view" class="ph-no-capture">
      <div class="wait-card">
        {lit !== null && <JobSteps at={lit} fail={vm.fail} done={vm.key === 'ready'} />}
        {vm.kind === 'waiting' && waiting}
        {vm.kind === 'status' && (
          <>
            {person && vm.key === 'working' ? (
              <div class="presence">
                <Avatar personName={personName} id={person} size="lg" />
                <div class="grow">
                  <b>{vm.headline}</b>
                  {vm.facts.length > 0 && <div class="t-sm t-2 dots">{vm.facts.map((part) => <span>{part}</span>)}</div>}
                </div>
              </div>
            ) : (
              <>
                <b>{vm.headline}</b>
                {vm.facts.length > 0 && <div class="t-sm t-2 dots">{vm.facts.map((part) => <span>{part}</span>)}</div>}
              </>
            )}
            {vm.progress.length > 0 && (
              <div class="prog" aria-label="What is happening">
                {vm.progress.map((row) => (
                  <div class={row.tone}>
                    {row.tone === 'ok' ? <Icon name="check" size="sm" /> : row.tone === 'now' ? <Spinner /> : <Icon name="clock" size="sm" />}
                    {row.code ? <span class="prog-text"><span>{row.text}</span><code class="prog-code" title={row.code}>{row.code}</code></span> : <span>{row.text}</span>}{row.after && <span class="prog-after">{row.after}</span>}
                  </div>
                ))}
              </div>
            )}
            {vm.text && <p class="t-sm t-2">{vm.text}</p>}
            {vm.note && <p class="t-xs t-2">{vm.note}</p>}
          </>
        )}
      </div>
    </Card>
  );
}

// "How it ran" (U17): receiptLines() rows, each naming who observed it, then the usage line.
export function HowItRan({ lines, checks = [], usage, note, missing, details = [], heading = 'How it ran', bare }) {
  const body = (
    <div class={(bare ? 'stack-3' : 'card-pad stack-3') + ' ph-no-capture'} data-telemetry-private="job-view">
      {heading && <h2 class="t-title2">{heading}</h2>}
      {lines.length > 0 && <Facts items={lines} label={heading} />}
      {checks.length > 0 && <CheckLines checks={checks} />}
      {missing && <p class="t-sm t-2">{missing}</p>}
      {details.length>0 && <details class="stack-2"><summary>Details</summary><Facts items={details} label="Other run details" /></details>}
      {note && <p class="t-xs t-2">{note}</p>}
      {usage && <p class="t-xs t-2">{usage}</p>}
    </div>
  );
  return bare ? body : <Card data-telemetry-private="job-view" class="ph-no-capture">{body}</Card>;
}

// What was asked, when this view received the prompt.
export function AskedCard({ prompt, own, action, bare=false,pending=false }) {
  const Container=bare?'section':Card;
  return (
    <Container data-telemetry-private="job-view" class="ph-no-capture">
      <div class={bare?'stack-2':'card-pad stack-2'}>
        <div class="job-asked-head"><h2 class="t-title3">{own ? 'What you asked' : 'What was asked'}</h2>{action}</div>
        {pending?<div class="skel" role="status" aria-label="Loading request"/>:<p class="prewrap">{prompt || (own ? 'No prompt was recorded for this job.' : 'The request couldn’t be loaded. Refresh to try again.')}</p>}
      </div>
    </Container>
  );
}

// "Added faravan/3f9a1c… to booking-site." (job.applied): a fact about the repository, with the one command to look at it.
export function AppliedCard({ applied }) {
  const line = appliedLineVM(applied);
  return (
    <Card data-telemetry-private="job-view" class="ph-no-capture">
      <div class="wait-card job-applied" role="status">
        <div class="hstack-2"><Icon name="check-circle" /><b>{line.heading}</b></div>
        <p class="t-sm t-2 phone-only">The branch is on your computer{line.repo ? ', in ' + line.repo : ''}. Switch to it there.</p>
        <div class="stack-2 desk-only"><details class="job-details"><summary>Show the switch-branch command</summary><p class="t-sm t-2">Open a terminal in {line.repo ? <b>{line.repo}</b> : 'your repository'}, then switch to the branch to review and test it.</p><Command text={line.switch} /></details><EditorLinks repo={applied?.repo} /></div>
        <ol class="t-sm"><li>Switch to the result branch deliberately; opening the editor does not switch branches.</li><li>Review the changes, including tests and configuration.</li><li>Run your own tests in a disposable environment before merging.</li></ol>
      </div>
    </Card>
  );
}
