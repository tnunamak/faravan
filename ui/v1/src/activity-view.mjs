import {whenLabel} from './view-models.mjs';
import {formatDate} from './dates.mjs';
import {agentLabel} from './helpers.mjs';

const circleOf = data => typeof data?.circle === 'object' ? data.circle?.id : data?.circle;

const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
const cleanName = value => {
  if (typeof value !== 'string') return '';
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || /^Member \d+$/i.test(name) || /^sha256:/i.test(name) || /^[\da-f]{32,}$/i.test(name) ||
      /^[\da-f]{8}-[\da-f-]{27,}$/i.test(name)) return '';
  return name;
};

const actorOf = (event, devices) => {
  const data = event?.data ?? {};
  for (const name of [data.actorName, data.localName, data.deviceName, data.device_name]) {
    const valid = cleanName(name);
    if (valid) return valid;
  }
  const actor = data.actor ?? data.actorId ?? data.actor_id ?? data.author ?? data.key_id;
  if (typeof actor === 'string' && actor) {
    if ([devices?.fingerprint, devices?.key_id, devices?.ownerKey].includes(actor)) return 'This computer';
    for (const circle of devices?.circles ?? []) {
      if (circleOf(data) && circle.circle !== circleOf(data)) continue;
      const member = (circle.members ?? []).find(item => item.key_id === actor);
      const name = cleanName(member?.localName) || cleanName(member?.device_name);
      if (name) return name;
    }
  }
  return 'Unknown computer';
};

// Evaluate oldest first so repeated job states do not become new activity.
const meaningfulEvents = dated => {
  const jobs = new Map(), agents = new Map(), rows = [];
  const emit = (row, title, identity) => rows.push({...row, title, identity});
  const jobState = (row, scope, id, status) => {
    if (typeof id !== 'string' || !id) return;
    const phase = status === 'Running' || status === 'running' ? 'running'
      : ['Finished', 'Done', 'Ready to review', 'Failed', 'Cancelled', 'finished', 'failed', 'stopped'].includes(status) ? 'finished' : '';
    if (!phase) return;
    const key = JSON.stringify([scope, id]);
    if (jobs.get(key) === phase) return;
    jobs.set(key, phase);
    emit(row, phase === 'running' ? 'Job started' : 'Job finished', ['job', id, phase]);
  };
  for (const row of dated) {
    const {event} = row, data = event?.data ?? {};
    const actor = data.actor ?? data.actorId ?? data.actor_id ?? data.author ?? data.key_id
      ?? data.actorName ?? data.localName ?? data.deviceName ?? data.device_name ?? '';
    const scope = JSON.stringify([circleOf(data) ?? '', actor]);
    if (event.type === 'lending-action') {
      const title = {on:'Lending turned on',off:'Lending turned off',paused:'Lending paused',resumed:'Lending resumed'}[data.action];
      if (title) emit(row, title, ['lending-action',data.action]);
    } else if (event.type === 'lending') {
      // Status observations are not lending actions. The current value is an attempt id.
      const attempt = typeof data.current === 'string' ? data.current : data.current?.attempt_id;
      if (attempt) jobState(row, scope, attempt, data.status);
    } else if (event.type === 'job') {
      const attempt = data.current_attempt;
      jobState(row, scope, attempt?.attempt_id ?? data.job_digest,
        attempt?.execution_started_at && data.status === 'Starting' ? 'Running' : data.status);
    } else if (event.type === 'agents') {
      if (data.refreshed || typeof data.id !== 'string' || !data.id || typeof data.useForLending !== 'boolean') continue;
      const key = JSON.stringify([scope, data.id]);
      if (agents.get(key) === data.useForLending) continue;
      agents.set(key, data.useForLending);
      emit(row, agentLabel(data.id) + (data.useForLending ? ' turned on for lending' : ' turned off for lending'), ['agents', data.id, data.useForLending]);
    } else if (event.type === 'enrollment' && data.state === 'joined') {
      emit(row, 'Device joined', ['member', data.deviceName ?? actor, 'joined']);
    } else if (event.type === 'circle-security') {
      const title={steward:'Backup steward changed','ownership-propose':'Ownership transfer offered','ownership-accept':'Ownership transfer accepted','ownership-cancel':'Ownership transfer cancelled','person-link':'Computer identities linked',role:'Circle role changed','person-block':'Person blocked','person-unblock':'Person unblocked','person-remove':'Person removed'}[data.action];
      if(title)emit(row,title,['circle-security',data.action,event.id]);
    } else if (event.type === 'member-left') {
      emit(row, 'Device left', ['member', data.deviceName ?? actor, 'left']);
    }
  }
  return rows;
};

