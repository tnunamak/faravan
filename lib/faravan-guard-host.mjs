/**
 * Host side of faravan-guard (LENDING-POLICY-DESIGN.md D3): builds the guest commands and reads back
 * what the guard says. The guard shares the guest with the borrower's agent, so every line and every
 * stop record is untrusted input here: parsed strictly, unknown fields dropped, bad values refused.
 */
import { constants as osConstants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './harnesses/job-framing.mjs';
import { GUARD_TOKEN_KEYS } from './v1/lending-meter.mjs';

export const GUARD_SOURCE_PATH = fileURLToPath(new URL('./faravan-guard.mjs', import.meta.url));
export const STOP_REASONS = Object.freeze(['budget', 'owner', 'time', 'provider_limit', 'error']);
export const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGKILL']);
export const GUARD_MODES = Object.freeze(['claude', 'codex']);
export const MAX_STOP_RECORD_BYTES = 4096;
const METER_SOURCES = ['claude-stream', 'codex-rollout'];
const STOP_KEYS = ['schema', 'nonce', 'stop_reason', 'budget_units', 'used_units', 'agent_exit', 'signal'];

/**
 * The guest shell command that runs `agentCommand` under the guard.
 * The agent runs as `sh -c`, so `cd … && agent` keeps working. Dash already waits for its foreground agent on
 * SIGINT (tested); the INT/TERM handler (a handler, not an ignore, which `exec` would pass on to the agent) keeps
 * any other guest shell from exiting before the agent writes its last events.
 */
export function guardRunCommand({ guardPath, config, agentCommand, runtimePath }) {
  if (typeof runtimePath !== 'string' || !runtimePath.startsWith('/')) throw new TypeError('absolute runtimePath is required');
  if (typeof agentCommand !== 'string' || !agentCommand) throw new TypeError('agentCommand is required');
  const encoded = Buffer.from(JSON.stringify(config), 'utf8').toString('base64');
  return [shellQuote(runtimePath), shellQuote(guardPath), 'run', '--config', encoded, '--', 'sh', '-c', shellQuote('trap : INT TERM; ' + agentCommand)].join(' ');
}

export function guardStopCommand({ guardPath, ctl, reason, runtimePath }) {
  if (typeof runtimePath !== 'string' || !runtimePath.startsWith('/')) throw new TypeError('absolute runtimePath is required');
  if (!STOP_REASONS.includes(reason)) throw new TypeError('unknown stop reason');
  return [shellQuote(runtimePath), shellQuote(guardPath), 'stop', reason, '--ctl', shellQuote(ctl)].join(' ');
}

const finiteOrNull = (value) => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
const shortString = (value, max) => (typeof value === 'string' && value.length <= max ? value : null);
const isoOrNull = (value) => (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null);

function parseWindows(windows) {
  if (!Array.isArray(windows) || windows.length > 16) return null;
  const out = [];
  for (const entry of windows) {
    if (!entry || typeof entry !== 'object') return null;
    const id = entry.window_id;
    if (typeof id !== 'string' || !/^[a-z0-9_:]{1,48}$/.test(id)) return null;
    const used = entry.used_pct;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1000) return null;
    const minutes = entry.window_minutes;
    if (minutes !== null && !(Number.isSafeInteger(minutes) && minutes > 0)) return null;
    out.push({ window_id: id, window_minutes: minutes, used_pct: used, resets_at: isoOrNull(entry.resets_at) });
  }
  return out;
}

function parseTokens(tokens) {
  if (tokens === undefined) return {};
  if (!tokens || typeof tokens !== 'object') return null;
  const out = {};
  for (const key of GUARD_TOKEN_KEYS) {
    if (tokens[key] === undefined) continue;
    if (!Number.isSafeInteger(tokens[key]) || tokens[key] < 0) return null;
    out[key] = tokens[key];
  }
  return out;
}

/**
 * One stderr line → `{type:'started', nonce, seq}` | `{type:'heartbeat', seq}` | `{type:'meter', …}` | null (the agent's own stderr, or a
 * malformed guard line). A line is a guard line only if it parses as a complete, valid record.
 */
