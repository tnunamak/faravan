import {currentAccountDecision} from './lending-summary.mjs';
import {remedyWords, remedyAction, DOCKER_RUNNING_CHECKS, dockerStoppedRow, DOCKER_SIGNED_OUT_MESSAGE} from './docker-state.mjs';
import {launchFenceLine, identityHoldCopy, REASON_LINE} from './lending-status-copy.mjs';
import {agentDisplayName} from './agent-display.mjs';
// Shown on a lent agent whose automatic checks used their budget. "Check agents" is the button on its blocker row.
export const AUTOMATIC_CHECKS_STOPPED = 'Automatic checks stopped after 3 failures. Press Check agents to try again.';
// Claude lends on Faravan's own sign-in. A computer that lent on the Docker proxy's login (and a new one) has none yet: one blocker, one button.
const SIGNIN_NAMES = {'claude-code-subscription': 'Claude', codex: 'Codex'};
export const faravanSigninLine = id => `Sign in to ${SIGNIN_NAMES[id] ?? 'this agent'} once more to finish updating Faravan.`;
export const CLAUDE_UPDATE_SIGNIN_LINE = faravanSigninLine('claude-code-subscription');
const signinFaultLine = id => `Faravan could not give ${SIGNIN_NAMES[id] ?? 'the agent'}'s sign-in to a sandbox. Sign in to ${SIGNIN_NAMES[id] ?? 'the agent'} again, then lending resumes.`;
export const stoppedAgentCheck = () => ({status:'blocked', headline:'Lending stopped: agent checks failed', detail:'Faravan could not check this agent in a sandbox. '+AUTOMATIC_CHECKS_STOPPED, action:'Check agents', automaticChecksStopped:true});
export const BLOCKER_ORDER = ['docker_installed', 'docker_running', 'docker_signin', 'readiness_requirement', 'lending', 'circle', 'agent'];

