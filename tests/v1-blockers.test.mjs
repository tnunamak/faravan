import './helpers/no-browser.mjs';
// Tests for src/blockers.mjs, the one "what blocks lending" model (EXPERIENCE §1.21).
// Usage: node blockers.test.mjs (exit 1 on failure). U3c ports it with the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { lendingBlockers, trayLines } from '../lib/v1/blockers.mjs';
let fails = [], n = 0;
// The designer's table, unchanged below this line, runs as one test.
test('the ordered blockers model passes the designer\'s table (mockups/blockers.test.mjs)', () => {
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

// An old qualification failure is no longer a computer-wide latch.
const safety = lendingBlockers({...good,isolationFailure:'The sandbox could reach your home network. Resume lending after checking Docker Sandboxes.'});
ok('retired qualification: can lend', safety.canLend && safety.headline === 'Lending is on');
ok('retired qualification: agents stay ready', safety.items.filter((x) => x.key === 'agent').every((x) => x.status === 'ok'));

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
const unreachable = lendingBlockers({...good, circle: {name: 'Weekend projects', reachable: false, host: 'Ana’s MacBook', lastReached: '6:10 PM'}});
ok('host unreachable', unreachable.headline === 'Lending waits: can’t reach Ana’s MacBook' && !unreachable.canLend);
ok('host unreachable: carries who hosts it for clients that name them', unreachable.first.hostName === 'Ana’s MacBook' && unreachable.first.label === 'Weekend projects');
ok('host unreachable: no fix button', !unreachable.needsYou.some((x) => x.key === 'circle'));
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
assert.deepEqual([...new Set(fails)].slice(0, 15), [], `${n - fails.length}/${n} checks pass`);
});

test('unknown agent sign-in or installation never reports lending ready', () => {
  const ready = {id:'codex', name:'Codex', enabled:true, installed:true, signedIn:true};
  const good = {docker:{installed:true, running:true, signedIn:true},intent:{on:true}};
  for (const unknown of [{signedIn:null}, {installed:null}]) {
    for (const agents of [[{...ready, ...unknown}], [{...ready, ...unknown}, {...ready, id:'claude'}]]) {
      const model = lendingBlockers({...good, agents});
      assert.equal(model.headline, 'Checking this computer…');
      assert.equal(model.canLend, false);
      assert.ok(model.items.some(item => item.key === 'agent' && item.status === 'unknown'));
    }
  }
  const partial = lendingBlockers({...good, agents:[{...ready, signedIn:false}, {...ready, id:'claude'}]});
  assert.equal(partial.canLend, true, 'a known signed-out agent does not block another ready agent');
});
import {readFileSync} from 'node:fs';

test('Docker expiry and circle last-seen retain the calendar date across days', () => {
  // Exercise the actual formatter expressions without starting the app.
  const source = readFileSync(new URL('../lib/v1/app.mjs', import.meta.url), 'utf8');
  const inputs = source.split('async function circleState() {')[1].split('// Synchronous, for the lender')[0];
  const circleExpression = inputs.match(/const fmt=ms=>([^;\n]+);/)?.[1];
  const expiryExpression = inputs.match(/(new Intl\.DateTimeFormat\([^\n]+\)\.format\(dockerOutSince\))/)?.[1];
  assert.ok(circleExpression);
  assert.ok(expiryExpression);
  const formatters = [
    new Function('ms', 'return ' + circleExpression),
    new Function('dockerOutSince', 'return ' + expiryExpression),
  ];
  const first = Date.UTC(2026, 9, 28, 12, 0);
  const second = first + 24 * 60 * 60 * 1000;
  for (const format of formatters) {
    assert.notEqual(format(first), format(second), 'same clock time on different days must be distinguishable');
    assert.match(format(first), /2026/);
  }
  const expiry = formatters[1](first), lastReached = formatters[0](first);
  const model = lendingBlockers({
    docker:{installed:true,running:true,signedIn:false,expiredAt:expiry},
    circle:{reachable:false,lastReached},
  });
  assert.equal(model.items.find(row => row.key === 'docker_signin').detail, 'Expired at ' + expiry + '.');
  assert.ok(model.items.find(row => row.key === 'circle').detail.includes('Last reached ' + lastReached + '.'));
});

test('Linux preview README documents archive contents, data home and active-unit reuse', () => {
  const readme = readFileSync(new URL('../packaging/README.md', import.meta.url), 'utf8');
  const preview = readme.split('### Isolated Linux preview')[1].split('## Channel command ownership')[0];
  assert.match(preview, /contains usr\/ and MIGRATION\.md/);
  assert.match(preview, /FARAVAN_DATA_HOME=<data-home>\/Faravan Preview LABEL/);
  assert.match(preview, /explicitly removes FARAVAN_HOME and FARAVAN_HOME/);
  assert.doesNotMatch(preview, /FARAVAN_HOME=\$root\/state/);
  assert.match(preview, /reuses already-active units/);
  assert.match(preview, /does not compare their version with the extracted files or stop an older process/);
  assert.match(preview, /bundle path and the build identity/);
});

