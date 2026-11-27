#!/usr/bin/env node
/**
 * faravan-guard: runs one lent agent inside the sandbox guest and stops it gracefully.
 * LENDING-POLICY-DESIGN.md D3 ("Partial results need one backend change, and get one guard for both agents").
 *
 * This file is copied alone into the guest (`sbx cp`), so it imports only Node builtins.
 *
 *   node faravan-guard.mjs run --config <base64 JSON> -- <agent argv...>
 *   node faravan-guard.mjs stop <owner|budget|time|provider_limit|error> --ctl <dir>
 *
 * `run` starts the agent in its own process group and passes its stdout and stderr through. It also:
 * - writes `faravan.heartbeat` lines on stderr every heartbeat_ms;
 * - writes `faravan.meter` lines on stderr: Claude from its stream-json (`rate_limit_event` is taken off
 *   stdout, so the lender's allowance never enters the borrower's transcript), Codex from its own rollout file;
 * - stops the agent on a stop request, the soft deadline, a Codex credit budget, or a rejected/overage reading:
 *   SIGINT to the group, SIGTERM after sigint_grace_ms, SIGKILL after sigterm_grace_ms more;
 * - after a Faravan-imposed stop (or Claude's own `error_max_budget_usd`), writes <ctl>/stop.json and exits 0,
 *   so the backend collects the work, once the owned process group has ceased. Otherwise it exits with the agent's
 *   code. After a normal exit 0, leftover helpers get TERM then KILL before completion. After a stop, the guard
 *   keeps the group's escalation running. If cessation cannot be confirmed, it writes no stop receipt and exits 1.
 *   A receipt is not proof that the sandbox was removed.
 * The guard shares the guest with the borrower's agent, so the host treats everything it writes as untrusted.
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const REASONS = ['budget', 'owner', 'time', 'provider_limit', 'error'];
const MAX_LINE = 4 * 1024 * 1024;

function emit(type, fields) {
  process.stderr.write(JSON.stringify({ type: 'faravan.' + type, v: 1, ...fields }) + '\n');
}

function isoFromEpoch(seconds) {
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

const pct = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;

// Claude: rate_limit_info.unifiedWindows.{five_hour,seven_day,...}.utilization is a 0..1 fraction (Phase 0, 2.1.280).
const CLAUDE_WINDOW_MINUTES = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080, seven_day_overage_included: 10080 };
export function claudeReading(info) {
  if (!info || typeof info !== 'object') return null;
  const windows = [];
  for (const [id, entry] of Object.entries(info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {})) {
    if (!/^[a-z0-9_]{1,40}$/.test(id) || !entry || !Number.isFinite(entry.utilization)) continue;
    windows.push({ window_id: id, window_minutes: CLAUDE_WINDOW_MINUTES[id] ?? null, used_pct: pct(entry.utilization * 100), resets_at: isoFromEpoch(entry.resetsAt) });
  }
  return { windows, status: typeof info.status === 'string' ? info.status.slice(0, 40) : null,
    ...(typeof info.isUsingOverage === 'boolean' ? {overage: info.isUsingOverage} : {}),
    ...(info.status === 'rejected' ? {limit_reached: true} : {}) };
}

// Codex rollout rate_limits.{primary,secondary}: used_percent 0..100, window_minutes, resets_at epoch seconds.
// "primary" is not "five hours": on Pro it is the weekly window, so the id carries the length (design D2).
export function codexWindows(limits) {
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const entry = limits?.[key];
    if (!entry || !Number.isFinite(entry.used_percent) || !Number.isFinite(entry.window_minutes)) continue;
    // The main Codex bucket reports limit_id 'codex'. It keeps the legacy series so
    // stored history, calibration and the tray stay continuous; other buckets split off.
    const bucketed = limits.limit_id !== undefined && limits.limit_id !== null && limits.limit_id !== 'codex';
    // Bucket IDs are opaque: never fall back to a shared legacy series for malformed IDs.
    // The importer reads the bucket as one colon-free segment and whole minutes, so the
    // guard emits nothing it cannot read back: such readings stay unknown, which holds.
    if (bucketed && (typeof limits.limit_id !== 'string' || !limits.limit_id.length || limits.limit_id.includes(':'))) continue;
    // Meters report 299/300 for a five-hour window. Snap bucketed readings to the
    // nearest whole hour only within 2% of that anchor; otherwise retain exact minutes.
    // This deterministic function is not pairwise tolerance equivalence. Legacy IDs
    // (without limit_id) and their durations remain byte-for-byte compatible.
    const hour = Math.round(entry.window_minutes / 60) * 60;
    const minutes = bucketed && hour > 0 && Math.abs(entry.window_minutes - hour) <= hour * 0.02
      ? hour : entry.window_minutes;
    if (bucketed && !Number.isSafeInteger(minutes)) continue;
    const window_id = bucketed ? `codex:${limits.limit_id}:${minutes}` : 'codex:' + minutes;
    windows.push({ window_id, window_minutes: minutes, used_pct: pct(entry.used_percent), resets_at: isoFromEpoch(entry.resets_at) });
  }
  return windows;
}

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Credits for cumulative Codex tokens. input_tokens includes cached input; reasoning is part of output. */
export function codexUnits(tokens, weights) {
  if (!weights) return null;
  const uncached = Math.max(0, tokens.input - tokens.cached_input);
  return uncached * (weights.input || 0) + tokens.cached_input * (weights.cached_input || 0) + tokens.output * (weights.output || 0);
}

