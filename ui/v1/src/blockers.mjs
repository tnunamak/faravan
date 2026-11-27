import {stoppedAgentCheck} from '../../../lib/v1/blockers.mjs';
import {remedyWords, remedyAction, DOCKER_RUNNING_CHECKS} from '../../../lib/v1/docker-state.mjs';
import {launchFenceLine} from '../../../lib/v1/lending-status-copy.mjs';
export const BLOCKER_ORDER = ['docker_installed', 'docker_running', 'docker_signin', 'readiness_requirement', 'isolation_check', 'lending', 'circle', 'agent'];

const blkKnown = (v) => v === true || v === false;
const blkName = (a) => (typeof a?.name === 'string' && a.name.trim()) || 'This agent';
export function lendingBlockers({docker, isolationFailure, readinessRequirements, launchFence, intent, agents, circle} = {}) {
  const items = [];
  let first = null;
  const add = (item) => { items.push(item); if (!first && item.status === 'blocked') first = item; return item; };
  const d = docker ?? {}, i = intent ?? {};
  // The failing check behind "running", when the caller knows it: one row that says what the app knows about it.
  const stopped = d.restart ? null : d.stopped ?? null;

  // Docker and the sandbox, in dependency order. A step after a blocked or unknown step waits for it.
  const dockerSteps = [
    ['docker_installed', 'Docker Sandboxes', d.installed, 'Not installed.', 'Install Docker Sandboxes', 'Lending needs Docker Sandboxes', 'Installed.'],
    ['docker_running', 'Docker Sandboxes', d.running, d.restart?.detail ?? stopped?.detail ?? 'Docker Sandboxes isn’t ready.', d.restart ? d.restart.action : stopped ? stopped.action : 'Check again', d.restart ? 'Docker Sandboxes needs to restart' : 'Lending stopped: Docker Sandboxes isn’t ready', 'Running.'],
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
    // One "Docker Sandboxes" row: an installed-but-stopped Docker replaces the "Installed." row.
    if (key === 'docker_running' && items[items.length - 1]?.key === 'docker_installed' && items[items.length - 1].status === 'ok') items.pop();
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
    const titles={network_policy:'Sandbox network rules',v1_limits:'Job limits',sbx_credential_store:'Docker sign-in storage',socket_path_length:'Sandbox files',sbx_version:'Update Docker Sandboxes',sbx_cli_contract:'Docker Sandboxes commands'};
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
  if(isolationFailure)add({key:'isolation_check',label:'Sandbox isolation',status:'blocked',detail:isolationFailure,action:'Resume lending',headline:'Lending paused: sandbox isolation check failed'});

  // A launch whose earlier run is unconfirmed holds new starts until its bound passes; the row's time is that bound.
  if (launchFence?.until) add({key: 'launch_fence', label: 'Earlier run', status: 'waits', detail: launchFenceLine(launchFence.until), time: launchFence.until});

  // Lending intent. "Off" and "paused" are choices, not faults, but they still block new jobs.
  if (i.on === false) add({key: 'lending', label: 'Lending', status: 'blocked', detail: 'Turned off.', action: 'Turn lending on', headline: 'Lending is off'});
  else if (i.pausedUntil) add({key: 'lending', label: 'Lending', status: 'blocked', detail: `Paused until ${i.pausedUntil}.`, action: 'Resume now', headline: `Paused until ${i.pausedUntil}`});
  else if (i.outsideUntil) add({key: 'lending', label: 'Lending', status: 'blocked', detail: `Outside your lending hours; starts at ${i.outsideUntil}.`, headline: `Lending starts at ${i.outsideUntil}`});
  else if (i.restingUntil) add({key: 'lending', label: 'Lending', status: 'blocked', detail: `Today’s limit is used; resets at ${i.restingUntil}.`, headline: `Resting until ${i.restingUntil}`});
  else if (i.on === true) add({key: 'lending', label: 'Lending', status: 'ok', detail: 'On.'});
  else add({key: 'lending', label: 'Lending', status: 'unknown', detail: 'Checking…'});

  // Give an explicit recheck without assuming an automatic retry contract.
  if (circle && circle.reachable === false) add({key: 'circle', label: circle.name ?? 'Your circle', status: 'blocked', detail: `Can’t reach ${circle.host ? circle.host + ', which hosts the circle' : 'the computer that hosts the circle'}. Check that ${circle.host || 'the host'} is online and Faravan is running.${circle.lastReached ? ` Last reached ${circle.lastReached}.` : ''}`, action:'Check again', headline: `Lending waits: can’t reach ${circle.host ?? 'the circle’s host'}`, ...(circle.host ? {hostName: circle.host} : {})});
  else if (circle && circle.reachable !== true) add({key: 'circle', label: circle.name ?? 'Your circle', status: 'unknown', detail: 'Checking…'});
  else if (circle && circle.hostVersion && circle.needVersion) add({key: 'circle', label: circle.name ?? 'Your circle', status: 'blocked', detail: `${circle.host ?? 'The host'} runs Faravan ${circle.hostVersion}. This computer needs ${circle.needVersion} or later to lend to it.${circle.owner ? ` Ask ${circle.owner} to update.` : ' Ask the person who hosts this circle to update.'}`, headline: `Lending waits: ${circle.name ?? 'your circle'} needs an update`});

  // Every agent, always, in /lend order (R-live: Home listed only Codex). Each waits for an earlier blocker.
  const machineBlock = items.find((x) => x.status !== 'ok' && ['docker_installed', 'docker_running', 'docker_signin', 'readiness_requirement', 'isolation_check'].includes(x.key));
  const list = Array.isArray(agents) ? agents.filter(Boolean) : [];
  if (!list.some((a) => a.enabled !== false)) add({key: 'agent', label: 'Coding agents', status: 'blocked', detail: 'No agent is chosen to lend.', action: 'Choose agents', headline: 'Choose an agent to lend'});
  for (const a of list) {
    const base = {key: 'agent', agent: a.id, label: blkName(a)};
    if (a.enabled === false) { add({...base, status: 'off', detail: 'Not lent.'}); continue; }
    if (a.enabled !== true) {add({...base,status:'unknown',detail:'Checking…'});continue;}
    if (a.installed === false) { add({...base, status: 'blocked', detail: 'Not installed.', action: `Install ${blkName(a)}`, headline: `Lending stopped: ${blkName(a)} isn’t installed`}); continue; }
    if (machineBlock) { add({...base, status: 'waits', detail: `Waits for ${blkWaitName(machineBlock)}.`, waitsFor: machineBlock.key}); continue; }
    if (a.signedIn === false) { add({...base, status: 'blocked', detail: 'Signed out.', action: `Sign in to ${blkName(a)}`, headline: `Lending stopped: ${blkName(a)} is signed out`}); continue; }
    // Credential isolation is checked before each real job.
    if (a.automaticChecksStopped === true && a.signedIn !== true) { add({...base,...stoppedAgentCheck()}); continue; }
    if (!blkKnown(a.signedIn) || !blkKnown(a.installed)) { add({...base, status: 'unknown', detail: 'Checking…'}); continue; }
    add({...base, status: 'ok', detail: 'Ready.'});
  }
  // A single signed-out agent doesn't stop lending while another agent can run: it is listed, not headlined.
  const agentsOk = list.some((a) => typeof a.id === 'string' && a.id.trim() &&
    list.filter((candidate) => candidate.id === a.id).length === 1 && a.enabled === true &&
    items.some((x) => x.key === 'agent' && x.agent === a.id && x.status === 'ok'));
  if (first?.key === 'agent' && agentsOk) first = null;
  const headline = first ? first.headline
    : items.some((x) => x.status === 'unknown') ? 'Checking this computer…' : 'Lending is on';
  for (const item of items) { item.detail_code = detailCode(item); item.waits_for = item.waitsFor ?? null; }
  const needsYou = items.filter((x) => x.status === 'blocked' && x.action);
  return {headline, first, items, needsYou, canLend: agentsOk && !first && !items.some((x) => x.status === 'unknown' && x.key !== 'agent')};
}
const detailCode = (x) => x.automaticChecksStopped ? 'checks_stopped' : x.status === 'waits' ? 'waits' : x.status === 'ok' ? 'ok' : x.status === 'off' ? 'off' : x.status === 'unknown' ? 'checking' :
  ({docker_installed: 'not_installed', docker_running: 'not_running', docker_signin: /^Expired/.test(x.detail) ? 'expired' : 'signed_out',
    readiness_requirement:x.cause,
    isolation_check:'failed', circle: /^Can/.test(x.detail) ? 'unreachable' : 'host_too_old',
    lending: /^Turned off/.test(x.detail) ? 'off' : /^Paused/.test(x.detail) ? 'paused' : /^Outside/.test(x.detail) ? 'outside_hours' : 'resting',
    agent: /^Not installed/.test(x.detail) ? 'not_installed' : /^Signed out/.test(x.detail) ? 'signed_out' : /^Its sign-in/.test(x.detail) ? 'credential_test_failed' : /^No agent/.test(x.detail) ? 'none_chosen' : 'blocked'})[x.key] ?? 'blocked';
const blkWaitName = (b) => ({docker_installed: 'Docker Sandboxes', docker_running: 'Docker Sandboxes', docker_signin: 'the Docker sign-in', isolation_check: 'the isolation check'})[b.key] ?? b.label;

// The tray shows the same model as native menu lines: headline, the first fix, then each item.
export function trayLines(model) {
  const lines = [[model.headline, 'dis']];
  if (model.first?.action) lines.push([model.first.action + '…', 'hl']);
  for (const it of model.items) if (it.status !== 'ok' || it.key === 'agent') lines.push([`${it.label} · ${it.detail.replace(/\.$/, '')}`, 'dis']);
  return lines;
}