import {createLender} from '../lib/v1/lender.mjs';
import {lenderFixture,until} from './helpers/v1-lender-fixture.mjs';

for(const kind of ['offers','claim'])test('repeated '+kind+' refusals block the circle until a successful poll',async t=>{
  const f=await lenderFixture(t,{offers:kind==='offers'}),stop=new AbortController();
  let calls=0,refusing=true,rateLimited=false;
  const read=()=>{calls++;if(refusing)throw Object.assign(new Error('busy'),{code:'rate_limited',status:429,retryable:true,outcome:'not_applied'});return null;};
  if(kind==='offers'){
    f.client.capabilities=async()=>({capabilities:['offers_v1','run_request_v1']});
    f.client.listOffers=async function*(){read();};
  }else f.client.claimNext=async()=>read();
  const lender=createLender({...f.runOptions,client:f.client,backend:f.backend,policy:f.policy,adapters:f.adapters,clock:f.clock,
    approve:async()=>true,onPoll:state=>{rateLimited=state.rateLimited;},onEvent:e=>f.events.push(e)});
  const loop=lender.start(stop.signal);f.stop=async()=>{stop.abort();await loop;};
  const model=()=>lendingBlockers({docker:{installed:true,running:true,signedIn:true},intent:{on:true},
    agents:[{id:'ready',enabled:true,installed:true,signedIn:true}],circle:{reachable:true,rateLimited}});
  await until(()=>calls===1&&f.clock.pending().includes(1000),'first refused poll',5000);
  f.clock.advance(1000);
  await until(()=>calls===2&&f.clock.pending().includes(2000),'repeated refused poll',5000);
  assert.notEqual(model().headline,'Lending is on');
  assert.equal(model().items.find(row=>row.key==='circle')?.status,'blocked');
  assert.match(model().items.find(row=>row.key==='circle').detail,/turning away.*keeps trying/);
  refusing=false;f.clock.advance(2000);
  await until(()=>calls===3&&f.clock.pending().includes(1000),'successful empty poll',5000);
  assert.equal(model().headline,'Lending is on');
  assert.equal(model().items.some(row=>row.key==='circle'&&row.status==='blocked'),false);
  await f.stop();
});

test('stopped automatic checks name the failed sandbox before agent sign-in', () => {
  const model=lendingBlockers({docker:{installed:true,running:true,signedIn:true},intent:{on:true},agents:[
    {id:'claude',name:'Claude Code',enabled:true,installed:true,signedIn:null,automaticChecksStopped:true,workspaceCause:'unknown'},
    {id:'codex',name:'Codex',enabled:true,installed:true,signedIn:null,automaticChecksStopped:true,workspaceCause:'unknown'}]});
  assert.equal(model.first?.key,'agent');
  assert.equal(model.first.action,'Check agents');
  assert.equal(model.headline,'Lending stopped: agent checks failed');
  assert.equal(model.canLend,false);
  assert.ok(model.items.filter(x=>x.key==='agent').every(x=>x.status==='blocked'&&x.detail.includes('Automatic checks stopped')));
  assert.match(trayLines(model)[1][0],/Check agents/);
});

test('a failed lending start never hides a specific host answer, and names the host otherwise', () => {
  const agents = [{id: 'claude', name: 'Claude Code', enabled: true, installed: true, signedIn: true}];
  const good = {docker: {installed: true, running: true, signedIn: true}, intent: {on: false}, agents};
  const base = {name: 'Weekend projects', reachable: true, host: 'Ana’s MacBook', owner: 'Ana', startFailed: true};
  // Resume failed, then the host came back but runs an older Faravan: the upgrade is the fix, not waiting.
  const row = (m) => m.items.find((x) => x.key === 'circle');
  const old = row(lendingBlockers({...good, circle: {...base, hostVersion: '0.11.2', needVersion: '0.12.0'}}));
  assert.equal(old.headline, 'Lending waits: Weekend projects needs an update');
  assert.match(old.detail, /Ask Ana to update/);
  const busy = row(lendingBlockers({...good, circle: {...base, rateLimited: true}}));
  assert.equal(busy.headline, 'Lending waits: the circle’s host is busy');
  const plain = row(lendingBlockers({...good, circle: base}));
  assert.equal(plain.headline, 'Lending waits: reconnecting to Ana’s MacBook');
  assert.equal(plain.hostName, 'Ana’s MacBook');
});
