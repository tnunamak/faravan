// One guest network witness: can a sandbox reach private addresses that the host itself owns?
//
// For each declared private IPv4 family that the host owns an address in, the host opens an ephemeral listener on that
// address and proves it answers the host (its control). One guest command then calls every listener twice: with no proxy,
// and through the guest's configured proxy. The verdict combines three kinds of evidence:
//   host-owned:  each listener's own request count, and one fresh exact-sandbox `sbx policy log` before and after;
//   guest-told:  the two curl exit codes and HTTP codes for each canary (reported by the guest, so never enough alone).
// This is aggregate evidence for the owned canaries only. It cannot replace the host's policy readback or its per-target
// decision checks, which cover every declared range. Success needs every canary present and in the shape that was
// calibrated on a real sandbox; a missing, extra or contradictory observation is never success.
import http from 'node:http';
import os from 'node:os';
import {randomUUID} from 'node:crypto';

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const ipv4 = host => typeof host === 'string' && host.split('.').length === 4
  && host.split('.').every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
const ipv4Int = ip => ip.split('.').reduce((total, part) => total * 256 + Number(part), 0);
const inFamily = (ip, family) => {
  const [network, bits] = family.split('/');
  const size = 2 ** (32 - Number(bits));
  return Math.floor(ipv4Int(ip) / size) === Math.floor(ipv4Int(network) / size);
};

/** The RFC 1918 families a witness can prove with an owned canary. Each is also one of the declared private denies. */
export const WITNESS_FAMILIES = Object.freeze(['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']);

/** Calibrated shapes on a real sandbox: no proxy gives curl 52 and no HTTP code; the configured proxy answers 403. */
export const WITNESS_QUALIFIED = Object.freeze({direct: Object.freeze({rc: 52, http: '000'}), configured: Object.freeze({rc: 0, http: '403'})});

/** One guest command covers every canary: two bounded curls (2 s each) per family, plus 4 s for the two policy-log reads and slack. */
export const WITNESS_BUDGET_MS = 4_000 + 4_000 * WITNESS_FAMILIES.length;

/**
 * The host's canaries: for each declared family, the first non-loopback IPv4 address of this host inside it.
 * A family with no owned address has `address: null`, so the caller can report it as evaluator-only.
 */
export function ownedCanaries(interfaces = os.networkInterfaces()) {
  const addresses = Object.values(interfaces ?? {}).flat()
    .filter(row => row?.family === 'IPv4' && row.internal === false && ipv4(row.address)).map(row => row.address);
  return WITNESS_FAMILIES.map(family => ({family, address: addresses.find(address => inFamily(address, family)) ?? null}));
}

/**
 * The single guest command. For each canary in $WITNESS_URLS (space-separated) it reports one JSON line tagged with the
 * host's nonce and the canary's number. It reports observations only; the host judges them.
 */
export const WITNESS_COMMAND = [
  'if ! command -v curl >/dev/null 2>&1; then printf \'{"schema":1,"nonce":"%s","tool":"missing"}\\n\' "$WITNESS_NONCE"; exit 0; fi',
  'check(){ code=$(curl -sS --connect-timeout 1 --max-time 2 -o /dev/null -w "%{http_code}" "$@" 2>/dev/null); echo "$?" "$code"; }',
  'i=0; for u in $WITNESS_URLS; do d=$(check --noproxy "*" "$u"); c=$(check "$u"); printf \'{"schema":1,"nonce":"%s","canary":"%s","direct":"%s","configured":"%s"}\\n\' "$WITNESS_NONCE" "$i" "$d" "$c"; i=$((i+1)); done',
].join('; ');

const transport = text => {
  const match = typeof text === 'string' ? /^(\d{1,3}) (\d{3})$/.exec(text) : null;
  return match && Number(match[1]) <= 255 ? {rc: Number(match[1]), http: match[2]} : null;
};

/**
 * Output for `canaries` canaries: exactly one nonce-tagged line per canary, numbered "0" to "n-1", each with exactly the known
 * keys. Other lines (banners, warnings) are ignored. Returns {tool:'missing'} when curl is absent, the results in canary order
 * ([{direct, configured}]), or null for anything missing, duplicated, extra, stale or malformed.
 */
export function parseWitnessOutput(stdout, nonce, canaries) {
  if (typeof stdout !== 'string' || typeof nonce !== 'string' || !nonce || !Number.isInteger(canaries) || canaries < 1) return null;
  const tagged = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (value && typeof value === 'object' && value.nonce === nonce) tagged.push(value);
  }
  if (tagged.length === 1 && tagged[0].schema === 1 && exactKeys(tagged[0], ['schema', 'nonce', 'tool']))
    return tagged[0].tool === 'missing' ? {tool: 'missing'} : null;
  if (tagged.length !== canaries) return null;
  const results = new Array(canaries);
  for (const report of tagged) {
    if (report.schema !== 1 || !exactKeys(report, ['schema', 'nonce', 'canary', 'direct', 'configured'])) return null;
    const index = typeof report.canary === 'string' && /^(0|[1-9]\d*)$/.test(report.canary) ? Number(report.canary) : -1;
    const direct = transport(report.direct), configured = transport(report.configured);
    if (index < 0 || index >= canaries || results[index] || !direct || !configured) return null;
    results[index] = {direct, configured};
  }
  return results.every(Boolean) ? results : null;
}

