import {Card} from './ds/index.mjs';
import {useResource} from './shared.jsx';
import {timelineVM} from './job-timeline.mjs';

const enc = encodeURIComponent;

/** Presentational: tests render this with a fixed view. */
export function JobTimelineView({view,bare=false}) {
  if (view.state === 'loading') return null;
  const Container=bare?'div':Card;
  return (
    <Container class="ph-no-capture" pad={bare?undefined:true} data-telemetry-private="job-timeline"><section class="stack-3 job-timeline" aria-label="Timeline">
      <h2 class="t-title3">Timeline</h2>
      {view.state === 'unavailable' ? <p class="t-sm t-2">The timeline is unavailable right now.</p>
        : view.state === 'empty' ? <p class="t-sm t-2">No stages recorded yet.</p>
        : <ol class="list stack-2">
          {view.rows.map(row => (
            <li key={row.key} class="row">
              <div class="row-main"><div class="row-title t-sm">{row.label}{row.detail ? ' · ' + row.detail : ''}</div></div>
              <div class={'row-end t-sm ' + (row.missing ? 't-3' : 't-2')}>{row.time}{row.duration ? ' · ' + row.duration : ''}</div>
            </li>
          ))}
        </ol>}
      {view.notes.map(note => <p key={note} class="t-xs t-2">{note}</p>)}
    </section></Container>
  );
}

/** Stage timeline for one job. The parent passes its revision so the timeline refreshes with the job. */
export function JobTimeline({api, jobId, circle, revision,bare=false,role,terminal}) {
  const path = api && jobId ? 'jobs/' + enc(jobId) + '/timeline' + (circle ? '?circle=' + enc(circle) : '') : null;
  const {data, error} = useResource(api, path, revision);
  return <JobTimelineView bare={bare} view={timelineVM(data, {error,role,terminal})} />;
}
