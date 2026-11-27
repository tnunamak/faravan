import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GUARD_SOURCE_PATH, guardRunCommand, guardStopCommand, parseGuardLine, validateStopRecord } from '../lib/faravan-guard-host.mjs';

const FIXTURES = fileURLToPath(new URL('./fixtures/guard/', import.meta.url));

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'faravan-guard-test-'));
  const work = path.join(dir, 'work');
  const home = path.join(dir, 'home');
  await mkdir(work); await mkdir(home);
  return { dir, work, home, ctl: path.join(dir, 'ctl'), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function config(ctl, overrides = {}) {
  return { v: 1, mode: 'claude', ctl, nonce: 'a'.repeat(32), soft_deadline_s: null, heartbeat_ms: 50,
    sigint_grace_ms: 2000, sigterm_grace_ms: 1000, budget: null, ...overrides };
}

/** Runs the guard command exactly as the backend would ask the guest shell to. */
function runGuard(command, { cwd, env = {} } = {}) {
  const home = env.HOME || (cwd ? path.join(path.dirname(cwd), 'home') : process.env.HOME);
  const isolated = {HOME:home, FARAVAN_HOME:path.join(home,'.faravan'), CODEX_HOME:path.join(home,'.codex'), CLAUDE_CONFIG_DIR:path.join(home,'.claude')};
  const child = spawn('sh', ['-c', command], { cwd, env: { ...process.env, ...isolated, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve) => child.once('close', (code) => resolve({ code, stdout, stderr })));
  return { child, done, stderrSoFar: () => stderr };
}

const agent = (name) => `node ${FIXTURES}${name}`;
const faravanLines = (stderr) => stderr.split('\n').map(parseGuardLine).filter(Boolean);
async function until(check, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error('condition not reached');
}
async function waitForFileSignal(file, timeoutMs = 10000) {
  if (existsSync(file)) return;
  const controller = new AbortController();
  let watcher, timeout;
  try {
    await new Promise((resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out waiting for file signal: ${file}`));
      }, timeoutMs);
      watcher = watch(path.dirname(file), {signal:controller.signal}, (_event, name) => {
        if (name?.toString() === path.basename(file) && existsSync(file)) resolve();
      });
      watcher.once('error', reject);
      if (existsSync(file)) resolve();
    });
  } finally {
    clearTimeout(timeout);
    controller.abort();
    watcher?.close();
  }
}
async function stopRecord(ctl) { return validateStopRecord(await readFile(path.join(ctl, 'stop.json'), 'utf8'), { nonce: 'a'.repeat(32) }); }

test('claude run to completion: exit 0, no stop record, heartbeats and a meter reading, rate_limit_event kept off stdout', async () => {
  const s = await scratch();
  try {
    const run = runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl), agentCommand: agent('fake-claude.mjs') }),
      { cwd: s.work, env: { FAKE_MODE: 'finish' } });
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!existsSync(path.join(s.ctl, 'stop.json')));
    assert.doesNotMatch(result.stdout, /rate_limit_event/, 'the lender\'s allowance never enters the borrower-visible transcript');
    assert.match(result.stdout, /"type":"result"/);
    const lines = faravanLines(result.stderr);
    assert.ok(lines.some((entry) => entry.type === 'heartbeat'));
    const meter = lines.filter((entry) => entry.type === 'meter');
    const windows = meter.flatMap((entry) => entry.windows);
    assert.deepEqual(windows.find((w) => w.window_id === 'five_hour'), { window_id: 'five_hour', window_minutes: 300, used_pct: 24, resets_at: '2026-10-20T16:20:00.000Z' });
    assert.equal(windows.find((w) => w.window_id === 'seven_day').used_pct, 37);
    const last = meter.at(-1);
    assert.equal(last.source, 'claude-stream');
    assert.equal(last.cost_usd, 0.01);
    assert.equal(last.tokens.output, 9, 'repeated usage for one message id is counted once');
  } finally { await s.cleanup(); }
});

test('claude native budget stop: guard writes stop_reason budget and exits 0 so the work is collected', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { budget: { unit: 'claude_usd', limit: 0.05 } }), agentCommand: agent('fake-claude.mjs') }),
      { cwd: s.work, env: { FAKE_MODE: 'budget' } }).done;
    assert.equal(result.code, 0, result.stderr);
    const record = await stopRecord(s.ctl);
    assert.equal(record.stop_reason, 'budget');
    assert.equal(record.agent_exit, 1);
    assert.equal(record.used_units, 0.051);
    assert.equal(record.budget_units, 0.05);
    assert.equal(await readFile(path.join(s.work, 'edit.txt'), 'utf8'), 'partial\n');
  } finally { await s.cleanup(); }
});

test('owner stop through the stop command: SIGINT reaches the agent, work stays, stop_reason owner', async () => {
  const s = await scratch();
  try {
    const run = runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl), agentCommand: agent('fake-claude.mjs') }),
      { cwd: s.work, env: { FAKE_MODE: 'hang' } });
    await until(() => existsSync(path.join(s.work, 'edit.txt')));
    const stop = await runGuard(guardStopCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, ctl: s.ctl, reason: 'owner' })).done;
    assert.equal(stop.code, 0, stop.stderr);
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(path.join(s.work, 'interrupted.txt'), 'utf8'), 'SIGINT\n');
    const record = await stopRecord(s.ctl);
    assert.equal(record.stop_reason, 'owner');
    assert.equal(record.signal, 'SIGINT');
  } finally { await s.cleanup(); }
});

test('an agent that ignores SIGINT gets SIGTERM on its process group after the grace', async () => {
  const s = await scratch();
  try {
    const run = runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { sigint_grace_ms: 200 }), agentCommand: agent('fake-claude.mjs') }),
      { cwd: s.work, env: { FAKE_MODE: 'ignore-sigint' } });
    await until(() => existsSync(path.join(s.work, 'edit.txt')));
    await runGuard(guardStopCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, ctl: s.ctl, reason: 'owner' })).done;
    const result = await run.done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(existsSync(path.join(s.work, 'terminated.txt')));
    const record = await stopRecord(s.ctl);
    assert.equal(record.stop_reason, 'owner');
    assert.equal(record.signal, 'SIGTERM');
  } finally { await s.cleanup(); }
});

test('soft deadline stops the agent with stop_reason time', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { soft_deadline_s: 1 }), agentCommand: agent('fake-claude.mjs') }),
      { cwd: s.work, env: { FAKE_MODE: 'hang' } }).done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await stopRecord(s.ctl)).stop_reason, 'time');
    assert.ok(existsSync(path.join(s.work, 'interrupted.txt')));
  } finally { await s.cleanup(); }
});

test('a rejected allowance reading stops the agent with stop_reason provider_limit', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl), agentCommand: agent('fake-claude.mjs') }),
      { cwd: s.work, env: { FAKE_MODE: 'rejected' } }).done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await stopRecord(s.ctl)).stop_reason, 'provider_limit');
    const meter = faravanLines(result.stderr).filter((entry) => entry.type === 'meter');
    assert.equal(meter[0].status, 'rejected');
  } finally { await s.cleanup(); }
});

test('codex: the guard tails the rollout, emits live meter lines and stops at the credit budget', async () => {
  const s = await scratch();
  try {
    // 400 uncached input, 600 cached, 100 output per step; weights in credits per token.
    const budget = { unit: 'codex_credits', limit: 3, weights: { input: 0.001, cached_input: 0.0001, output: 0.005 } };
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { mode: 'codex', budget }), agentCommand: agent('fake-codex.mjs') }),
      { cwd: s.work, env: { HOME: s.home, FAKE_MODE: 'run' } }).done;
    assert.equal(result.code, 0, result.stderr);
    const record = await stopRecord(s.ctl);
    assert.equal(record.stop_reason, 'budget');
    assert.ok(record.used_units >= 3, `used ${record.used_units}`);
    assert.equal(record.agent_exit, 1);
    assert.ok(existsSync(path.join(s.work, 'interrupted.txt')));
    const meter = faravanLines(result.stderr).filter((entry) => entry.type === 'meter');
    assert.ok(meter.length >= 2, 'readings arrive while the agent runs');
    assert.equal(meter[0].source, 'codex-rollout');
    assert.equal(meter[0].model, 'gpt-6-luna');
    assert.deepEqual(meter[0].windows, [{ window_id: 'codex:10080', window_minutes: 10080, used_pct: 33, resets_at: '2026-10-27T06:32:06.000Z' }]);
    assert.deepEqual(meter[0].tokens, { input: 1000, cached_input: 600, output: 100, reasoning_output: 40 });
    assert.ok(!JSON.stringify(meter).includes('balance'), 'credit balances and plan details stay out of the meter');
  } finally { await s.cleanup(); }
});

test('codex run to completion reports its final reading and exits 0 without a stop record', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { mode: 'codex' }), agentCommand: agent('fake-codex.mjs') }),
      { cwd: s.work, env: { HOME: s.home, FAKE_MODE: 'finish' } }).done;
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!existsSync(path.join(s.ctl, 'stop.json')));
    assert.ok(faravanLines(result.stderr).some((entry) => entry.type === 'meter' && entry.tokens.output === 100));
  } finally { await s.cleanup(); }
});

test('codex run that ends normally ends its meter with a final reading of the rollout total', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { mode: 'codex' }), agentCommand: agent('fake-codex.mjs') }),
      { cwd: s.work, env: { HOME: s.home, FAKE_MODE: 'finish' } }).done;
    assert.equal(result.code, 0, result.stderr);
    const meters = faravanLines(result.stderr).filter((entry) => entry.type === 'meter');
    assert.equal(meters.filter((entry) => entry.final).length, 1, 'exactly one final reading');
    const last = meters.at(-1);
    assert.equal(last.final, true, 'the last reading is the final one');
    assert.equal(last.source, 'codex-rollout');
    assert.deepEqual(last.tokens, { input: 1000, cached_input: 600, output: 100, reasoning_output: 40 });
    assert.deepEqual(last.windows, [{ window_id: 'codex:10080', window_minutes: 10080, used_pct: 33, resets_at: '2026-10-27T06:32:06.000Z' }]);
  } finally { await s.cleanup(); }
});

test('codex run that crashes after spending reports no final reading', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { mode: 'codex' }), agentCommand: agent('fake-codex.mjs') }),
      { cwd: s.work, env: { HOME: s.home, FAKE_MODE: 'crash' } }).done;
    assert.equal(result.code, 3, result.stderr);
    const meters = faravanLines(result.stderr).filter((entry) => entry.type === 'meter');
    assert.ok(meters.some((entry) => entry.used_units !== null || entry.tokens.input > 0), 'the rollout showed usage');
    assert.ok(!meters.some((entry) => entry.final), 'a crashed turn may be partial, so no reading claims completeness');
  } finally { await s.cleanup(); }
});

async function codexScript(s, name, body) {
  const script = path.join(s.dir, name);
  await writeFile(script, [
    "import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "const id = '0199a213-81c0-7800-8aa1-bbab2a035a53';",
    "const dir = join(process.env.CODEX_HOME, 'sessions');",
    "mkdirSync(dir, { recursive: true });",
    "const own = join(dir, 'rollout-2026-11-01T00-00-00-' + id + '.jsonl');",
    "const usage = (n) => appendFileSync(own, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000 * n, cached_input_tokens: 0, output_tokens: 100 * n, reasoning_output_tokens: 0 } }, rate_limits: null } }) + '\\n');",
    "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: id }) + '\\n');",
    ...body,
  ].join('\n'));
  return 'node ' + JSON.stringify(script);
}

async function codexMeters(s, agentCommand) {
  const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { mode: 'codex' }), agentCommand }),
    { cwd: s.work, env: { HOME: s.home } }).done;
  assert.equal(result.code, 0, result.stderr);
  return faravanLines(result.stderr).filter((entry) => entry.type === 'meter');
}

test('codex helper script with one rollout and a rising total ends final (control for the two cases below)', async () => {
  const s = await scratch();
  try {
    const meters = await codexMeters(s, await codexScript(s, 'one.mjs', ['usage(1);', 'usage(2);']));
    assert.equal(meters.at(-1).final, true);
    assert.equal(meters.at(-1).tokens.input, 2000);
  } finally { await s.cleanup(); }
});

test('codex run with a second rollout in the same CODEX_HOME reports no final reading', async () => {
  const s = await scratch();
  try {
    const meters = await codexMeters(s, await codexScript(s, 'two.mjs', ['usage(1);',
      "writeFileSync(join(dir, 'rollout-2026-11-01T00-00-01-0199a213-0000-0000-0000-000000000002.jsonl'), '');"]));
    assert.ok(meters.length >= 1);
    assert.ok(!meters.some((entry) => entry.final), 'one file may not hold the whole run, so no reading claims completeness');
  } finally { await s.cleanup(); }
});

test('codex run whose rollout total falls reports no final reading', async () => {
  const s = await scratch();
  try {
    const meters = await codexMeters(s, await codexScript(s, 'falls.mjs', ['usage(3);', 'usage(1);']));
    assert.ok(!meters.some((entry) => entry.final), 'a total that fell was rewritten, so no reading claims completeness');
  } finally { await s.cleanup(); }
});

test('codex run whose rollout has no token_count reports no final reading', async () => {
  const s = await scratch();
  try {
    const script = path.join(s.dir, 'no-usage.mjs');
    await writeFile(script, [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const dir = join(process.env.CODEX_HOME, 'sessions');",
      "mkdirSync(dir, { recursive: true });",
      "writeFileSync(join(dir, 'rollout-synthetic-no-usage.jsonl'), JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'low' } }) + '\\n');",
    ].join('\n'));
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { mode: 'codex' }), agentCommand: 'node ' + JSON.stringify(script) }),
      { cwd: s.work, env: { HOME: s.home } }).done;
    assert.equal(result.code, 0, result.stderr);
    const meters = faravanLines(result.stderr).filter((entry) => entry.type === 'meter');
    assert.ok(!meters.some((entry) => entry.final), 'unknown usage stays unknown, never final');
  } finally { await s.cleanup(); }
});

test('codex run stopped at its budget gets no final reading, since a killed turn may leave usage out of the rollout', async () => {
  const s = await scratch();
  try {
    const budget = { unit: 'codex_credits', limit: 3, weights: { input: 0.001, cached_input: 0.0001, output: 0.005 } };
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl, { mode: 'codex', budget }), agentCommand: agent('fake-codex.mjs') }),
      { cwd: s.work, env: { HOME: s.home, FAKE_MODE: 'run' } }).done;
    assert.equal(result.code, 0, result.stderr);
    assert.equal((await stopRecord(s.ctl)).stop_reason, 'budget');
    const meters = faravanLines(result.stderr).filter((entry) => entry.type === 'meter');
    assert.ok(meters.length >= 2);
    assert.ok(!meters.some((entry) => entry.final), 'a stopped run is partial, so no reading claims completeness');
  } finally { await s.cleanup(); }
});

test('a genuine failure keeps its exit code, and a planted stop record does not survive', async () => {
  const s = await scratch();
  try {
    await mkdir(s.ctl, { recursive: true });
    await writeFile(path.join(s.ctl, 'stop.json'), JSON.stringify({ schema: 'faravan.stop.v1', stop_reason: 'budget' }));
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, config: config(s.ctl), agentCommand: agent('fake-claude.mjs') }),
      { cwd: s.work, env: { FAKE_MODE: 'fail' } }).done;
    assert.equal(result.code, 2);
    assert.match(result.stderr, /real failure/);
    assert.ok(!existsSync(path.join(s.ctl, 'stop.json')));
  } finally { await s.cleanup(); }
});

test('the stop command fails when no guard is running, so the host can fall back at once', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardStopCommand({runtimePath:process.execPath, guardPath: GUARD_SOURCE_PATH, ctl: s.ctl, reason: 'owner' })).done;
    assert.notEqual(result.code, 0);
  } finally { await s.cleanup(); }
});

test('stop records are untrusted: wrong nonce, unknown reason, extra fields, oversize and bad numbers are refused', () => {
  const nonce = 'a'.repeat(32);
  const good = { schema: 'faravan.stop.v1', nonce, stop_reason: 'owner', budget_units: null, used_units: null, agent_exit: 130, signal: 'SIGINT' };
  assert.deepEqual(validateStopRecord(JSON.stringify(good), { nonce }), good);
  for (const bad of [
    { ...good, nonce: 'x'.repeat(32) },
    { ...good, stop_reason: 'done' },
    { ...good, stop_reason: '__proto__' },
    { ...good, extra: 1 },
    { ...good, used_units: -1 },
    { ...good, used_units: 'NaN' },
    { ...good, agent_exit: 1.5 },
    { ...good, signal: 'SIGHUP' },
  ]) assert.equal(validateStopRecord(JSON.stringify(bad), { nonce }), null, JSON.stringify(bad));
  assert.equal(validateStopRecord('{', { nonce }), null);
  assert.equal(validateStopRecord(JSON.stringify(good) + ' '.repeat(5000), { nonce }), null);
});

test('guard lines are parsed strictly; anything else is the agent\'s own stderr', () => {
  assert.equal(parseGuardLine('plain agent text'), null);
  assert.equal(parseGuardLine('{"type":"faravan.meter"}'), null, 'a meter line without its fields is not a reading');
  assert.equal(parseGuardLine(JSON.stringify({ type: 'faravan.meter', v: 1, seq: 1, at: 'x', source: 'evil', windows: [] })), null);
  assert.deepEqual(parseGuardLine(JSON.stringify({ type: 'faravan.heartbeat', v: 1, seq: 3 })), { type: 'heartbeat', seq: 3 });

  const meter = { type: 'faravan.meter', v: 1, seq: 4, at: '2026-10-22T12:00:00.000Z', source: 'codex-rollout', windows: [], tokens: {} };
  const unknown = parseGuardLine(JSON.stringify(meter));
  assert.ok(unknown);
  assert.equal(Object.hasOwn(unknown, 'overage'), false, 'missing overage remains unknown');
  assert.equal(Object.hasOwn(unknown, 'limit_reached'), false, 'missing limit verdict remains unknown');

  const invalid = parseGuardLine(JSON.stringify({ ...meter, seq: 5, overage: 'false', limit_reached: null }));
  assert.ok(invalid, 'invalid verdict values do not discard a valid usage reading');
  assert.equal(Object.hasOwn(invalid, 'overage'), false);
  assert.equal(Object.hasOwn(invalid, 'limit_reached'), false);

  const explicitFalse = parseGuardLine(JSON.stringify({ ...meter, seq: 6, overage: false, limit_reached: false }));
  assert.equal(explicitFalse.overage, false, 'explicit false remains a supported recovery signal');
  assert.equal(explicitFalse.limit_reached, false, 'explicit false remains a supported recovery signal');
  const explicitTrue = parseGuardLine(JSON.stringify({ ...meter, seq: 7, overage: true, limit_reached: true }));
  assert.equal(explicitTrue.overage, true);
  assert.equal(explicitTrue.limit_reached, true);
});

test('Codex with no usage evidence stops even while guard heartbeats continue',async()=>{
 const s=await scratch();try{
  const result=await runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,config:config(s.ctl,{mode:'codex',meter_start_ms:200,soft_deadline_s:2,budget:{unit:'codex_credits',limit:10,weights:{input:1,cached_input:1,output:1}}}),agentCommand:agent('fake-claude.mjs')}),{cwd:s.work,env:{HOME:s.home,FAKE_MODE:'hang'}}).done;
  const diagnostic = faravanLines(result.stderr).find(e => e.type === 'exit');
  assert.equal(diagnostic.stop_imposed, true);assert.equal(diagnostic.stop_reason, 'error');assert.equal(diagnostic.group_ceased, true);
  assert.equal(result.code,0,result.stderr);assert.equal((await stopRecord(s.ctl)).stop_reason,'error');assert.ok(faravanLines(result.stderr).some(e=>e.type==='heartbeat'));
  assert.equal(await readFile(path.join(s.work,'edit.txt'),'utf8'),'partial\n');
 }finally{await s.cleanup();}
});

async function signalFixture(mode, events) {
  const s = await scratch();
  try {
    const script = path.join(s.dir, 'signals.mjs');
    const body = mode === 'claude'
      ? "for(const info of "+JSON.stringify(events)+")console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:info}));"
      : "import {mkdirSync,writeFileSync} from 'node:fs';import {join} from 'node:path';const dir=join(process.env.CODEX_HOME,'sessions');mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'rollout-synthetic-signals.jsonl'),"+JSON.stringify(events.map(rate_limits=>JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:2}},rate_limits}})).join('\n')+'\n')+");";
    await writeFile(script,body);
    const result=await runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,
      config:config(s.ctl,{mode}),agentCommand:'node '+JSON.stringify(script)}),{cwd:s.work,env:{HOME:s.home}}).done;
    assert.equal(result.code,0,result.stderr);
    const meters=result.stderr.split('\n').filter(line=>line.startsWith('{"type":"faravan.meter"')).map(JSON.parse);
    // A Codex run that ends on its own adds one final reading after the raw events; it is not a raw event.
    assert.equal(meters.filter(row=>!row.final).length,events.length,'real process emitted each raw meter event');
    assert.ok(meters.every(row=>parseGuardLine(JSON.stringify(row))?.type==='meter'),'host accepts the protocol envelope');
    return {meters,stopped:existsSync(path.join(s.ctl,'stop.json'))?await stopRecord(s.ctl):null};
  } finally {await s.cleanup();}
}

test('Claude raw guard events preserve missing and invalid funding verdicts rather than false',async()=>{
  const {meters,stopped}=await signalFixture('claude',[{}, {isUsingOverage:'false',status:17},
    {isUsingOverage:false,status:'unrecognized'}]);
  assert.equal(stopped,null);
  assert.equal(Object.hasOwn(meters[0],'overage'),false);
  assert.equal(Object.hasOwn(meters[0],'limit_reached'),false);
  assert.equal(Object.hasOwn(meters[1],'overage'),false);
  assert.equal(Object.hasOwn(meters[1],'limit_reached'),false);
  assert.equal(meters[2].overage,false,'explicit typed false remains recovery evidence for overage only');
  assert.equal(Object.hasOwn(meters[2],'limit_reached'),false);
});

test('Claude explicit rejection and overage still stop the real guard',async()=>{
  for(const info of [{status:'rejected'},{isUsingOverage:true}]) {
    const {meters,stopped}=await signalFixture('claude',[info]);
    assert.equal(stopped.stop_reason,'provider_limit');
    assert.equal(info.status==='rejected'?meters[0].limit_reached:meters[0].overage,true);
  }
});

test('Codex raw guard events preserve absent or invalid limit verdicts',async()=>{
  const {meters,stopped}=await signalFixture('codex',[{}, {rate_limit_reached_type:false},
    {rate_limit_reached_type:0},{rate_limit_reached_type:{}},{rate_limit_reached_type:null},
    {rate_limit_reached_type:''}]);
  for(const row of meters) {
    assert.equal(Object.hasOwn(row,'limit_reached'),false);
    assert.equal(row.tokens.input,10);assert.equal(row.tokens.output,2);
  }
  assert.equal(stopped,null);
});

test('Codex explicit reached type still stops the real guard',async()=>{
  const {meters,stopped}=await signalFixture('codex',[{rate_limit_reached_type:'primary'}]);
  assert.equal(meters[0].limit_reached,true);
  assert.equal(stopped.stop_reason,'provider_limit');
});

for (const grace of [100, 5000]) test('descendant stdout holder: owner stop must not publish completion before cessation (grace=' + grace + ')', { timeout: 12000 }, async () => {
  const s = await scratch();
  let run;
  try {
    const descendant = path.join(s.dir, 'descendant.mjs');
    const parent = path.join(s.dir, 'parent.mjs');
    await writeFile(descendant, [
      "import {writeFileSync} from 'node:fs';",
      "writeFileSync('descendant.pid',String(process.pid));",
      "process.on('SIGINT',()=>{});",
      "process.on('SIGUSR2',()=>process.stdout.write('descendant-signal-output\\n',error=>{if(error)process.exit(2);writeFileSync('descendant-output-ready','yes');}));",
      "process.on('SIGUSR1',()=>process.exit(0));",
      "process.on('SIGTERM',()=>{});",
      "setInterval(()=>{},1000);",
      "writeFileSync('ready','yes');",
    ].join('\n'));
    await writeFile(parent, [
      "import {spawn} from 'node:child_process';",
      "spawn(process.execPath,["+JSON.stringify(descendant)+"],{stdio:['ignore',1,2]});",
      "process.on('SIGINT',()=>process.exit(0));",
      "setTimeout(()=>process.exit(0),8000);",
    ].join('\n'));
    run=runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,config:config(s.ctl,{sigint_grace_ms:grace,sigterm_grace_ms:5000}),agentCommand:'node '+JSON.stringify(parent)}),{cwd:s.work,env:{HOME:s.home}});
    await waitForFileSignal(path.join(s.work,'ready'));
    const stop=await runGuard(guardStopCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,ctl:s.ctl,reason:'owner'}),{cwd:s.work,env:{HOME:s.home}}).done;
    assert.equal(stop.code,0);
    process.kill(Number(await readFile(path.join(s.work,'descendant.pid'),'utf8')),'SIGUSR2');
    await waitForFileSignal(path.join(s.work,'descendant-output-ready'));
    assert.equal(existsSync(path.join(s.ctl,'stop.json')),false,'stop completion waits while the descendant holds stdout open');
    process.kill(Number(await readFile(path.join(s.work,'descendant.pid'),'utf8')),'SIGUSR1');
    const result=await run.done;
    assert.equal(result.code,0,result.stderr);
    assert.ok(result.stdout.includes('descendant-signal-output'),'the descendant\'s synchronized stdout output is retained');
    const record=await stopRecord(s.ctl);
    assert.equal(record.stop_reason,'owner');
    assert.equal(record.nonce,'a'.repeat(32),'actual guard producer matches host nonce validator');
  } finally {
    // Only process groups/PIDs created by this fixture, never global host cleanup.
    for(const file of [path.join(s.ctl,'agent.pgid'),path.join(s.work,'descendant.pid')]) {
      try {const pid=Number(await readFile(file,'utf8'));if(Number.isSafeInteger(pid)&&pid>1)process.kill(file.endsWith('agent.pgid')?-pid:pid,'SIGKILL');}catch{}
    }
    if(run) {run.child.kill('SIGTERM');await run.done;}
    await s.cleanup();
  }
});

for (const grace of [5000]) test('descendant stderr-only holder: owner stop must not publish completion before cessation (grace=' + grace + ')', { timeout: 12000 }, async () => {
  const s = await scratch();
  let run;
  try {
    const descendant = path.join(s.dir, 'descendant.mjs');
    const parent = path.join(s.dir, 'parent.mjs');
    await writeFile(descendant, [
      "import {writeFileSync,appendFileSync} from 'node:fs';",
      "writeFileSync('descendant.pid',String(process.pid));",
      "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});",
      "setInterval(()=>appendFileSync('useful.txt','tick\\n'),50);",
      "setTimeout(()=>process.exit(0),8000);",
    ].join('\n'));
    await writeFile(parent, [
      "import {spawn} from 'node:child_process';import {existsSync,writeFileSync} from 'node:fs';",
      "spawn(process.execPath,["+JSON.stringify(descendant)+"],{stdio:['ignore','ignore',2]});",
      "process.on('SIGINT',()=>process.exit(0));",
      "const poll=setInterval(()=>{if(existsSync('descendant.pid')){writeFileSync('ready','yes');clearInterval(poll);}},10);",
      "setTimeout(()=>process.exit(0),8000);",
    ].join('\n'));
    run=runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,config:config(s.ctl,{sigint_grace_ms:grace,sigterm_grace_ms:100}),agentCommand:'node '+JSON.stringify(parent)}),{cwd:s.work,env:{HOME:s.home}});
    await until(()=>existsSync(path.join(s.work,'ready'))&&existsSync(path.join(s.work,'useful.txt')));
    const before=await readFile(path.join(s.work,'useful.txt'),'utf8');
    assert.ok(before.includes('tick'),'descendant performed useful controlled work before cancellation');
    const stop=await runGuard(guardStopCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,ctl:s.ctl,reason:'owner'}),{cwd:s.work,env:{HOME:s.home}}).done;
    assert.equal(stop.code,0);
    await until(()=>existsSync(path.join(s.ctl,'stop.json')),6500);
    const record=await stopRecord(s.ctl);
    assert.equal(record.stop_reason,'owner');
    assert.equal(record.nonce,'a'.repeat(32),'actual guard producer matches host nonce validator');
    const atRecord=await readFile(path.join(s.work,'useful.txt'),'utf8');
    await new Promise(resolve=>setTimeout(resolve,180));
    const afterRecord=await readFile(path.join(s.work,'useful.txt'),'utf8');
    assert.equal(afterRecord,atRecord,'matching stop record must not precede continuing descendant work; parent exit is not cessation');
    const result=await run.done;
    assert.equal(result.code,0,result.stderr);
  } finally {
    // Only process groups/PIDs created by this fixture, never global host cleanup.
    for(const file of [path.join(s.ctl,'agent.pgid'),path.join(s.work,'descendant.pid')]) {
      try {const pid=Number(await readFile(file,'utf8'));if(Number.isSafeInteger(pid)&&pid>1)process.kill(file.endsWith('agent.pgid')?-pid:pid,'SIGKILL');}catch{}
    }
    if(run) {run.child.kill('SIGTERM');await run.done;}
    await s.cleanup();
  }
});

for (const grace of [5000]) test('graceful descendant with nonzero parent: owner stop must not publish completion before cessation (grace=' + grace + ')', { timeout: 12000 }, async () => {
  const s = await scratch();
  let run;
  try {
    const descendant = path.join(s.dir, 'descendant.mjs');
    const parent = path.join(s.dir, 'parent.mjs');
    await writeFile(descendant, [
      "import {writeFileSync,appendFileSync} from 'node:fs';",
      "writeFileSync('descendant.pid',String(process.pid));",
      "process.on('SIGINT',()=>setTimeout(()=>{writeFileSync('graceful.done','kept');process.exit(0);},3000));process.on('SIGTERM',()=>{});",
      "setInterval(()=>appendFileSync('useful.txt','tick\\n'),50);",
      "setTimeout(()=>process.exit(0),8000);",
    ].join('\n'));
    await writeFile(parent, [
      "import {spawn} from 'node:child_process';import {existsSync,writeFileSync} from 'node:fs';",
      "spawn(process.execPath,["+JSON.stringify(descendant)+"],{stdio:['ignore',1,2]});",
      "process.on('SIGINT',()=>process.exit(7));",
      "const poll=setInterval(()=>{if(existsSync('descendant.pid')){writeFileSync('ready','yes');clearInterval(poll);}},10);",
      "setTimeout(()=>process.exit(0),8000);",
    ].join('\n'));
    run=runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,config:config(s.ctl,{sigint_grace_ms:grace,sigterm_grace_ms:100}),agentCommand:'node '+JSON.stringify(parent)}),{cwd:s.work,env:{HOME:s.home}});
    await until(()=>existsSync(path.join(s.work,'ready'))&&existsSync(path.join(s.work,'useful.txt')));
    const before=await readFile(path.join(s.work,'useful.txt'),'utf8');
    assert.ok(before.includes('tick'),'descendant performed useful controlled work before cancellation');
    const stop=await runGuard(guardStopCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,ctl:s.ctl,reason:'owner'}),{cwd:s.work,env:{HOME:s.home}}).done;
    assert.equal(stop.code,0);
    await until(()=>existsSync(path.join(s.ctl,'stop.json')),6500);
    const record=await stopRecord(s.ctl);
    assert.equal(record.stop_reason,'owner');
    assert.equal(record.agent_exit,7);
    assert.equal(await readFile(path.join(s.work,'graceful.done'),'utf8'),'kept','full graceful work survives beyond the old two-second cutoff');
    assert.equal(record.nonce,'a'.repeat(32),'actual guard producer matches host nonce validator');
    const atRecord=await readFile(path.join(s.work,'useful.txt'),'utf8');
    await new Promise(resolve=>setTimeout(resolve,180));
    const afterRecord=await readFile(path.join(s.work,'useful.txt'),'utf8');
    assert.equal(afterRecord,atRecord,'matching stop record must not precede continuing descendant work; parent exit is not cessation');
    const result=await run.done;
    assert.equal(result.code,0,result.stderr);
  } finally {
    // Only process groups/PIDs created by this fixture, never global host cleanup.
    for(const file of [path.join(s.ctl,'agent.pgid'),path.join(s.work,'descendant.pid')]) {
      try {const pid=Number(await readFile(file,'utf8'));if(Number.isSafeInteger(pid)&&pid>1)process.kill(file.endsWith('agent.pgid')?-pid:pid,'SIGKILL');}catch{}
    }
    if(run) {run.child.kill('SIGTERM');await run.done;}
    await s.cleanup();
  }
});

test('guard preserves failed spawn exit without a stop receipt',async()=>{
 const s=await scratch();
 try {
  const r=await runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH,config:config(s.ctl),agentCommand:'/definitely-not-an-installed-guard-fixture-command'}),{cwd:s.work,env:{HOME:s.home}}).done;
  assert.notEqual(r.code,0);assert.equal(existsSync(path.join(s.ctl,'stop.json')),false);
 }finally{await s.cleanup();}
});

test('exit 0 with a long-lived child succeeds only after helper cleanup', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH, config:config(s.ctl), agentCommand:agent('fake-agent-exit.mjs')}),
      {cwd:s.work, env:{FAKE_MODE:'child'}}).done;
    assert.equal(result.code, 0);
    const diagnostic = faravanLines(result.stderr).find(entry => entry.type === 'exit');
    assert.equal(diagnostic.agent_exit_code, 0);
    assert.equal(diagnostic.group_ceased, true);
    assert.equal(diagnostic.leftover_terminated, true);
    const pid = Number(await readFile(path.join(s.work, "leftover.pid"), "utf8"));
    try { assert.match(await readFile(`/proc/${pid}/stat`, "utf8"), /\) [ZX] /); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    assert.equal(diagnostic.stop_imposed, false);
    assert.equal(diagnostic.stop_reason, null);
    assert.ok(diagnostic.elapsed_ms >= 2000);
    assert.match(result.stdout, /READY/);
    assert.equal(existsSync(path.join(s.ctl, 'stop.json')), false);
  } finally {
    try { process.kill(Number(await readFile(path.join(s.work,'leftover.pid'),'utf8')), 'SIGKILL'); } catch {}
    await s.cleanup();
  }
});


test('exit diagnostics are bounded untrusted input with unknown fields removed', () => {
  const value = {type:'faravan.exit',v:1,seq:2,nonce:'a'.repeat(32),agent_exit_code:3,agent_signal:null,
    group_ceased:true,stop_imposed:false,stop_reason:null,outside_signal:null,elapsed_ms:25};
  const parse = overrides => parseGuardLine(JSON.stringify({...value,...overrides}));
  assert.equal(parse({private_output:'secret'}).private_output, undefined);
  for (const overrides of [{agent_exit_code:256},{agent_exit_code:-1},{agent_exit_code:'3'},
    {group_ceased:'true'},{leftover_terminated:'true'},{stop_imposed:true},{stop_reason:'secret'},{agent_signal:'secret'},
    {outside_signal:'secret'},{elapsed_ms:-1},{elapsed_ms:1.5},{nonce:'bad'}]) assert.equal(parse(overrides), null);
  assert.equal(parse({agent_signal:'SIGTERM'}).agent_signal, 'SIGTERM');
  assert.equal(parse({leftover_terminated:true}).leftover_terminated, true);
});

test('a signalled agent keeps its signal separate from the guard exit status', async () => {
  const s = await scratch();
  try {
    const result = await runGuard(guardRunCommand({runtimePath:process.execPath,guardPath:GUARD_SOURCE_PATH, config:config(s.ctl),
      agentCommand:'trap - TERM; kill -TERM $$'}), {cwd:s.work}).done;
    assert.equal(result.code, 128);
    const diagnostic = faravanLines(result.stderr).find(entry => entry.type === 'exit');
    assert.equal(diagnostic.agent_exit_code, null);
    assert.equal(diagnostic.agent_signal, 'SIGTERM');
    assert.equal(diagnostic.group_ceased, true);
    assert.equal(diagnostic.stop_imposed, false);
  } finally { await s.cleanup(); }
});

for (const scenario of ['normal', 'kill', 'unknown', 'nonzero', 'outside', 'owner', 'budget', 'ambiguous', 'no-usage']) {
  test('Codex leftover cleanup: ' + scenario, {timeout:12000}, async () => {
    const s = await scratch();
    let run;
    try {
      const helper = path.join(s.dir, 'helper.mjs');
      await writeFile(helper, `import {writeFileSync} from 'node:fs';
        process.on('SIGTERM',()=>{writeFileSync('term-seen','yes');${scenario === 'normal' || scenario === 'ambiguous' || scenario === 'no-usage' ? 'process.exit(0);' : ''}});
        process.on('SIGINT',()=>{});
        writeFileSync('helper.pid',String(process.pid));
        setInterval(()=>{},1000);`);
      const parent = path.join(s.dir, 'parent.mjs');
      const thread = '12345678-1234-1234-1234-123456789abc';
      await writeFile(parent, `import {spawn} from 'node:child_process';
        import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
        import {join} from 'node:path';
        const sessions=join(process.env.CODEX_HOME,'sessions');mkdirSync(sessions,{recursive:true});
        console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(thread)}}));
        ${scenario === 'no-usage' ? '' : `writeFileSync(join(sessions,'rollout-${thread}.jsonl'),JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:10,output_tokens:2}}}})+'\\n');`}
        ${scenario === 'ambiguous' ? "writeFileSync(join(sessions,'rollout-other.jsonl'),'');" : ''}
        spawn(process.execPath,[${JSON.stringify(helper)}],{stdio:'ignore'});
        const wait=setInterval(()=>{if(existsSync('helper.pid'))process.exit(${scenario === 'nonzero' ? 3 : 0});},10);`);
      let guardPath = GUARD_SOURCE_PATH;
      if (scenario === 'unknown') {
        guardPath = path.join(s.dir, 'guard.mjs');
        const source = await readFile(GUARD_SOURCE_PATH, 'utf8');
        assert.ok(source.includes('const groupStopped = () => {'));
        await writeFile(guardPath, source.replace('const groupStopped = () => {', 'const groupStopped = () => { return false;'));
      }
      run = runGuard(guardRunCommand({runtimePath:process.execPath,guardPath,config:config(s.ctl,{mode:'codex',sigint_grace_ms:100,sigterm_grace_ms:700}),agentCommand:'node '+JSON.stringify(parent)}),{cwd:s.work});
      if (scenario === 'owner' || scenario === 'budget' || scenario === 'outside') {
        await until(()=>existsSync(path.join(s.work,'term-seen')));
        if (scenario === 'outside') process.kill(Number(await readFile(path.join(s.ctl,'guard.pid'),'utf8')), 'SIGTERM');
        else await writeFile(path.join(s.ctl,'stop-request'), scenario);
      }
      const result = await run.done;
      const events = faravanLines(result.stderr);
      const diagnostic = events.find(e=>e.type==='exit');
      const failed = ['unknown','nonzero','outside'].includes(scenario);
      assert.equal(result.code, failed ? 1 : 0, result.stderr);
      assert.equal(diagnostic.group_ceased, !['unknown','nonzero'].includes(scenario));
      assert.equal(diagnostic.leftover_terminated, scenario !== 'nonzero');
      const final = events.filter(e=>e.type==='meter'&&e.final);
      assert.equal(final.length, ['normal','kill'].includes(scenario) ? 1 : 0, 'cleanup does not promote partial or unknown totals');
      if (final.length) assert.equal(final[0].tokens.input,10);
      if (scenario === 'owner' || scenario === 'budget') assert.equal((await stopRecord(s.ctl)).stop_reason,scenario);
      else assert.equal(existsSync(path.join(s.ctl,'stop.json')),false);
      if (scenario === 'outside') assert.equal(diagnostic.outside_signal,'SIGTERM');
      if (scenario !== 'nonzero') {
        const pid = Number(await readFile(path.join(s.work,'helper.pid'),'utf8'));
        try { assert.match(await readFile(`/proc/${pid}/stat`,'utf8'), /\) [ZX] /); }
        catch(error) {if(error.code!=='ENOENT')throw error;}
      }
    } finally {
      try { process.kill(Number(await readFile(path.join(s.work,'helper.pid'),'utf8')),'SIGKILL'); } catch {}
      if(run) {run.child.kill('SIGTERM');await run.done;}
      await s.cleanup();
    }
  });
}