const dateKey = (at, zone) => {
  return formatDate(at, 'dayKey', {zone});
};
const dayName = (at, zone, today, yesterday) => {
  const key = dateKey(at, zone);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return formatDate(at, 'monthDayLong', {zone});
};

/** Pure projection for recent local activity; clock and timezone are explicit inputs. */
export function activityVM(events, {now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, devices = {}, circleId = ''} = {}) {
  if (!Array.isArray(events)) return {state:'loading', groups:[]};
  const selected = circleId ? events.filter(event => circleOf(event?.data) === circleId) : events;
  const dated = selected.map(event => ({event, at:timestamp(event?.at)}))
    .filter(row => Number.isFinite(row.at)).sort((a, b) => a.at - b.at);
  const today = dateKey(now, timeZone);
  const [year, month, day] = today.split('-').map(Number);
  const yesterday = Number.isFinite(year + month + day) ? new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10) : '';
  const groups = [];
  let previousKey;
  for (const {event, at, title, identity} of meaningfulEvents(dated).reverse()) {
    const actor = actorOf(event, devices), when = whenLabel(at, now, timeZone);
    let group = groups.at(-1);
    const day = dateKey(at, timeZone), label = dayName(at, timeZone, today, yesterday);
    if (!group || group.day !== day) {groups.push(group = {day, label, events:[]});previousKey = undefined;}
    const last = group.events.at(-1);
    const data = event.data ?? {};
    const repeatKey = JSON.stringify([circleOf(data) ?? '', data.actor ?? data.actorId ?? data.actor_id ?? data.author ?? data.key_id ?? '', identity]);
    if (last && last.title === title && last.actor === actor && previousKey === repeatKey) {
      last.count += 1;
      last.when = when; // Keep the first occurrence, not the latest repeated delivery.
    } else group.events.push({title, actor, when, count:1});
    previousKey = repeatKey;
  }
  return {state:groups.length ? 'rows' : 'empty', groups};
}

/** Newest-first pages from GET activity/history merged by id; a refreshed first page never drops loaded older pages. */
export function mergeHistoryPages(first, older = []) {
  const seen = new Set(), events = [];
  for (const page of [first, ...older]) for (const event of page?.events ?? []) {
    if (!Number.isSafeInteger(event?.id) || seen.has(event.id)) continue;
    seen.add(event.id); events.push(event);
  }
  return events.sort((a, b) => b.id - a.id);
}

/** What the durable history keeps, in words. retention is the page's retention block. */
export function historyNote(retention) {
  if (!retention) return 'Shows activity since Faravan last started.';
  if (retention.durable === false) return "This computer couldn't save its activity, so this shows only what happened since Faravan started.";
  const days = Number.isSafeInteger(retention.days) ? retention.days : 90;
  return 'This computer keeps activity for ' + days + ' days.' + (retention.trimmedBefore ? ' Some older activity was removed to save space.' : '');
}

export const activityTypes=Object.freeze({all:'',jobs:'job,approval',lending:'lending,lending-action,agents,attention',people:'enrollment,member-left,circle-security'});
export function filterActivity(events=[],filter='all') {
  const types=activityTypes[filter]||'';
  return events.filter(event=>!types||types.split(',').includes(event.type));
}
export function savedActivityState({enabled=false,data,error}={},filter='all') {
  return {
    pending:enabled&&!data&&!error,
    warning:error?"Saved activity couldn't load. Showing activity available since Faravan started.":'',
    empty:{people:'No people changes in the available history.',jobs:'No job changes in the available history.',lending:'No lending changes in the available history.'}[filter]||'No activity in the available history.',
  };
}
