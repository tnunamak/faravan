import * as p from '../protocol/index.mjs';

// A stable cursor for status changes that matter to job pages. Lease renewals and
// progress do not change this view, so watchers wake only for a new job state.
export function jobWatchRevision(view, stopRequest=null) {
  const attempt=view.current_attempt;
  if(typeof view?.job_digest!=='string'||!view.job_digest||typeof view.state!=='string'||!view.state)
    throw new TypeError('A job watch revision requires a job identity and state');
  if(view.attempts_started!==undefined&&(!Number.isSafeInteger(view.attempts_started)||view.attempts_started<0))
    throw new TypeError('A job watch revision requires a valid attempts_started count');
  if(attempt&&(typeof attempt.attempt_id!=='string'||!attempt.attempt_id||
      !Number.isSafeInteger(attempt.generation)||attempt.generation<1))
    throw new TypeError('A job watch revision requires a valid current attempt identity');
  if(attempt?.state!==undefined&&typeof attempt.state!=='string')
    throw new TypeError('A job watch revision requires a valid current attempt state');
  if(attempt?.compute_stopped!==undefined&&typeof attempt.compute_stopped!=='boolean')
    throw new TypeError('A job watch revision requires a valid compute_stopped value');
  return p.digest({job_digest:view.job_digest,state:view.state,attempts_started:view.attempts_started??null,
    result_digest:view.result_digest??null,declined_count:view.declined_count??0,
    attempt:attempt?{attempt_id:attempt.attempt_id,generation:attempt.generation,state:attempt.state??null,
      reason:attempt.reason??null,execution_started_at:attempt.execution_started_at??null,
      execution_observed_at:attempt.execution_observed_at??null,
      compute_stopped:attempt.compute_stopped===true,stopped_at:attempt.stopped_at??null}:null,
    stopRequest:stopRequest??null});
}
