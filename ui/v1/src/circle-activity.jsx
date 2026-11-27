import { useState } from 'preact/hooks';
import { Button, Card } from './ds/index.mjs';
import { useResource } from './shared.jsx';
import { activityVM, historyNote, mergeHistoryPages, activityTypes, filterActivity, savedActivityState } from './activity-view.mjs';

// Durable history for this circle, newest first. If the history read fails, the live activity
// since start still shows, so a disk or network problem never blanks the page.
export function Activity({ data, circleId = '', api = null, revision }) {
  const [filter,setFilter]=useState('all');
  const types=activityTypes;
  const path = api && circleId ? 'activity/history?circle=' + encodeURIComponent(circleId)+(types[filter]?'&types='+encodeURIComponent(types[filter]):'') : null;
  const first = useResource(api, path, revision);
  const [older, setOlder] = useState({ path, first: first.data, pages: [], busy: false, error: '' });
  // A refreshed first page may jump past the old page boundary. Start pagination
  // from its new cursor instead of keeping older rows with a gap in between.
  const samePage = older.path === path && older.first === first.data;
  const pages = samePage ? older.pages : [];
  const history = first.data ? mergeHistoryPages(first.data, pages) : null;
  const nextBefore = pages.length ? pages.at(-1).nextBefore : first.data?.nextBefore ?? null;
  const loadOlder = async () => {
    if (!nextBefore || (samePage&&older.busy)) return;
    const generation=first.data;
    setOlder({ path, first:generation, pages, busy: true, error: '' });
    try {
      const page = await api.get(path + '&before=' + nextBefore);
      setOlder(current=>current.path===path&&current.first===generation?{ path, first:generation, pages: [...pages, page], busy: false, error: '' }:current);
    } catch {
      setOlder(current=>current.path===path&&current.first===generation?{ path, first:generation, pages, busy: false, error: "Older activity couldn't load. Try again." }:current);
    }
  };
  const fallback=filterActivity(data.activity??[],filter);
  const saved=savedActivityState({enabled:Boolean(path),data:first.data,error:first.error},filter);
  const view = activityVM(first.error ? fallback : history ?? fallback, {
    now: Date.now(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    devices: data.devices,
    circleId,
  });
  return (
    <Card pad class="circle-page stack-6 ph-no-capture" data-telemetry-private="circle-activity">
      <div class="pair"><h2 class="t-title3">Recent activity</h2><label class="field"><span class="sr">Activity type</span><select class="input" aria-label="Activity type" value={filter} onChange={e=>setFilter(e.currentTarget.value)}><option value="all">All activity</option><option value="jobs">Jobs</option><option value="lending">Lending</option><option value="people">People</option></select></label></div>
      {saved.pending&&<p role="status">Loading saved activity…</p>}
      {saved.warning&&<div role="alert"><p>{saved.warning}</p><Button onClick={first.reloadAndWait}>Retry saved activity</Button></div>}
      {view.state === 'loading' ? (
        <div class="circle-skeleton" role="status" aria-label="Loading recent activity"><span /><span /><span /></div>
      ) : view.state === 'empty' ? (
        !saved.pending&&!saved.warning?<p class="t-sm t-2">{saved.empty}</p>:null
      ) : (
        <div class="stack-6">
          {view.groups.map((group) => (
            <section key={group.label} class="stack-2">
              <h3 class="t-sm t-2">{group.label}</h3>
              <ol class="list stack-2">
                {group.events.map((event, index) => (
                  <li key={group.label + ':' + index} class="row">
                    <div class="row-main">
                      <div class="row-title t-sm">{event.title}{event.count > 1 ? ` ${event.count} times` : ''} · {event.actor}</div>
                    </div>
                    <div class="row-end t-sm t-2">{event.when}</div>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
      {history && nextBefore ? <div><Button pending={samePage&&older.busy} onClick={loadOlder}>Show older</Button></div> : null}
      {older.error && samePage ? <p class="form-error" role="alert">{older.error}</p> : null}
      <p class="t-sm t-2">{historyNote(history ? first.data.retention : null)}</p>
    </Card>
  );
}
