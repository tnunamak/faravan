import {durationLabel} from './transcript-feed.mjs';
import {formatDate} from './dates.mjs';

// Clock times go through the shared formatter (dates.mjs) so every screen formats times the same way.
const clockTime = (at, zone) => formatDate(Date.parse(at), 'clock', {zone, locale: 'en-US'});
const APPROVAL = {waiting: 'Waiting for a decision', accepted: 'Approved', declined: 'Declined', expired: 'No decision in time', cancelled: 'Cancelled'};

/**
 * Pure projection of GET jobs/:id/timeline. Times are only what was recorded; a stage with no time
 * says so, and a time this computer only noticed later is labelled as noticed.
 */
export function timelineVM(timeline, {timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, error = null, role = 'sent', terminal = false} = {}) {
  if (!timeline) return {state: error ? 'unavailable' : 'loading', rows: [], notes: []};
  const stages = Array.isArray(timeline.stages) ? timeline.stages : [];
  const approved = timeline.approval === 'approved' || stages.some(stage=>['preparing','running','checks','sending'].includes(stage.key));
  const rows = stages.filter(stage=>role==='sent'||stage.key!=='sent').map(stage => {
    const time = stage.at ? clockTime(stage.at, timeZone) : '';
    let detail = '';
    if (stage.key === 'approval') detail = stage.auto ? 'Approved automatically' : APPROVAL[stage.outcome==='waiting'&&approved?'accepted':stage.outcome] ?? '';
    const took = durationLabel(stage.durationMs);
    return {
      key: stage.key, label: stage.label, detail,
      time: time ? (stage.noticed ? 'Recorded at ' + time : time) : 'Time not recorded',
      missing: !time,
      duration: took ? 'took ' + took : '',
      // The lender's computer sends its own stage times; they can be a little off from this computer's clock.
      reported: stage.clock === 'reported',
    };
  });
  const notes = [];
  if (!terminal && !timeline.complete && rows.length) notes.push('More stages appear as they happen.');
  if (rows.some(row => row.reported)) notes.push('Stage times come from the computer that ran the job.');
  if (timeline.retention?.durable === false) notes.push("This computer couldn't save its history, so some times may be missing after a restart.");
  return {state: rows.length ? 'rows' : 'empty', rows, notes};
}
