// Pure, versioned display projection for the predicate used by
// app.mjs checkApprovalAcceptance. This never authorizes an acceptance write.
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const optionalCount = value => value === null || count(value);
const unknown = (reasonCode = 'invalid_evidence') => ({schemaVersion:2,kind:'request-admission',admission:'unknown',reasonCode,
  evidence:{jobCap:null,minuteCap:null}});

/**
 * Project the exact admission inputs: usage's rounded display counters, raw
 * accounted milliseconds, the signed wall_seconds, and the configured cap.
 * A missing usage snapshot means the server has no usage predicate to apply;
 * malformed supplied evidence is unknown and must not be treated as allowed.
 */
export function projectRequestAdmission({usage = null, accountedMilliseconds = null, dailyMinutes = null, wallSeconds, now = Date.now()} = {}) {
  if (!Number.isFinite(now) || !count(wallSeconds) ||
      !(usage === null || isRecord(usage) && count(usage.jobs) && optionalCount(usage.jobLimit) &&
        count(usage.minutes) && optionalCount(usage.minuteLimit)) ||
      !(accountedMilliseconds === null || count(accountedMilliseconds)) ||
      !(dailyMinutes === null || Number.isSafeInteger(dailyMinutes) && dailyMinutes >= 0) ||
      usage !== null && usage.minuteLimit !== dailyMinutes) return unknown();

  const job = usage && usage.jobLimit !== null ? {used:usage.jobs,limit:usage.jobLimit} : null;
  const minute = usage && usage.minuteLimit !== null ? {used:usage.minutes,limit:usage.minuteLimit,
    usedMilliseconds:accountedMilliseconds ?? 0,
    limitMilliseconds:dailyMinutes * 60000,
    requestedMilliseconds:wallSeconds * 1000} : null;
  if (minute && (!Number.isSafeInteger(minute.limitMilliseconds) ||
      !Number.isSafeInteger(minute.requestedMilliseconds))) return unknown();

  const jobCap = Boolean(job && job.used >= job.limit);
  const minuteCapReached = Boolean(minute && minute.used >= minute.limit);
  const requestDoesNotFit = Boolean(minute &&
    (accountedMilliseconds ?? 0) + wallSeconds * 1000 > dailyMinutes * 60000);
  const reasonCode = jobCap ? 'job_cap' : minuteCapReached ? 'minute_cap_reached' : requestDoesNotFit ? 'request_does_not_fit' : null;
  return {schemaVersion:2,kind:'request-admission',admission:reasonCode ? 'blocked' : 'allowed',reasonCode,
    evidence:{jobCap:job,minuteCap:minute}};
}

/** Runtime trust boundary for a server supplied request-admission projection. */
export function validateRequestAdmission(input) {
  const reasons = new Set(['job_cap','minute_cap_reached','request_does_not_fit']);
  const unknownReasons = new Set(['invalid_evidence','invalid_projection']);
  if (!isRecord(input) || input.schemaVersion !== 2 || input.kind !== 'request-admission' ||
      !['allowed','blocked','unknown'].includes(input.admission) ||
      !(input.reasonCode === null || typeof input.reasonCode === 'string' &&
        (reasons.has(input.reasonCode) || input.admission === 'unknown' && unknownReasons.has(input.reasonCode))) ||
      !isRecord(input.evidence) ||
      !(input.evidence.jobCap === null || isRecord(input.evidence.jobCap) && count(input.evidence.jobCap.used) && count(input.evidence.jobCap.limit)) ||
      !(input.evidence.minuteCap === null || isRecord(input.evidence.minuteCap) &&
        count(input.evidence.minuteCap.used) && count(input.evidence.minuteCap.limit) &&
        count(input.evidence.minuteCap.usedMilliseconds) &&
        count(input.evidence.minuteCap.limitMilliseconds) &&
        count(input.evidence.minuteCap.requestedMilliseconds)) ||
      input.admission === 'blocked' && !reasons.has(input.reasonCode)) {
    return unknown('invalid_projection');
  }
  if(input.admission==='unknown') {
    if(input.reasonCode===null||input.evidence.jobCap!==null||input.evidence.minuteCap!==null)return unknown('invalid_projection');
    return unknown(input.reasonCode);
  }
  if(input.admission!=='unknown') {
    const jobCap=input.evidence.jobCap && input.evidence.jobCap.used>=input.evidence.jobCap.limit;
    const minuteCap=input.evidence.minuteCap && input.evidence.minuteCap.used>=input.evidence.minuteCap.limit;
    const minute=input.evidence.minuteCap;
    const requestDoesNotFit=Boolean(minute && minute.limitMilliseconds!==null &&
      minute.usedMilliseconds+minute.requestedMilliseconds>minute.limitMilliseconds);
    const expectedReason=jobCap?'job_cap':minuteCap?'minute_cap_reached':requestDoesNotFit?'request_does_not_fit':null;
    if(input.reasonCode!==expectedReason || input.admission!==(expectedReason?'blocked':'allowed')) return unknown('invalid_projection');
  }
  return {schemaVersion:2,kind:'request-admission',admission:input.admission,reasonCode:input.reasonCode,
    evidence:{jobCap:input.evidence.jobCap && {...input.evidence.jobCap},minuteCap:input.evidence.minuteCap && {...input.evidence.minuteCap}}};
}
