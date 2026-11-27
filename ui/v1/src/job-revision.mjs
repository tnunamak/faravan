// Job pages revalidate when something about their own job changed, not on every app event.
// `all` moves for events that name no job; `jobs[digest]` moves for one job.
export const JOB_REVISIONS = {all: 0, jobs: {}};

export const jobRevisionOf = (state, id) => state.all + (state.jobs[id] ?? 0);

const bump = (state, digest) => ({...state, jobs: {...state.jobs, [digest]: (state.jobs[digest] ?? 0) + 1}});

export function reviseForEvent(state, event) {
  const data = event?.data ?? {};
  if (data.status === 'transcript') return state;
  const digest = data.jobDigest ?? data.job_digest;
  if (typeof digest === 'string' && digest) return bump(state, digest);
  return ['job', 'reset'].includes(event?.type) ? {...state, all: state.all + 1} : state;
}

const rowDigest = row => row?.job_digest ?? row?.jobDigest;
// Observations are evidence for readers, not job transitions (matching jobEventSignature):
// status/projection observation times and poll/heartbeat times of online computers.
// An offline computer's last-seen time is a fact about it and still counts.
const quiet = device => device?.online === true ? {...device, last_poll_at: null, last_heartbeat_at: null} : device;
export function jobRowSignature(row) {
  if (!row?.statusContract && !row?.jobProjection?.times && !Array.isArray(row?.presence?.devices)) return JSON.stringify(row);
  return JSON.stringify({...row,
    ...(row.statusContract ? {statusContract: {...row.statusContract, observedAt: null}} : {}),
    ...(row.jobProjection?.times ? {jobProjection: {...row.jobProjection,
      times: {...row.jobProjection.times, observedAt: null}}} : {}),
    ...(Array.isArray(row.presence?.devices) ? {presence: {...row.presence, devices: row.presence.devices.map(quiet)}} : {})});
}
const bySignature = rows => new Map((Array.isArray(rows) ? rows : []).filter(rowDigest).map(row => [rowDigest(row), jobRowSignature(row)]));

// The Jobs and approvals lists name their rows; only a row that changed revises its job.
export function reviseForShell(state, resource, previous, next) {
  if (!['jobs', 'approvals'].includes(resource) || previous === undefined) return state;
  const before = bySignature(previous), after = bySignature(next);
  let result = state;
  for (const [digest, signature] of after) if (before.get(digest) !== signature) result = bump(result, digest);
  for (const digest of before.keys()) if (!after.has(digest)) result = bump(result, digest);
  return result;
}