function parseArgs(argv) {
  const at = argv.indexOf('--');
  const own = at < 0 ? argv : argv.slice(0, at);
  const flags = {};
  for (let i = 0; i < own.length; i++) if (own[i].startsWith('--')) flags[own[i].slice(2)] = own[++i];
  return { flags, positional: own.filter((word, i) => !word.startsWith('--') && !own[i - 1]?.startsWith('--')), agent: at < 0 ? [] : argv.slice(at + 1) };
}

function readPid(ctl) {
  try {
    const text = readFileSync(join(ctl, 'guard.pid'), 'utf8').trim();
    const pid = /^[1-9][0-9]*$/.test(text) ? Number(text) : NaN;
    return Number.isSafeInteger(pid) && pid > 1 ? pid : NaN;
  } catch { return NaN; }
}

function verifyGuardPid(pid) {
  // Liveness alone accepts a recycled PID. Check the kernel's argv/executable,
  // not a substring in ps output (or an unrelated node -e argument).
  // The supported host command is `node <guardPath> run --config ... -- ...`.
  if (process.platform !== 'linux') return 'cannot verify guard PID on this platform';
  try {
    const proc = '/proc/' + pid;
    const argv = readFileSync(join(proc, 'cmdline'), 'utf8').split('\0');
    if (argv[2] !== 'run' || !argv[1] ||
        realpathSync(join(proc, 'exe')) !== realpathSync(process.execPath) ||
        realpathSync(resolve(join(proc, 'cwd'), argv[1])) !== realpathSync(fileURLToPath(import.meta.url)))
      return 'PID is not a guard run process';
    return null;
  } catch { return 'cannot verify guard PID from /proc'; }
}

function stopCommand(reason, ctl) {
  if (!REASONS.includes(reason) || !ctl) { process.stderr.write('usage: faravan-guard stop <reason> --ctl <dir>\n'); return 2; }
  const pid = readPid(ctl);
  if (!Number.isSafeInteger(pid)) { process.stderr.write('faravan-guard: invalid guard PID\n'); return 3; }
  try { process.kill(pid, 0); } catch { process.stderr.write('faravan-guard is not running\n'); return 3; }
  const identityError = verifyGuardPid(pid);
  if (identityError) { process.stderr.write('faravan-guard: ' + identityError + '\n'); return 3; }
  writeFileSync(join(ctl, 'stop-request.tmp'), reason);
  renameSync(join(ctl, 'stop-request.tmp'), join(ctl, 'stop-request'));
  return 0;
}

