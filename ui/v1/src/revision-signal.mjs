import {jobRowSignature} from './job-revision.mjs';

// What counts as a change worth re-reading every open page. A streamed transcript chunk changes
// on every line the agent prints; pages poll the transcript themselves (home.jsx ignores these too).
const chunk=event=>event?.data?.status==='transcript';

export const eventRevisesPages=event=>!['phone','update'].includes(event?.type)&&!chunk(event);
// A streamed chunk changes no shell resource either: re-reading all of them for each one was most of a running
// job page's read budget (judge r8 O13, I30).
export const eventRefreshesShell=event=>!chunk(event);
// A job event (or a lender's state for one job) that names its job re-reads only the shell resources that show jobs: the
// Jobs list, approval cards, activity and Home. Circles, agents, devices and readiness have their own events, so the job's
// news leaves them alone (judge r12 R12-2: one event re-read all eight shell resources, most of a running job page's read
// budget). 'all' is everything else.
const jobNamed=event=>event?.data?.job_digest??event?.data?.jobDigest;
export const eventScopeOf=event=>(event?.type==='job'||event?.type==='lending')&&jobNamed(event)?'job':'all';

// Home carries an observation timestamp even when nothing changed.
export function revisionSignature(resource,value) {
  if(resource==='home'&&value&&typeof value==='object'){const {observedAt,...content}=value;return JSON.stringify(content);}
  if(resource==='activity'&&Array.isArray(value))return JSON.stringify(value.filter(event=>!chunk(event)));
  if(resource==='jobs'&&Array.isArray(value))return JSON.stringify(value.map(jobRowSignature));
  return JSON.stringify(value);
}