export function parseGuardLine(line) {
  if (typeof line !== 'string' || line.length > 64 * 1024 || !line.startsWith('{"type":"faravan.')) return null;
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || value.v !== 1 || !Number.isSafeInteger(value.seq) || value.seq < 0) return null;
  if (value.type === 'faravan.started' && /^[a-f0-9]{32}$/.test(value.nonce) && isoOrNull(value.at))
    return { type: 'started', nonce: value.nonce, seq: value.seq, at: value.at };
  if (value.type === 'faravan.exit') {
    const signal = s => s === null || (typeof s === 'string' && Object.hasOwn(osConstants.signals, s));
    if (!/^[a-f0-9]{32}$/.test(value.nonce) ||
        !(value.agent_exit_code === null || (Number.isSafeInteger(value.agent_exit_code) && value.agent_exit_code >= 0 && value.agent_exit_code <= 255)) ||
        !signal(value.agent_signal) || !signal(value.outside_signal) || typeof value.group_ceased !== 'boolean' ||
        typeof value.stop_imposed !== 'boolean' ||
        (value.leftover_terminated !== undefined && typeof value.leftover_terminated !== 'boolean') ||
        !(value.stop_reason === null || STOP_REASONS.includes(value.stop_reason)) ||
        value.stop_imposed !== (value.stop_reason !== null) ||
        !(value.elapsed_ms === null || (Number.isSafeInteger(value.elapsed_ms) && value.elapsed_ms >= 0))) return null;
    return { type: 'exit', seq: value.seq, nonce: value.nonce, agent_exit_code: value.agent_exit_code,
      agent_signal: value.agent_signal, group_ceased: value.group_ceased, stop_imposed: value.stop_imposed,
      stop_reason: value.stop_reason, outside_signal: value.outside_signal, elapsed_ms: value.elapsed_ms,
      ...(value.leftover_terminated !== undefined ? {leftover_terminated: value.leftover_terminated} : {}) };
  }
  if (value.type === 'faravan.heartbeat') return { type: 'heartbeat', seq: value.seq };
  if (value.type !== 'faravan.meter' || !METER_SOURCES.includes(value.source) || !isoOrNull(value.at)) return null;
  const windows = parseWindows(value.windows);
  const tokens = parseTokens(value.tokens);
  if (!windows || !tokens) return null;
  for (const key of ['cost_usd', 'used_units', 'budget_units']) if (value[key] !== undefined && !finiteOrNull(value[key])) return null;
  return {
    type: 'meter', seq: value.seq, at: value.at, source: value.source,
    model: shortString(value.model, 80), effort: shortString(value.effort, 20), tokens, windows,
    cost_usd: value.cost_usd ?? null, used_units: value.used_units ?? null, budget_units: value.budget_units ?? null,
    status: shortString(value.status, 40),
    ...(typeof value.overage === 'boolean' ? { overage: value.overage } : {}),
    ...(typeof value.limit_reached === 'boolean' ? { limit_reached: value.limit_reached } : {}),
    final: value.final === true,
  };
}

/** Text of <ctl>/stop.json → the record, or null if anything about it is off. */
export function validateStopRecord(text, { nonce }) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_STOP_RECORD_BYTES || typeof nonce !== 'string' || !nonce) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== STOP_KEYS.length || !STOP_KEYS.every((key) => Object.hasOwn(value, key))) return null;
  if (value.schema !== 'faravan.stop.v1' || value.nonce !== nonce) return null;
  if (!STOP_REASONS.includes(value.stop_reason)) return null;
  if (!finiteOrNull(value.budget_units) || !finiteOrNull(value.used_units)) return null;
  if (value.agent_exit !== null && !(Number.isSafeInteger(value.agent_exit) && value.agent_exit >= 0 && value.agent_exit <= 255)) return null;
  if (value.signal !== null && !STOP_SIGNALS.includes(value.signal)) return null;
  return Object.fromEntries(STOP_KEYS.map((key) => [key, value[key]]));
}

/**
 * Claude's native cap overshoots by up to one model call, so `--max-budget-usd` is the budget minus the largest call this
 * account has seen for the model. Before any history, the worst call the model can make at the prompt sizes it can reach
 * (worstCallUsd in lib/v1/lending-meter.mjs; design D3, review r2 N21). Returns the headroom in USD.
 */
export function claudeHeadroomUsd({ observedMaxCallUsd = null, worstCaseUsd = null } = {}) {
  if (Number.isFinite(observedMaxCallUsd) && observedMaxCallUsd > 0) return observedMaxCallUsd;
  if (!Number.isFinite(worstCaseUsd) || worstCaseUsd < 0) throw new TypeError('headroom needs an observed call cost or a worst-case call cost');
  return worstCaseUsd;
}

export function claudeMaxBudgetUsd({ limitUsd, headroomUsd }) {
  if (!Number.isFinite(limitUsd) || limitUsd <= 0 || !Number.isFinite(headroomUsd) || headroomUsd < 0) return null;
  const cap = Math.floor((limitUsd - headroomUsd) * 1e6) / 1e6;
  return cap > 0 ? cap : null;
}
