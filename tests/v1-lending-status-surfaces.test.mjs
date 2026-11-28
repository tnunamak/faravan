import './helpers/no-browser.mjs';
// One lending answer. The app reads GET /api/status, `faravan status` prints it and the MCP status_get tool returns it.
// For the same computer in the same state, all of them say whether lending is ready, waiting, running or off, why, and
// what to do next, in the same words. A lender who reads two surfaces never gets two stories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';
import { lendPageVM } from '../ui/v1/src/view-models.mjs';

const BIN = fileURLToPath(new URL('../bin/faravan', import.meta.url));
const env = home => ({...process.env, FARAVAN_HOME:home, FARAVAN_NO_AUTOSTART:'1', FARAVAN_NO_BROWSER:'1'});

async function run(home, args) {
  const child = spawn(process.execPath, [BIN, ...args], {env:env(home), stdio:['ignore','pipe','pipe']});
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const [code] = await once(child, 'close');
  return {code, stdout, stderr};
}
async function mcpStatus(t, home) {
  const child = spawn(process.execPath, [BIN, 'mcp', '--root', home], {env:env(home), stdio:['pipe','pipe','pipe']});
  t.after(() => { child.stdin.end(); child.kill(); });
  const waiting = new Map(); let buffer = '', id = 0;
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let n; (n = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, n)); buffer = buffer.slice(n + 1);
      waiting.get(message.id)?.(message); waiting.delete(message.id);
    }
  });
  const write = value => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params = {}) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); write({jsonrpc:'2.0', id:n, method, params}); });
  await request('initialize', {protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name:'status-test', version:'1'}});
  write({jsonrpc:'2.0', method:'notifications/initialized'});
  const {result} = await request('tools/call', {name:'status_get', arguments:{}});
  return result.structuredContent;
}

async function everySurface(t, lender) {
  const status = await api(lender.app, '/api/status');
  const cliJson = JSON.parse((await run(lender.home, ['status', '--json'])).stdout);
  const cliText = (await run(lender.home, ['status'])).stdout;
  const mcp = await mcpStatus(t, lender.home);
  return {status, cliJson, cliText, mcp};
}

test('app, CLI and MCP give one lending answer: off', {timeout:120000}, async t => {
  const f = await appFixture(t);
  const {lender} = await f.connect();
  const {status, cliJson, cliText, mcp} = await everySurface(t, lender);
  const summary = status.summary;
  assert.equal(summary.phase, 'off');
  assert.equal(summary.headline, 'Lending is off');
  assert.equal(summary.action?.op, 'lending.on', 'off says what to do');
  assert.deepEqual(mcp.summary, summary, 'MCP status_get is the app answer');
  assert.deepEqual(cliJson.lending.summary, summary, 'faravan status --json is the app answer');
  assert.match(cliText, new RegExp('^Lending:\\s+' + summary.headline + '$', 'm'));
  assert.ok(cliText.includes(summary.reason), 'the CLI says why');
  // The app page builds its headline and reason from the same shared formatter.
  const page = lendPageVM(status, {agents:[], readiness:{ready:true, checks:[]}});
  assert.equal(page.headline, summary.headline);
  assert.equal(page.reason, summary.reason);
});

test('app, CLI and MCP give one lending answer: on but waiting for lending hours', {timeout:120000}, async t => {
  const f = await appFixture(t);
  const {lender, circle} = await f.connect();
  // A window that is never open now: the only allowed day is not today in this zone.
  const zone = 'America/New_York';
  const today = new Date().toLocaleString('en-US', {timeZone:zone, weekday:'short'});
  const day = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(today);
  await api(lender.app, '/api/lending/limits', {method:'POST', body:{timeZone:zone, schedule:{days:[(day + 3) % 7], from:'09:00', to:'10:00', weekends_all_day:false}}});
  await api(lender.app, '/api/agents/codex', {method:'POST', body:{useForLending:true}});
  await api(lender.app, '/api/lending/on', {method:'POST', body:{circle:circle.id}});
  await waitFor(async () => (await api(lender.app, '/api/status')).intent?.state === 'outside', 'outside lending hours');
  const {status, cliJson, cliText, mcp} = await everySurface(t, lender);
  const summary = status.summary;
  assert.equal(status.intent.on, true, 'lending is switched on');
  assert.equal(summary.phase, 'waiting', 'switched on but no job can start: waiting, never "Lending is on"');
  assert.equal(summary.headline, 'Outside lending hours');
  assert.match(summary.reason, /Lending starts at /, 'waiting says why, and until when');
  assert.deepEqual(mcp.summary, summary);
  assert.deepEqual(cliJson.lending.summary, summary);
  assert.match(cliText, new RegExp('^Lending:\\s+' + summary.headline + '$', 'm'));
  assert.ok(cliText.includes(summary.reason));
  const page = lendPageVM(status, {agents:[], readiness:{ready:true, checks:[]}});
  assert.equal(page.headline, summary.headline);
  assert.equal(page.reason, summary.reason);
});

