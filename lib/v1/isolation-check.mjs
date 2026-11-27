// Deterministic admission checks in the prepared job, before any agent starts.
import {guestRuntimeCommand, runtimeError, RUNTIME_HELP} from '../guest-runtime.mjs';
import {readFile, writeFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {extractReport, validateProbeReport} from './credential-probe.mjs';
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
export const ISOLATION_TARGETS = Object.freeze(['169.254.169.254', '10.0.0.1', '192.168.1.1', '172.16.0.1', '100.64.0.1']);
const dnsName = host => typeof host === 'string' && host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
const ipv4 = host => typeof host === 'string' && host.split('.').length === 4 && host.split('.').every(n => /^(0|[1-9]\d{0,2})$/.test(n) && Number(n) <= 255);
export function isolationControl(adapter) {
  return adapter?.spec?.provider_domains?.find(dnsName)?.toLowerCase() ?? null;
}

/** Self-contained guest program: observations only, never a guest-authored verdict. */
export async function isolationGuest(controlHost, fixedTargets) {
  const fs = require('node:fs'), http = require('node:http'), https = require('node:https');
  let gateway = null;
  try {
    for (const line of fs.readFileSync('/proc/net/route', 'utf8').trim().split(/\r?\n/).slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[1] !== '00000000' || !/^[0-9a-f]{8}$/i.test(fields[2]) || !(parseInt(fields[3], 16) & 2)) continue;
      gateway = fields[2].match(/../g).reverse().map(n => parseInt(n, 16)).join('.');
      if (gateway !== '0.0.0.0') break;
      gateway = null;
    }
  } catch { /* Missing routing information is explicitly inconclusive. */ }
  const observe = (host, protocol, port) => new Promise(resolve => {
    let finished = false, request;
    const base = { host, protocol, port };
    const finish = result => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      resolve({ ...base, ...result });
      request?.destroy();
    };
    const timer = setTimeout(() => finish({ observation: 'error', status: null, tlsAuthorized: false, error: 'timeout' }), 4000);
    try {
      // Honor the guest's configured HTTP agent: it routes policy-denied HTTP
      // requests to the sandbox proxy so its denial can be observed and logged.
      request = (protocol === 'https:' ? https : http).request({ hostname: host, port, path: '/', method: 'HEAD', rejectUnauthorized: true }, response => {
        finish({ observation: 'response', status: response.statusCode, tlsAuthorized: protocol === 'https:' && response.socket.authorized === true, error: null });
        response.destroy();
      });
      request.on('error', error => finish({ observation: 'error', status: null, tlsAuthorized: false, error: String(error.code || 'request_failed').slice(0, 80) }));
      request.end();
    } catch (error) {
      finish({ observation: 'error', status: null, tlsAuthorized: false, error: String(error.code || 'request_failed').slice(0, 80) });
    }
  });
  const hosts = [...new Set([...fixedTargets, ...(gateway ? [gateway] : [])])];
  const [control, ...targets] = await Promise.all([observe(controlHost, 'https:', 443), ...hosts.map(host => observe(host, 'http:', 80))]);
  process.stdout.write(JSON.stringify({ schema: 1, completed: true, gateway, control, targets }) + '\n');
}
export const isolationScript = (host, runtimePath) => dnsName(host)
  ? quote(runtimePath) + ' -e ' + quote('(' + isolationGuest.toString() + ')(' + JSON.stringify(host) + ',' + JSON.stringify(ISOLATION_TARGETS) + ').catch(() => { process.exitCode = 1; });')
  : null;

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Validate raw policy snapshots before interpreting their exact-sandbox observations.
 * A valid empty baseline is different from an unavailable or malformed policy log.
 */
export function isolationPolicy(result, sandboxId) {
  if (!sandboxId || result?.code !== 0 || typeof result.stdout !== 'string') return null;
  try {
    const raw = JSON.parse(result.stdout);
    if (!Array.isArray(raw.allowed) || !Array.isArray(raw.blocked)) return null;
    const hosts = Object.create(null);
    for (const [kind, rows] of [['allowed', raw.allowed], ['denied', raw.blocked]]) {
      for (const row of rows) {
        if (!row || typeof row !== 'object' || typeof row.sandbox_id !== 'string' || typeof row.host !== 'string') return null;
        if (row.sandbox_id !== sandboxId) continue;
        const host = row.host.toLowerCase().replace(/:\d+$/, '');
        if (!dnsName(host) && !ipv4(host)) return null;
        hosts[host] = kind;
      }
    }
    return hosts;
  } catch { return null; }
}

