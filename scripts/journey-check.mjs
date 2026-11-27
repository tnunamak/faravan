#!/usr/bin/env node
// Public CLI only: no app internals, credentials, HTTP, or automatic app startup.
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP = 'Usage: journey-check [--binary <faravan>] [--signin-probe] [--step-timeout-ms <ms>] [--expect-version <v>] [--lend-on --yes] [--send <git folder> --prompt <text> --yes [--apply] [--stop]] [--json]';
const BOOL = new Set(['--signin-probe', '--lend-on', '--yes', '--apply', '--stop', '--json', '--help']);
const KINDS = new Set(['docker_not_installed', 'docker_not_running', 'docker_signed_out', 'circle_unreachable', 'circle_update_needed', 'no_agents', 'agent_not_ready', 'agent_signed_out', 'lending_not_started', 'sandbox_not_ready']);
const FIXES = new Set(['signin.start', 'circles.check', 'agents.select', 'agents.check', 'lending.on', 'readiness.get']);
const STATES = new Set(['queued', 'claimed', 'result-accepted', 'failed', 'cancelled', 'expired']);
const KNOWN_ADAPTER_IDS = new Set(['docker', 'codex', 'claude-code-subscription', 'claude-code-api-key', 'gemini']);
const KNOWN_TARGETS = new Set([...KNOWN_ADAPTER_IDS, ...[...KNOWN_ADAPTER_IDS].map(id => `${id}-lending`)]);
const KNOWN_ERROR_CODES = new Set([
  'signin_failed', 'docker_not_installed', 'docker_not_running', 'docker_signed_out',
  'circle_unreachable', 'circle_update_needed',
  'no_agents', 'agent_not_ready', 'agent_signed_out', 'lending_not_started', 'sandbox_not_ready',
  'credential_writer_unresolved', 'signin_closed', 'signin_not_waiting_for_code', 'signin_unsupported',
]);
const KNOWN_CHECK_NAMES = new Set([
  'sbx_install', 'sbx_version', 'sbx_cli_contract', 'docker_runtime', 'sbx_daemon', 'kvm_access',
  'docker_login', 'network_policy', 'sbx_credential_store', 'socket_path_length', 'hypervisor_platform',
  'test_workspace', 'sandbox', 'v1_limits', 'sbx_keychain',
]);
const APP_READY_TIMEOUT_MS = 300000;
const APP_READY_POLL_MS = 1000;
const APP_READY_READ_MS = 10000;
const STOP_SUBMIT_TIMEOUT_MS = 5000;
const STOP_CANCEL_TIMEOUT_MS = 5000;
const STOP_CONFIRM_TIMEOUT_MS = 30000;
const TERMINATION_GRACE_MS = 250;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const truth = value => value === true ? 'yes' : value === false ? 'no' : 'unknown';
const checkArray = value => Array.isArray(value)
  && value.every(check => object(check) && typeof check.name === 'string' && typeof check.ok === 'boolean');

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (Object.hasOwn(options, flag)) throw new Error('Duplicate option.');
    if (BOOL.has(flag)) options[flag] = true;
    else if (flag === '--send' || flag === '--prompt' || flag === '--binary' || flag === '--step-timeout-ms' || flag === '--expect-version') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing option value.');
      options[flag] = value;
    } else throw new Error('Unknown option.');
  }
  if (options['--help']) return options;
  if (Boolean(options['--send']) !== Boolean(options['--prompt']) || options['--prompt']?.trim() === '')
    throw new Error('--send and a nonempty --prompt must be supplied together.');
  if (options['--apply'] && !options['--send']) throw new Error('--apply requires --send and --prompt.');
  if (options['--stop'] && !options['--send']) throw new Error('--stop requires --send and --prompt.');
  if ((options['--send'] || options['--lend-on'] || options['--apply']) && !options['--yes'])
    throw new Error('--yes is required before sending, lending, or applying.');
  if (options['--expect-version'] && (!options['--expect-version'].trim() || options['--expect-version'].length > 128
      || /[\s\u0000-\u001f\u007f]/.test(options['--expect-version'])))
    throw new Error('--expect-version requires a nonempty version without whitespace (at most 128 characters).');
  if (options['--binary']?.trim() === '') throw new Error('--binary requires a path.');
  if (options['--step-timeout-ms'] && (!/^\d+$/.test(options['--step-timeout-ms'])
      || Number(options['--step-timeout-ms']) < 1000 || Number(options['--step-timeout-ms']) > 300000))
    throw new Error('--step-timeout-ms must be between 1000 and 300000.');
  return options;
}