function findRollout(sessions, threadId, since) {
  let best = null;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        if (threadId && entry.name.includes(threadId)) { best = { full, exact: true }; return; }
        let mtime;
        try { mtime = statSync(full).mtimeMs; } catch { continue; }
        if (mtime >= since && !best?.exact && (!best || mtime > best.mtime)) best = { full, mtime };
      }
      if (best?.exact) return;
    }
  };
  walk(sessions, 0);
  return best?.full ?? null;
}

// Rollout files written since the run started. More than one means another Codex session shared CODEX_HOME,
// so one file's total may not be the run's total.
function recentRollouts(sessions, since) {
  let found = 0;
  const walk = (dir, depth) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && depth < 4) walk(full, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try { if (statSync(full).mtimeMs >= since) found++; } catch { found++; }
      }
    }
  };
  walk(sessions, 0);
  return found;
}

function runCommand(config, agent) {
  const { ctl, mode, nonce } = config;
  if (!['claude', 'codex', 'generic'].includes(mode) || !ctl || !agent.length) { process.stderr.write('faravan-guard: bad configuration\n'); return Promise.resolve(2); }
  mkdirSync(ctl, { recursive: true });
  for (const name of ['stop.json', 'stop-request']) rmSync(join(ctl, name), { force: true });
  writeFileSync(join(ctl, 'guard.pid'), String(process.pid));

  const startedAt = Date.now();
  const budget = config.budget && Number.isFinite(config.budget.limit) && config.budget.limit > 0 ? config.budget : null;
  const state = { stopping: null, signal: null, nativeBudget: false, usedUnits: null, seq: 0, threadId: null,
    lastUsageAt:null, tokens: { input: 0, cached_input: 0, output: 0, reasoning_output: 0 }, claudeMessages: new Map(), costUsd: null, model: null, effort: null, windows: [], totalDecreased: false };
  const timers = [];
  let stopBy = null;
  const child = spawn(agent[0], agent.slice(1), { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const group = (signal) => { try { process.kill(-child.pid, signal); } catch { /* already gone */ } };
  // The host's hard backstop (`timeout --signal=KILL`) can only reach the agent's group through this file.
  if (child.pid) writeFileSync(join(ctl, 'agent.pgid'), String(child.pid));

  const impose = (reason) => {
    if (state.stopping || !REASONS.includes(reason)) return;
    state.stopping = reason;
    stopBy = Date.now() + (config.sigint_grace_ms ?? 20_000) + (config.sigterm_grace_ms ?? 10_000) + 2000;
    state.signal = 'SIGINT';
    group('SIGINT');
    timers.push(setTimeout(() => {
      state.signal = 'SIGTERM'; group('SIGTERM');
      timers.push(setTimeout(() => { state.signal = 'SIGKILL'; group('SIGKILL'); }, config.sigterm_grace_ms ?? 10_000));
    }, config.sigint_grace_ms ?? 20_000));
  };

  const meter = (source, fields) => {
    state.seq += 1;
    emit('meter', { seq: state.seq, at: new Date().toISOString(), source, model: state.model, effort: state.effort,
      tokens: { ...state.tokens }, cost_usd: state.costUsd, used_units: state.usedUnits, budget_units: budget?.limit ?? null, windows: [], ...fields });
  };

  // Claude: passthrough stdout, line by line.
  const claudeLine = (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return true; }
    if (event?.type === 'rate_limit_event') {
      const reading = claudeReading(event.rate_limit_info);
      if (reading) {
        meter('claude-stream', reading);
        if (reading.limit_reached || reading.overage) impose('provider_limit');
      }
      return false;
    }
    if (event?.type === 'assistant' && event.message?.usage) {
      const usage = event.message.usage;
      if (typeof event.message.model === 'string') state.model = event.message.model.slice(0, 80);
      state.claudeMessages.set(String(event.message.id ?? state.claudeMessages.size), {
        input: count(usage.input_tokens), cached_input: count(usage.cache_read_input_tokens), cache_write: count(usage.cache_creation_input_tokens), output: count(usage.output_tokens) });
      const sum = { input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning_output: 0 };
      for (const entry of state.claudeMessages.values()) for (const key of Object.keys(entry)) sum[key] += entry[key];
      state.tokens = sum;
      meter('claude-stream', {final:false});
    }
    if (event?.type === 'result') {
      if (Number.isFinite(event.total_cost_usd)) state.costUsd = event.total_cost_usd;
      if (event.subtype === 'error_max_budget_usd') state.nativeBudget = true;
      meter('claude-stream', { final: true });
    }
    return true;
  };

  const codexLine = (line) => {
    if (!state.threadId && line.includes('thread.started')) {
      try { const event = JSON.parse(line); if (typeof event.thread_id === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(event.thread_id)) state.threadId = event.thread_id; } catch { /* not an event */ }
    }
    return true;
  };

  let outBuffer = '';
  child.stdout.on('data', (chunk) => {
    outBuffer += chunk.toString('utf8');
    let at;
    while ((at = outBuffer.indexOf('\n')) >= 0) {
      const line = outBuffer.slice(0, at);
      outBuffer = outBuffer.slice(at + 1);
      if ((mode === 'generic' || (mode === 'claude' ? claudeLine : codexLine)(line))) process.stdout.write(line + '\n');
    }
    if (outBuffer.length > MAX_LINE) { process.stdout.write(outBuffer); outBuffer = ''; }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  // Codex: tail the session's own rollout file.
  const rollout = { path: null, offset: 0, rest: '' };
  const sessions = join(process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex'), 'sessions');
  const readRollout = () => {
    if (mode !== 'codex') return;
    rollout.path ??= findRollout(sessions, state.threadId, startedAt - 2000);
    if (!rollout.path) return;
    let fd;
    try {
      fd = openSync(rollout.path, 'r');
      const buffer = Buffer.alloc(256 * 1024);
      for (let read; (read = readSync(fd, buffer, 0, buffer.length, rollout.offset)) > 0;) {
        rollout.offset += read;
        rollout.rest += buffer.subarray(0, read).toString('utf8');
      }
    } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
    const lines = rollout.rest.split('\n');
    rollout.rest = lines.pop();
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const payload = record?.payload ?? record;
      if (record?.type === 'turn_context' || payload?.type === 'turn_context') {
        if (typeof payload.model === 'string') state.model = payload.model.slice(0, 80);
        if (typeof payload.effort === 'string') state.effort = payload.effort.slice(0, 20);
      }
      if (payload?.type !== 'token_count') continue;
      const total = payload.info?.total_token_usage;
      const hasUsage=Boolean(total&&Number.isFinite(total.input_tokens)&&Number.isFinite(total.output_tokens));
      if (hasUsage) {
        state.lastUsageAt=Date.now();
        const next = { input: count(total.input_tokens), cached_input: count(total.cached_input_tokens), output: count(total.output_tokens), reasoning_output: count(total.reasoning_output_tokens) };
        // A running total never falls. A lower one means the rollout was rewritten, so no reading from it is final.
        if (Object.keys(next).some((key) => next[key] < state.tokens[key])) state.totalDecreased = true;
        state.tokens = next;
        state.usedUnits = codexUnits(state.tokens, budget?.weights);
      }
      const limits = payload.rate_limits;
      // A missing or malformed discriminator is not an authoritative recovery.
      const reached = typeof limits?.rate_limit_reached_type === 'string' && limits.rate_limit_reached_type.trim().length > 0;
      state.windows = codexWindows(limits);
      meter('codex-rollout', { windows: state.windows, ...(reached ? {limit_reached: true} : {}), used_units:hasUsage?state.usedUnits:null });
      if (reached) impose('provider_limit');
      if (budget && state.usedUnits !== null && state.usedUnits >= budget.limit) impose('budget');
    }
  };

  const readStopRequest = () => {
    try {
      const reason = readFileSync(join(ctl, 'stop-request'), 'utf8').trim();
      rmSync(join(ctl, 'stop-request'), { force: true });
      impose(reason);
    } catch { /* no request */ }
  };
  const beat = () => emit('heartbeat', { seq: ++state.seq, at: new Date().toISOString() });
  timers.push(setInterval(beat, config.heartbeat_ms ?? 10_000));
  timers.push(setInterval(() => {
    if(mode==='codex')readRollout();
    // A heartbeat proves the guard is alive, not that its spend meter works.
    if(mode==='codex'&&budget){
      const age=Date.now()-(state.lastUsageAt??startedAt);
      if(age>=(state.lastUsageAt===null?(config.meter_start_ms??60000):(config.meter_loss_ms??120000)))impose('error');
    }
    readStopRequest();
  }, 250));
  if (Number.isFinite(config.soft_deadline_s) && config.soft_deadline_s > 0) timers.push(setTimeout(() => impose('time'), config.soft_deadline_s * 1000));

  // An outside signal is not a Faravan stop: pass it on and fail as before.
  let outside = null;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { outside = signal; group(signal); });

  // kill(0) also sees unreaped zombies. In the Linux guest, inspect only
  // process metadata to distinguish these from members still capable of work.
  // Unknown observations fail closed; escaped groups remain the host's concern.
  const groupStopped = () => {
    if (!child.pid) return true;
    try { process.kill(-child.pid, 0); }
    catch (error) { return error.code === 'ESRCH'; }
    if (process.platform !== 'linux') return false;
    let members = 0;
    try {
      for (const name of readdirSync('/proc')) {
        if (!/^[0-9]+$/.test(name)) continue;
        let stat;
        try { stat = readFileSync('/proc/' + name + '/stat', 'utf8'); }
        catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return false; }
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        if (Number(fields[2]) !== child.pid) continue;
        members++;
        if (!['Z', 'X'].includes(fields[0])) return false;
      }
    } catch { return false; }
    // No visible member despite a positive group probe is ambiguous, not proof.
    return members > 0;
  };
  return new Promise((resolve) => {
    let exit = null, exitAt = null, finished = false, drainBy = null, leftoverTerminated = false;
    child.once('spawn', () => {
      emit('started', { seq: ++state.seq, at: new Date().toISOString(), nonce });
      beat();
    });
    const finish = (ceased) => {
      if (finished) return;
      finished = true;
      if (outBuffer) { if (mode === 'generic' || (mode === 'claude' ? claudeLine : codexLine)(outBuffer)) process.stdout.write(outBuffer); outBuffer = ''; }
      // Final only when the agent ended on its own with exit 0: no stop was imposed before its exit and no outside signal reached it. A stopped
      // run can be cut mid-turn, and a turn that was cut may never reach the rollout, so its total is partial and stays unfinal.
      const endedOnItsOwn = ceased && !outside && state.stopping === null && exit?.code === 0;
      if(mode==='codex')readRollout();
      // Codex: the rollout total is complete once the agent has exited normally, if it is this thread's only rollout and it never
      // fell. Unknown usage (no token_count) stays unknown.
      const wholeRollout = Boolean(state.threadId && rollout.path?.includes(state.threadId)) && !state.totalDecreased &&
        recentRollouts(sessions, startedAt - 2000) === 1;
      if(mode==='codex'&&endedOnItsOwn&&wholeRollout&&state.lastUsageAt!==null)meter('codex-rollout',{final:true,windows:state.windows,used_units:state.usedUnits});
      for (const timer of timers) { clearTimeout(timer); clearInterval(timer); }
      // Both pipes may be held outside the group. Never hang on them or mistake
      // closing either one for group cessation. Already-read partial output stays.
      child.stdout?.destroy(); child.stderr?.destroy();
      const reason = outside ? null : state.stopping ?? (state.nativeBudget ? 'budget' : null);
      // Agent stderr may end without a newline. Keep the diagnostic on its own line.
      process.stderr.write('\n');
      emit('exit', { seq: ++state.seq, nonce, agent_exit_code: exit?.agentCode ?? null,
        agent_signal: exit?.signal ?? null, group_ceased: ceased, stop_imposed: Boolean(state.stopping || state.nativeBudget),
        stop_reason: state.stopping ?? (state.nativeBudget ? 'budget' : null), outside_signal: outside,
        leftover_terminated: leftoverTerminated,
        elapsed_ms: exitAt === null ? null : Math.max(0, Date.now() - exitAt) });
      if (!ceased || !reason) {
        rmSync(join(ctl, 'stop.json'), { force: true });
        return resolve(!ceased || outside ? 1 : exit.code ?? 1);
      }
      const record = { schema: 'faravan.stop.v1', nonce, stop_reason: reason, budget_units: budget?.limit ?? null,
        used_units: mode === 'claude' ? state.costUsd : state.usedUnits, agent_exit: exit.code ?? null, signal: state.stopping ? state.signal : null };
      writeFileSync(join(ctl, 'stop.json.tmp'), JSON.stringify(record));
      renameSync(join(ctl, 'stop.json.tmp'), join(ctl, 'stop.json'));
      resolve(0);
    };
    const inspect = () => {
      if (finished || !exit) return;
      readStopRequest();
      const ceased = groupStopped(), now = Date.now();
      if (ceased) {
        // Drain both streams normally; an escaped holder cannot delay forever.
        drainBy ??= now + 2000;
        if ((child.stdout.closed && child.stderr.closed) || now >= drainBy) finish(true);
        return;
      }
      drainBy = null;
      if (state.nativeBudget && !state.stopping && !outside) impose('budget');
      // Keep the original graceful escalation alive after the leader exits.
      // On an unresolved backstop, return failure and no stop receipt.
      if (now >= (stopBy ?? exitAt + 2000)) {
        if (!leftoverTerminated && !state.stopping && !state.nativeBudget && !outside && exit.code === 0) {
          leftoverTerminated = true;
          stopBy = now + (config.sigterm_grace_ms ?? 10_000) + 2000;
          group('SIGTERM');
          timers.push(setTimeout(() => group('SIGKILL'), config.sigterm_grace_ms ?? 10_000));
        } else finish(false);
      }
    };
    timers.push(setInterval(inspect, 25));
    child.once('error', (error) => { process.stderr.write('faravan-guard: ' + error.message + '\n'); exit = { code: 127, agentCode: null, signal: null }; exitAt = Date.now(); finish(groupStopped()); });
    child.once('exit', (code, signal) => {
      exit = { code: code ?? (signal ? 128 : 1), agentCode: code, signal }; exitAt = Date.now();
      inspect();
    });
    child.stdout.once('close', inspect);
    child.stderr.once('close', inspect);
  });
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  const { flags, positional, agent } = parseArgs(rest);
  if (command === 'stop') return stopCommand(positional[0], flags.ctl);
  if (command === 'run') {
    let config;
    try { config = JSON.parse(Buffer.from(flags.config || '', 'base64').toString('utf8')); } catch { config = null; }
    if (!config || config.v !== 1) { process.stderr.write('faravan-guard: bad configuration\n'); return 2; }
    return runCommand(config, agent);
  }
  process.stderr.write('usage: faravan-guard run --config <b64> -- <agent...> | stop <reason> --ctl <dir>\n');
  return 2;
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }, (error) => { process.stderr.write('faravan-guard: ' + (error?.message || error) + '\n'); process.exitCode = 1; });
}

export const _test = { existsSync, findRollout };