/** Guest output alone cannot prove isolation. Require fresh, exact-sandbox policy evidence. */
export function parseIsolation(stdout, { code, controlHost, before, after } = {}) {
  const invalid = () => ({ ok: null, reached: [], denied: [], inconclusive: [...ISOLATION_TARGETS], control: false });
  if (code !== 0 || !dnsName(controlHost) || typeof stdout !== 'string') return invalid();
  let report;
  try { report = JSON.parse(stdout); } catch { return invalid(); }
  if (!exactKeys(report, ['schema', 'completed', 'gateway', 'control', 'targets']) || report.schema !== 1 || report.completed !== true
    || (report.gateway !== null && (!ipv4(report.gateway) || report.gateway === '0.0.0.0')) || !Array.isArray(report.targets)) return invalid();
  const expected = [...new Set([...ISOLATION_TARGETS, ...(report.gateway ? [report.gateway] : [])])];
  const rowValid = (row, host, protocol, port) => exactKeys(row, ['host', 'protocol', 'port', 'observation', 'status', 'tlsAuthorized', 'error'])
    && row.host === host && row.protocol === protocol && row.port === port && typeof row.tlsAuthorized === 'boolean'
    && (row.observation === 'response'
      ? Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 && row.error === null
      : row.observation === 'error' && row.status === null && row.tlsAuthorized === false && typeof row.error === 'string' && row.error.length > 0 && row.error.length <= 80);
  if (!rowValid(report.control, controlHost, 'https:', 443) || report.targets.length !== expected.length
    || new Set(report.targets.map(row => row?.host)).size !== expected.length
    || report.targets.some(row => !expected.includes(row?.host) || !rowValid(row, row.host, 'http:', 80) || row.tlsAuthorized)) return invalid();
  const response = row => row.observation === 'response' && ![502, 503, 504].includes(row.status);
  const fresh = (host, observation) => before !== null && after !== null && before !== undefined && after !== undefined
    && !Object.hasOwn(before, host) && Object.hasOwn(after, host) && after[host] === observation;
  // Provisioning can already have contacted the provider. The live TLS response
  // proves this request completed; policy still must allow it and never block it.
  const control = response(report.control) && report.control.tlsAuthorized && before != null
    && after != null && after[controlHost] === 'allowed';
  const denied = [], reached = [], inconclusive = [];
  for (const row of report.targets) {
    if (response(row) && fresh(row.host, 'denied')) denied.push(row.host);
    else if (response(row) && fresh(row.host, 'allowed') && row.status !== 403) reached.push(row.host);
    else inconclusive.push(row.host);
  }
  // A 403 with no blocked observation may be a proxy denial: not upstream proof.
  if (report.gateway === null) inconclusive.push('default_gateway');
  return { ok: reached.length ? false : control && !inconclusive.length ? true : null, reached, denied, inconclusive, control };
}

async function readIsolationPolicy(backend, handle) {
  try { return isolationPolicy(await backend.runSbx(['policy', 'log', handle.sandbox_id, '--json'],{sbxRuntime:handle._sbxRuntime}), handle.sandbox_id); }
  catch { return null; }
}


// The whole check shares one budget, built from measured parts (sandbox daemon logs, Linux sbx 0.51, n=181 check runs):
//   cold boot while another sandbox runs, p95   7.8 s  (COLD_BOOT)
//   exec time, p95s summed                     10.5 s  (EXEC: egress 5.0 + user credential 0.8 + root credential 4.2 + five short execs 0.5)
//   slowdown from one concurrent sandbox, p95   5.7 s  (CONCURRENCY)
//   one cold restart, p95                      10.2 s  (RESTART: the VM auto-stops 30 s after its last exec, so it can stop just before the check)
//   sum 34.2 s, rounded up to 35 s. Cross-check: the observed maximum is 30.6 s on its own and 29.7 s beside another sandbox.
export const ISOLATION_COLD_BOOT_P95_MS = 7800;
export const ISOLATION_EXEC_P95_MS = 10500;
export const ISOLATION_CONCURRENCY_P95_MS = 5700;
export const ISOLATION_RESTART_P95_MS = 10200;
export const ISOLATION_CHECK_BUDGET_MS = Math.ceil((ISOLATION_COLD_BOOT_P95_MS + ISOLATION_EXEC_P95_MS
  + ISOLATION_CONCURRENCY_P95_MS + ISOLATION_RESTART_P95_MS) / 1000) * 1000;