// The injected runner has exactly the subprocess boundary: executable, argv, options.
// Capture both streams. Never echo stderr, raw JSON, child errors, prompt, or paths.
export function cliRunner(file, args, options) {
  return new Promise(resolveRun => {
    const {timeout = 300000, killGraceMs = TERMINATION_GRACE_MS, ...execOptions} = options;
    let timedOut = false;
    let settled = false;
    let escalationTimer;
    let abandonTimer;
    const settle = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(escalationTimer);
      clearTimeout(abandonTimer);
      resolveRun(result);
    };
    const child = execFile(file, args, {...execOptions, timeout: 0}, (error, stdout, stderr) => settle({
      code: timedOut || error?.code === 'ETIMEDOUT' || error?.killed || error?.signal
        ? 5 : error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
      stdout, stderr,
    }));
    // Timeout cleanup signals the CLI process itself. A wrapper's own descendants are not
    // signalled: execFile cannot start the child in a new process group.
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalationTimer = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      // A descendant that inherited stdout/stderr can hold the pipes open after the child exits, so execFile's
      // callback may never come. Stop reading and settle as a timeout so the step keeps its wall bound.
      abandonTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle({code: 5, stdout: '', stderr: ''});
      }, killGraceMs * 2);
    }, timeout);
  });
}

