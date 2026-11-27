import {useState,useRef} from 'preact/hooks';
import {ReadinessCheck} from './lending-checks.jsx';
import {agentSectionsVM, agentsCheckedVM, canonicalAgentId} from './view-models.mjs';
import { Action,Confirm } from './shared.jsx';
import { SignIn } from './signin.jsx';
import { Button, Card, Command, Icon, Spinner } from './ds/index.mjs';
import { diskHelpVM } from './disk-help.mjs';

export function RestartSandbox({api,refresh,kind='secondary',policy=false}) {
  const [confirm,setConfirm]=useState(false);
  const initialize=policy==='init';
  const label=initialize?'Initialize sandbox network rules':policy?'Reset sandbox network rules':'Restart Docker Sandboxes';
  return <><Button class="ph-no-capture" kind={kind} size="sm" onClick={()=>setConfirm(true)} data-telemetry-private="blockers">{label}</Button>
    {confirm&&<Confirm title={label+"?"} confirmLabel={label} onClose={()=>setConfirm(false)}
      onConfirm={async()=>{await api.post(initialize?'setup/initialize-policy':policy?'setup/repair-policy':'setup/restart-sandbox',{confirmed:true});await refresh();}}>
      <p>{initialize?'This initializes the missing sandbox network policy as deny-all.':policy?'This removes all custom sandbox network rules and restarts the service.':'Restarting this service can stop sandboxes used by other apps.'} Continue only when other sandbox jobs have finished.</p>
    </Confirm>}</>;
}

// On the Lend page the agent list is already on screen, so "Choose agents" moves to it. Elsewhere it follows "#/lend".
// False when the list is not in this document, so the link navigates instead.
export function focusAgentList(doc = globalThis.document) {
  const section = doc?.getElementById('lend-agents');
  if (!section) return false;
  section.scrollIntoView?.({block: 'start'});
  const first = section.querySelector('[role="switch"]:not([aria-disabled="true"])');
  if (first) first.focus?.();
  else { section.tabIndex = -1; section.focus?.(); }
  return true;
}

// "Install <agent>" on the Lend page: the install steps sit in that agent's collapsed Details, so open them and move there.
// False when the card is not in this document, so the link navigates instead.
export function openAgentInstall(agentId, doc = globalThis.document) {
  const section = doc?.getElementById('lend-agents');
  const details = section && [...section.querySelectorAll('details[data-agent-id]')].find((node) => node.getAttribute('data-agent-id') === agentId);
  if (!details) return false;
  details.open = true;
  const summary = details.querySelector('summary');
  (summary ?? details).scrollIntoView?.({block: 'center'});
  summary?.focus?.();
  return true;
}

// The fix on one row of "What lending needs, in order" (blockers.mjs `action`). Only the first row that needs you
// is primary. Docker and agent sign-in are the existing sign-in flows; nothing starts until a click.
export function BlockerAction({ item, primary, api, agents, mutate, circle, refresh, latched, byAgent = {}, surface = '' }) {
  const currentByAgent=useRef(byAgent);currentByAgent.current=byAgent;
  const checked=ids=>result=>agentsCheckedVM((Array.isArray(result)?result:[]).filter(agent=>ids.some(id=>canonicalAgentId({id})===canonicalAgentId(agent))),currentByAgent.current);
  const kind = primary ? 'primary' : 'secondary';
  // Only a stopped or outdated shared service is restarted. A workspace that timed out gets Check again below.
  if(item?.key==='docker_running'&&item.action==='Restart Docker Sandboxes')
    return <RestartSandbox api={api} refresh={refresh} kind={kind}/>;
  if(item?.action==='Open Settings')return <Button class="ph-no-capture" kind={kind} size="sm" href="#/settings/data" data-telemetry-private="blockers">Open Settings</Button>;
  if(item?.cause==='network_policy'&&item.action==='Initialize sandbox network rules')return <RestartSandbox api={api} refresh={refresh} kind={kind} policy="init"/>;
  if(item?.cause==='network_policy'&&item.action==='Reset sandbox network rules')return <RestartSandbox api={api} refresh={refresh} kind={kind} policy/>;
  if(item?.cause==='network_policy'&&item.action==='')return null;
  if((item?.key==='readiness_requirement'||item?.key==='docker_running')&&item.action==='Check again')return <ReadinessCheck api={api} refresh={refresh} kind={kind}>Check again</ReadinessCheck>;
  if(item?.cause==='network_policy' && item.status==='blocked')return <ReadinessCheck api={api} refresh={refresh} kind={kind}>Retry network setup</ReadinessCheck>;
  if(item?.key==='circle'&&item.action==='Check again')return <ReadinessCheck api={api} refresh={refresh} kind={kind}>Check again</ReadinessCheck>;
  if (!item?.action) return null;
  if(item.action==='Check agents')return <Action className={'btn btn-sm btn-'+kind} run={()=>mutate('agents/refresh',{agents:agentSectionsVM(agents).shown.map(agent=>agent.id)})} success={checked(agentSectionsVM(agents).shown.map(agent=>agent.id))}>Check agents</Action>;
  if(item.agent && item.action.startsWith('Check '))return <Action className={'btn btn-sm btn-'+kind} run={()=>mutate('agents/refresh',{agents:[item.agent]})} success={checked([item.agent])}>{item.action}</Action>;
  if (item.key === 'docker_signin' && item.status === 'unknown') return <ReadinessCheck api={api} refresh={refresh} kind={kind}>Check again</ReadinessCheck>;
  if (item.key === 'docker_signin') return <div class={('legacy blocker-signin ' + kind) + ' ph-no-capture'} data-telemetry-private="blockers"><SignIn api={api} target="docker" refresh={refresh} /></div>;
  if (item.key === 'lending')
    return <Action className={'btn btn-sm btn-' + kind} run={() => mutate('lending/' + (item.action === 'Resume now' || latched ? 'resume' : 'on'), { circle })}
      success="Lending is on. Your approval mode and limits apply.">{item.action}</Action>;
  if (item.agent && (item.action.startsWith('Sign in to ') || item.action === 'Sign in')) {
    const agent = agents.find((a) => a.id === item.agent);
    if (agent?.signInSupported) return <div class={('legacy blocker-signin ' + kind) + ' ph-no-capture'} data-telemetry-private="blockers"><SignIn api={api} target={agent.id} agentName={item.label} refresh={refresh} /></div>;
  }
  // On Lending the agent list is on the page, so the button moves to it and links nowhere.
  if (item.key === 'agent' && !item.agent && surface === 'lend')
    return <Button class="ph-no-capture" kind={kind} size="sm" onClick={() => focusAgentList()} data-telemetry-private="blockers">{item.action}</Button>;
  if (item.key === 'agent' && !item.agent)
    return <Button class="ph-no-capture" kind={kind} size="sm" href="#/lend" onClick={(event) => { if (focusAgentList()) event.preventDefault(); }} data-telemetry-private="blockers">{item.action}</Button>;
  // On Lending the install steps are on the page: the button opens them and links nowhere.
  if (item.key === 'agent' && item.agent && item.action.startsWith('Install') && surface === 'lend')
    return <Button class="ph-no-capture" kind={kind} size="sm" onClick={() => openAgentInstall(item.agent)} data-telemetry-private="blockers">{item.action}</Button>;
  // Install and start controls live on the Setup and Lending pages.
  const href = item.key === 'agent' && item.action.startsWith('Install') ? '#/lend' : '#/setup';
  return <Button class="ph-no-capture" kind={kind} size="sm" href={href} onClick={(event) => { if (item.agent && href === '#/lend' && openAgentInstall(item.agent)) event.preventDefault(); }} data-telemetry-private="blockers">{item.action}</Button>;
}

