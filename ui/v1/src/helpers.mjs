import {problemView, browserProblemContext, readStateView} from './problem-catalog.mjs';
import {requestContextVM} from './request-context.mjs';
import {formatJobProjection} from './job-projection-view.mjs';
import {lendingProjectionOf, formatLendingProjection} from './lending-projection-view.mjs';
import {LINES, REASON_LINE, calibrationMissingCopy, identityHoldCopy, fundingHoldCopy} from '../../../lib/v1/lending-status-copy.mjs';
import {waitView} from '../../../lib/v1/lending-wait.mjs';
import {safeName} from './safe-name.mjs';
import {formatMembership, membershipProjectionFor} from './membership-projection-view.mjs';
export {safeName};
// Agent preferences are opt-in: this computer's defaults do not constrain a lender.
// A 401 means this page's session ended (expired, revoked, or never opened here), not that anything else failed.
// Sessions survive a restart, so the copy names no cause; an update restart has its own automatic banner.
/** The one name for a requester whose name is unknown; lowercase it inside a sentence with inSentence(). */
export const CIRCLE_MEMBER='A circle member';
export const inSentence=name=>name===CIRCLE_MEMBER?'a circle member':name;
/** A request this computer sent is the person's own job: never a stranger "asking for help". */
export const OWN_REQUEST_TITLE='Your job is ready to run on your computer';
export const isOwnRequest=(card={},self='')=>Boolean(self&&typeof card.requester==='string'&&card.requester===self);
export const requestTitle=(card={},name='',self='')=>isOwnRequest(card,self)?OWN_REQUEST_TITLE:(name||CIRCLE_MEMBER)+' asked for help';
export const isSessionLost=error=>error?.status===401||error?.code==='unauthorized';
// Only a definite answer from the folder check means the folder is missing; a lost session or network failure never does.
export const isTransportFailure=error=>!error?.repoRefusal&&(isSessionLost(error)||!Number.isInteger(error?.status)||error.status>=500||['network','offline'].includes(error?.code));

