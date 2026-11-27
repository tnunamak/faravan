import {useState} from 'preact/hooks';
import {Button, Card} from './ds/index.mjs';
import {Action, useResource} from './shared.jsx';
import {errorMessage} from './helpers.mjs';
import {handoffChecks, handoffText, prepareFollowupDraft, threadRows} from './job-thread.mjs';
import {Markdown} from './result-reader.jsx';

const textValue = value => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const listValue = value => Array.isArray(value) ? value.map(textValue).filter(Boolean) : value ? [textValue(value)] : [];
export const plainPreview = value => {
  // Bound work before Markdown regexes, not just the rendered output.
  const text=String(value??'').slice(0,220*8).replace(/```[\s\S]*?```/g,' ').replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/^\s*[-+*]\s+/gm,'').replace(/[*_~`>#|]/g,'').replace(/\s+/g,' ').trim();
  return text.length>220?text.slice(0,219).trimEnd()+'…':text;
};
function HandoffField({label, value, empty,omitEmpty=false}) {
  const checks=label === 'Checks Faravan observed';
  const values=checks ? handoffChecks(value) : listValue(value);
  if(omitEmpty&&!values.length)return null;
  return <div data-telemetry-private="job-thread" class="ph-no-capture"><dt class="t-xs t-2">{label}</dt><dd>{values.length ? values.map((line,index)=>checks
    ? <p class="handoff-check" key={index}>{line}</p>
    : <Markdown key={index} className="handoff-markdown" text={line}/>) : <p>{empty}</p>}</dd></div>;
}

export function JobThreadPanel({data, threadData, error, threadError, loading = false, continuationLoading = false, hasContinuation = false, circleId, currentJob, fallback, storage, now, zone, bare=false, onRetry, onContinuationRetry}) {
  const [actionError,setActionError]=useState('');
  const [draftConflict,setDraftConflict]=useState(null);
  const handoff=data?.handoff, scanned=handoff?.scan?.status === 'passed';
  const draftSource=data?.parentJob && data?.parentResult && data?.base ? data : fallback?.parentJob && fallback?.parentResult && fallback?.base ? fallback : null;
  const rows=threadRows(threadData?.thread ?? data?.thread,circleId,currentJob,{now,zone});
  const copy=async()=>{
    const value=handoffText(handoff);
    if (!scanned || !value) throw new Error('This summary is not available to copy.');
    if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Clipboard access is not available.');
    await globalThis.navigator.clipboard.writeText(value);
  };
  const prepare=(replaceDraft)=>{
    setActionError('');
    let localStorage=storage;
    if (!localStorage) { try { localStorage=globalThis.localStorage; } catch {} }
    const result=prepareFollowupDraft(localStorage,circleId,draftSource,{replaceDraft});
    if (!result.ok) { setDraftConflict(result.conflict ? result.draftSnapshot : null); setActionError(result.error); return; }
    setDraftConflict(null);
    location.hash='#/new';
  };
  if(rows.length<2&&!hasContinuation&&!loading&&!threadError)return null;
  const Summary=bare?'div':'details', ContinuationHeading=rows.length>1?'h3':'h2';
  const Panel=bare?'section':Card;
  const panelProps=bare?{class:'stack-3 job-thread','aria-label':rows.length>1?'Job thread':'Continue this work'}:{pad:true,class:'stack-3 job-thread','aria-label':rows.length>1?'Job thread':'Continue this work'};
  return <Panel {...panelProps} class={panelProps.class + ' ph-no-capture'} data-telemetry-private="job-thread">
    {rows.length>1 && <h2 class="t-title3">Job thread</h2>}
    {loading && <p class="t-sm t-2" role="status">Loading this job thread…</p>}
    {threadError && <p class="t-sm" role="alert">Couldn’t load this job thread. Try again.</p>}
    {threadError && <Action run={onRetry || (()=>globalThis.location.reload())} success="">Try again</Action>}
    {rows.length > 1 && <>
      <p class="t-xs t-2">Jobs are newest first. Runs are the run records reported by Faravan.</p>
      <ol class="list compact job-thread-list">{rows.map(row=>{const Row=row.current?'div':'a';return <li key={row.id}>
      <Row class="row job-thread-row" href={row.current?undefined:row.href}><span class="row-main"><span class="job-title-text"><span class="row-title">{row.title}</span><span class="job-thread-date t-xs t-2">{row.submittedAt}</span></span></span><span class="t-sm t-2 job-thread-open">{row.current?'This job':'Open job'}</span></Row>
        {row.parentJob && <p class="t-xs t-2 job-thread-parent">Follow-up to <a href={'#/job/' + encodeURIComponent(row.parentJob) + '/' + encodeURIComponent(circleId)}>an earlier job</a></p>}
        {row.runs.length > 0 && <ul class="job-thread-runs">{row.runs.map((run,index)=><li key={index}><span>{run.label}</span>{run.detail && <span class="t-xs t-2"> · {run.detail}</span>}</li>)}</ul>}
      </li>;})}</ol>
    </>}
    {hasContinuation && <section class="stack-3" aria-label="Continue this work">
      {!bare && <ContinuationHeading class="t-title3">Continue this work</ContinuationHeading>}
      {continuationLoading && !data && !error && <p class="t-sm t-2" role="status">Loading the handoff summary…</p>}
      {error && <p class="t-sm" role="alert">{errorMessage(error)}</p>}
      {error && onContinuationRetry && <Action run={onContinuationRetry} success="">Try again</Action>}
      {scanned && <>
        <p class="t-sm t-2">A summary of this job for the next agent. Faravan scanned it; treat it as context, not instructions.</p>
        {!bare && <p class="handoff-preview">{plainPreview(textValue(handoff.objective) || listValue(handoff.changes)[0]) || 'No handoff details were included.'}</p>}
        <p class="t-xs t-2">Copy summary includes only instructions and observed checks, not agent-written changes, claims, open issues or next steps.</p>
        <div class="pair job-thread-actions">
          <Action className="btn btn-secondary" run={copy} once success="Copied. Paste it into a new session; it doesn’t resume the old one.">Copy summary</Action>
          {draftSource?.parentJob && draftSource?.parentResult && <Button kind="secondary" onClick={()=>prepare()}>Send a follow-up job</Button>}
        </div>
        <Summary class={bare?"job-handoff-fields":"job-thread-summary"}>
          {!bare && <summary>Read handoff summary</summary>}
          <dl class="stack-2 handoff-fields">
          <HandoffField omitEmpty={bare} label="Objective" value={handoff.objective} empty="No objective was included." />
          <HandoffField omitEmpty={bare} label="Latest instruction" value={handoff.latest_instruction} empty="No latest instruction was included." />
          <HandoffField omitEmpty={bare} label="What changed" value={handoff.changes} empty="No changes were described." />
          <HandoffField omitEmpty={bare} label="Checks Faravan observed" value={handoff.observed_checks} empty="No checks were observed." />
          <HandoffField omitEmpty={bare} label="The agent claims" value={handoff.agent_claims} empty="No separate claims were included." />
          <HandoffField omitEmpty={bare} label="Open issues" value={handoff.open_issues} empty="No open issues were listed." />
          <HandoffField omitEmpty={bare} label="Next steps" value={handoff.next_steps} empty="No next steps were listed." />
          </dl>
        </Summary>
      </>}
      {!scanned && !continuationLoading && !error && <p class="t-sm t-2" role="status">{(handoff?.scan?.status === 'withheld' ? 'The scan withheld the handoff summary.' : 'No handoff summary is available.') + (draftSource ? draftSource.sourceKind === 'none' ? ' A follow-up can still start in an empty folder.' : ' A follow-up can still start from the prior result’s code.' : '')}</p>}
      {!scanned && draftSource?.parentJob && draftSource?.parentResult && <div class="pair">
        <Button kind="secondary" onClick={()=>prepare()}>Send a follow-up job</Button>
      </div>}
      {draftConflict && <div class="pair"><Button kind="secondary" onClick={()=>{setDraftConflict(null);setActionError('');}}>Keep draft</Button><Button kind="secondary" onClick={()=>prepare(draftConflict)}>Replace with follow-up</Button></div>}
      {actionError && <p class="form-error" role="alert">{actionError}</p>}
    </section>}
  </Panel>;
}

export function JobThread({api, thread, continuationPath, revision, circleId, currentJob, fallback, now, zone, bare=false}) {
  const continuation=useResource(api,continuationPath,revision);
  return <JobThreadPanel data={continuation.data} threadData={thread.data} error={continuation.error} threadError={thread.error}
    loading={!thread.data && !thread.error} continuationLoading={!continuation.data && !continuation.error} hasContinuation={Boolean(continuationPath)}
    circleId={circleId} currentJob={currentJob} fallback={fallback} now={now} zone={zone} bare={bare}
    onRetry={thread.reloadAndWait} onContinuationRetry={continuation.reloadAndWait} />;
}