const ICON = { ok: 'check-circle', blocked: 'alert', waits: 'clock', unknown: 'clock' };
const STATE = { ok: 'Done', blocked: 'Needs you', waits: 'Waiting', unknown: 'Checking' };

// Read only: what could be freed in Docker while a job waits for disk space.
export function DiskHelp({disk}) {
  const help = diskHelpVM(disk);
  if (!help) return null;
  return <div class="disk-help stack-2 ph-no-capture" data-disk-help data-telemetry-private="blockers">
    {help.docker && <>
      <p class="t-sm t-2">{help.docker.heading}</p>
      {help.docker.items.map(item => <div key={item.command} class="disk-help-item"><span class="t-sm">{item.label} · {item.size}</span><Command text={item.command} /></div>)}
      <p class="t-xs t-2">To see everything Docker keeps: <code>{help.docker.listCommand}</code></p>
    </>}
    {help.faravan && <p class="t-sm t-2">{help.faravan.heading} {help.faravan.names.join(', ')}.</p>}
  </div>;
}

export function StepRow({item, children, action}) {
  return <li class="ph-no-capture" data-blocker={item.key + (item.agent ? ':' + item.agent : '')} data-state={item.status} data-telemetry-private="blockers">
    <div class="row">
      <span class={'av st-' + item.status} aria-hidden="true">{item.status === 'unknown' ? <Spinner /> : <Icon name={ICON[item.status]} size="sm" />}</span>
      <div class="row-main"><div class="row-title">{item.label}<span class="sr"> · {STATE[item.status]}</span></div><div class="row-meta">{item.detail}</div>{item.disk && <DiskHelp disk={item.disk} />}{children}</div>
      {action && <div class="row-end">{action}</div>}
    </div>
  </li>;
}

export function BlockerList({model, suppressAction = null, primary = true, ...ctx}) {
  const rows = model.items.filter(item => item.status !== 'off');
  const first = model.needsYou[0];
  return <section class="ph-no-capture" aria-labelledby="needs-h" data-telemetry-private="blockers">
    <div class="section-h"><h2 id="needs-h">What lending needs, in order</h2></div>
    <Card><ul class="list blockers">{rows.map((item, i) => <StepRow key={item.key + (item.agent ?? '') + i} item={item}
      action={item.action && item !== suppressAction &&
        !(suppressAction?.action === 'Check agents' && item.agent && item.action?.startsWith('Check ')) && item.key !== 'lending' &&
        <BlockerAction item={item} primary={primary && item === first} {...ctx} byAgent={model.byAgent ?? Object.fromEntries(model.items.filter(row=>row.agent).map(row=>[row.agent,row]))} />} />)}</ul></Card>
    <p class="t-xs t-2 blocker-help">Start with the first step that needs you. After fixing it, check readiness again.</p>
  </section>;
}
