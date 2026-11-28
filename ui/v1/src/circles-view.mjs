import { safeName } from './helpers.mjs';
import {formatDate} from './dates.mjs';
import { whenLabel, whenWords, jobActivity } from './view-models.mjs';
import { formatMembership } from './membership-projection-view.mjs';
import {lendingProjectionOf, formatLendingProjection} from './lending-projection-view.mjs';

function unavailableCircleHost(circle, now, zone) {
  const owner = safeName(circle?.joinInfo?.ownerName);
  const host = owner ? owner + '’s computer, which hosts this circle,' : 'The computer that hosts this circle';
  const lastReached = whenWords(circle?.host?.lastReachedAt, now, zone);
  return host + ' did not answer.' + (lastReached ? ' Last reached ' + lastReached + '.' : '') +
    ' Only that computer serves this circle for now; jobs wait until it is back.';
}

// Only an explicit successful read may establish empty history.
export function circleJobsStatus(circleId, coverage, uncheckedIds = [], readError = null, {circle, now = Date.now(), zone} = {}) {
  const observation = Array.isArray(coverage) ? coverage.find(row => row?.circleId === circleId) : undefined;
  if (observation?.state === 'skipped') return null;
  if (readError && observation) {
    const status = Number(readError.status);
    return {message: status === 401 || status === 403 ? 'Job history is not available with your current access.' : 'Job history could not be refreshed.', warning:true};
  }
  if (observation?.state === 'verified_empty') return {message:'No jobs were found in the latest check.', warning:false};
  if (observation?.state === 'verified') return null;
  if (observation?.state === 'partial') {
    // Member computers answered for the jobs they run; jobs only the circle host holds could not be checked.
    let message = unavailableCircleHost(circle, now, zone) + ' Showing jobs that member computers confirmed; other jobs could not be checked.';
    const at = typeof observation.savedAt === 'string' ? Date.parse(observation.savedAt) : NaN;
    if (!(observation.cachedRows > 0)) return {message, warning:true};
    message += ' Saved jobs may still be shown.';
    return Number.isFinite(at) && new Date(at).toISOString() === observation.savedAt
      ? {message, warning:true, savedAt:observation.savedAt} : {message, warning:true};
  }
  if (observation?.state !== 'unavailable' && !uncheckedIds.some(entry => (typeof entry === 'string' ? entry : entry?.id) === circleId)) return null;
  const reason = observation?.reason;
  let message = reason === 'access' ? 'Job history is not available with your current access.'
    : reason === 'busy' ? 'The circle host is busy. Job history could not be refreshed.'
    : reason === 'missing' ? 'The circle is no longer available to check for jobs.'
    : reason === 'unreachable' ? unavailableCircleHost(circle, now, zone)
    : 'Job history could not be checked.';
  if (observation?.cachedRows > 0) message += ' Saved jobs may still be shown.';
  if ((reason === 'busy' || reason === 'unreachable') && Number.isInteger(observation?.cachedRows) &&
      observation.cachedRows >= 0 && typeof observation.savedAt === 'string') {
    const at = Date.parse(observation.savedAt);
    if (Number.isFinite(at) && new Date(at).toISOString() === observation.savedAt) {
      if (observation.cachedRows === 0) message += ' There are no jobs in the saved view.';
      return {message, warning:true, savedAt:observation.savedAt};
    }
  }
  return {message, warning:true};
}

export function invitationExpiryLabel(expiresAt, now = Date.now()) {
  const deadline = typeof expiresAt === 'number' ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return '';
  if (deadline <= now) return 'Invitation expired';
  const hours = Math.ceil((deadline - now) / 3600000);
  return 'Invitation expires in ' + hours + (hours === 1 ? ' hour' : ' hours');
}

// Display names are optional. Identifiers never stand in for people.
export function circlePerson(member = {}, { self = false, deviceName = '' } = {}) {
  const display = value => {
    const name = safeName(value);
    return /^(?:sha256:|[\da-f]{16,}$|[\da-f]{8}-[\da-f-]{27,}$|Member \d+$|A circle member$)/i.test(name) ? '' : name;
  };
  return display(member.localName) || display(member.personName) || display(member.ownerName) || display(member.device_name) ||
    (self ? display(deviceName) || 'This computer' : 'Unnamed computer');
}