const blkKnown = (v) => v === true || v === false;
const blkName = (a) => (typeof a?.name === 'string' && a.name.trim()) || 'This agent';
export function lendingBlockers({docker, readinessRequirements, launchFence, intent, agents, circle, readiness, checking} = {}) {
  const items = [];
  let first = null;
  const add = (item) => { items.push(item); if (!first && item.status === 'blocked') first = item; return item; };
  const d = docker ?? {}, i = intent ?? {};
  // The failing check behind "running", when the caller knows it: one row that says what the app knows about it.
  const stopped = d.restart ? null : d.stopped ?? null;

  // Docker and the sandbox, in dependency order. A step after a blocked or unknown step waits for it.
  const dockerSteps = [
    ['docker_installed', 'Docker Sandboxes', d.installed, 'Not installed.', 'Install Docker Sandboxes', 'Lending needs Docker Sandboxes', 'Installed.'],
    ['docker_running', 'Sandbox service', d.running, d.restart?.detail ?? stopped?.detail ?? 'Docker Sandboxes isn’t ready.', d.restart ? d.restart.action : stopped ? stopped.action : 'Check again', d.restart ? 'Docker Sandboxes needs to restart' : 'Lending stopped: Docker Sandboxes isn’t ready', 'Running.'],
    ['docker_signin', 'Docker sign-in', d.signedIn, d.signinDetail ?? (d.expiredAt ? `Expired at ${d.expiredAt}.` : 'Not signed in.'), d.signinDetail ? 'Open Setup and select Sign in to Docker.' : 'Sign in to Docker', d.signinDetail ?? (d.expiredAt ? 'Lending stopped: your Docker sign-in expired' : 'Lending stopped: sign in to Docker'), d.signinAccepted ? "Docker accepted Faravan's request to start a test workspace." : d.account ? `Signed in as ${d.account}.` : 'Signed in.'],
  ];
  let dockerBlock = null; // the first Docker step that isn't ok
  for (const [key, label, ok, bad, action, headline, good] of dockerSteps) {
    if (key === 'docker_running' && d.installed === false) continue; // one line for "not installed"
    if (key === 'docker_signin' && (d.installed === false || d.running === false || (stopped && dockerBlock?.key === 'docker_running'))) {
      add({key, label, status: 'waits', detail: `Waits for ${dockerBlock.label}.`, waitsFor: dockerBlock.key});
      continue;
    }
    if (ok === true) {
      const prev = items[items.length - 1];
      if (key === 'docker_running' && prev?.key === 'docker_installed' && prev.status === 'ok') { prev.detail = 'Installed and running.'; continue; }
      add({key, label, status: 'ok', detail: good}); continue;
    }
    // Installation and service failures keep their own distinct labels.
    const named = key === 'docker_running' && stopped && ok !== true;
    const it = add(named ? {key, cause: stopped.cause, label, status: stopped.status, detail: bad, ...(action ? {action} : {}), ...(stopped.status === 'blocked' ? {headline} : {})}
      : ok === false
      ? {key, label, status: 'blocked', detail: bad, action, headline}
      : key === 'docker_signin' && d.signinSettled === true && d.signinChecking !== true
        ? {key, label, status: 'unknown', detail: d.signinDetail ?? 'Faravan could not confirm the Docker sign-in.', action: 'Check again'}
        : {key, label, status: 'unknown', detail: 'Checking…'});
    dockerBlock ??= it;
  }
  for (const requirement of Array.isArray(readinessRequirements) ? readinessRequirements : []) {
    const cause=typeof requirement?.cause==='string'?requirement.cause:'unknown';
    if(cause==='docker_login')continue; // Covered by Docker sign-in above.
    if(stopped&&DOCKER_RUNNING_CHECKS.includes(cause))continue; // The stopped-sandbox row above already names this check.
    const titles={guard_runtime_unavailable:'Sandbox job guard',network_policy:'Sandbox network rules',v1_limits:'Job limits',sbx_credential_store:'Docker sign-in storage',socket_path_length:'Sandbox files',sbx_version:'Update Docker Sandboxes',sbx_cli_contract:'Docker Sandboxes commands'};
    const waiting=cause==='network_policy'&&Boolean(dockerBlock);
    const label=typeof requirement?.label==='string'&&requirement.label.trim()?requirement.label:'A readiness requirement';
    const remedy=typeof requirement?.remedy==='string'?requirement.remedy.trim():'';
    // A remedy that is a button label stays the action. A sentence is the instruction: the row shows it once and offers Check again.
    const instruction=remedyWords(remedy);
    // A disk requirement's label is a full sentence and its remedy is an instruction, not a button label:
    // show a short title, one explanation, and a Check again button.
    const disk=['host_disk','host_disk_low','host_disk_unreadable'].includes(cause);
    add({key:'readiness_requirement',cause,label:disk?(cause==='host_disk_unreadable'?'Free disk space check':'Free disk space'):(titles[cause]??'Sandbox setup'),status:waiting?'waits':'blocked',
      ...(waiting?{waitsFor:dockerBlock.key}:{}),
      detail:waiting?'Faravan sets up the network rules after Docker sign-in.':disk?[label,instruction].filter(Boolean).join(' '):cause==='network_policy'?'The sandbox network rules are not ready.':[label,instruction&&!label.includes(instruction)?instruction:''].filter(Boolean).join(' '),

      ...(requirement?.observedAt?{observedAt:requirement.observedAt}:{}),action:waiting?undefined:disk?'Check again':cause==='network_policy'?remedy:remedyAction(remedy),
      headline:cause==='network_policy'?'Lending stopped: network policy is not enforced':
        cause==='v1_limits'?'Lending stopped: required job limits are not enforceable':
        (cause==='host_disk'||cause==='host_disk_low')?'Lending stopped: this computer is low on disk space':
        cause==='host_disk_unreadable'?'Lending stopped: Faravan could not read free disk space':'Lending is blocked by a readiness requirement'});
  }

  // A launch whose earlier run is unconfirmed holds new starts until its bound passes; the row's time is that bound.
  if (launchFence?.until) add({key: 'launch_fence', label: 'Earlier run', status: 'waits', detail: launchFenceLine(launchFence.until), time: launchFence.until});

  // Lending intent. "Off" and "paused" are choices, not faults, but they still block new jobs.
  if (i.on === false) add({key: 'lending', label: 'Lending', status: 'blocked', detail: 'Turned off.', action: 'Turn lending on', headline: 'Lending is off'});
  else if (i.pausedUntil) add({key: 'lending', label: 'Lending', status: 'blocked', detail: `Paused until ${i.pausedUntil}.`, action: 'Resume now', headline: `Paused until ${i.pausedUntil}`});
  else if (i.outsideUntil) add({key: 'lending', label: 'Lending', status: 'blocked', detail: `Outside your lending hours; starts at ${i.outsideUntil}.`, headline: `Lending starts at ${i.outsideUntil}`});
  else if (i.restingUntil) add({key: 'lending', label: 'Lending', status: 'blocked', detail: `Today’s limit is used; resets at ${i.restingUntil}.`, headline: `Resting until ${i.restingUntil}`});
  else if (i.on === true) add({key: 'lending', label: 'Lending', status: 'ok', detail: 'On.'});
  else add({key: 'lending', label: 'Lending', status: 'unknown', detail: 'Checking…'});

  // The circle's host: in the MVP, the owner's computer. It retries by itself, so there is no fix button.
  if (circle && circle.reachable === false) add({key: 'circle', label: circle.name ?? 'Your circle', status: 'blocked', detail: `Can’t reach ${circle.host ? circle.host + ', which hosts the circle' : 'the computer that hosts the circle'}.${circle.lastReached ? ` Last reached ${circle.lastReached}.` : ''}`, headline: `Lending waits: can’t reach ${circle.host ?? 'the circle’s host'}`, ...(circle.host ? {hostName: circle.host} : {})});
  else if (circle?.rateLimited) add({key:'circle',label:circle.name??'Your circle',status:'blocked',detail:"The circle's host is turning away this computer's requests. Faravan keeps trying.",headline:'Lending waits: the circle’s host is busy'});
  else if (circle && circle.hostVersion && circle.needVersion) add({key: 'circle', label: circle.name ?? 'Your circle', status: 'blocked', detail: `${circle.host ?? 'The host'} runs Faravan ${circle.hostVersion}. This computer needs ${circle.needVersion} or later to lend to it.${circle.owner ? ` Ask ${circle.owner} to update.` : ''}`, headline: `Lending waits: ${circle.name ?? 'your circle'} needs an update`});
  // A failed lending start is the generic fallback: a specific host answer (busy, too old) names the real fix.
  else if (circle?.startFailed) add({key:'circle',label:circle.name??'Your circle',status:'blocked',detail:`Can’t connect lending to ${circle.host??'the circle’s host'}. Faravan keeps trying.`,headline:`Lending waits: reconnecting to ${circle.host??'the circle’s host'}`,...(circle.host?{hostName:circle.host}:{})});

  // Every agent, always, in /lend order (R-live: Home listed only Codex). Each waits for an earlier blocker.
  const machineBlock = items.find((x) => x.status !== 'ok' && ['docker_installed', 'docker_running', 'docker_signin', 'readiness_requirement'].includes(x.key));
  const list = Array.isArray(agents) ? agents : [];
  if (!list.some((a) => a.enabled !== false)) add({key: 'agent', label: 'Coding agents', status: 'blocked', detail: 'No agent is chosen to lend.', action: 'Choose agents', headline: 'Choose an agent to lend'});
  for (const a of list) {
    const base = {key: 'agent', agent: a.id, label: blkName(a)};
    if (a.enabled === false) { add({...base, status: 'off', detail: 'Not lent.'}); continue; }
    if (a.installed === false) { add({...base, status: 'blocked', detail: 'Not installed.', action: `Install ${blkName(a)}`, headline: `Lending stopped: ${blkName(a)} isn’t installed`}); continue; }
    if (machineBlock && machineBlock.status !== 'unknown') { add({...base, status: 'waits', detail: `Waits for ${blkWaitName(machineBlock)}.`, waitsFor: machineBlock.key}); continue; }
    if (a.signedIn === false && a.faravanSignIn === true) { add({...base, status: 'blocked', detail: faravanSigninLine(a.id), action: 'Sign in', headline: `Lending stopped: sign in to ${SIGNIN_NAMES[a.id] ?? 'the agent'} once more`}); continue; }
    if (a.signInFault && a.faravanSignIn === true) { add({...base, status: 'blocked', detail: signinFaultLine(a.id), action: 'Sign in', headline: `Lending stopped: ${SIGNIN_NAMES[a.id] ?? 'the agent'}'s sign-in could not be used`}); continue; }
    if (a.signedIn === false) { add({...base, status: 'blocked', detail: 'Signed out.', action: `Sign in to ${blkName(a)}`, headline: `Lending stopped: ${blkName(a)} is signed out`}); continue; }
    // Actual job isolation remains the backend’s responsibility.
    if (a.automaticChecksStopped === true && a.signedIn !== true) { add({...base, ...stoppedAgentCheck()}); continue; }
    if (!blkKnown(a.signedIn) || !blkKnown(a.installed)) { add({...base, status: 'unknown', detail: 'Checking…'}); continue; }
    add({...base, status: 'ok', detail: 'Ready.'});
  }
  // A single signed-out agent doesn't stop lending while another agent can run: it is listed, not headlined.
  const agentsOk = list.some((a) => a.enabled !== false && items.some((x) => x.agent === a.id && x.status === 'ok'));
  if (first?.key === 'agent' && agentsOk) first = null;
  const headline = first ? first.headline
    : items.some((x) => x.status === 'unknown') ? 'Checking this computer…' : 'Lending is on';
  for (const item of items) { item.detail_code = detailCode(item); item.waits_for = item.waitsFor ?? null; }
  const needsYou = items.filter((x) => x.status === 'blocked' && x.action);
  return projectReadinessBlockers({headline, first, items, needsYou, canLend: !first && !items.some((x) => x.status === 'unknown')},readiness,{checking});
}
// Current readiness outranks an older display snapshot. A lifecycle-aware
// caller supplies only checks still within their time bound; omitted lifecycle
// retains compatibility for older clients while known failures always win.
export function projectReadinessBlockers(model,readiness,{checking}={}) {
  if(!Array.isArray(model?.items))return model;
  const items=model.items.map(item=>({...item}));
  const failed=(readiness?.checks??[]).filter(check=>check?.ok===false&&check.unknown!==true);
  const installed=failed.find(check=>['sbx_install','sbx_cli_contract'].includes(check.name));
  const signin=failed.find(check=>check.name==='docker_login'&&!['docker_signin_state_unavailable','docker_signin_refresh_unavailable'].includes(check.cause))??
    failed.find(check=>check.name==='sbx_daemon'&&/\bnot signed in\b/i.test(check.label??''));
  const service=failed.find(check=>DOCKER_RUNNING_CHECKS.includes(check.name));
  const allowed=item=>checking===true||(item.key==='agent'?checking?.agents?.includes(item.agent):checking?.machine===true);
  let root,source;
  if(installed){root={key:'docker_installed',label:'Docker Sandboxes',detail:installed.label||'Not installed.',action:'Install Docker Sandboxes',headline:'Lending needs Docker Sandboxes'};source=installed;}
  else if(signin){
    const expired=items.find(item=>item.key==='docker_signin'&&item.status==='blocked'&&item.detail_code==='expired');
    root={key:'docker_signin',label:'Docker sign-in',detail:expired?.detail??DOCKER_SIGNED_OUT_MESSAGE,action:'Sign in to Docker',headline:expired?.headline??'Lending stopped: sign in to Docker'};source=signin;
  }
  else if(service){
    const stopped=dockerStoppedRow([service]);
    const working=stopped?.status==='unknown'&&allowed({key:'docker_running'});
    root={key:'docker_running',label:'Sandbox service',status:working?'unknown':'blocked',detail:working?stopped.detail:
      stopped?.status==='unknown'?(service.label||'Faravan could not confirm the sandbox service.'):stopped?.detail||service.label||'The sandbox service is unavailable.',
      action:working?undefined:stopped?.action||'Check again',headline:'Lending stopped: the sandbox service is unavailable'};source=service;
  }
  else if(checking!==undefined){
    root=items.find(item=>item.status==='blocked'&&item.key!=='lending'&&item.key!=='agent');
    // A finished Docker sign-in check that could not tell (for example a refresh failure that may be temporary) keeps its own
    // sentence and a recheck; it is not the generic sandbox-service row.
    const settled=!root&&items.find(item=>item.key==='docker_signin'&&item.status==='unknown'&&item.action==='Check again'&&!allowed(item));
    if(settled)root={key:'docker_signin',label:'Docker sign-in',unconfirmed:true,detail:settled.detail,action:'Check again',headline:settled.detail};
    if(!root&&items.some(item=>item.key.startsWith('docker_')&&item.status==='unknown'&&!allowed(item)))
      root={key:'docker_running',label:'Sandbox service',unconfirmed:true,detail:'Faravan could not confirm the sandbox service. Choose Check again.',action:'Check again',headline:'The sandbox service could not be checked'};
  }
  if(root){
    const index=items.findIndex(item=>item.key===root.key&&(root.key!=='readiness_requirement'||item.cause===root.cause));
    root={...(index>=0?items[index]:{}),...root,status:root.status??'blocked'};
    delete root.waitsFor;if(source)delete root.unconfirmed;
    if(index>=0)items[index]=root;
    else {const order=BLOCKER_ORDER.indexOf(root.key),at=items.findIndex(item=>BLOCKER_ORDER.indexOf(item.key)>order);items.splice(at<0?items.length:at,0,root);}
    const waitName=root.key==='docker_signin'?'the Docker sign-in':root.label;
    for(let i=items.length-1;i>=0;i--){const item=items[i];
      if(item===root)continue;
      if(source&&item.key==='readiness_requirement'&&[source.name,source.reason,source.cause].some(cause=>cause&&cause===item.cause)){items.splice(i,1);continue;}
      if(root.key.startsWith('docker_')&&((item.key.startsWith('docker_')&&item.status!=='ok')||(item.key==='agent'&&['unknown','ok'].includes(item.status)))){
        Object.assign(item,{status:'waits',detail:`Waits for ${waitName}.`,waitsFor:root.key});delete item.action;delete item.headline;delete item.unconfirmed;
      }
    }
  }
  if(checking!==undefined)for(const item of items){
    if(item.status!=='unknown'||allowed(item))continue;
    Object.assign(item,{status:'blocked',unconfirmed:true,detail:'Faravan could not confirm this check.',
      action:item.key==='agent'?(item.agent?'Check '+(item.label||'agent'):'Check agents'):'Check again',headline:'A check could not be completed'});
  }
  for(const item of items){if(item.key==='docker_running')item.label='Sandbox service';item.detail_code=detailCode(item);item.waits_for=item.waitsFor??null;}
  const agentsOk=items.some(item=>item.key==='agent'&&item.status==='ok');
  const first=items.find(item=>item.status==='blocked'&&(!agentsOk||item.key!=='agent'))??null;
  return {...model,items,first,needsYou:items.filter(item=>item.status==='blocked'&&item.action),
    headline:first?.headline??(items.some(item=>item.status==='unknown')?'Checking this computer…':'Lending is on'),
    canLend:!first&&!items.some(item=>item.status==='unknown')};
}
const detailCode = (x) => x.unconfirmed ? 'blocked' : x.automaticChecksStopped ? 'checks_stopped' : x.status === 'waits' ? 'waits' : x.status === 'ok' ? 'ok' : x.status === 'off' ? 'off' : x.status === 'unknown' ? 'checking' :
  ({docker_installed: 'not_installed', docker_running: 'not_running', docker_signin: /^Expired/.test(x.detail) ? 'expired' : 'signed_out',
    readiness_requirement:x.cause,
    circle: /^Can/.test(x.detail) ? 'unreachable' : /^The circle's host is turning away/.test(x.detail) ? 'rate_limited' : 'host_too_old',
    lending: /^Turned off/.test(x.detail) ? 'off' : /^Paused/.test(x.detail) ? 'paused' : /^Outside/.test(x.detail) ? 'outside_hours' : 'resting',
    agent: /^Not installed/.test(x.detail) ? 'not_installed' : /^(Signed out|Sign in to \w+ once more|Faravan could not give)/.test(x.detail) ? 'signed_out' : /^Its sign-in/.test(x.detail) ? 'credential_test_failed' : /^No agent/.test(x.detail) ? 'none_chosen' : 'blocked'})[x.key] ?? 'blocked';
