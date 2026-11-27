// Tests for src/blockers.mjs, the one "what blocks lending" model (EXPERIENCE §1.21).
// Usage: node blockers.test.mjs (exit 1 on failure). U3c ports it with the module.
import { lendingBlockers, trayLines } from './blockers.mjs';
let fails = [], n = 0;
const allGoodRows = (m) => m.items.filter((x) => x.label === 'Docker Sandboxes').length;
const ok = (label, cond) => { n++; if (!cond) fails.push(label); };
const agents = [{id: 'claude', name: 'Claude Code', enabled: true, installed: true, signedIn: true}, {id: 'codex', name: 'Codex', enabled: true, installed: true, signedIn: true}];
const good = {docker: {installed: true, running: true, signedIn: true, account: 'ana-r'},intent: {on: true},agents};

// The live defect: Docker sign-in expired. Root cause first; never "safety"; both agents listed and waiting.
const live = lendingBlockers({...good,docker: {installed: true, running: true, signedIn: false, expiredAt: '1:52 PM'}});
ok('live: headline names Docker', live.headline === 'Lending stopped: your Docker sign-in expired');
ok('live: no safety wording', !/safety/i.test(live.headline));
ok('live: both agents listed in order', live.items.filter((x) => x.key === 'agent').map((x) => x.agent).join() === 'claude,codex');
ok('live: agents wait for Docker sign-in', live.items.filter((x) => x.key === 'agent').every((x) => x.status === 'waits' && /Docker sign-in/.test(x.detail)));
ok('live: the one fix is Sign in to Docker', live.needsYou.length === 1 && live.needsYou[0].action === 'Sign in to Docker');

// The safety test is blamed only when it ran on a working Docker and failed.
const safety = lendingBlockers({...good,isolationFailure:'The sandbox could reach your home network. Resume lending after checking Docker Sandboxes.'});
ok('safety: headline', safety.headline === 'Lending paused: sandbox isolation check failed');
ok('safety: agents wait for the test', safety.items.filter((x) => x.key === 'agent').every((x) => x.status === 'waits'));

// Docker order: not installed hides running; not running makes sign-in wait.
const notRunning = lendingBlockers({...good, docker: {installed: true, running: false, signedIn: true}});
ok('order: not running first', notRunning.first.key === 'docker_running');
ok('order: one Docker Sandboxes row when stopped', notRunning.items.filter((x) => x.label === 'Docker Sandboxes').length === 1);
ok('order: sign-in waits for running', notRunning.items.find((x) => x.key === 'docker_signin').status === 'waits');
const notInstalled = lendingBlockers({...good, docker: {installed: false}});
ok('order: not installed', notInstalled.first.key === 'docker_installed' && !notInstalled.items.some((x) => x.key === 'docker_running'));

// Lending off comes after Docker; agents still show their own state.
const off = lendingBlockers({...good, intent: {on: false}, agents: [agents[0], {...agents[1], signedIn: false}]});
ok('off: headline', off.headline === 'Lending is off');
ok('off: Codex signed out still shown', off.items.find((x) => x.agent === 'codex').detail === 'Signed out.');
ok('off before agents', off.items.findIndex((x) => x.key === 'lending') < off.items.findIndex((x) => x.key === 'agent'));

