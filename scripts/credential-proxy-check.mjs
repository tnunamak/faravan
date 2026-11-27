#!/usr/bin/env node
// Runs the S5.2 credential-proxy probe inside a real Faravan job sandbox, once per adapter.
// Usage: node scripts/credential-proxy-check.mjs [--adapter ID]... [--label internal|independent] [--canary] [--without-egress-plan]
//          [--host-credential-file PATH]... [--faravan-version X] [--evidence-out FILE] [--report-out FILE]
// How to read the result: docs/security/credential-proxy-test.md.
//
// The sandbox is started by the same backend code a real job uses (DockerSbxBackend.prepare/start, the
// adapter's normal image, provider-only network, the sbx identity HOME=~/.wfsbx). The probe file is placed
// in the job workspace, so the job-side view is the one an agent has. Nothing here prints a secret value:
// output is names, lengths, 4-character hash prefixes, and the probe's own redacted evidence.
import { randomUUID, createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DockerSbxBackend, parseSbxListing } from '../lib/docker-backend.mjs';
import { buildValidatedJobSpec } from '../lib/executor.mjs';
import { getHarnessAdapter, resolveHarness } from '../lib/harnesses/index.mjs';
import { buildEvidenceRecord, extractReport, hostCredentialHashes, normalizeSbxVersion, readFaravanVersion, validateProbeReport } from '../lib/v1/credential-probe.mjs';

const PROBE_FILE = fileURLToPath(new URL('../lib/v1/credential-probe-guest.mjs', import.meta.url));
const DEFAULT_ADAPTERS = ['claude-code-subscription', 'codex'];

function args() {
  const argv = process.argv.slice(2), out = { adapter: [], hostFiles: [], label: 'internal' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--adapter') out.adapter.push(argv[++i]);
    else if (flag === '--host-credential-file') out.hostFiles.push(argv[++i]);
    else if (flag === '--label') out.label = argv[++i];
    else if (flag === '--canary') out.canary = true;
    else if (flag === '--without-egress-plan') out.withoutEgressPlan = true;
    else if (flag === '--faravan-version') out.faravanVersion = argv[++i];
    else if (flag === '--evidence-out') out.evidenceOut = argv[++i];
    else if (flag === '--report-out') out.reportOut = argv[++i];
    else { console.error('unknown argument: ' + flag); process.exit(2); }
  }
  if (!out.adapter.length) out.adapter = DEFAULT_ADAPTERS;
  return out;
}

function faravanVersion(explicit) {
  if (explicit) return explicit;
  const installed = readFaravanVersion();
  if (installed) return installed;
  // A source checkout has no VERSION. Name it for what it is; no release will ever match this string.
  let commit = 'unknown';
  try { commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a checkout */ }
  return '0.0.0-dev+' + commit;
}

async function hostSecretStates(backend) {
  const result = await backend.runSbx(['secret', 'ls', '-g']);
  const rows = String(result.stdout).split('\n').slice(1).map((line) => line.trim().split(/\s{2,}/)).filter((row) => row.length >= 4);
  return rows.map(([scope, type, name, state]) => ({ scope, type, name, state }));
}