const blkWaitName = (b) => ({docker_installed: 'Docker Sandboxes', docker_running: 'Docker Sandboxes', docker_signin: 'the Docker sign-in'})[b.key] ?? b.label;

// The tray shows the same model as native menu lines: headline, the first fix, then each item.
export function trayLines(model) {
  const lines = [[model.headline, 'dis']];
  if (model.first?.action) lines.push([model.first.action + '…', 'hl']);
  for (const it of model.items) if (it.status !== 'ok' || it.key === 'agent') lines.push([`${it.label} · ${it.detail.replace(/\.$/, '')}`, 'dis']);
  return lines;
}

// Current account availability is distinct from install and sign-in checks.
const PROVIDER_AGENT = {codex: 'codex', claude: 'claude-code-subscription'};
export function accountHolds({accounts, agents} = {}) {
  const lent = (Array.isArray(agents) ? agents : []).filter((a) => a?.useForLending === true);
  const holds = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const agent = lent.find((a) => a.id === PROVIDER_AGENT[account?.provider]);
    const d = currentAccountDecision(account);
    if (!agent || d?.admitted !== false) continue;
    const recovery = d.status?.recovery?.who === 'owner' ? d.status.recovery : null;
    const reason = d.reason ?? d.objective?.reasonCode ?? d.status?.id ?? 'account_unavailable';
    const name = agentDisplayName(agent.id);
    const line = identityHoldCopy(reason, {provider: account.provider})?.line ?? `${name}: ${d.status?.line ?? d.objective?.reasonText ?? 'Waiting for a quota reading.'}`;
    holds.push({kind: 'account_held', agent: agent.id, reason, message: line,
      signIn: (REASON_LINE[reason] ?? reason) === 'identity_mismatch', recovery});
  }
  return holds;
}