export async function checkJobIsolation({backend, handle, adapter, signal, timeoutMs = ISOLATION_CHECK_BUDGET_MS, monotonic = () => performance.now()}) {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const startedAt=monotonic(),endsAt=startedAt+timeoutMs;
  const remaining=()=>Math.max(0,Math.floor(endsAt-monotonic()));
  const expired=()=>combined.aborted||remaining()<=0;
  let timer, guestProbeCopied=false;
  const entrypoint = handle._entrypoint;
  const probeFile = join(handle.scratch_dir, '.faravan-isolation-'+randomUUID()+'.mjs');
  // The step name and elapsed time say where a slow host ran out of budget. No paths, tokens or prompts.
  let step='start';
  const inconclusiveNow = () => ({state:'inconclusive', code:'isolation_check_inconclusive', details:{step, elapsedMs:Math.max(0,Math.round(monotonic()-startedAt)), budgetMs:timeoutMs}});
  const run = async command => {
    handle._entrypoint = command;
    handle._lastExecStdout = '';
    try { await backend.start(handle, {signal:combined}); return {code:0, stdout:handle._lastExecStdout ?? ''}; }
    catch (error) { if (error.code === 'guard_runtime_unavailable') throw error; return {code:error.exitCode ?? 1, stdout:error.stdout ?? ''}; }
    finally { handle._entrypoint = entrypoint; }
  };
  try {
    const deadline = new Promise(resolve => { timer=setTimeout(()=>{controller.abort();resolve(inconclusiveNow());},timeoutMs); });
    const checks = (async()=>{
      step='control_host';
      const controlHost=isolationControl(adapter);
      if (!controlHost) return inconclusiveNow();
      if (!backend.ensureGuestRuntime) throw runtimeError();
      step='guest_runtime';
      const runtime = await backend.ensureGuestRuntime(handle);
      const command=isolationScript(controlHost, runtime.node);
      if(!command)return inconclusiveNow();
      step='policy_before';
      const before=await readIsolationPolicy(backend,handle);
      if(expired())return inconclusiveNow();
      step='network_probe';
      const network=await run(guestRuntimeCommand(runtime, command));
      if(expired())return inconclusiveNow();
      step='policy_after';
      const after=await readIsolationPolicy(backend,handle);
      step='network_verdict';
      const parsed=parseIsolation(network.stdout,{code:network.code,controlHost,before,after});
      if(parsed.ok===false) {
        const destinations=[...new Set(parsed.reached.map(host=>host==='169.254.169.254'?'cloud metadata':ISOLATION_TARGETS.includes(host)?'your home network':"this computer's network gateway"))];
        return {state:'failed',code:'isolation_check_failed',blocker:'The sandbox could reach '+destinations.join(' and ')+'. Check Docker Sandboxes, then resume lending to try again.'};
      }
      if(parsed.ok!==true||expired())return inconclusiveNow();
      step='credential_probe_stage';
      const text=await readFile(new URL('./credential-probe-guest.mjs',import.meta.url),'utf8');
      if(expired())return inconclusiveNow();
      await writeFile(probeFile,text,{mode:0o644,flag:'wx'});
      if(expired())return inconclusiveNow();
      if(handle._mountless) {
        step='credential_probe_copy';
        const copied=await backend.runSbx(['cp',probeFile,handle.sandbox_id+':'+probeFile],{signal:combined,sbxRuntime:handle._sbxRuntime});
        guestProbeCopied=copied?.code===0;
        if(!guestProbeCopied||expired())return inconclusiveNow();
      }
      // A mounted runtime is Faravan's own read-only Node, proven read-only when it was installed. The probe accepts that one
      // mount, and only while the guest still sees it read-only.
      const runtimeMount=runtime.method==='mount'&&typeof runtime.dir==='string'?' --allow-ro-mount '+quote(runtime.dir):'';
      // Scope and generation come from host preparation, never the guest report or environment.
      const ownerGeneration=handle._executionScope==='owner'&&handle._ownerProviderGeneration?.service===adapter.spec.provider_service_id
        ? handle._ownerProviderGeneration : undefined;
      const ownerArgs=ownerGeneration?' --owner-generation '+quote(Buffer.from(JSON.stringify(ownerGeneration)).toString('base64url')):'';
      step='credential_probe';
      const credentials=await run(guestRuntimeCommand(runtime, quote(runtime.node)+' '+quote(probeFile)+' --provider '+quote(adapter.spec.provider_service_id)+' --budget-ms '+remaining()+runtimeMount+ownerArgs+' --exclude-workspace '+quote(handle.scratch_dir)));
      if(expired())return inconclusiveNow();
      const report=extractReport(credentials.stdout);
      if(!validateProbeReport(report,{ownerGeneration}).ok)return inconclusiveNow();
      if(report.verdict==='fail')return {state:'failed',code:'isolation_check_failed',blocker:"The sandbox could read your agent sign-in. Check Docker Sandboxes, then resume lending to try again."};
      if(report.verdict!=='pass'||credentials.code!==0)return inconclusiveNow();
      if(guestProbeCopied) {
        step='credential_probe_cleanup';
        const removed=await backend.runSbx(['exec',handle.sandbox_id,'--','rm','-f','--',probeFile],{signal:combined,sbxRuntime:handle._sbxRuntime});
        if(removed?.code!==0||expired())return inconclusiveNow();
        guestProbeCopied=false;
      }
      // Snapshot after both probes. A failed snapshot leaves later traffic unattributed.
      step='egress_snapshot';
      const baseline=await backend.snapshotEgress?.(handle,{signal:combined})??null;
      if(expired())return inconclusiveNow();
      handle._egressBaseline=baseline;
      if(handle._execution)handle._execution.egress_evidence=null;
      return {state:'pass'};
    })();
    return await Promise.race([checks,deadline]);
  } catch (error) {
    if (error.code === 'guard_runtime_unavailable') return {state:'failed', code:error.code, blocker:RUNTIME_HELP};
    return inconclusiveNow();
  }
  finally {
    clearTimeout(timer);handle._entrypoint=entrypoint;
    if(guestProbeCopied)await backend.runSbx(['exec',handle.sandbox_id,'--','rm','-f','--',probeFile],{signal:combined,sbxRuntime:handle._sbxRuntime}).catch(()=>{});
    await unlink(probeFile).catch(()=>{});
  }
}