/**
 * Counts for each endpoint, for this sandbox only. Exact `address:port` rows are attributable to that endpoint. Port-less rows
 * for an address could be other traffic to it, so they are counted apart. A malformed row, or a duplicate counter key of this
 * sandbox, makes the whole snapshot ambiguous. Returns one {allowed, blocked, bareAllowed, bareBlocked} per endpoint, or null.
 */
export function parseWitnessAudit(stdout, {sandboxId, endpoints} = {}) {
  if (typeof stdout !== 'string' || !sandboxId || !Array.isArray(endpoints) || endpoints.length === 0) return null;
  if (!endpoints.every(endpoint => endpoint && ipv4(endpoint.address) && Number.isInteger(endpoint.port) && endpoint.port >= 1 && endpoint.port <= 65535))
    return null;
  let document;
  try { document = JSON.parse(stdout); } catch { return null; }
  if (!document || !Array.isArray(document.allowed) || !Array.isArray(document.blocked)) return null;
  const count = rows => {
    const totals = endpoints.map(() => ({exact: 0, bare: 0}));
    const keys = new Set();
    for (const row of rows) {
      if (!row || typeof row !== 'object' || typeof row.sandbox_id !== 'string' || typeof row.host !== 'string') return null;
      if (row.sandbox_id !== sandboxId) continue;
      const matches = [];
      endpoints.forEach(({address, port}, index) => {
        if (row.host === address + ':' + port) matches.push([index, 'exact']);
        else if (row.host === address) matches.push([index, 'bare']);
      });
      if (matches.length === 0) continue;
      if (!Number.isSafeInteger(row.count) || row.count < 1 ||
          (row.proxy_type !== undefined && (typeof row.proxy_type !== 'string' || row.proxy_type.length > 64))) return null;
      const key = row.host + '\0' + (row.proxy_type ?? '');
      if (keys.has(key)) return null;
      keys.add(key);
      for (const [index, kind] of matches) {
        totals[index][kind] += row.count;
        if (!Number.isSafeInteger(totals[index][kind])) return null;
      }
    }
    return totals;
  };
  const allowed = count(document.allowed), blocked = count(document.blocked);
  if (!allowed || !blocked) return null;
  return endpoints.map((_, index) => ({allowed: allowed[index].exact, blocked: blocked[index].exact,
    bareAllowed: allowed[index].bare, bareBlocked: blocked[index].bare}));
}

const FIELDS = ['allowed', 'blocked', 'bareAllowed', 'bareBlocked'];
const counts = value => value && FIELDS.every(field => Number.isInteger(value[field]) && value[field] >= 0);
const same = (observed, expected) => observed?.rc === expected.rc && observed?.http === expected.http;

/**
 * Pure verdict for one canary. `failed` needs host-owned evidence of a leak (the listener was reached, or the exact sandbox's
 * policy log gained an allowed occurrence for the exact address and port).
 * `verified` needs every observation, both transports in the calibrated shape, no listener hit, no allowed row
 * and at least one fresh blocked row naming this run's exact address:port, with no new port-less row that
 * could belong to other traffic and no row for the unique port that was already there before the run (stale).
 * Everything else is `inconclusive` with a reason. Every verdict carries the raw before/after counts.
 */
export function judgeWitness({control, hits, guest, before, after} = {}) {
  const auditOk = counts(before) && counts(after);
  const result = (state, reason, extra = {}) => ({state, reason, ...extra, ...(auditOk ? {before, after} : {})});
  if (Number.isInteger(hits) && hits > 0) return result('failed', 'listener_reached', {hits});
  if (auditOk && after.allowed > before.allowed)
    return result('failed', 'policy_allowed', {allowedDelta: after.allowed - before.allowed});
  if (control !== true) return result('inconclusive', 'host_control_failed');
  if (!Number.isInteger(hits) || hits < 0) return result('inconclusive', 'listener_hits_unreadable');
  if (!auditOk) return result('inconclusive', 'audit_unavailable');
  if (FIELDS.some(field => after[field] < before[field])) return result('inconclusive', 'audit_regressed');
  if (before.allowed > 0 || before.blocked > 0) return result('inconclusive', 'stale_evidence');
  if (!guest) return result('inconclusive', 'guest_output_invalid');
  if (guest.tool === 'missing') return result('inconclusive', 'curl_missing');
  if (!same(guest.direct, WITNESS_QUALIFIED.direct) || !same(guest.configured, WITNESS_QUALIFIED.configured))
    return result('inconclusive', 'unqualified_shape', {direct: guest.direct, configured: guest.configured});
  const blockedDelta = after.blocked - before.blocked;
  if (after.bareAllowed > before.bareAllowed || after.bareBlocked > before.bareBlocked)
    return result('inconclusive', 'attribution_ambiguous');
  if (blockedDelta < 1) return result('inconclusive', 'no_block_recorded');
  return result('verified', null, {hits: 0, allowedDelta: 0, blockedDelta, direct: guest.direct, configured: guest.configured});
}