// Unit check on a hand-built projection only: no real job runs here, so this is not a cross-surface proof of a running job.
test('a running projection reads as running in the shared summary (projection unit, no app run)', async () => {
  const {lendingSummary} = await import('../lib/v1/lending-summary.mjs');
  const projection = {schemaVersion:2, kind:'lending', intent:'off', admission:'blocked', admissionReason:'lending_off', execution:'running',
    executionJob:'attempt-1', evidence:{dailyLimitReached:false, intentState:null, executionState:'running'}, version:null};
  const summary = lendingSummary(projection, {person:'Ana'});
  assert.equal(summary.phase, 'running');
  assert.equal(summary.headline, 'Running Ana’s job');
});

test('a fresh install never says lending is on before the person chose it, on every surface', {timeout:120000}, async t => {
  // A real first start (not the fixtures' Off): nothing is joined, no agent is chosen, lending was never turned on.
  const f = await appFixture(t, {freshLending:'automatic'});
  const lender = await f.start('lender');
  const {status, cliJson, cliText, mcp} = await everySurface(t, lender);
  const summary = status.summary;
  assert.notEqual(summary.phase, 'ready');
  assert.notEqual(summary.phase, 'running');
  for (const text of [summary.headline, summary.label, summary.reason, cliJson.lending.status, cliText.split('\n').find(line => line.startsWith('Lending:'))])
    assert.doesNotMatch(text, /lending (is )?on\b/i, 'no surface claims lending is on: ' + text);
  assert.doesNotMatch(cliText, /finish setup before jobs can start/);
  assert.ok(summary.reason.length > 0, 'it says why');
  assert.deepEqual(mcp.summary, summary);
  assert.deepEqual(cliJson.lending.summary, summary);
  assert.match(cliText, new RegExp('^Lending:\\s+' + summary.headline + '$', 'm'));
  assert.ok(cliText.includes(summary.reason), 'the CLI says the same why');
  const page = lendPageVM(status, {agents:[], readiness:{ready:true, checks:[]}});
  assert.equal(page.headline, summary.headline);
  assert.equal(page.reason, summary.reason);
});

// Shared-summary unit checks: each case is one projection, so every surface that calls lendingSummary agrees by construction.
const projectionOf = (admissionReason, over = {}) => ({schemaVersion:2, kind:'lending', intent:'on', admission:'blocked', admissionReason,
  execution:'idle', executionJob:null, evidence:{dailyLimitReached:admissionReason === 'daily_limit', intentState:'blocked', executionState:'idle'}, version:null, ...over});

test('an automatic wait says why and offers no action, on every surface', async () => {
  const {lendingSummary} = await import('../lib/v1/lending-summary.mjs');
  // The summary reads the projection's closed reason list (createLendingProjection translates the retired private causes first).
  for (const admissionReason of ['owner_active', 'readiness_changed', 'daily_limit', 'no_spare']) {
    const summary = lendingSummary(projectionOf(admissionReason));
    assert.equal(summary.action, null, admissionReason + ' clears by itself');
    assert.ok(summary.reason.length > 0, admissionReason + ' says why');
  }
});

test('a held selected account is the same answer on every surface', async () => {
  const {lendingSummary} = await import('../lib/v1/lending-summary.mjs');
  const projection = {...projectionOf(null), admission:'allowed', evidence:{dailyLimitReached:false, intentState:'ready', executionState:'idle'}};
  const accounts = [{provider:'codex', decision:{admitted:false, reason:'held_for_test',
    status:{id:'held_for_test', line:'Codex is holding your allowance for you.', recovery:{who:'automatic'}}}}];
  const summary = lendingSummary(projection, {lendingAccounts:accounts, selectedAgents:['codex']});
  assert.equal(summary.phase, 'waiting', 'a held account is a wait, not ready');
  assert.equal(summary.reason, 'Codex is holding your allowance for you.', 'the reason is the account reason');
  assert.equal(summary.action, null, 'an automatic hold needs nothing from the lender');
  // The app page reads the same summary, so its headline and reason cannot differ from the CLI and MCP.
  const page = lendPageVM({lendingProjection:projection, summary, lendingPolicy:{accounts}}, {agents:[]});
  assert.equal(page.headline, summary.headline);
  assert.equal(page.reason, summary.reason);
});

test('a held account does not turn a ready sibling into a machine-wide alert', async () => {
  const {lendingSummary} = await import('../lib/v1/lending-summary.mjs');
  const projection = projectionOf(null, {
    admission:'allowed', evidence:{dailyLimitReached:false, intentState:'ready', executionState:'idle'},
  });
  const claude = {provider:'claude', decision:{availability:{admitted:false, reason:'held_for_test',
    status:{line:'Claude Code’s job check is waiting.', recovery:{who:'owner'}}}}};
  const codex = {provider:'codex', decision:{availability:{admitted:true}}};
  const selectedAgents = ['claude-code-subscription','codex'];
  const ready = lendingSummary(projection, {selectedAgents,lendingAccounts:[claude,codex]});
  assert.equal(ready.headline, 'Ready for requests');
  assert.equal(ready.action, null);
  assert.doesNotMatch(ready.reason, /Claude Code/);
  const waiting = lendingSummary(projection, {selectedAgents,lendingAccounts:[claude]});
  assert.equal(waiting.headline, 'Check lending accounts');
  assert.equal(waiting.reason, 'Claude Code’s job check is waiting.');
});