// An empty list counts as 0 only from a held roster. A missing group or an empty list with no roster held keeps `lastCounts` (circle id to the last count seen); with no count seen the row shows none.
export function circlesListVM(circles = [], devices, hosting, {lastCounts = {}, uncheckedCircles = [], now = Date.now(), zone} = {}) {
  const unchecked = new Map(uncheckedCircles.map(entry => typeof entry === 'string' ? [entry, null] : [entry.id, entry.reason]));
  return circles.filter(circle => circle.origin).map(circle => {
    const group = devices?.circles?.find(group => group.circle === circle.id), listed = group?.members;
    const members = listed?.length || (Array.isArray(listed) && group.rosterHeld) ? listed : Number.isInteger(lastCounts[circle.id]) ? {length: lastCounts[circle.id]} : undefined;
    const localHost = hostedHere(circle, hosting);
    const membership = formatMembership(circle);
    const owner=safeName(circle.joinInfo?.ownerName);
    const lastSeen = whenWords(circle.host?.lastReachedAt, now, zone);
    const reachable = circle.host?.reachable;
    const hostOffline = reachable === false || (reachable !== true && ['unreachable', 'partial'].includes(unchecked.get(circle.id)));
    let status = membership.status;
    if (membership.phase === 'approved') {
      if (localHost) status = hosting.running === true ? 'Online' : hosting.running === false ? 'Offline · Hosting is stopped' : 'Hosting status unknown';
      else if (hostOffline) status = 'Host offline' + (lastSeen ? ' · last seen ' + lastSeen : '');
      else if (unchecked.has(circle.id)) status = 'Job history unavailable';
    } else if (membership.phase === 'unknown' && circle.joinIntent?.outcome === 'unknown') {
      status = 'Couldn’t reach the host · retrying';
    }
    return {id: circle.id, name: safeName(circle.name, 'Unnamed circle'), href: '#/circle/' + encodeURIComponent(circle.id),
      purpose: safeName(circle.purpose), hostingAction:localHost && hosting.running === false ? {label:'Start hosting',href:'#/circles/host'} : null, meta: [localHost ? 'Hosted on this computer' : owner ? 'Hosted by ' + owner : '',
        Number.isSafeInteger(circle.personCount) && circle.personCount >= 0 ? circle.personCount + (circle.personCount === 1 ? ' person' : ' people') : '',
        members ? members.length + (members.length === 1 ? ' computer' : ' computers') : '', status].filter(Boolean).join(' · ')};
  });
}

// The join result is a snapshot from the moment of joining; the refreshed circle list is the truth.
export function joinOutcomeVM(result, circles = [], {snapshot = null, afterReadId} = {}) {
  if (!result?.id) return null;
  const authoritativeNewer = Number.isInteger(snapshot?.readId) && snapshot.readId > afterReadId
    && Array.isArray(snapshot.rows);
  const raw = authoritativeNewer ? snapshot.rows.find(circle => circle.id === result.id) : null;
  if (authoritativeNewer && !raw) return null;
  const live = raw ?? (Array.isArray(circles) ? circles : []).find(circle => circle.id === result.id) ?? result;
  const name = safeName(live.name || result.name, 'the circle');
  return {...formatMembership(live, {surface: 'outcome', name, owner: live.joinInfo?.ownerName || result.joinInfo?.ownerName}), circleId: result.id};
}

export function memberAvailability(member, { self, home, now, zone, jobs = [] } = {}) {
  if (self && home) {
    const {kind} = formatLendingProjection(lendingProjectionOf(home));
    if (kind === 'ready') return {word: 'Ready to lend', kind: 'on'};
    return {word: 'Online', kind: 'off'};
  }
  if (member.online === true) return {word: member.ready === true ? 'Ready to lend' : 'Online', kind: member.ready === true ? 'on' : 'off'};
  const at = value => typeof value === 'number' ? value : Date.parse(value);
  // A computer that joined within the hour and has no presence entry has not lent yet; say so instead of "No recent report".
  const joined = at(member.joinedAt), sinceJoin = (now ?? Date.now()) - joined;
  const justJoined = member.reported === false && Number.isFinite(joined) && sinceJoin >= 0 && sinceJoin < 3600000;
  const activity = (Array.isArray(jobs) ? jobs : []).map(jobActivity);
  const recentJob = activity.filter(event => member.key_id && event?.participants.includes(member.key_id) && event.at <= (now ?? Date.now()))
    .map(event => event.at).sort((a,b) => b-a)[0];
  return {word: recentJob != null ? 'Last job ' + whenLabel(recentJob, now, zone) : justJoined ? 'Joined ' + whenLabel(joined, now ?? Date.now(), zone) + ' · not lending yet' : 'No recent report', kind: null};
}

export function deviceUsage(value) {
  const used = value?.usage, limits = value?.limits ?? {};
  const usage = used ? (value.carried ? 'Earlier day: ' : 'Today: ') + used.jobs + (used.jobs === 1 ? ' job' : ' jobs') + ', ' + Math.ceil(used.milliseconds / 60000) + ' min' : 'Usage unavailable';
  const cap = [limits.dailyJobs != null ? 'Up to ' + limits.dailyJobs + (limits.dailyJobs === 1 ? ' job' : ' jobs') + ' a day' : '', limits.dailyMinutes != null ? 'Up to ' + limits.dailyMinutes + ' min a day' : ''].filter(Boolean).join(' · ');
  return [usage, cap].filter(Boolean).join(' · ');
}