export function borrowRequestBody(draft, circle, source) {
  const specific = draft.specificAgent === true && Boolean(draft.agent);
  return {
    circle,
    prompt: draft.prompt,
    ...(draft.title.trim() ? {title: draft.title.trim()} : {}),
    ...(specific ? {harness: draft.agent} : {}),
    ...(specific && draft.model && draft.model !== 'any' ? {model: draft.model} : {}),
    egress: JOB_EGRESS,
    ...source,
  };
}
export function validateBorrowDraft(draft, circle, selected) {
  if (!draft.prompt.trim()) return 'Describe what you want the agent to do.';
  if (!circle) return 'Choose a circle before sending.';
  if (!selected?.origin)
    return 'Start a circle on this computer, or join with an invitation.';
  if (draft.kind === 'repository') {
    let url;
    try {
      url = new URL(draft.git);
    } catch {
      return 'Enter a credential-free HTTPS repository URL.';
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
      return 'Enter a credential-free HTTPS repository URL without a query or fragment.';
    if (!/^[0-9a-f]{40}$/i.test(draft.commit))
      return 'Use the full 40-character commit. Branch names cannot be resolved by this app.';
  } else if (!draft.files.length) return 'Choose files before sending.';
  return fileProblem(draft.files);
}
import {sourceFileOmission, sourceOmissionLines} from "../../../lib/v1/secret-files.mjs";
import {formatDate} from './dates.mjs';
// Synchronous click guard, including success before Action has rendered its disabled state.
export function createActionGate() {
  let pending=false,succeeded=false;
  const blocked=(disabled=false,once=false)=>disabled||pending||(once&&succeeded);
  return {
    blocked,
    start(disabled=false,once=false) {
      if(blocked(disabled,once))return false;
      pending=true;return true;
    },
    succeed(){succeeded=true;},
    finish(){pending=false;},
  };
}
// Display freshness only. This does not change lender admission or reserve rules.
export const ALLOWANCE_FRESH_MS = 5 * 60 * 1000;
const timestamp = value => typeof value === 'number' ? value :
  typeof value === 'string' && value.trim() ? Date.parse(value) : NaN;
export function decisionTime(value, {timeZone} = {}) {
  const time = timestamp(value);
  if (!Number.isFinite(time)) return '';
  return formatDate(time, 'decision', timeZone ? {zone: timeZone} : {});
}
function elapsedWords(milliseconds) {
  if (milliseconds < 60000) return 'less than a minute';
  const [unit, divisor] = milliseconds < 3600000 ? ['minute', 60000] :
    milliseconds < 86400000 ? ['hour', 3600000] : ['day', 86400000];
  const amount = Math.floor(milliseconds / divisor);
  return amount + ' ' + unit + (amount === 1 ? '' : 's');
}
export function allowanceLine(allowance, {timeZone, now = Date.now()} = {}) {
  if (allowance?.provider !== 'claude' || !Number.isFinite(allowance.remaining) ||
      allowance.remaining < 0 || allowance.remaining > 100 ||
      !Number.isFinite(allowance.observedAt) || !Number.isFinite(allowance.resetsAt) ||
      !Number.isFinite(now)) return 'Allowance unknown.';
  if (allowance.observedAt > now) return 'Allowance unknown. The reading is dated in the future.';
  const reset = decisionTime(allowance.resetsAt, {timeZone});
  if (!reset || allowance.resetsAt <= allowance.observedAt) return 'Allowance unknown.';
  const age = now - allowance.observedAt;
  const stale = age >= ALLOWANCE_FRESH_MS || allowance.resetsAt <= now;
  const amount = 'Claude weekly allowance: ' + Math.round(allowance.remaining) + '% remaining';
  if (stale) return amount + ' at last read. Last read ' + elapsedWords(age) +
    ' ago; may be out of date. Recorded reset time: ' + reset + '.';
  return amount + '. Read ' + elapsedWords(age) + ' ago. Resets at ' + reset + '.';
}
export function waitingJobLine(job = {}, {timeZone, now = Date.now()} = {}) {
  const submitted = timestamp(job.waitingTiming?.submittedAt ?? job.created_at ?? job.local?.submittedAt);
  const expires = timestamp(job.waitingTiming?.expiresAt ?? job.expires_at ?? job.job?.payload?.expires_at);
  const expiry = decisionTime(expires, {timeZone});
  const expired = formatJobProjection(job).projection.phase === 'expired';
  const until = expired && Number.isFinite(expires) ? Math.min(now, expires) : now;
  const age = Number.isFinite(submitted) && Number.isFinite(until) && submitted <= until ?
    elapsedWords(until - submitted) : null;
  if (expired) return (expiry ? 'Expired at ' + expiry + '.' : 'Job expired. Expiry time unknown.') +
    (age ? ' Waited ' + age + '.' : ' Waiting time unknown.');
  return 'Waiting for a lender. ' + (expiry ? 'Expires at ' + expiry + '.' : 'Expiry time unknown.') +
    (age ? ' Waiting for ' + age + '.' : ' Waiting time unknown.');
}
// Stringified into the inline bootstrap, so it must stay self-contained.
// Strips a stale ?token= or #token= from the address bar and nothing more. It never returns or stores the value,
// so an old link cannot sign a tab in. Sign-in is the HttpOnly cookie from /auth/handoff.
export function takeSession(location, history) {
  const url = new URL(location.href);
  const hashToken = /^#token=/.test(url.hash);
  if (!url.searchParams.has('token') && !hashToken) return;
  url.searchParams.delete('token');
  if (hashToken) url.hash = '';
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
}
const rows = {
  checking:['Checking status','Checking this computer…','Try again'],
  not_joined:['Not connected','Connect a computer to run your first job.','Connect a computer'],
  pending_approval:['Waiting for approval','This computer is waiting for approval.','Check again'],
  approval_revoked:['Access removed','Ask the owner for a new invitation.','Join another circle'],
  idle:['Lending on','Waiting for a job','Pause lending'],
  off:['Lending off','No jobs will start','Turn lending on'],
  contributing:['Running a job','A job is running on this computer.','View job'],
  pausing:['Pausing after this job','No new jobs will start','View job'],
  paused:['Paused','Lending is paused. No new jobs will start.','Resume lending'],
  user_active:["Waiting until you're away",'Automatic lending is waiting for this computer to be idle.','Edit limits'],
  daily_limit:['Daily limit reached',"Today's lending limit is reached.",'Edit limits'],
  no_spare:['Keeping allowance for you','Your remaining allowance is being kept for you.','View allowance'],
  model_not_lendable:['No lender can take this model now','The lenders here cannot take this model right now. Try another model, or try again later.','Choose another model'],
  quota_unknown:["Can't read your allowance",'Automatic jobs start once Faravan can read your remaining allowance.','Use ask-each-time'],
  action_needed:['Sign-in needed','New jobs using this account are paused.','Choose another agent'],
  awaiting_browser:['Sign-in needed','Finish signing in, then return here.','Check sign-in'],
  manual_auth:['Sign-in needed','Sign in to this agent outside the app, then check again.','Check again'],
  setup_required:['Setup needed','Finish setting up the protected workspace to run jobs here.','Open setup'],
  sandbox_not_ready:['Setup needed','Finish setting up the protected workspace to run jobs here.','Open setup'],
  waiting_for_sandbox:['Waiting for setup',"Lending is on, but this computer can't run jobs right now. Check protected workspace setup.",'Open setup'],
  required_update:['Update needed','Update Faravan to continue lending.','Open setup'],
  circle_unavailable:['Circle unavailable','Your other circles and devices are still available.','Switch circle'],
  local_unavailable:["Can't connect to this computer","We can't connect to Faravan on this computer.",'Reconnect'],
  session_expired:['Reconnect to Faravan','Your local session expired','Reconnect'],
  invalid_invite:["Invitation can't be used",'Ask for a new invitation.','Paste another invitation'],
  sending:['Sending job','Checking delivery','Check submission'],
  queued:['Waiting','Waiting for a lender.','View devices'],
  waiting:['Waiting','Waiting for a lender.','View devices'],
  offer:['Offers to review','Available jobs hold nothing until you run one.','Review job'],
  preparing:['Preparing','Preparing the accepted job on this computer.','Open job'],
  'awaiting-approval':['Waiting for you','A job is waiting for your review.','Review job'],
  claimed:['Starting','A computer is getting ready to run it.','Refresh status'],
  submitted:['Starting','A computer is getting ready to run it.','Refresh status'],
  evaluating:['Starting','A computer is getting ready to run it.','Refresh status'],
  starting:['Starting','A computer is getting ready to run it.','Refresh status'],
  running:['Running','A computer is running this job.','View transcript'],
  stop_requested:['Stop requested','Waiting for confirmation','Check status'],
  connection_lost:['Connection lost','It may still be running','Check status'],
  stopping:['Stopping','Waiting for sandbox removal. Lending remains paused.','Check status'],
  stopped_by_lender:['Stopped','The job was stopped on this computer. Lending remains paused.','Open the job'],
  cleanup_pending:['Finishing cleanup','This computer is finishing sandbox cleanup.','Wait for cleanup'],
  cessation_unverified:['Stop requested','Waiting for confirmation','Check status'],
  expired:['Expired','This job has expired. Review its history before submitting again.','Submit again'],
  agent_not_chosen:['Choose an agent to lend','A ready agent is available. Choose which one may help.','Choose an agent'],
  no_ready_agent:['Get an agent ready','Install or sign in to an agent. Then check it again.','Set up an agent'],
  agent_signed_out:['Sign-in needed',"This agent isn't signed in inside Faravan's sandbox anymore. Sign in again on the Lend page, then lending resumes.",'Sign in'],
  failed:['Failed',"This job couldn't finish.",'View transcript'],
  error:['Failed',"This job couldn't finish.",'View transcript'],
  returned:['Run stopped','Review the partial output before retrying.','Review partial output'],
  cancelled:['Cancelled','No more work will run for this job.','Open the job'],
  settled:['Finished','The job finished. Open Changes to review the result.','View job details'],
  finished:['Finished','The job finished. Open Changes to review the result.','View job details'],
  'result-accepted':['Finished','The job finished. Open Changes to review the result.','View job details'],
  result_pending:['Result not ready','The result arrives when the job finishes.','View transcript'],
  result_checking:['Checking result',"We're checking that the result arrived.",'Check again'],
  result_ready:['Result ready','Changes are ready to review.','Download patch'],
  result_unavailable:['Result unavailable',"The work finished, but we couldn't verify its result.",'Retry download'],
  review_ready:['Ready to review','Review and test these changes before using them.','Review changes'],
  applied:['Changes applied','Run your tests before committing.','View changed files'],
  conflict:['Changes need review','Your files changed while this job ran.','Download patch'],
  pr_pending:['Checking pull request','Checking whether the pull request was created.','Check again'],
  pr_created:['Pull request opened','Your pull request is available.','Open pull request'],
  optional_update:['Update available','An update is available.','Later'],
  // Named evidence holds: each shows the reviewed status line for its reason (lib/v1/lending-status-copy.mjs), with its remedy.
  account_busy:[LINES[REASON_LINE.account_busy],LINES[REASON_LINE.account_busy],'View allowance'],
  probe_deferred:[LINES[REASON_LINE.probe_deferred],LINES[REASON_LINE.probe_deferred],'View allowance'],
  refresh_failed:[LINES[REASON_LINE.refresh_failed],LINES[REASON_LINE.refresh_failed],'View allowance'],
  identity_unknown:[LINES[REASON_LINE.identity_unknown],LINES[REASON_LINE.identity_unknown],'View allowance'],
  identity_mismatch:[LINES[REASON_LINE.identity_mismatch],LINES[REASON_LINE.identity_mismatch],'Check agent sign-in'],
  account_week_mapping_unknown:[LINES[REASON_LINE.account_week_mapping_unknown],LINES[REASON_LINE.account_week_mapping_unknown],'View allowance'],
  epoch_unknown:[LINES[REASON_LINE.epoch_unknown],LINES[REASON_LINE.epoch_unknown],'View allowance'],
  resources_incomplete:[LINES[REASON_LINE.resources_incomplete],LINES[REASON_LINE.resources_incomplete],'View allowance'],
  funding_unknown:[LINES[REASON_LINE.funding_unknown],LINES[REASON_LINE.funding_unknown],'Check agent sign-in'],
  executor_unknown:[LINES[REASON_LINE.executor_unknown],LINES[REASON_LINE.executor_unknown],'Open setup'],
  stop_bound_unknown:[LINES[REASON_LINE.stop_bound_unknown],LINES[REASON_LINE.stop_bound_unknown],'Open setup'],
  conversion_unknown:[LINES[REASON_LINE.conversion_unknown],LINES[REASON_LINE.conversion_unknown],'Check for updates'],
  history_unknown:[LINES[REASON_LINE.history_unknown],LINES[REASON_LINE.history_unknown],'View allowance'],
  queue_unknown:[LINES[REASON_LINE.queue_unknown],LINES[REASON_LINE.queue_unknown],'Refresh status'],
  owner_scenarios_unknown:[LINES[REASON_LINE.owner_scenarios_unknown],LINES[REASON_LINE.owner_scenarios_unknown],'View allowance'],
  friend_value_unknown:[LINES[REASON_LINE.friend_value_unknown],LINES[REASON_LINE.friend_value_unknown],'Refresh status'],
  objective_evidence_unknown:[LINES[REASON_LINE.objective_evidence_unknown],LINES[REASON_LINE.objective_evidence_unknown],'View allowance'],
};
export const STATUS_KEYS = Object.freeze(Object.keys(rows));
export function statusView(value, facts = {}) {
  let key = String(value || 'checking').toLowerCase().replaceAll(' ', '_');
  if (key === 'running' && facts.executionProof === false) key = 'starting';
  if (key === 'cancelled' && facts.computeStopped !== true && facts.neverStarted !== true) key = 'stop_requested';
  if (key === 'idle' && facts.enabled === false) key = 'off';
  const funding = fundingHoldCopy(key, facts.detail);
  if (funding) return {label:funding.line, message:funding.line, remedy:funding.action};
  const identity = identityHoldCopy(key, facts.detail);
  if (identity) return {label:identity.line, message:identity.line, remedy:identity.action};
  const missing = key === 'conversion_unknown' ? calibrationMissingCopy(facts.detail) : null;
  if (missing) return {label:missing.line, message:missing.line, remedy:missing.action};
  // A lending wait follows its reason: a signed-out or unchosen agent is not a protected workspace problem.
  if (key === 'waiting_for_sandbox' && facts.reason) {
    const wait = waitView(facts.reason, {until:facts.until,nextAction:facts.nextAction,detail:facts.detail});
    return {label:wait.headline, message:wait.message, remedy:wait.remedy};
  }
  const [label, message, remedy] = rows[key] || ['Status unavailable','We could not recognize this status.','Refresh status'];
  return {label,message:key==='agent_signed_out'&&facts.agentName?agentSignedOutMessage(facts.agentName):message,remedy};
}
// The agent's product name comes from the app; the sentence stays fixed.
export const agentSignedOutHeadline = (name) => safeName(name,'This agent')+" isn't signed in inside Faravan's sandbox anymore.";
export const agentSignedOutMessage = (name) => agentSignedOutHeadline(name)+' Sign in again on the Lend page, then lending resumes.';
export function iconState(lending = {}, attention = []) {
  const projection=lendingProjectionOf(lending&&typeof lending==='object'&&Object.hasOwn(lending,'lendingProjection') ? lending : {lending});
  return formatLendingProjection(projection).iconState;
}
// Compatibility facade: all ordinary failure text is owned by the catalog.
export function errorMessage(error, context = browserProblemContext()) {
  return problemView(error?.problem ?? error, context).detail;
}
export function formatBytes(n) { return Number.isFinite(n) ? n < 1024 ? n+' bytes' : n < 1048576 ? (n/1024).toFixed(1)+' KB' : (n/1048576).toFixed(1)+' MB' : ''; }
export function formatTime(value) { return formatDate(value, 'exact'); }
const limitNames={cpu:'CPU',memory_bytes:'memory',wall_seconds:'running time',disk_bytes:'host storage',output_bytes:'output size'};
const limitList=value=>Array.isArray(value)?value.map(key=>limitNames[key]||safeName(key)).filter(Boolean).join(', '):'';
// One summary line for the review card; the per-check rows go in a details disclosure.
export function protectionView(protection={}) {
  const p=protection&&typeof protection==='object'?protection:{};
  const network=p.egress?.requested==='provider-only'?'AI provider only':p.egress?.requested==='internet'?'General internet':'';
  const satisfied=p.satisfied===true,enforced=limitList(p.limits?.enforced),unenforced=limitList(p.limits?.unenforced);
  const rows=[
    ['Sandbox',p.sandbox_ready===true?'Ready':'Not ready'],
    ['Version',p.version_gate?.ok===true?'Supported':'Update needed'],
    ['Internet',network&&network+(p.egress?.enforceable===true?' · enforced':' · not enforced')],
    ['Source-network rules',p.egress?.source_enforceable===true?'Reported enforceable':'Not confirmed'],
    ['Enforced limits',enforced],
    ['Not enforced',unenforced],
  ].filter(([,value])=>value);
  return {satisfied,rows,enforced,unenforced,
    sourceNetworkNote:'This is not a check that source is hidden from the lender or model provider.',
    summary:satisfied?'Required readiness checks passed'+(enforced?'; '+enforced+' limits reported enforced.':'.'):'Required checks for this job have not passed.'};
}
export function shortFingerprint(keyId) {
  const hex=typeof keyId==='string'?keyId.replace(/^sha256:/,''):'';
  return /^[0-9a-f]{16,}$/.test(hex)?hex.slice(0,16).replace(/(.{4})(?=.)/g,'$1 '):'';
}
export function sourceSummary(source = {}) {
  if(source.kind==='none') return 'No project · prompt only';
  if(source.kind==='git') return [safeName(source.url,'Repository'),typeof source.commit==='string'&&/^[0-9a-f]{40}$/i.test(source.commit)?'commit '+source.commit.slice(0,12):''].filter(Boolean).join(' · ');
  const bytes=source.artifact?.bytes ?? source.size_bytes ?? source.size;
  const files=Number.isSafeInteger(source.file_count) ? source.file_count+(source.file_count===1?' file':' files')+' · ' : '';
  return (source.kind==='archive'?'Uploaded files · ':'')+files+formatBytes(bytes);
}
// A viewer-local petname is shown only when the app sent one for this exact key; never a remote string.
export function localNameOf(value) {
  return typeof value==='string'&&value.trim()&&[...value].length<=64&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)?value:'';
}
// Headline and separate facts for one member. The local name and the remote device name never share a field.
export function memberIdentity(member = {}, {self = false} = {}) {
  const key = typeof member.key_id === 'string' ? member.key_id : '';
  const localName = localNameOf(member.localName), remoteName = safeName(member.device_name);
  return {key, localName, remoteName, fingerprint: shortFingerprint(key), self,
    headline: localName || safeName(member.personName) || safeName(member.ownerName) || remoteName || 'Unnamed computer',
    saveLabel: localName ? 'Change local name' : 'Save a local name'};
}
// Roster members of one circle only, so the same key in another circle never supplies a name.
export function circleMembers(devices, circleId) {
  const group = (devices?.circles || []).find(c => c.circle === circleId);
  return group ? group.members || [] : null;
}
export function reviewCard(card = {}, agents = [], members = [], self = '') {
  const agent = agents.find(a => a.id === card.harness);
  const member = members.find(m => (m.key_id || m.keyId) === card.requester);
  const source = card.source || {};
  const personName = safeName(Object.hasOwn(card,'identity') ? card.identity?.personName : card.personName || member?.personName || member?.ownerName);
  const context = requestContextVM(typeof card.prompt === 'string' ? card.prompt : '');
  const remoteName = safeName(Object.hasOwn(card,'identity')?card.requesterName:member?.device_name || member?.name || member?.display_name,CIRCLE_MEMBER), localName = localNameOf(card.localName);
  return {
    requesterName:remoteName,
    personName, context,
    localName,
    requesterKey:typeof card.requester==='string'?card.requester:'',
    requesterFingerprint:shortFingerprint(card.requester),
    requester:localName || personName || remoteName,
    own:isOwnRequest(card,self),
    title:requestTitle(card,localName || personName || remoteName,self),
    agent:agentProduct(card.harness).name,
    account:safeName(agent?.account),
    model:Array.isArray(card.model)&&card.model.length?card.model.map(x=>safeName(x)).filter(Boolean).join(', '):'Any model',
    source:sourceSummary(card.sourceFiles===undefined||card.sourceFiles===null?source:{...source,file_count:card.sourceFiles}),
    minutes:Number.isFinite(card.runtimeSeconds)?Math.ceil(card.runtimeSeconds/60)+' minutes':'',
    prompt:typeof card.prompt==='string'?card.prompt:'',
    complete:Boolean((!card.identity || (card.identity.memberPresent && card.identity.rosterFresh && card.identity.rootMatches && card.identity.circleMatches)) && card.prompt && card.requester && card.source && card.harness && ['provider-only','internet'].includes(card.network) && Number.isFinite(card.runtimeSeconds)),
    protectionVerified:card.protection?.satisfied===true,
    protection:protectionView(card.protection),
    credentialInGuest:card.credentialInGuest===true,
  };
}
export function fileProblem(files) {
  const paths=new Set();
  for(const file of files) {
    const path=file.webkitRelativePath || file.path || file.name;
    if(!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p=>!p||p==='.'||p==='..')) return 'Choose files with safe relative paths.';
    if(paths.has(path)) return 'Two files use ‘'+path+'’. Remove or rename a file.';
    paths.add(path);
  }
  return '';
}
export const excludedFile=path=>Boolean(sourceFileOmission(path));
// The web form sends the same network setting as the CLI and MCP tools.
// Lenders see it on their approval card before accepting.
export const JOB_EGRESS='internet';
export const EGRESS_NOTICE='Jobs can reach the general internet, so don\u2019t send anything you wouldn\u2019t want shared.';
// Files the service left out of an upload (server-side secret rules), for display after submit.
export function excludedNotice(excluded) {
  const paths=Array.isArray(excluded)?excluded.filter(x=>typeof x==='string'):[];
  if(!paths.length) return null;
  return {title:paths.length+(paths.length===1?' file was':' files were')+' not sent',paths,
    message:sourceOmissionLines(paths.map(path=>sourceFileOmission(path)??{path,reason:'not_source'})).join(' · ')+'. Other files may still contain secrets.'};
}
// Canonical screen routes are shared by navigation and hash resolution.
export const ROUTES=Object.freeze({
  home:'Home',jobs:'Jobs',devices:'Devices',circles:'Circles',
  settings:'You',lend:'Lending',limits:'What you lend',setup:'Set up lending',
  signin:'Sign in',borrow:'New job',job:'Job details',circle:'Circle',person:'Circle member',request:'Request',host:'Host a circle',
  telemetry:'What we send',
});
// The destinations of the app shell, in order: Home, Jobs, Lending, Circles (EXPERIENCE), then Setup, so the checklist
// can be found again after the first run (a tester could not find it).
export const NAV_ITEMS=Object.freeze([
  {page:'home',label:'Home',icon:'home'},{page:'jobs',label:'Jobs',icon:'jobs'},
  {page:'lend',label:'Lending',icon:'lend'},{page:'circles',label:'Circles',icon:'circles'},{page:'setup',label:'Setup',icon:'check-circle'},
].map(Object.freeze));
// A detail page highlights the destination it belongs to; Settings and the rest highlight none.
const NAV_PARENT=Object.freeze({job:'jobs',circle:'circles',person:'circles',host:'circles',borrow:'jobs',limits:'lend',request:'home'});
export const navCurrent=(page)=>NAV_ITEMS.some(item=>item.page===page)?page:NAV_PARENT[page]||null;
export function routeFromHash(hash='') {
  try {
    const parts=hash.replace(/^#\/?/,'').split('/').filter(Boolean).map(decodeURIComponent);
    let page=parts[0]||'home';
    if (page === 'trust' && parts.length === 1) return {page:'setup',id:'details'};
    if (page === 'activity' && parts.length === 1) return {page:'jobs',id:null};
    if (page === 'review') page = parts[1] ? 'request' : 'home';
    if (page === 'watch') page = parts[1] ? 'job' : 'jobs';
    page=({new:'borrow',lending:'lend',you:'settings'})[page]||page;
    if(page==='settings'&&parts.length===3&&parts[1]==='data'&&parts[2]==='telemetry')return {page:'telemetry',id:null};
    if(page==='settings'&&parts.length===2&&['all','profile','appearance','notifications','updates','phone','data','account'].includes(parts[1]))return {page,id:parts[1]};
    if(page==='setup'&&parts.length===2&&parts[1]==='details')return {page,id:'details'};
    if((page==='jobs'&&parts[1]==='new'&&parts.length===2)||(page==='new-job'&&parts.length===1))return {page:'borrow',id:null};
    if(page==='lend'&&parts[1]==='limits'&&parts.length===2)return {page:'limits',id:null};
    if(page==='circles'&&parts[1]==='host'&&parts.length===2)return {page:'host',id:null};
    if(page==='circles'&&parts[1]==='new'&&parts.length===2)return {page:'host',id:'new'};
    if(page==='person')return parts.length===3?{page,id:parts[1],circle:parts[2]}:{page:'not-found',id:null};
    if(page==='limits'||!Object.hasOwn(ROUTES,page))return {page:'not-found',id:null};
    const detail=page==='job'||page==='circle'||page==='request'||page==='signin';
    if((detail&&!parts[1])||parts.length>(page==='job'?3:detail?2:1))return {page:'not-found',id:null};
    return {page,id:parts[1]||null,...(parts[2]?{circle:parts[2]}:{})};
  }catch{return {page:'not-found',id:null};}
}
// A saved lending circle is evidence that lending was previously enabled.
// The service also reports paused on a never-enabled device; do not present it as a user pause.
export function lendingView(lending={}) {
  const projection=lendingProjectionOf(lending&&typeof lending==='object'&&Object.hasOwn(lending,'lendingProjection') ? lending : {lending});
  const view=formatLendingProjection(projection,{agentName:projection.admissionReason==='account_signed_out'?agentLabel(lending.agent):'',until:lending.until??lending.lending?.until,nextAction:lending.nextAction??lending.lending?.nextAction,detail:lending.detail??lending.lending?.detail});
  return {label:view.label,message:view.reason,remedy:view.remedy};
}
export function lendingBadge(lending={},attention=[]) {
  return iconState(lending,attention);
}
// Heading badge text; the prefix gives the link a self-explanatory accessible name.
export const lendingBadgeText=(label)=>/^lending/i.test(label)?label:'Lending: '+label;
// Your jobs across every circle (GET /api/jobs without ?circle, S4.2). The one place that knows
// the list is not per circle; each job carries circle:{id,name}.
export function jobsListPath(circles=[]) {
  return circles.some(circle=>circle?.origin)?'jobs':null;
}
export function jobsEmptyState(selected,error) {
  if(error&&error.code!=='origin_required')return null;
  if((selected&&selected.origin===null)||error?.code==='origin_required'){
    const view=readStateView({kind:'no-membership'});
    return {message:view.text,action:view.action,page:'circles'};
  }
  return null;
}

export const LAN_WARNING='This circle uses your local network without encryption; people on the same network could read code sent for jobs.';
export function joinPreviewView(preview={}) {
  return {name:safeName(preview.name,'Unnamed circle'),
    warning:preview.lanMode===true||preview.warning===LAN_WARNING?LAN_WARNING:null,
    origin:safeName(preview.origin),ownerName:safeName(preview.ownerName),expiresAt:preview.expiresAt,
    uses:Number.isSafeInteger(preview.maxUses)&&preview.maxUses>0 ? preview.maxUses===1?'For one person.':'For up to '+preview.maxUses+' people.' : ''};
}
// Keep the invitation and review in memory only. Editing or leaving invalidates
// any in-flight preview so a late reply cannot enable enrollment for an older link.
export function createJoinReview(previewRequest,joinRequest) {
  let generation=0,current=null,pending=false;
  return {
    invalidate(){generation++;current=null;},
    async inspect(link) {
      const ticket=++generation;current=null;
      const preview=await previewRequest(link);
      if(ticket!==generation)return null;
      if(typeof preview?.lanMode!=='boolean'||typeof preview?.name!=='string'||typeof preview?.origin!=='string')throw {code:'invalid_invite'};
      current={link,preview};return current;
    },
    async confirm(review) {
      if(pending||!review||review!==current)throw {code:'invite_preview_required'};
      pending=true;current=null;generation++;
      try{return await joinRequest({link:review.link,...(review.preview.lanMode?{acknowledgedWarning:true}:{})});}
      finally{pending=false;}
    },
  };
}

export const DIFF_LINE_LIMIT=2000;
// Syntax-neutral: colour only by the first character, and bound what is rendered.
export function diffLines(text='',limit=DIFF_LINE_LIMIT) {
  const all=String(text).split('\n');
  if(all.at(-1)==='')all.pop();
  const kind=line=>/^(diff |index |--- |\+\+\+ |@@|new file|deleted file|old mode|new mode|similarity|rename |Binary files|GIT binary patch)/.test(line)?'meta':
    line.startsWith('+')?'add':line.startsWith('-')?'del':'ctx';
  return {lines:all.slice(0,limit).map(line=>({kind:kind(line),text:line})),omitted:Math.max(0,all.length-limit)};
}
export function changeSummary(stat={}) {
  const files=stat.files??0;
  return files+(files===1?' file':' files')+' changed, +'+(stat.insertions??0)+' −'+(stat.deletions??0);
}
// A job this device submitted: the app stores prompt, title, source, agent and model locally,
// so none of these may read "Not reported". Jobs from other members have no local facts.
// Current roster names never stand in for historical signed assertions.
export function jobIdentityHistory(job={}) {
  const history=job.historyIdentity??{},signed=job.job?.payload??{};
  const author=history.author??signed.author;
  return [
    ['Your local name',localNameOf(history.localName)||'Not set'],
    ['Signed author key',typeof author==='string'&&/^sha256:[0-9a-f]{64}$/.test(author)?author:'Not available'],
    ['Device name in the signed job',safeName(history.deviceName??signed.device_name,'Not recorded')],
  ];
}
export function jobFacts(job={}) {
  const local=job.local&&typeof job.local==='object'?job.local:null;
  const model=local?.model;
  return {
    own:Boolean(local),
    title:local?safeName(local.title,'Your job'):'A member’s job',
    prompt:typeof local?.prompt==='string'?local.prompt:null,
    source:local&&typeof local.source==='string'&&local.source?local.source:null,
    agent:local?(local.agent?agentLabel(local.agent):'Any agent'):null,
    model:local?(model?safeName(model):'Any available model'):null,
    submitted:local?.submittedAt?formatTime(local.submittedAt):null,
  };
}
const AGENT_NAMES={codex:'Codex',claude:'Claude Code','claude-code':'Claude Code','claude-code-subscription':'Claude Code','claude-code-api-key':'Claude Code (API key)'};
export const agentLabel=id=>AGENT_NAMES[id]||safeName(id,'Agent');
// Only recent activity is known (the service keeps no presence list), so say exactly that.
// Compact expiry in the viewer's time zone, including the calendar day.
export function waitingTime(value, {timeZone, now = Date.now()} = {}) {
  const time = timestamp(value);
  if (!Number.isFinite(time) || !Number.isFinite(now)) return '';
  try {
    const zone = timeZone ? {zone: timeZone} : {};
    const day = value => formatDate(value, 'dayKey', zone);
    const clock = formatDate(time, 'clock24', zone);
    if (!clock) return '';
    const label = day(time) === day(now) ? 'today' :
      formatDate(time, new Date(time).getFullYear() !== new Date(now).getFullYear() ? 'weekdayDateYear' : 'weekdayDate', zone);
    return label + ' ' + clock;
  } catch { return ''; }
}
const waitingExpiry = job => job.waitingTiming?.expiresAt ?? job.expires_at ?? job.job?.payload?.expires_at;
function validPresence(presence) {
  return presence?.basis === 'recent-activity' && Number.isSafeInteger(presence.online) &&
    Number.isSafeInteger(presence.total) && presence.total > 0 &&
    presence.online >= 0 && presence.online <= presence.total;
}
export function waitingPresenceLine(job = {}, presence, options = {}) {
  const now = options.now ?? Date.now(), expires = timestamp(waitingExpiry(job));
  if (!validPresence(presence) || formatJobProjection(job).projection.phase === 'expired') return waitingJobLine(job, {...options, now});
  const expiry = waitingTime(expires, {...options, now});
  const line = presence.online === 0 ?
    'No one in ' + safeName(options.circleName, 'this circle') + ' has been active recently' :
    waitingLine(presence);
  return line + (expiry ? ' · expires ' + expiry : ' · expiry time unknown');
}
export function waitingLine(presence) {
  const known=Number.isSafeInteger(presence?.online)&&Number.isSafeInteger(presence?.total)&&presence.total>0&&presence.online>0;
  return known?'Waiting for a lender · '+presence.online+' of '+presence.total+(presence.total===1?' member':' members')+' active recently':'Waiting for a lender';
}
// Owner side: one pending request. The name is signed into the proof; the code matches the joining computer.
export function enrollmentView(item={}) {
  const verified=item.proof_valid===true;
  return {id:item.enrollment_id,
    name:verified?safeName(item.device_name,'Unnamed computer'):'Unverified request',
    code:typeof item.device_code==='string'&&/^[0-9A-F]{6}$/.test(item.device_code)?item.device_code:null,
    verified,requested:formatTime(item.created_at)};
}
// Joining-side compatibility facade; phase and membership copy come from the shared projection.
export function joinStatusView(circle={}) {
  return formatMembership(circle, {surface:'join-status'});
}

// Lenders pick agents by the product they know; the adapter ID stays in the details.
// Backend-agnostic: plans, API keys and self-hosted models are all first-class.
const BUILT_IN='comes with Docker Sandboxes. Update Docker Sandboxes, then choose Check again.';
const AGENT_PRODUCTS={
  'claude-code':{name:'Claude Code',via:'Claude Code with the lender’s available account',install:BUILT_IN},
  'claude-code-subscription':{name:'Claude Code',via:'Claude Code with your Claude plan',install:BUILT_IN},
  'claude-code-api-key':{name:'Claude Code',via:'Claude Code with an Anthropic API key',install:BUILT_IN,
    connect:'Add your key to Docker Sandboxes with sbx secret set -g anthropic, then choose Check again.'},
  codex:{name:'Codex',via:'Codex with your ChatGPT plan',install:BUILT_IN},
  gemini:{name:'Gemini (API key)',via:'Gemini CLI with a Google API key',install:BUILT_IN,
    connect:'Add your key to Docker Sandboxes with sbx secret set -g google, then choose Check again.'},
  opencode:{name:'OpenCode',via:'OpenCode with your API key or self-hosted model'},
  'gh-cli':{name:'GitHub CLI',via:'GitHub CLI with your GitHub sign-in'},
};
export function agentProduct(id) {
  if(typeof id==='string'&&id.endsWith('-lending'))id=id.slice(0,-8);
  const known=AGENT_PRODUCTS[id],name=known?.name||safeName(id,'Agent');
  return {id:typeof id==='string'?id:'',name,via:known?.via||'',
    install:known?.install?name+' '+known.install:'Set up '+name+' on this computer, then choose Check again.',
    connect:known?.connect||'Sign in to '+name+' outside the app, then choose Check again.'};
}
// Three groups, each with one next step: Ready → lend, Needs sign-in → sign in, Not installed → install.
export function agentGroups(agents=[]) {
  const groups={ready:[],signin:[],install:[]};
  for(const a of Array.isArray(agents)?agents:[]) {
    const row={...a,product:agentProduct(a.id)};
    if(a.installed===false)groups.install.push(row);
    else if(a.signedIn===true)groups.ready.push(row);
    else groups.signin.push({...row,unchecked:a.signedIn!==false});
  }
  return groups;
}
// Today's lending use against the daily limits, from the service's counters.
// Counters from an earlier day count as zero (the day is in the lender's chosen time zone).
// Counters from an earlier day count as zero (the day is in the lender's chosen time zone).
export function todayCounts(lending={},now=new Date()) {
  const limits=lending.limits||{};
  if(!Number.isSafeInteger(limits.dailyJobs)||!Number.isSafeInteger(limits.dailyMinutes))return null;
  // This is lending-limit math, not display: the saved zone defines the counter's real reset day.
  const today=formatDate(now,'dayKey',limits.timeZone?{zone:limits.timeZone}:{});
  const counters=lending.counters?.day===today?lending.counters:{};
  return {jobs:Number.isSafeInteger(counters.jobs)?counters.jobs:0,max:limits.dailyJobs,
    minutes:Number.isFinite(counters.milliseconds)?Math.ceil(counters.milliseconds/60000):0,maxMinutes:limits.dailyMinutes};
}
export function todayUse(lending={},now=new Date()) {
  const use=todayCounts(lending,now);
  if(!use)return '';
  return 'Today: '+use.jobs+' of '+use.max+(use.max===1?' job':' jobs')+' · '+use.minutes+' of '+use.maxMinutes+' minutes';
}
// Home answers "what do I do now?" with one primary action.
// Roles come from facts: owning a connected circle or sending jobs makes a borrower;
// joining someone else's circle, choosing an agent or having turned lending on makes a lender.
export function homePlan({circles=[],lending={},lendingProjection=null,attention=[],agents=[],jobs=[],signInNeeded=false}={}) {
  const projection=lendingProjection ? lendingProjectionOf({lendingProjection}) : lendingProjectionOf({lending});
  const connected=circles.filter(c=>c?.origin);
  const own=jobs.filter(job=>job?.local&&typeof job.local==='object')
    .sort((a,b)=>String(b.local.submittedAt||'').localeCompare(String(a.local.submittedAt||'')));
  const lender=Boolean(['on','paused'].includes(projection.intent)||lending.circle||connected.some(c=>!c.owned)||agents.some(a=>a.useForLending));
  const borrower=connected.some(c=>c.owned)||own.length>0;
  const fresh=!lender&&!borrower;
  const primary=attention.length?'attention':fresh?'invite':lender&&signInNeeded?'signin':borrower?'run':'lending';
  return {fresh,lender,borrower,primary,latest:own[0]||null};
}

// Pure projections; the app owns the lifetime of seen IDs and notification permission.
export function approvalTitle(count=0) {
  return Number.isSafeInteger(count)&&count>0?'('+count+') Review job · Faravan':'Faravan';
}
export function newApprovalIds(cards=[],seenIds=[]) {
  const seen=new Set(seenIds),fresh=[];
  for(const card of cards) {
    if(typeof card?.id!=='string'||!card.id||seen.has(card.id))continue;
    seen.add(card.id);fresh.push(card.id);
  }
  return fresh;
}
// System notifications can appear on a lock screen or a shared screen, so they
// never carry the borrower's task text; the task is shown only inside the app.
export function approvalNotificationBody() {
  return 'A job is waiting for your review.';
}
export function approvalNotificationTitle(card={},self='') {
  return isOwnRequest(card,self)?OWN_REQUEST_TITLE:(localNameOf(card.localName)||safeName(card.identity?.personName)||safeName(card.personName)||safeName(card.requesterName,CIRCLE_MEMBER))+' asked for your help';
}

// A review's deadline comes from the app's approval timer, never from a render-relative duration.
export const APPROVAL_EXPIRED = problemView({code:'approval_expired'}).detail;
export function approvalDeadline(card={},now=Date.now()) {
  const expiresAt=typeof card.expiresAt==='number'?card.expiresAt:Date.parse(card.expiresAt);
  if(!Number.isFinite(expiresAt)||!Number.isFinite(now))
    return {known:false,expired:false,seconds:null,label:'Deadline unavailable. Refresh this review.'};
  const seconds=Math.max(0,Math.ceil((expiresAt-now)/1000));
  if(card.offer)return {known:true,expired:now>=expiresAt,seconds,label:now>=expiresAt?'This job expired.':'Open until '+decisionTime(expiresAt)};
  if(card.legacyHold)return {known:true,expired:now>=expiresAt,seconds,label:now>=expiresAt?'This computer’s review window ended.':
    'Review window closes in '+(seconds>=60?Math.ceil(seconds/60)+' minutes':seconds+' seconds')+'.'};
  return {known:true,expired:now>=expiresAt,seconds,
    label:now>=expiresAt?APPROVAL_EXPIRED:seconds>=60?'Answer within '+Math.ceil(seconds/60)+(seconds<=60?' minute':' minutes')+' ('+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0')+' left).':'Accept within '+seconds+(seconds===1?' second.':' seconds.')};
}
export function lendingRulesSummary(lending={},circle) {
  const limits=lending.limits;
  if(!limits||!['dailyJobs','dailyMinutes','maxWallSeconds'].every(key=>limits[key]===null||Number.isFinite(limits[key])))
    return 'Your account and computer limits apply. Check them before turning lending on.';
  const daily=limits.dailyJobs===null&&limits.dailyMinutes===null?'No daily job or minute cap.':[
    limits.dailyJobs===null?null:'Up to '+limits.dailyJobs+(limits.dailyJobs===1?' job':' jobs')+' a day.',
    limits.dailyMinutes===null?null:'Up to '+limits.dailyMinutes+' minutes a day.'].filter(Boolean).join(' ');
  const wall=limits.maxWallSeconds===null?'Each job must fit before reset.':'Up to '+Math.ceil(limits.maxWallSeconds/60)+' minutes per job.';
  return ((circle?.lendingMode??lending.mode)==='auto'?'Automatic lending.':'Ask before each job.')+' Your account and computer concurrency limits apply. '+daily+' '+wall;
}
// Read-only navigation advice. Positive downstream evidence outranks incomplete setup reads.
// Keep the last coherent step through missing/older refreshes, but honor explicit pause/restart
// and current setup failures. Nothing here changes membership, agents, rules or lending.
export function contributorNextStep(input={},previous=null) {
  const {home={},circles,approvals=[],jobs,deviceKey,selectedCircle,now=Date.now()}=input;
  const readinessAt=Date.parse(input.readiness?.protection?.observed_at);
  const agentTimes=(Array.isArray(input.agents)?input.agents:[]).map(a=>Date.parse(a.checkedAt)).filter(Number.isFinite);
  const agentsAt=agentTimes.length?Math.max(...agentTimes):NaN;
  const readiness=Number.isFinite(readinessAt)&&readinessAt<previous?.readinessAt?undefined:input.readiness;
  const agents=Number.isFinite(agentsAt)&&agentsAt<previous?.agentsAt?undefined:input.agents;
  const lending=home.lending||input.lending||{};
  const projectionSource=Object.hasOwn(home,'lendingProjection')||home.intent||home.execution ? home : {lending};
  const projection=lendingProjectionOf(projectionSource);
  const untilValue=home.intent?.until ?? lending.until ?? lending.pause_until;
  const projectionView=formatLendingProjection(projection, {until:untilValue,now});
  const domainUnknown=['intent','admission','execution'].some(axis=>projection[axis]==='unknown');
  const observedAt=home.observedAt;
  if(previous&&Number.isFinite(previous.observedAt)&&
    (!Number.isFinite(observedAt)||observedAt<previous.observedAt))return previous;
  const knownCircles=Array.isArray(circles)?circles:home.circles;
  const invited=(knownCircles||[]).filter(c=>c?.origin&&c.owned===false);
  let circle=invited.find(c=>c.id===lending.circle)||invited.find(c=>c.id===selectedCircle)||invited[0];
  const membership=home.circles?.find(c=>c.id===circle?.id);
  if(circle&&membership) {
    if(Object.hasOwn(membership,'membershipProjection'))
      circle={...circle,membershipProjection:membership.membershipProjection};
    else if(!Object.hasOwn(circle,'membershipProjection'))circle={...circle,enrollment:membership.enrollment};
  }
  if(!circle)return Array.isArray(home.circles)&&!home.circles.some(c=>c.id===previous?.circleId)?null:previous;
  const same=previous?.circleId===circle.id?previous:null;
  const rank={membership_pending:0,membership_unknown:0,membership_expired:0,membership_rejected:0,joined:1,sandbox_not_ready:2,no_ready_agent:3,agent_not_chosen:4,
    lending_off:5,lending_waiting:6,approval_waiting:7,job_running:8,result_delivered:9};
  const unknownSetup=readiness?.ready===undefined||!Array.isArray(agents)||!agents.length||
    agents.every(a=>a.stale===true||(a.installed==null&&a.signedIn==null));
  const step=(id,title,message,label,page,extra={})=>{
    const explicitPause=(projection.intent==='off'&&lending.circle===circle.id&&rank[same?.id]>=6)||
      (lending.circle&&lending.circle!==circle.id);
    if(same&&rank[id]<rank[same.id]&&unknownSetup&&!explicitPause&&
      readiness?.ready!==false&&membershipProjectionFor(circle).phase==='approved')return {
        ...same,observedAt,
        action:same.action.enable?{label:'Check lending',page:'lend',enable:false}:same.action,
      };
    return {id,title,message,circleId:circle.id,observedAt,
      readinessAt:Number.isFinite(readinessAt)?Math.max(readinessAt,same?.readinessAt||0):same?.readinessAt,
      agentsAt:Number.isFinite(agentsAt)?Math.max(agentsAt,same?.agentsAt||0):same?.agentsAt,
      action:{label,page,...extra}};
  };
  const ownJobs=(Array.isArray(jobs)?jobs:[]).filter(j=>deviceKey&&j.current_attempt?.holder===deviceKey);
  const executing=['running','finishing','stopping'].includes(projection.execution);
  if(executing) {
    const job=ownJobs.find(j=>j.current_attempt?.attempt_id===projection.executionJob);
    const stopping=projection.execution==='stopping';
    return step('job_running',stopping?'Stopping this job':'Your computer is helping',
      stopping?'Wait for confirmation that the job stopped.':'Open the job to see its progress.',
      'View job',job?.job_digest?'job':'lend',job?.job_digest?{id:job.job_digest,circleId:circle.id}:{});
  }
  const membershipPhase=membershipProjectionFor(circle).phase;
  if(membershipPhase!=='approved') {
    const membershipView=formatMembership(circle,{surface:'banner'});
    const phaseStep={
      pending:['membership_pending','Waiting to join','Check membership'],
      unknown:['membership_unknown','Check circle membership','Check membership'],
      expired:['membership_expired','Invitation expired','View circle'],
      rejected:['membership_rejected','Not added to circle','View circle'],
    }[membershipPhase]??['membership_unknown','Check circle membership','Check membership'];
    return step(phaseStep[0],phaseStep[1],membershipView.message,phaseStep[2],'circle',{id:circle.id});
  }
  if(lending.circle&&lending.circle!==circle.id)
    return step('lending_off','Check your lending circle','Lending is set to another circle. Pause it before switching.',
      'Check lending','lend');
  const approval=approvals.find(c=>(c.job?.circle||lending.circle)===circle.id&&!approvalDeadline(c,now).expired);
  if(approval)
    return step('approval_waiting','A job needs your review','Read the job before you accept it.','Review job',approval?'request':'lend',approval?{id:approval.id}:{});
  const delivered=ownJobs.find(j=>formatJobProjection(j).projection.phase==='result_accepted');
  if(delivered&&projection.intent!=='off')return step('result_delivered','Your result was delivered','The requester can now review the result.',
    'View result','job',{id:delivered.job_digest,circleId:circle.id});
  const paused=projection.intent==='off'||projection.intent==='paused';
  if(same?.id==='result_delivered'&&!Array.isArray(jobs)&&!paused)return same;
  if(['on','paused'].includes(projection.intent)) {
    const blocked=projection.admission!=='allowed';
    return step('lending_waiting',blocked?'Lending needs a check':'Ready when a job arrives',
      blocked?projectionView.reason:'Lending is on. Your saved approval mode and limits apply.',
      blocked?'Check lending':'View lending','lend');
  }
  // A saved lending circle or an explicit agent choice proves setup advanced beyond joining.
  const chosen=(Array.isArray(agents)?agents:[]).some(a=>a.useForLending===true);
  const advanced=chosen||lending.circle===circle.id;
  if(readiness?.ready===false)
    return step('sandbox_not_ready','Set up the protected workspace','This computer needs a protected workspace before it can help.',
      'Open setup','setup');
  if(advanced) {
    const checked=readiness?.ready===true&&(agents||[]).some(a=>a.useForLending===true&&a.installed===true&&a.signedIn===true&&a.stale!==true);
    return step('lending_off',checked?'Ready to turn lending on':'Check before lending',
      'Lending is off. No jobs will start until you turn it on.',checked?'Turn lending on':'Check lending','lend',{enable:checked});
  }
  const ready=(Array.isArray(agents)?agents:[]).some(a=>a.installed===true&&a.signedIn===true&&a.stale!==true);
  if(ready)return step('agent_not_chosen','Choose an agent to lend','A ready agent is available. Choose which one may help.',
    'Choose an agent','lend');
  if(Array.isArray(agents)&&readiness?.ready===true)
    return step('no_ready_agent','Get an agent ready','Install or sign in to an agent. Then check it again.',
      'Set up an agent','lend');
  if(domainUnknown)return step('lending_waiting','Check lending',projectionView.reason,'Check lending','lend');
  if(same&&!paused&&!['membership_pending','membership_unknown','membership_expired','membership_rejected','joined'].includes(same.id))return same;
  return step('joined','You joined the circle','Check this computer before lending your first job.',
    'Open setup','setup');
}

export function contributionMinutes(value) {
  return Number.isFinite(value)&&value>=0 ?
    new Intl.NumberFormat('en',{maximumFractionDigits:2}).format(value) : 'Unknown';
}
// The headline uses plain words; the detail table keeps the raw minutes.
export function contributionTime(minutes) {
  if(!Number.isFinite(minutes)||minutes<0)return 'time unknown';
  if(minutes<1)return 'less than a minute';
  const whole=Math.round(minutes);return whole+(whole===1?' minute':' minutes');
}
const listNames=names=>names.length>1?names.slice(0,-1).join(', ')+' and '+names.at(-1):names[0];
export function contributionLine(window,self='', {ownerName='', ownerPersonId='', ownerKeys=[]} = {}) {
  if(!window||!Number.isSafeInteger(window.devices)||window.devices<1||
     !Number.isSafeInteger(window.jobs)||window.jobs<1)return '';
  // Name the people helped; jobs this computer ran for itself are not help.
  const isOwner = row => row.keyId === self || ownerKeys.includes(row.keyId) ||
    (ownerPersonId && row.personId === ownerPersonId) || (ownerName && safeName(row.personName) === ownerName);
  const helped=new Map();
  for(const row of Array.isArray(window.rows)?window.rows:[])
    if(typeof row?.keyId==='string'&&!isOwner(row)&&Number.isSafeInteger(row.run)&&row.run>0&&!helped.has(row.keyId))
      helped.set(row.keyId,localNameOf(row.localName)||safeName(row.personName)||safeName(row.deviceName,''));
  if (Array.isArray(window.rows) && !helped.size) return '';
  const counts = new Map();
  for (const row of Array.isArray(window.rows) ? window.rows : []) {
    if (isOwner(row)) continue;
    const id = JSON.stringify([row.circle, row.keyId]);
    const count = Number.isSafeInteger(row.delivered) ? row.delivered : Number.isSafeInteger(row.run) ? row.run : 0;
    counts.set(id, Math.max(counts.get(id) || 0, count));
  }
  const jobs = Array.isArray(window.rows) ? [...counts.values()].reduce((sum,count)=>sum+count,0) : window.jobs;
  if (!jobs) return '';
  const names=[...helped.values()];
  const named=[...new Set(names.filter(Boolean))],unnamed=names.filter(name => !name).length;
  const people=!helped.size?window.devices+(window.devices===1?' circle member':' circle members')
    :!named.length?unnamed+(unnamed===1?' circle member':' circle members')
    :listNames(named.length>2?[...named.slice(0,2),(named.length-2+unnamed)+' others']:unnamed?[...named,unnamed+(unnamed===1?' other':' others')]:named);
  return 'You helped '+people+' with '+jobs+' '+(jobs===1?'job':'jobs')+' in the last 7 days.';
}
export function contributionName(row={}) {
  const short=typeof row.keyId==='string'?row.keyId.replace(/^sha256:/,'').slice(0,12):'Unknown key';
  const local=safeName(row.localName,'');
  return local?local+' · '+short:safeName(row.deviceName,'Device')+' · '+short;
}

// A reload can reset the page's circle picker before lending state arrives.
// Existing lending controls always address the circle saved by the server.
export function lendingControlBody(path, body = {}, lending = {}) {
  return /^lending\/(?:on|off|pause|resume)$/.test(path) && lending.circle
    ? {...body, circle: lending.circle} : body;
}