// One signed-out agent with another ready: lending is on, the signed-out one is listed and needs you.
const partial = lendingBlockers({...good, agents: [{...agents[0], signedIn: false}, agents[1]]});
ok('partial: lending is on', partial.headline === 'Lending is on' && partial.canLend);
ok('partial: Claude needs you', partial.needsYou.some((x) => x.action === 'Sign in to Claude Code'));
const allOut = lendingBlockers({...good, agents: agents.map((a) => ({...a, signedIn: false}))});
ok('all agents out: stopped', allOut.headline === 'Lending stopped: Claude Code is signed out' && !allOut.canLend);
const none = lendingBlockers({...good, agents: agents.map((a) => ({...a, enabled: false}))});
ok('no agent lent', none.headline === 'Choose an agent to lend');
const allGood = lendingBlockers(good);
ok('all good', allGood.headline === 'Lending is on' && allGood.canLend && !allGood.needsYou.length);
const unknownAgent = lendingBlockers({...good, agents: [{id:'claude', name:'Claude Code', enabled:true, installed:null, signedIn:null}]});
ok('unknown agent facts cannot lend', unknownAgent.headline === 'Checking this computer…' && !unknownAgent.canLend);
const noSelectedAgent = lendingBlockers({...good, agents: []});
ok('no selected agent cannot lend', !noSelectedAgent.canLend);
const missingId = lendingBlockers({...good, agents: [{}]});
ok('agent with missing id cannot borrow readiness from unrelated rows', !missingId.canLend);
const duplicateIds = lendingBlockers({...good, agents: [agents[0], {...agents[0], installed: null, signedIn: null}]});
ok('duplicate agent ids are ambiguous and cannot lend', !duplicateIds.canLend);
const allDisabled = lendingBlockers({...good, agents: agents.map((a) => ({...a, enabled: false}))});
ok('all disabled agents cannot lend', !allDisabled.canLend);
const namedUnknownAgent = lendingBlockers({...good, agents: [{id: 'missing', name: 'Unknown agent', enabled: true, installed: null, signedIn: null}]});
ok('named unknown agent cannot lend', !namedUnknownAgent.canLend);
const oneReadyAgent = lendingBlockers({...good, agents: [agents[0]]});
ok('one ready uniquely identified agent can lend', oneReadyAgent.canLend);
const unknownEnabledAgent = lendingBlockers({...good, agents: [{id: 'claude', name: 'Claude Code', installed: true, signedIn: true}]});
ok('unknown enabled flag cannot lend', unknownEnabledAgent.items.some((x) => x.agent === 'claude' && x.status === 'unknown') && !unknownEnabledAgent.canLend);
const nullAgent = lendingBlockers({...good, agents: [null]});
ok('null agent does not crash or enable lending', !nullAgent.canLend);
const unknownDockerAgent = lendingBlockers({...good, docker: {installed: true, running: null, signedIn: true}});
ok('agent waits for unknown Docker state', unknownDockerAgent.items.find((x) => x.key === 'agent')?.status === 'waits');
const unreachable = lendingBlockers({...good, circle: {name: 'Weekend projects', reachable: false, host: 'Ana’s MacBook', lastReached: '6:10 PM'}});
ok('host unreachable', unreachable.headline === 'Lending waits: can’t reach Ana’s MacBook' && !unreachable.canLend);
ok('host unreachable: offers a real recheck', unreachable.needsYou.some((x) => x.key === 'circle' && x.action === 'Check again'));
for (const reachable of [null, undefined]) {
  const unknownCircle = lendingBlockers({...good, circle: {name: 'Weekend projects', reachable}});
  ok(`host reachability ${reachable}: unknown blocks lending`, unknownCircle.items.some((x) => x.key === 'circle' && x.status === 'unknown') && !unknownCircle.canLend);
}
const oldHost = lendingBlockers({...good, circle: {name: 'Weekend projects', reachable: true, host: 'Ana’s MacBook', owner: 'Ana', hostVersion: '0.11.2', needVersion: '0.12.0'}});
ok('host too old', oldHost.headline === 'Lending waits: Weekend projects needs an update' && /Ask Ana to update/.test(oldHost.first.detail));
ok('docker before host', lendingBlockers({...good, docker: {installed: true, running: false}, circle: {reachable: false}}).first.key === 'docker_running');
ok('one row for installed and running', allGoodRows(lendingBlockers(good)) === 1);
// A blocker never turns lending off: the model has no output that changes intent.
ok('no intent output', !('intent' in lendingBlockers({...good, docker: {installed: true, running: true, signedIn: false}})));

// Totality: unknown facts never become "ok", never throw, never print placeholders.
const vals = [undefined, null, true, false];
for (const installed of vals) for (const running of vals) for (const signedIn of vals) for (const st of [undefined, 'passed', 'failed', 'running', 'not_run', 'weird'])
  for (const on of vals) for (const ag of [undefined, [], [{}], agents, [{id: 'x', enabled: true, installed: null, signedIn: null}]]) {
    let m; n++;
    try { m = lendingBlockers({docker: {installed, running, signedIn},intent: {on},agents: ag}); } catch (e) { fails.push('threw ' + e.message); continue; }
    const text = [m.headline, ...m.items.map((x) => x.label + ' ' + x.detail), ...trayLines(m).map((l) => l[0])].join(' | ');
    if (/undefined|\bnull\b|NaN/.test(text)) fails.push('placeholder: ' + text);
    if (m.canLend && (installed !== true || running !== true || signedIn !== true || on !== true)) fails.push('can lend on unknown facts: ' + JSON.stringify({installed, running, signedIn, st, on}));
  }
console.log(`${n - fails.length}/${n} checks pass`);
if (fails.length) { console.log([...new Set(fails)].slice(0, 15).join('\n')); process.exit(1); }