// The presence report can be empty after a restart; signed job traffic is independent evidence.
export function hostContact(hosting, jobs = [], {now = Date.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone} = {}) {
  const at = value => typeof value === 'number' ? value : Date.parse(value);
  const dates = [hosting?.lastReachedAt];
  for (const row of jobs) {
    const job = row.job?.payload ?? row.job ?? {};
    const author = row.historyIdentity?.author ?? job.author;
    if (hosting?.selfKey && author && author !== hosting.selfKey) dates.push(row.waitingTiming?.submittedAt, job.created_at);
    const attempt = row.current_attempt;
    if (hosting?.selfKey && attempt?.holder && attempt.holder !== hosting.selfKey) dates.push(attempt.claimed_at, attempt.execution_started_at, attempt.completed_at);
  }
  const seen = dates.map(at).filter(value => Number.isFinite(value) && value <= now);
  if (!seen.length) return '';
  const last = Math.max(...seen);
  const day = value => formatDate(value, 'dayKey', {zone});
  const clock = formatDate(last, 'clock', {zone});
  const date = day(last) === day(now) ? '' : 'on ' + formatDate(last, 'monthDay', {zone}) + ' ';
  return 'Members reached it ' + date + 'at ' + clock + '.';
}

export function deviceLimitsDraft(draft) {
  if (!draft) return {valid:false, values:null, reason:''};
  const values = {};
  for (const name of ['dailyJobs','dailyMinutes']) {
    const text = String(draft[name] ?? '').trim();
    const value = text === '' ? null : /^\d+$/.test(text) ? Number(text) : NaN;
    if (value !== null && (!Number.isSafeInteger(value) || value > 2147483))
      return {valid:false, values:null, reason:'Use a whole number from 0 to 2147483, or leave empty for no limit.'};
    values[name] = value;
  }
  return {valid:true, values, reason:''};
}

export function circleHostingVM(circle, hosting) {
  if (!circle?.origin) return {canStop:false, text:'This circle is stored on this computer and is not shared through a circle host. Jobs may still send data to AI providers and leave logs.'};
  if (!hosting) return {canStop:false, text:'Loading hosting details…'};
  if (hosting.unreadable || hosting.processState === 'unreadable') return {canStop:false, text:'Couldn’t read hosting status: ' + (hosting.unreadable?.reason ?? hosting.statusError).replace(/[.\s]+$/, '') + '. Faravan changed nothing.'};
  const here = hostedHere(circle, hosting);
  return {canStop:here, text:here ? (hosting.circles?.length>1?'Stopping hosting affects all '+hosting.circles.length+' circles on this computer. ':'')+'Members cannot send or get jobs while hosting is stopped. Stopping hosting does not delete data here. Jobs, code and results are still deleted 30 days after each job ends.' : 'This computer does not report hosting this circle. Open Faravan on the computer that runs it to manage hosting.'};
}

export const hostedHere = (circle, hosting) => hosting?.configured === true
  && (hosting.circle === circle?.id || hosting.circles?.some(c => c.id === circle?.id) === true);

// Confirmation is separate from the saved preference: an enabled switch is not proof the host is awake.
export function keepAwakeVM(value, {now = Date.now(), requestedAt = now} = {}) {
  if (!value?.enabled) return {text:'This computer follows its sleep settings.', retry:false};
  if (value.active) return {text:'On while connected to power', retry:false};
  if (value.reason === 'on_battery') return {text:'Waiting for power', retry:false};
  if (value.reason === 'unsupported') return {text:'Keep-awake is not supported on this computer.', retry:false};
  return now - requestedAt < 10000 ? {text:'Turning on…', retry:false} : {text:"Couldn't confirm", retry:true};
}

// One row per computer, even when it belongs to several circles. Nicknames remain circle-specific.
export function devicesListVM(devices, circles = []) {
  if (!devices) return {state:'loading',rows:[]};
  const selfKey = devices.fingerprint || 'this-computer';
  const computers = new Map([[selfKey,{id:selfKey,self:true,ownerName:devices.ownerName,device_name:devices.name,circles:[]}]]);
  for (const group of devices.circles || []) for (const member of group.members || []) {
    if (!member.key_id) continue;
    const existing = computers.get(member.key_id);
    const row = existing || {...member,id:member.key_id,circles:[],self:false};
    const circle = circles.find(circle => circle.id === group.circle);
    if (circle?.origin) row.circles.push(safeName(circle.name,'Unnamed circle'));
    computers.set(member.key_id,row);
  }
  return {state:'rows',rows:[...computers.values()].map(row => {
    const name=circlePerson({...row,localName:''},{self:row.self,deviceName:devices.name});
    const machine=safeName(row.device_name);
    // Nicknames belong to one circle; the combined list uses the member's shared person name.
    return {id:row.id,name,avatarName:row.self ? safeName(devices.ownerName) : safeName(row.personName),
      meta:[row.self?'Your computer':'',machine&&machine!==name?machine:'',...new Set(row.circles)].filter(Boolean).join(' · '),href:row.self?'#/you/profile':null};
  })};
}

export function hostRestartVM(hosting) {
  if (!hosting?.configured || !hosting.origin) return null;
  if (hosting.reach?.kind!=='lan') return null;
  return {tunnel:'lan',...(hosting.name?{name:hosting.name}:{})};
}
export function hostStartProgress(pending, elapsedSeconds = 0) {
  if (!pending) return '';
  if (elapsedSeconds < 10) return 'Starting the circle…';
  return 'Starting the circle… ' + Math.floor(elapsedSeconds / 60) + ':' + String(elapsedSeconds % 60).padStart(2,'0');
}