/**
 * One verdict for the batch. A failed canary fails the batch. The batch is verified only when every canary is verified.
 * Anything else is inconclusive, named by the first canary that is not verified. Each canary keeps its own verdict and counts.
 */
export function judgeBatch(canaries) {
  const open = canaries.filter(canary => canary.verdict.state !== 'verified');
  const failing = open.find(canary => canary.verdict.state === 'failed');
  // A canary that never started because a peer's control failed names the peer's failure, not its own.
  const blame = failing ?? open.find(canary => canary.verdict.reason !== 'batch_not_started') ?? open[0] ?? null;
  const total = field => canaries.reduce((sum, canary) => sum + (canary.verdict[field] ?? 0), 0);
  return {
    state: failing ? 'failed' : open.length ? 'inconclusive' : 'verified',
    reason: blame ? blame.verdict.reason : null,
    hits: total('hits'), allowedDelta: total('allowedDelta'), blockedDelta: total('blockedDelta'),
    canaries: canaries.map(({family, address, verdict}) => ({family, address, ...verdict})),
  };
}

/** A host-owned listener on one private address. Only the nonce-bound guest path counts as a hit. */
export async function ownedListener(address, {nonce = randomUUID()} = {}) {
  const controlPath = '/control-' + nonce;
  const guestPath = '/guest-' + nonce;
  let hits = 0;
  const server = http.createServer((request, response) => {
    if (request.url === guestPath) hits += 1;
    if (request.url === guestPath || request.url === controlPath) {
      response.writeHead(200, {'content-type': 'text/plain'}).end('fixture');
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, address, resolve));
  const port = server.address().port;
  const origin = 'http://' + address + ':' + port;
  return {
    address, port, url: origin + guestPath,
    hits: () => hits,
    async control() {
      try {
        const response = await fetch(origin + controlPath, {signal: AbortSignal.timeout(1500)});
        await response.text();
        return response.ok;
      } catch { return false; }
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/**
 * Run the witness once over every owned canary. Dependencies are injected so every path is testable without a sandbox:
 *   listen(address, {nonce}) -> listener            one host-owned listener per canary (default: ownedListener)
 *   exec({command, env}) -> {code, stdout}          the one guest command for all canaries
 *   audit([{address, port}, ...]) -> [{allowed, blocked}, ...] | null   one fresh exact-sandbox policy-log count per endpoint
 * No guest command starts unless every host control answered and the baseline audit was read.
 */
export async function runGuestEgressWitness({exec, audit, interfaces, listen = ownedListener, nonce = randomUUID()}) {
  const canaries = ownedCanaries(interfaces);
  const owned = canaries.filter(canary => canary.address !== null);
  // Declared families this host owns no address in: no traffic proof is possible, so the policy checks are their only evidence.
  const uncovered = canaries.filter(canary => canary.address === null).map(canary => canary.family);
  const finish = verdict => ({...verdict, uncovered});
  if (owned.length === 0) return finish({state: 'inconclusive', reason: 'no_private_ipv4', canaries: []});
  const opened = [];
  try {
    for (const {family, address} of owned) {
      try { opened.push({family, listener: await listen(address, {nonce})}); }
      catch { return finish({state: 'inconclusive', reason: 'listener_unavailable', canaries: []}); }
    }
    const controls = await Promise.all(opened.map(({listener}) => listener.control()));
    const judged = (before, guestFor, after) => judgeBatch(opened.map(({family, listener}, index) => ({family, address: listener.address,
      verdict: judgeWitness({control: controls[index], hits: listener.hits(), guest: guestFor(index),
        before: before?.[index] ?? null, after: after?.[index] ?? null})})));
    // One canary without a healthy control means no guest traffic. Healthy canaries did not start, so they are not judged on evidence they lack.
    if (controls.some(control => !control)) return finish(judgeBatch(opened.map(({family, listener}, index) => ({family, address: listener.address,
      verdict: controls[index] ? {state: 'inconclusive', reason: 'batch_not_started'} : judgeWitness({control: false, hits: listener.hits()})}))));
    const targets = opened.map(({listener}) => ({address: listener.address, port: listener.port}));
    const before = await audit(targets).catch(() => null);
    if (!Array.isArray(before) || before.length !== targets.length) return finish(judged(null, () => null, null));
    let result = null;
    try {
      result = await exec({command: WITNESS_COMMAND,
        env: {WITNESS_URLS: opened.map(({listener}) => listener.url).join(' '), WITNESS_NONCE: nonce}});
    } catch { /* judged below */ }
    const after = await audit(targets).catch(() => null);
    const parsed = result?.code === 0 ? parseWitnessOutput(result.stdout, nonce, opened.length) : null;
    const guestFor = index => Array.isArray(parsed) ? parsed[index] : parsed;
    return finish(judged(before, guestFor, Array.isArray(after) && after.length === targets.length ? after : null));
  } finally {
    await Promise.all(opened.map(({listener}) => listener.close().catch(() => {})));
  }
}