async function runOne(backend, adapterId, options, context) {
  const adapter = getHarnessAdapter(adapterId);
  if (!adapter) throw new Error('unknown adapter ' + adapterId);
  const harness = resolveHarness(adapterId);
  const service = adapter.spec.provider_service_id;
  const probeText = await readFile(PROBE_FILE, 'utf8');
  const probeDigest = createHash('sha256').update(probeText).digest('hex').slice(0, 16);
  const hashes = await hostCredentialHashes(options.hostFiles);
  const hashArgument = hashes.length ? ` --known-hashes ${Buffer.from(JSON.stringify(hashes)).toString('base64')}` : '';
  let guestPath, canary = null;
  const entrypoint = () => `node ${guestPath} --provider ${service}${hashArgument}`;
  // Same construction as a real job, except the entrypoint runs the probe instead of the agent.
  const job = buildValidatedJobSpec({
    taskDigest: randomUUID().replaceAll('-', '').repeat(2), harness, entrypointWithPrompt: 'true', network: 'disabled',
    resources: { cpu: 1, memory_mib: 1024, storage_mib: 512, wall_seconds: 240, output_bytes: 1048576, network_bytes: 1, max_processes: 64 },
  });
  const outcome = { adapter_id: adapterId, provider: service, sandbox: null, removed: null, report: null, record: null, error: null, host_hashes: hashes.length };
  let handle;
  try {
    // The image pull reads the Docker Hub token from the desktop keyring, which fails now and then
    // ("failed to open secretservice session"). That is a start failure, not a result: try again.
    for (let attempt = 1; ; attempt++) {
      outcome.attempts = attempt;
      try { handle = await backend.prepare(job); break; }
      catch (error) {
        if (attempt >= 3 || !/secretservice|keyring|encode registry auth/i.test(String(error.message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    outcome.sandbox = handle.sandbox_id;
    guestPath = path.join(handle.scratch_dir, '.faravan-credential-probe.mjs');
    await writeFile(guestPath, probeText, { mode: 0o644 });
    handle._entrypoint = entrypoint();
    if (options.canary) {
      // Negative control: plant a made-up GitHub token in the guest's gh config, exactly where a leaked one would be.
      // The probe must now fail. No evidence record is written for a canary run.
      canary = 'ghp_' + randomBytes(27).toString('base64url').replace(/[-_]/g, 'x').slice(0, 36);
      const planted = await backend._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c',
        `mkdir -p "$HOME/.config/gh" && printf 'github.com:\\n  oauth_token: %s\\n' '${canary}' > "$HOME/.config/gh/hosts.yml"`]);
      if (planted.code !== 0) throw new Error('could not plant the canary: exit ' + planted.code);
    }
    await backend.start(handle);
    outcome.report = extractReport(handle._lastExecStdout);
    if (!outcome.report) outcome.error = 'no probe report in sandbox output';
  } catch (error) {
    outcome.error = `${error.code ?? 'error'}: ${String(error.message ?? error).slice(0, 600)}`;
  } finally {
    if (handle) {
      const receipt = await backend.destroy(handle);
      const names = parseSbxListing(await backend.runSbx(['ls', '--json']));
      outcome.removed = receipt.removed === true && receipt.scratch_removed === true && names !== null && !names.includes(handle.sandbox_id);
    }
  }
  if (canary && outcome.report) {
    const printed = JSON.stringify(outcome.report);
    outcome.canary = { planted: true, detected: outcome.report.verdict === 'fail' && outcome.report.checks.some((entry) => entry.id === 'credential-files' && entry.found === true),
      value_in_report: printed.includes(canary) || printed.includes(canary.slice(0, 8)) };
    return outcome; // a canary run never produces an evidence record
  }
  if (outcome.report && options.withoutEgressPlan) {
    outcome.egress_plan = 'skipped (diagnostic run, no evidence record)';
    return outcome;
  }
  if (outcome.report) {
    const checked = validateProbeReport(outcome.report);
    if (!checked.ok) { outcome.error = 'probe report refused: ' + checked.reason; outcome.report = null; }
    else {
      outcome.record = buildEvidenceRecord({ report: outcome.report, adapter, faravanVersion: context.faravanVersion,
        sbxVersion: context.sbxVersion, testedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), label: options.label, probeDigest });
    }
  }
  return outcome;
}

const options = args();
const backend = new DockerSbxBackend();
if (options.withoutEgressPlan) {
  // Diagnostic only: skip the per-sandbox network plan, which refuses a sandbox when the global policy is wider than the
  // agent's kit allows. The sandbox, its credentials and the private-range denies at creation are unchanged, but the egress
  // rules are not what a real job gets, so a run like this never produces an evidence record.
  backend._configureEgress = async (handle) => { handle._policyVerification = {}; };
  options.canary = options.canary ?? false;
}
const versionResult = await backend.runSbx(['version']);
const context = { sbxVersion: normalizeSbxVersion(versionResult.stdout), faravanVersion: faravanVersion(options.faravanVersion) };
const results = [];
for (const adapterId of options.adapter) results.push(await runOne(backend, adapterId, options, context));
const summary = { faravan_version: context.faravanVersion, sbx_version: context.sbxVersion, host_secrets: await hostSecretStates(backend), results };
if (options.reportOut) await writeFile(options.reportOut, JSON.stringify(summary, null, 2) + '\n');
if (options.evidenceOut) {
  const existing = await readFile(options.evidenceOut, 'utf8').then(JSON.parse).catch(() => []);
  await writeFile(options.evidenceOut, JSON.stringify([...existing, ...results.map((entry) => entry.record).filter(Boolean)], null, 2) + '\n');
}
console.log(JSON.stringify(summary, null, 2));
// 0: every adapter produced a report and no sandbox is left. 1: some adapter failed the test. 3: a sandbox may be left behind.
// 4: an adapter produced no report at all (sbx refused or the probe did not run); that is no result, not a pass.
process.exitCode = results.some((entry) => entry.sandbox && entry.removed !== true) ? 3 : results.some((entry) => entry.report?.verdict === 'fail') ? 1 : results.some((entry) => !entry.report) ? 4 : 0;