async function npmVerify(folder) {
  let source;
  try { source = await readFile(join(folder, 'package.json'), 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return false;
    throw new Error('Cannot inspect package.json.');
  }
  let pkg;
  try { pkg = JSON.parse(source); } catch { throw new Error('Invalid package.json.'); }
  return typeof pkg?.scripts?.test === 'string' && pkg.scripts.test.trim().length > 0;
}

function publicLabel(value, response, {adapterId = false} = {}) {
  const secrets = [];
  const visit = (entry, sensitive = false) => {
    if (typeof entry === 'string') { if (sensitive && entry) secrets.push(entry); }
    else if (Array.isArray(entry)) entry.forEach(item => visit(item, sensitive));
    else if (object(entry)) for (const [key, item] of Object.entries(entry))
      visit(item, sensitive || /token|secret|password|credential|authorization|cookie|private|api.?key|signature/i.test(key));
  };
  visit(response);
  if (typeof value !== 'string' || secrets.some(secret => value.includes(secret))) return '[redacted label]';
  if (adapterId) return KNOWN_ADAPTER_IDS.has(value) ? value : '[redacted label]';
  if (!/^[\p{L}\p{N} ._-]{1,64}$/u.test(value)
      || /token|secret|password|credential|bearer|api.?key|sk-|gh[pousr]_|[A-Za-z0-9_-]{24}/i.test(value))
    return '[redacted label]';
  return value;
}

function isTerminalRemedy(fix) {
  // "Check readiness" or "Type your email" are in-app steps; only a named command line counts.
  return /```[\s\S]*?```|`[^`\n]+`|\b(?:docker|sbx)\s+login\b|\b(?:terminal|command prompt|shell|console)\b|\b(?:run|execute|type)\s+(?:sudo|sbx|docker|faravan|faravan|npm|npx|node|brew|curl|bash|sh|zsh|powershell|winget|apt|systemctl|launchctl)\b/i.test(fix);
}

export async function runJourney(argv = [], {
  runner = cliRunner, write = line => console.log(line), now = () => performance.now(),
  env = process.env, hasNpmTest = npmVerify, sleep = delay,
} = {}) {
  const rows = [];
  let jsonOutput = argv.includes('--json');
  function record(op, state, ms, detail) {
    const cleanDetail = String(detail).replace(/[\r\n|]/g, ' ').slice(0, 160);
    rows.push({step: op, state, ms, detail: cleanDetail});
  }
  function finish() {
    const firstFail = rows.find(row => row.state === 'FAIL')?.step ?? null;
    const result = firstFail ? 'FAIL' : 'PASS';
    if (jsonOutput) write(JSON.stringify({steps: rows, result, first_fail: firstFail}));
    else {
      write('step | PASS/FAIL/SKIP | ms | detail');
      for (const row of rows) write(`${row.step} | ${row.state} | ${row.ms} | ${row.detail}`);
      write(`RESULT ${result} first_fail=${firstFail ?? 'none'}`);
    }
    return firstFail ? 1 : 0;
  }
  let options;
  try { options = parseArgs(argv); }
  catch (error) { record('arguments', 'FAIL', 0, error.message); return finish(); }
  if (options['--help']) { write(HELP); return 0; }
  jsonOutput = Boolean(options['--json']);
  const binary = options['--binary'] ?? env.FARAVAN_BINARY ?? 'faravan';
  const stepTimeout = Number(options['--step-timeout-ms'] ?? 300000);
  async function step(op, input, summarize, yes = false, {
    includeFailureCode = false, keepFailedData = false, stepName = op, timeout = stepTimeout,
    onIndeterminate = () => {},
  } = {}) {
    const start = now();
    try {
      const args = ['ops', 'call', op, '--input', JSON.stringify(input), '--json', ...(yes ? ['--yes'] : [])];
      const reply = await runner(binary, args, {
        env: {...env, FARAVAN_NO_AUTOSTART: '1', FARAVAN_NO_BROWSER: '1'},
        timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      });
      // Even CLI failure JSON and exception messages may include secrets.
      if (!Number.isInteger(reply?.code) || reply.code !== 0) {
        let detail = 'CLI failed; raw output suppressed.';
        if (reply?.code === 5) {
          detail = op === 'jobs.wait' ? 'Timed out; stop not confirmed.'
            : op === 'jobs.send_and_wait' ? 'Timed out; job may still run.'
              : 'Timed out; raw output suppressed.';
        }
        let failureData = null;
        if (includeFailureCode || keepFailedData) {
          try {
            const failure = JSON.parse(reply?.stdout ?? '');
            failureData = object(failure) ? failure : null;
            const code = failure?.error?.code ?? failure?.code;
            if (includeFailureCode && code !== undefined && code !== null)
              detail = `code=${typeof code === 'string' && KNOWN_ERROR_CODES.has(code) ? code : 'unknown_code'}`;
          } catch {}
        }
        record(stepName, 'FAIL', Math.max(0, Math.round(now() - start)), detail);
        // A structured error reply means the app answered and holds no pending flow for it.
        const answered = (failureData?.error?.code ?? failureData?.code) != null;
        if (op === 'signin.start' && !answered
            && !(typeof failureData?.flowId === 'string' && failureData.flowId.trim())) onIndeterminate();
        return keepFailedData ? failureData : null;
      }
      const data = JSON.parse(reply.stdout);
      const report = summarize(data);
      record(stepName, report.ok ? 'PASS' : 'FAIL', Math.max(0, Math.round(now() - start)), report.detail);
      return report.ok || keepFailedData ? data : null;
    } catch (error) {
      const detail = error?.code === 'ETIMEDOUT' || error?.killed || error?.signal
        ? `Timed out after ${timeout}ms; raw output suppressed.`
        : 'Invalid response or CLI unavailable; raw output suppressed.';
      record(stepName, 'FAIL', Math.max(0, Math.round(now() - start)), detail);
      if (op === 'signin.start') onIndeterminate();
      return null;
    }
  }
  const skip = (op, reason) => record(op, 'SKIP', 0, reason);

  // App startup is one elapsed-time budget, not a new per-step allowance on every poll.
  // update.status reports the running app, unlike the CLI executable's own version.
  async function waitForApp() {
    const start = now(), deadline = start + APP_READY_TIMEOUT_MS;
    const expected = options['--expect-version'];
    let last = 'no response';
    while (now() < deadline) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      let ready = false;
      try {
        const reply = await runner(binary, ['ops','call','update.status','--input','{}','--json'], {
          env: {...env, FARAVAN_NO_AUTOSTART:'1', FARAVAN_NO_BROWSER:'1'},
          timeout: Math.min(APP_READY_READ_MS, remaining), killGraceMs: 0,
          maxBuffer: 4 * 1024 * 1024, encoding:'utf8',
        });
        if (reply?.code !== 0) last = reply?.code === 5 ? 'CLI timed out' : 'CLI unavailable or refused connection';
        else {
          const data = JSON.parse(reply.stdout);
          if (!object(data) || !['faravan','apt','brew','development','disabled'].includes(data.owner)
              || typeof data.state !== 'string' || typeof data.automatic !== 'boolean'
              || !['currentVersion','candidate','checkedAt','nextCheckAt','notesUrl','waitingFor','error']
                .every(key => !Object.hasOwn(data, key) || data[key] === null || typeof data[key] === 'string')
              || (Object.hasOwn(data, 'notes') && (!Array.isArray(data.notes)
                || !data.notes.every(note => typeof note === 'string')))) last = 'invalid update.status response';
          else {
            last = data.currentVersion == null ? 'app answered; version unknown'
              : 'app answered; version=' + publicLabel(data.currentVersion, data);
            ready = expected === undefined || data.currentVersion === expected;
          }
        }
      } catch (error) {
        last = error?.code === 'ETIMEDOUT' || error?.killed || error?.signal
          ? 'CLI timed out' : 'invalid response or CLI unavailable';
      }
      // A late answer cannot turn an expired startup budget green.
      if (ready && now() <= deadline) {
        record('app.ready', 'PASS', Math.max(0, Math.round(now() - start)), last);
        return true;
      }
      const left = deadline - now();
      if (left <= 0) break;
      await sleep(Math.min(APP_READY_POLL_MS, left));
    }
    const elapsed = Math.max(0, Math.round(now() - start));
    record('app.ready', 'FAIL', elapsed, `Waited ${elapsed / 1000} seconds for the app${expected === undefined ? '' : ' at the expected version'}; last: ${last}.`);
    return false;
  }
  if (!await waitForApp()) return finish();

  await step('status.blockers', {}, data => {
    if (typeof data?.can_lend !== 'boolean' || !Array.isArray(data.blockers)) throw new Error();
    const first = data.blockers[0];
    const kind = first ? (KINDS.has(first.kind) ? first.kind : 'unknown blocker') : 'none';
    const fix = first ? (FIXES.has(first.fix?.op) ? first.fix.op : 'human action / see status.blockers') : 'none';
    return {ok: data.can_lend && data.blockers.length === 0,
      detail: 'can_lend=' + data.can_lend + '; first=' + kind + '; fix=' + fix};
  });
  const agents = await step('agents.list', {}, data => {
    if (!Array.isArray(data)) throw new Error();
    return {ok: data.some(agent => agent?.signedIn === true && agent?.useForLending === true),
      detail: data.length ? data.map(agent => publicLabel(agent?.id, data, {adapterId: true}) + ': signed_in=' + truth(agent?.signedIn) + ', selected=' + truth(agent?.useForLending)).join('; ') : 'No agents.'};
  }, false, {keepFailedData: true});
  const readiness = await step('readiness.get', {refresh: true}, data => ({
    ok: typeof data?.ready === 'boolean' && checkArray(data.checks),
    detail: 'ready=' + truth(data?.ready) + '; checks=' + (Array.isArray(data?.checks) ? data.checks.length : 'unknown'),
  }), false, {keepFailedData: true});
  const doctor = await step('doctor.run', {quick: true}, data => ({
    ok: ['ready', 'setup_required'].includes(data?.status) && checkArray(data.checks),
    detail: 'status=' + (['ready', 'setup_required'].includes(data?.status) ? data.status : 'unknown')
      + '; checks=' + (Array.isArray(data?.checks) ? data.checks.length : 'unknown'),
  }), false, {keepFailedData: true});
  const safeCheckName = value => typeof value === 'string' && KNOWN_CHECK_NAMES.has(value) ? value : 'unknown_check';
  const safeTargetLabel = value => typeof value === 'string' && KNOWN_TARGETS.has(value) ? value : 'other-target';
  const safeHost = value => typeof value === 'string' && value.length <= 253
    && /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)
    && !/(token|secret|password|credential|bearer|api.?key|[a-z0-9_-]{24,})/i.test(value)
    ? value : '[redacted host]';
  if (readiness && doctor) {
    const validReadiness = typeof readiness.ready === 'boolean' && checkArray(readiness.checks);
    const validDoctor = ['ready', 'setup_required'].includes(doctor.status) && checkArray(doctor.checks);
    const failedCheck = validDoctor ? doctor.checks.find(check => check.ok === false) : null;
    let consistent = true;
    let consistencyDetail = 'Readiness agrees with doctor checks.';
    if (!validReadiness || !validDoctor) {
      consistent = false;
      consistencyDetail = 'Invalid readiness or doctor check shape.';
    } else if (readiness.ready && failedCheck) {
      consistent = false;
      consistencyDetail = `ready=true; doctor check false: ${safeCheckName(failedCheck.name)}`;
    } else if (readiness.ready && doctor.status === 'setup_required') {
      consistent = false;
      consistencyDetail = 'ready=true; doctor status setup_required.';
    } else if (!readiness.ready && doctor.status === 'ready' && doctor.checks.every(check => check.ok)) {
      consistent = false;
      consistencyDetail = 'ready=false; doctor status ready with all checks passing.';
    }
    await stepResult('readiness.doctor-consistency', consistent, consistencyDetail);
    const badRemedy = validDoctor ? doctor.checks.find(check => typeof check.fix === 'string' && isTerminalRemedy(check.fix)) : null;
    await stepResult('doctor.remedies', !badRemedy,
      badRemedy ? `Terminal command remedy: ${safeCheckName(badRemedy.name)}` : 'No terminal command remedies.');
  } else {
    skip('readiness.doctor-consistency', 'Readiness or doctor checks unavailable.');
    skip('doctor.remedies', 'Doctor checks unavailable.');
  }


  async function stepResult(op, ok, detail) {
    const start = now();
    record(op, ok ? 'PASS' : 'FAIL', Math.max(0, Math.round(now() - start)), detail);
  }

  if (options['--signin-probe']) {
    const targets = ['docker', 'codex', 'claude-code-subscription'];
    for (const agent of Array.isArray(agents) ? agents : []) {
      if (agent?.lendingSignInTarget === true && typeof agent.id === 'string') targets.push(`${agent.id}-lending`);
      else if (typeof agent?.lendingSignInTarget === 'string' && agent.lendingSignInTarget)
        targets.push(agent.lendingSignInTarget);
    }
    const uniqueTargets = [...new Set(targets)];
    for (const target of uniqueTargets) {
      const started = await step('signin.start', {target}, data => {
        let host = null;
        if (typeof data?.url === 'string') {
          try {
            const url = new URL(data.url);
            if (url.protocol === 'https:' && url.hostname && !url.username && !url.password) host = safeHost(url.host);
          } catch {}
        }
        const alreadySignedIn = data?.already_signed_in === true || data?.alreadySignedIn === true
          || data?.status === 'already_signed_in' || data?.status === 'complete';
        const flowId = typeof data?.flowId === 'string' && data.flowId.trim().length > 0;
        const pending = data?.status === 'awaiting_browser';
        const knownCode = data?.code !== undefined && data.code !== null
          ? (typeof data.code === 'string' && KNOWN_ERROR_CODES.has(data.code) ? data.code : 'unknown_code') : null;
        const ok = alreadySignedIn || (pending && flowId && Boolean(host));
        const detail = alreadySignedIn ? 'Already signed in.'
          : pending && !flowId ? 'Pending sign-in; cleanup unknown because no flow id was returned.'
            : host ? `url_host=${host}` : knownCode ? `code=${knownCode}` : 'No HTTPS URL or signed-in result.';
        return {ok, detail};
      }, false, {includeFailureCode: true, keepFailedData: true,
        stepName: `signin.start[${safeTargetLabel(target)}]`,
        onIndeterminate: () => record(`signin.cleanup[${safeTargetLabel(target)}]`, 'FAIL', 0,
          'cleanup unknown; start may have completed.')});
      // signin.cancel returns the flow's view; any terminal status means nothing is left waiting.
      // Cancelling a flow that already ended is harmless, so every returned flow id is cancelled.
      const OPEN_FLOW = ['starting', 'awaiting_browser'], ENDED_FLOW = ['cancelled', 'complete', 'failed', 'timed_out'];
      if (typeof started?.flowId === 'string' && started.flowId.trim()) {
        await step('signin.cancel', {flowId: started.flowId}, data => {
          const ended = data?.cancelled === true || (ENDED_FLOW.includes(data?.status) && !OPEN_FLOW.includes(data?.status));
          return {ok: ended, detail: ended ? `Sign-in flow ended (${data?.cancelled === true ? 'cancelled' : data.status}).`
            : 'cleanup unknown; sign-in cancellation was not confirmed.'};
        }, false, {stepName: `signin.cancel[${safeTargetLabel(target)}]`});
      }
    }
  } else skip('signin.start', 'Requires --signin-probe.');
  const lending = await step('lending.get', {}, data => ({
    ok: object(data) && (typeof data.circle === 'string' || data.circle === null),
    detail: 'Lending=' + truth(data?.enabled) + '; active circle ' + (data?.circle ? 'configured.' : 'not configured.'),
  }));
  let active = null;
  const circles = await step('circles.list', {}, data => {
    if (!Array.isArray(data)) throw new Error();
    active = data.find(circle => typeof circle?.id === 'string' && circle.id === lending?.circle) ?? null;
    return {ok: Boolean(active), detail: active
      ? 'Active circle: ' + publicLabel(active.name ?? active.id, data) + ' (entry ' + (data.indexOf(active) + 1) + ').'
      : 'No matching active circle; refusing to guess.'};
  });
  let host = null;
  if (circles && active) host = await step('circles.check', {circle: active.id}, data => ({
    ok: data?.state === 'approved', detail: data?.state === 'approved' ? 'Host answers; membership approved.' : data?.state === 'pending' ? 'Host answers; membership pending.' : 'Host response invalid.',
  }));
  else skip('circles.check', 'No active circle.');
  if (options['--lend-on'] && host) await step('lending.on', {circle: active.id}, data => ({
    ok: data?.enabled === true, detail: 'Lending=' + truth(data?.enabled),
  }), true);
  else skip('lending.on', options['--lend-on'] ? 'Active circle or host failed.' : 'Requires --lend-on --yes; unchanged.');

  if (!options['--send'] || !host) {
    for (const op of ['jobs.send_and_wait', ...(options['--stop'] ? ['jobs.cancel', 'jobs.wait'] : []), 'jobs.receipt', 'jobs.apply_preview', 'jobs.apply'])
      skip(op, options['--send'] ? 'Active circle or host failed.' : 'No --send requested.');
    return finish();
  }
  const folder = resolve(options['--send']);
  let verify;
  try { verify = await hasNpmTest(folder); }
  catch { record('package.json', 'FAIL', 0, 'Cannot inspect npm test script; job not sent.'); return finish(); }
  const sent = await step('jobs.send_and_wait', {
    circle: active.id, repo: {path: folder}, prompt: options['--prompt'], timeout_seconds: options['--stop'] ? 0 : 300,
    ...(verify ? {verify: {cmd: 'npm test'}} : {}),
  }, data => {
    const state = STATES.has(data?.job?.state) ? data.job.state : 'unknown';
    if (options['--stop']) return {
      ok: /^sha256:[a-f0-9]{64}$/.test(data?.jobDigest),
      detail: /^sha256:[a-f0-9]{64}$/.test(data?.jobDigest) ? 'Job submitted.' : 'No job id returned.',
    };
    return {ok: data?.done === true && state === 'result-accepted' && /^sha256:[a-f0-9]{64}$/.test(data?.jobDigest),
      detail: 'Result=' + state + '; done=' + truth(data?.done) + '; changes=' + (object(data?.changes) ? 'available' : 'unavailable') + '; verify=' + (verify ? 'npm test' : 'not configured') + (data?.done === false ? '; work may still be running; not cancelled.' : '')};
  }, true, {timeout: options['--stop'] ? STOP_SUBMIT_TIMEOUT_MS : stepTimeout,
    keepFailedData: Boolean(options['--stop'])});
  if (options['--stop']) {
    if (sent) {
      const input = {digest: sent.jobDigest, circle: active.id};
      await step('jobs.cancel', input, data => ({
        ok: object(data) && typeof data.compute_stopped === 'boolean',
        detail: data?.compute_stopped === true ? 'Job stopped.' : `Stop requested; cancellation deadline ${STOP_CANCEL_TIMEOUT_MS}ms.`,
      }), true, {timeout: STOP_CANCEL_TIMEOUT_MS});
      await step('jobs.wait', {...input, timeout_seconds: STOP_CONFIRM_TIMEOUT_MS / 1000}, data => {
        const state = data?.job?.state;
        const status = data?.job?.status;
        const statusState = status === undefined ? undefined
          : ['Stopped', 'Cancelled'].includes(status) ? 'cancelled' : 'unknown';
        const stopped = data?.done === true && state === 'cancelled'
          && (statusState === undefined || statusState === state);
        return {ok: stopped, detail: stopped
          ? `Job ended cancelled within ${STOP_CONFIRM_TIMEOUT_MS}ms confirmation deadline (cancel deadline ${STOP_CANCEL_TIMEOUT_MS}ms).`
          : `Stop not confirmed within ${STOP_CONFIRM_TIMEOUT_MS}ms confirmation deadline (cancel deadline ${STOP_CANCEL_TIMEOUT_MS}ms).`};
      }, false, {timeout: STOP_CONFIRM_TIMEOUT_MS});
    } else {
      skip('jobs.cancel', 'Job submission failed.');
      skip('jobs.wait', 'Job submission failed.');
    }
    for (const op of ['jobs.receipt', 'jobs.apply_preview', 'jobs.apply']) skip(op, 'Stop probe does not read or apply results.');
    return finish();
  }
  if (!sent) {
    for (const op of ['jobs.receipt', 'jobs.apply_preview', 'jobs.apply']) skip(op, 'Job did not finish successfully.');
    return finish();
  }
  const input = {digest: sent.jobDigest, circle: active.id};
  const receipt = await step('jobs.receipt', input, data => {
    if (!object(data?.receipt) || !Array.isArray(data?.checks)) throw new Error();
    const passed = data.checks.filter(check => check?.exit === 0 && check?.timed_out === false).length;
    const timed = data.checks.filter(check => check?.timed_out === true).length;
    return {ok: passed === data.checks.length && (!verify || data.checks.some(check => check?.cmd === 'npm test' && check.exit === 0 && check.timed_out === false)),
      detail: 'Receipt available (self-report); checks=' + data.checks.length + ', passed=' + passed + ', failed/unknown=' + (data.checks.length - passed) + ', timed_out=' + timed};
  });
  const preview = await step('jobs.apply_preview', {...input, repo: folder}, data => ({
    ok: data?.status === 'dry_run' && object(data?.expect),
    detail: data?.status === 'dry_run' ? 'Dry-run only; repository unchanged.' : 'Preview refused; repository unchanged.',
  }));
  if (options['--apply'] && preview && receipt) await step('jobs.apply', {
    ...input, repo: folder, expect: preview.expect,
  }, data => ({ok: data?.status === 'applied', detail: data?.status === 'applied' ? 'Added as a branch.' : 'Apply refused; inspect the app.'}), true);
  else skip('jobs.apply', options['--apply'] ? 'Receipt/checks or preview failed.' : 'Requires --apply --yes; no branch written.');
  return finish();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runJourney(process.argv.slice(2));
}
