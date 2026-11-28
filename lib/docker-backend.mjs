import {SBX_MIN_VERSION,supportedSbxVersion} from './sbx-version.mjs';
import {cleanupStatusSummary} from './v1/cleanup-status.mjs';
import {createSharedSandboxWatcher} from './v1/sandbox-shared-watcher.mjs';
import { stageGuestRuntime, intendedRuntimeDir, guardRuntimeReadiness, runtimeWorkspaceArgs, installGuestRuntime, guestRuntimeCommand, guestRuntimeCheckFailed, runtimeStartFailed, runtimeError, RUNTIME_HELP } from './guest-runtime.mjs';
/**
 * DockerSbxBackend: SandboxBackend implementation over Docker Sandboxes'
 * `sbx` CLI (Runtime Decision, 2026-07-20 — inbox/2026-07-20-chatgpt-sandbox.md).
 *
 * Status: Faravan Preview backend only. This module implements the
 * MECHANISM (interface, error handling, safety boundary around workspace and
 * credentials). It does NOT itself prove the graduation gates A-I from the
 * decision note — that is a separate adversarial conformance suite run
 * against a real `sbx` install. See DOCKER_ADAPTER_MAKER_REPORT.md for the
 * honest list of what remains unverified pending real sbx.
 *
 * prepare()/start()/destroy()'s `sbx` argv shapes were corrected and directly
 * proven against a real, authenticated sbx v0.35.0 install (2026-07-21):
 * `sbx run` needs the agent BEFORE the workspace path (not after, as this
 * file originally guessed) plus `--detached`; `start()` must drive the
 * entrypoint through `sbx exec SANDBOX -- sh -c ENTRYPOINT` since entrypoint
 * is a multi-word HarnessSpec command string, not a single guest binary name;
 * `sbx rm` needs `--force` non-interactively. A full prepare->start->destroy
 * cycle against a real deny-all-policy sandbox produced the exact expected
 * stdout and an independently-verified clean removal. See
 * docs/history/design/archive/FEDERATION_V0_UAT_REPORT.md "Autonomous fix loop".
 */

import { execFile as execFileCb, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import {setTimeout as sleep} from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import {createSbxRuntime,currentSbxRuntime,assertSbxRuntime,withSbxRuntime,describeSbxRuntime,cleanupSbxRuntime,qualifiedSbxRuntime,runtimeDescriptor,hostDefaultSbxRuntime,restoreSbxRuntime,sbxBinaryIdentity as qualifiedBinaryIdentity,nonSbxCommand} from './sbx-runtime.mjs';
import { mkdir, rm, stat, lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { existsSync, lstatSync, statSync, readFileSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, createReadStream, readdirSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { borrowedStrategyAllowed } from './harness-spec.mjs';
import { HARNESS_ADAPTERS } from './harnesses/index.mjs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SandboxBackend, validateJobSpec } from './runtime.mjs';
import { channelDataHome, channelIdentity } from './channel-identity.mjs';
import { planNetworkDeny, parsePolicyListing, probeTarget, sampleForChecks, resourceHost, covers } from './network-policy.mjs';
import { removeSandboxPolicies } from './sandbox-policy-cleanup.mjs';
import { createSandboxScratch, recoverSandboxScratch, releaseSandboxScratchRecord, deadScratchOwners, withSandboxScratchLock, canonicalScratchPath } from './sandbox-scratch.mjs';
import { GITHUB_BINDING_GUEST_PROBE, GITHUB_PROBE_URL, INERT_SERVICE_DENY, INERT_SERVICE_ENV, INERT_SERVICE_HOSTS, assignSandboxGitHub, classifyGitHubProbe, removeLegacyGitHubSecrets, removeNativeProviderGlobalSecret, removeSandboxGitHub, restrictCredentialScope, acquireCredentialPreparation, withCredentialPreparation } from './sandbox-credentials.mjs';
import { readClaudeAccount, readClaudeAccountSync, readClaudeAccountValue, removeOrphanClaudeGenerations } from './credential-generations.mjs';
import { createAccountRegistry } from './v1/lending-accounts.mjs';
import { accountIdOfKey } from './v1/lending-account-key.mjs';
import { CLAUDE_KIT, claudeKitDigest, claudeService, claudeGuestEnv, ensureClaudeBinding, assignClaudeAccount, claudeControlValue, verifyClaudeAccountRemoved, claudeAccountCheckGeneration, claudeAccountFenceHolds, currentClaudeCheckGeneration, beginClaudeAccountCheck, recordClaudeAccountCheck, claudeCheckOutcome, claudeCheckSuperseded } from './claude-accounts.mjs';
import { assignLentOpenAI } from './v1/lent-claude-credential.mjs';
import { refreshProviderGeneration, codexConsumerCopy } from './credential-generations.mjs';
import { TUNNEL_ORIGIN, guestRelayArgv, attachGuestBrokerTunnel } from './v1/guest-broker-tunnel.mjs';
import { runGuestEgressWitness, parseWitnessAudit, WITNESS_BUDGET_MS } from './v1/guest-egress-witness.mjs';
import { createImageArgs, loadImagePins, IMAGE_UNPINNED } from './sbx-image-pins.mjs';
import { digestHex, parseFullImageListing, imageMatchesDigests } from './disk-sweep-plan.mjs';
import { createStoreCoordinator } from './store-lock.mjs';
import { ownCreatedImages, imagesBefore, CREATED_REASON } from './disk-ownership.mjs';
import { openDiskStore, diskLedgerFile } from './disk-store.mjs';
import { createStoragePool, storageVolumes, STORAGE_BLOCKED } from './sandbox-storage.mjs';
import {freshSandboxName,sandboxOwnerScope,legacySandboxNameFor} from './sandbox-name.mjs';
import { createSandboxCleanupJournal, establishedAbsentWatch, OLD_RECORD } from './sandbox-cleanup-journal.mjs';
import { watchProofStore, watchProofDirectory } from './v1/sandbox-watch-proofs.mjs';
import { acquireRecordOwner, createIdOf } from './v1/sandbox-record-owner.mjs';
import {createSandboxDeadlineManager,sandboxDeadlineClock,sandboxDeadlineReservation,sandboxDeadlineRemaining,validSandboxDeadline,runDeadlineCommand,deadlineProcessIdentity} from './sandbox-deadline.mjs';
import {deadlineRecoveryHold as recoveryHoldFor, deadlineRecoveryError,sandboxServiceUnavailableHold,daemonRestartNeeded} from './sandbox-remediation.mjs';
import {sandboxCommandDiagnosticOf,bindSandboxCommandDiagnostic} from './sandbox-command-diagnostic.mjs';
import {sandboxCommandDiagnostic} from './sandbox-command-observation.mjs';
import { DISK_FULL_PATTERN, createDiskWait } from './disk-wait.mjs';
import { createHostDisk, validateHostDiskReading, watchHostDisk, HOST_DISK_HEADROOM_BYTES, hostDiskLow, hostDiskUnreadable, hostDiskStop } from './host-disk.mjs';
import { configHome } from './local-state.mjs';
import { uninstallInProgress } from './v1/uninstall-lock.mjs';
import { DOCKER_SIGNIN_REFRESH_MESSAGE, DOCKER_SIGNED_OUT, DOCKER_SIGNED_OUT_MESSAGE, dockerSignedOutError, DOCKER_SIGNIN_STATE_UNAVAILABLE, dockerSignInStateError } from './v1/docker-state.mjs';
import { createDockerSignInState } from './v1/docker-signin-state.mjs';
import { collectOutputStream } from './output-collection.mjs';
import { VERIFY_RESERVE_SECONDS } from './protocol/verification.mjs';
import { GUARD_SOURCE_PATH, GUARD_MODES, STOP_REASONS, guardRunCommand, guardStopCommand, parseGuardLine, validateStopRecord } from './faravan-guard-host.mjs';

import { readSbxOwner, ensureSbxOwner, installRoot, resolveSbxExecutable, restoreSbxOwner, quarantineUnreadableSbxOwner, sbxUnitBelongsToOwner } from './sbx-daemon-owner.mjs';

const preparationObservations = new WeakMap();
const preparationId = value => typeof value === 'string' && value.length > 0 &&
  value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
export function preparationView(value) {
  const unknown = {schemaVersion:1,state:'unknown',jobId:null,attemptId:null,sandboxId:null,observedAtMs:null};
  if (!value || !['prepared','pending'].includes(value.state) ||
      !preparationId(value.jobId) || !preparationId(value.attemptId) ||
      !Number.isFinite(value.observedAtMs) || value.observedAtMs < 0 ||
      (value.state === 'prepared' && !preparationId(value.sandboxId))) return unknown;
  return {schemaVersion:1,state:value.state,jobId:value.jobId,attemptId:value.attemptId,
    sandboxId:value.state === 'prepared' ? value.sandboxId : null,observedAtMs:value.observedAtMs};
}

const daemonJobContext = new AsyncLocalStorage();
const daemonLifecycleContext = new AsyncLocalStorage();
const observationDaemonContext = new AsyncLocalStorage();
const deadlineRecoveryContext = new AsyncLocalStorage();
let daemonLifecycleGeneration = 0;

function sbxBinaryIdentity(env=sbxChildEnv()) {
  try {
    const executable=resolveSbxExecutable(sbxBin(),env), info=lstatSync(executable);
    return [executable,info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs].join('\0');
  } catch { return [sbxBin(),env.PATH].join('\0'); }
}
let daemonLifecycleTail = Promise.resolve();
export function withDaemonLifecycle(action) {
  if (daemonLifecycleContext.getStore()) return action();
  const pending = daemonLifecycleTail.then(() => daemonLifecycleContext.run(true, action));
  daemonLifecycleTail = pending.catch(() => {});
  return pending;
}

function recordDaemonLaunch(child) {
  const context = daemonJobContext.getStore();
  if (context?.agentRun && context.managed) child?.once('spawn', () => launchedDaemonHandles.add(context.handle));
}
const launchedDaemonHandles = new WeakSet();

const reaperPassContext=new AsyncLocalStorage();
function countReaperCommand(command,args) {
  const pass=reaperPassContext.getStore();if(!pass?.active)return;
  pass.command_calls++;
  if(command===sbxBin()&&args[0]==='ls'&&args.includes('--json'))pass.inventory_calls++;
}
const rawExecFile=promisify(execFileCb);
const execFile=(command,args,...options)=>{countReaperCommand(command,args);return rawExecFile(command,args,...options);};
const signInJobs = new WeakSet();
const signInHandles = new WeakSet();

export const BACKEND_ID = 'docker-sbx';
export const SBX_PREFLIGHT_SCHEMA_VERSION = 1;
// Idle availability polls reuse a successful preflight this long; a job's readiness recheck never does.
const PREFLIGHT_TTL_MS = 60000;
// Most `sbx policy check` reads in flight at once, for both the sentinel group and the identity probe.
const POLICY_CHECK_WORKERS = 8;
const IDENTITY_POLICY_CACHE_LIMIT = 8;
// Keep this contract in sync with prepare(); its recorded-argv test enforces it.
export const SBX_RUN_OPTIONS = Object.freeze(['-d', '--name', '--kit', '--cpus', '--memory', '--skills', '--deny-network']);
const INSTALL_HINT = 'https://docs.docker.com/ai/sandboxes/get-started/';
const UBUNTU_INSTALL_FIX = 'curl -fsSL https://get.docker.com | sudo REPO_ONLY=1 sh && sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-sbx';
import {selectSbxHome, containerdSocketPathForSbxHome, sbxSocketPathLimit, socketPathFits, accountHome} from './sbx-home.mjs';
export {selectSbxHome, containerdSocketPathForSbxHome, sbxSocketPathLimit, SBX_SOCKET_PATH_LIMIT} from './sbx-home.mjs';
export const ENFORCED_LIMITS = Object.freeze(['cpu', 'memory', 'wall', 'output']);
export const UNENFORCED_LIMITS = Object.freeze(['storage', 'processes', 'network_bytes']);
// A check sandbox ends this long before the earlier of its job's and its caller's deadlines, so removing it fits.
export const CHECK_REMOVAL_RESERVE_MS = 30_000;
// The host watchdog stops a check command this long before the check sandbox's own deadline.
export const CHECK_STOP_MS = 10_000;

const V1_LIMIT_NAMES = Object.freeze({ cpu: 'cpu', memory_bytes: 'memory', wall_seconds: 'wall', output_bytes: 'output', disk_bytes: 'storage' });
const V1_MAX_LIMITS = Object.freeze({ cpu: 256, memory_bytes: 1024 ** 4, wall_seconds: 86400, output_bytes: 1073741824, disk_bytes: 1024 ** 4 });

/** Names from `sbx ls --json` (verified on sbx 0.47 and 0.48: an array of
 * {name, status, ...}). The human table changed between versions and has
 * multi-word cells, so it is never parsed. Anything else fails closed (null).
 */
export function parseSbxListing(result) {
  if (result?.code !== 0) return null;
  let rows;
  try { rows = JSON.parse(String(result.stdout || '')); } catch { return null; }
  if (!Array.isArray(rows)) return null;
  const names = [];
  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(row.name) || names.includes(row.name)) return null;
    names.push(row.name);
  }
  return names;
}

/** True when a listing command finished cleanly: not timed out, killed, truncated, failed to start, or noisy on stderr. */
export function completeSbxListing(result) {
  return !(result?.timedOut || result?.killed || result?.truncated || result?.errorCode || result?.stderr?.trim());
}

/** Names of sandboxes in `sbx ls --json` output that are not stopped; null when the listing is not trustworthy. */
export function activeSandboxNames(result) {
  if (!parseSbxListing(result)) return null;
  return JSON.parse(String(result.stdout)).filter((row) => row.status !== 'stopped').map((row) => row.name);
}

export const PRIVATE_NETWORK_DENIES = Object.freeze([
  '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10',
  '169.254.0.0/16', '127.0.0.0/8', '0.0.0.0/8', '::1/128',
  'fc00::/7', 'fe80::/10', 'metadata.google.internal',
  'mcp-gateway.docker.internal',
]);

// Names, not arbitrary hosts, cross the job boundary. No wildcard registries.
export const REGISTRY_HOSTS = Object.freeze({
  npm: Object.freeze(['registry.npmjs.org']),
  pypi: Object.freeze(['pypi.org', 'files.pythonhosted.org']),
});

// The provider service each image signs in to, and the variables that carry that provider's secret into a guest.
// A provider-free check proves them absent. sbx sets SBX_CRED_*_MODE (none or oauth) and the guest holds only
// placeholders, so a variable counts as absent when it is empty or holds the placeholder.
const PROVIDER_SERVICE_BY_IMAGE = Object.freeze({ codex: 'openai', claude: 'anthropic', gemini: 'google', opencode: 'openrouter', 'wf-pi': 'broker' });
const PROVIDER_SECRET_ENV = Object.freeze({
  openai: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY']),
  anthropic: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']),
  google: Object.freeze(['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
  openrouter: Object.freeze(['OPENROUTER_API_KEY']),
});
// A broker-only guest (pi) has no provider of its own: it must hold none of any provider's keys.
const ALL_PROVIDER_SECRET_ENV = Object.freeze(Object.values(PROVIDER_SECRET_ENV).flat());
// sbx's placeholders, matched exactly: bare, and the Claude and OpenAI OAuth forms (docs/design/LENDING-POLICY.md).
const SBX_PLACEHOLDERS = Object.freeze(['proxy-managed', 'sk-ant-oat01-proxy-managed', 'sk-ant-ort01-proxy-managed', 'oai-oat01-proxy-managed']);
// Exits 0 when every named variable is empty or holds only one of sbx's placeholders.
function absentEnvCommand(names) {
  return names.map(name => `case "\${${name}:-}" in ''|${SBX_PLACEHOLDERS.join('|')}) true ;; *) false ;; esac`).join(' && ');
}

const BORROWED_PROXY_ONLY = 'A borrowed job may only use the Docker credential proxy; keys and native sign-in files are for owner jobs.';

function borrowedCredentialMechanismAllowed(job, { accountBroker = false } = {}) {
  // Resolve against the catalog that selects the runnable image. A label alone
  // cannot turn a guest credential mechanism into a proxy mechanism.
  return HARNESS_ADAPTERS.some(adapter => {
    const spec = adapter.lendingSpec ?? adapter.spec;
    if (spec.install !== job.image || spec.auth_strategy !== job.auth_strategy) return false;
    if (spec.credential_in_guest === false && borrowedStrategyAllowed(spec.auth_strategy)) return true;
    // A broker account job keeps the provider credential on the host; the guest key is a one-job broker key.
    return accountBroker && spec.auth_strategy === 'guest-env-api-key' && spec.credential_in_guest === true;
  });
}

function policyError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

/** Pure admission: no provider, sandbox or credential activity. */
export function admitDockerJob(job, { storage = false, accountBroker = false } = {}) {
  try { validateJobSpec(job); } catch (error) {
    return { ok: false, code: 'policy_unenforceable', reason: error.message };
  }
  if (job.execution_scope !== 'owner' && !borrowedCredentialMechanismAllowed(job, { accountBroker })) {
    return { ok: false, code: 'native_credentials_owner_only', reason: BORROWED_PROXY_ONLY };
  }
  if (!['internet', 'provider-only', 'provider+registries'].includes(job.egress)) {
    return { ok: false, code: 'policy_unenforceable', reason: 'Legacy opaque egress policy cannot be enforced; rebuild the job with an explicit egress policy.' };
  }
  // The gh-cli agent exists only through the GitHub task kit, and a check must never get that credential.
  if (job.verify !== undefined && job.image === 'wf-gh-cli') {
    return { ok: false, code: 'policy_unenforceable', reason: 'Checks cannot run for the GitHub CLI agent: its sandbox needs the GitHub credential.' };
  }
  if (job.resources.memory_mib < 512 || job.resources.wall_seconds > 2147483) {
    return { ok: false, code: 'limits_unenforceable', reason: 'Memory must be at least 512 MiB and wall time must fit the product deadline timer.' };
  }
  if (job.required_limits?.includes('storage')) return { ok: false, code: 'storage_unenforceable', reason: STORAGE_BLOCKED };
  const enforced = storage ? [...ENFORCED_LIMITS, 'guest_block_device_capacity'] : ENFORCED_LIMITS;
  if (storage) { try { storageVolumes(job.resources.storage_mib * 1048576, job.image); } catch { return { ok: false, code: 'storage_unenforceable', reason: STORAGE_BLOCKED }; } }
  const unsupported = (job.required_limits || ENFORCED_LIMITS).filter((limit) => !enforced.includes(limit));
  if (unsupported.length) return { ok: false, code: 'limits_unenforceable', reason: 'Required limits are not enforceable by docker-sbx.', limits: unsupported };
  return { ok: true, enforced_limits: [...enforced],
    unenforced: [...UNENFORCED_LIMITS] };
}

/** Strict, provisional adapter until real daemon JSON is captured. */
export function parseNetworkPolicyDecision(result) {
  // sbx 0.48 exits 1 for a denied decision while still printing its JSON, so
  // the body decides. Any other nonzero exit, or no JSON, stays unknown.
  if (result?.code !== 0 && result?.code !== 1) return 'unknown';
  let value;
  try { value = JSON.parse(result.stdout); } catch { return 'unknown'; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
  const decisions = [];
  if (typeof value.allowed === 'boolean') decisions.push(value.allowed ? 'allowed' : 'denied');
  for (const key of ['decision', 'result', 'verdict']) {
    if (typeof value[key] !== 'string') continue;
    const word = value[key].toLowerCase();
    if (['allow', 'allowed'].includes(word)) decisions.push('allowed');
    else if (['deny', 'denied', 'blocked'].includes(word)) decisions.push('denied');
    else return 'unknown';
  }
  const decision = decisions.length && decisions.every((entry) => entry === decisions[0]) ? decisions[0] : 'unknown';
  return result.code === 1 && decision !== 'denied' ? 'unknown' : decision;
}

// Policy counters are scoped to sandbox, host and decision. Never infer later
// occurrences by subtracting host names: a probe and an agent can contact the same host.
function observedPolicyRows(result, sandboxId) {
  if(result?.code!==0||!sandboxId)return null;
  let value;
  try {value=JSON.parse(result.stdout);}catch {return null;}
  if(!Array.isArray(value?.allowed)||!Array.isArray(value?.blocked))return null;
  return [['denied',value.blocked],['allowed',value.allowed]].flatMap(([decision,rows])=>rows
    .filter(row=>row?.sandbox_id===sandboxId).map(row=>({...row,decision})));
}
function observedHost(raw) {
  if(typeof raw!=='string')return null;
  const match=/^([a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)(?::([0-9]{1,5}))?$/.exec(raw);
  if(!match||match[1].length>253||(match[2]&&(+match[2]<1||+match[2]>65535)))return null;
  const host=match[1].toLowerCase();
  return !['__proto__','constructor','prototype'].includes(host)&&host.split('.').every(label=>label.length<=63&&/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ? host : null;
}
const egressCounterKey=row=>row.decision+'\0'+String(row.proxy_type??'')+'\0'+row.host.toLowerCase();
export function observedEgressCounts(result, sandboxId) {
  const rows=observedPolicyRows(result,sandboxId);
  if(rows===null)return null;
  const counts=new Map();
  for(const row of rows) {
    const host=observedHost(row.host);
    if(!host||!Number.isSafeInteger(row.count)||row.count<1)return null;
    if(row.proxy_type!==undefined&&(typeof row.proxy_type!=='string'||row.proxy_type.length>64))return null;
    const key=egressCounterKey(row);
    if(counts.has(key))return null; // Not a unique cumulative counter ledger.
    counts.set(key,row.count);
  }
  return counts;
}
/** Without an occurrence boundary this is cumulative data. A supplied boundary
 * requires monotonic counters; missing/reset counters leave attribution unknown. */
export function parseObservedEgress(result, sandboxId, {afterCounts} = {}) {
  const rows=observedPolicyRows(result,sandboxId);
  if(rows===null||afterCounts===null)return null;
  let current;
  if(afterCounts!==undefined) {
    if(!(afterCounts instanceof Map)||(current=observedEgressCounts(result,sandboxId))===null)return null;
    for(const [key,count] of afterCounts)if((current.get(key)??0)<count)return null;
  }
  const hosts=new Map();
  for(const row of rows) {
    const host=observedHost(row.host);
    if(!host)continue;
    const key=egressCounterKey(row);
    if(current&&(current.get(key)??0)<=(afterCounts.get(key)??0))continue;
    // Blocked observations come first and win over allowed observations.
    if(!hosts.has(host)&&hosts.size<32)hosts.set(host,row.decision);
  }
  return hosts.size?Object.fromEntries(hosts):null;
}


export function sbxVersionCheck(version) {
  const restartVersion=daemonRestartNeeded(version)&&/^Client Version:\s*v?\d+\.\d+\.\d+\s*$/m.test(outputOf(version));
  const blocked = (!commandWorked(version)&&!restartVersion) || !supportedSbxVersion(outputOf(version));
  return {...check('sbx_version', !blocked, blocked ? 'Update Docker Sandboxes' : 'Docker Sandboxes meets the security minimum.', blocked ? `Update Docker Sandboxes to ${SBX_MIN_VERSION.join('.')} or newer.` : '', diagnosticsOf(version)), severity:blocked?'error':'info', status:blocked?'blocked':'passed'};
}

const PI_KIT_DIR = fileURLToPath(new URL('../kits/wf-pi', import.meta.url));
const GITHUB_KIT_DIR = fileURLToPath(new URL('../kits/wf-gh-cli', import.meta.url));
let warnedAboutLongLegacySbxHome = false;

// Read at call time (not module load) so tests can point FARAVAN_SBX_BIN at
// a stub executable per-test without re-importing the module.
function sbxBin() {
  return process.env.FARAVAN_SBX_BIN || 'sbx';
}

function claudeBinaryIdentity() {
  return qualifiedBinaryIdentity(sbxBin(),sbxChildEnv());
}
function claudeRuntimeFenceHolds(runtime) {
  try {
    return JSON.stringify(claudeBinaryIdentity())===JSON.stringify(runtime.binary) &&
      createHash('sha256').update(readFileSync(path.join(CLAUDE_KIT,'spec.yaml'))).digest('hex')===runtime.kitDigest;
  } catch {return false;}
}

// Env var name patterns that must never reach an `sbx` child process. Matches
// the note's §3 list: SSH agent forwarding, DOCKER_HOST, provider/model
// secrets, cloud CLI credentials, Git credential helpers, personal OAuth state.
// DBUS_SESSION_BUS_ADDRESS: with it, sbx's credential store uses the desktop
// keyring (Secret Service) — the operator's wallet pops unlock prompts for
// every background daemon operation, and a locked/hiccuping wallet turns into
// "no valid user session, sign in to Docker" plus undecryptable-secret
// failures (all found live, 2026-07-23). KDE's KWallet 6.24 also drops the
// login at random (DH session failures, 2026-10-19). The inherited variable
// is stripped here and sbxChildEnv() then pins a dead bus instead (see
// credentialStoreEnv), so the file store is chosen deterministically.
const STRIP_EXACT = new Set(['SSH_AUTH_SOCK', 'DOCKER_HOST', 'DBUS_SESSION_BUS_ADDRESS']);
const STRIP_PATTERNS = [
  /_API_KEY$/i,
  /_TOKEN$/i,
  /^AWS_/i,
  /^GCP_/i,
  /^GOOGLE_/i,
  /^AZURE_/i,
  /^GIT_/i,
  /^GH_/i,
  /^GITHUB_/i,
  /^DOCKER_/i,
  /^NPM_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
];

/**
 * Returns a copy of baseEnv with credential/identity-bearing variables
 * stripped. Exported by exact name for an independent hygiene test.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {NodeJS.ProcessEnv}
 */
export function sanitizedEnv(baseEnv) {
  const out = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (STRIP_EXACT.has(key)) continue;
    if (STRIP_PATTERNS.some((pattern) => pattern.test(key))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Waspflow-owned sbx state directory, distinct from the developer's personal
 * sbx config. `sbx` has no documented --config-dir flag as of this writing
 * (Runtime Decision §1: "I did not find a documented, cross-platform named
 * local-profile mechanism"). This is the LAST-RESORT option from that
 * numbered list: a distinct OS-level identity via a Waspflow-owned HOME,
 * pending Docker confirming a supported profile mechanism (graduation gate A,
 * decision-note item 12).
 */
// The disk store's record for the active sbx HOME (status and doctor read it without opening a backend).
export const sbxDiskLedgerFile = () => diskLedgerFile(sbxHome());
// True only for the sbx home Faravan itself selected (its default, its data-dir home or its own override variable): never
// the account's own home or the user's own Docker or sbx store. When this cannot be proven, nothing is removed.
export function isPrivateSbxHome(home, { override = process.env.FARAVAN_SBX_HOME, selected = () => selectSbxHome({ override: undefined }).home,
  userHomes = [os.homedir(), accountHome()] } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) return false;
  const resolved = path.resolve(home);
  if (userHomes.some(user => user && path.resolve(user) === resolved)) return false;
  if (['.sbx', '.docker'].includes(path.basename(resolved))) return false;
  return resolved === path.resolve(selected()) || (Boolean(override) && resolved === path.resolve(override));
}
function sbxHome() {
  const selection = selectSbxHome();
  if (selection.migration === 'legacy_home_too_long' && !warnedAboutLongLegacySbxHome) {
    warnedAboutLongLegacySbxHome = true;
    process.stderr.write('Waspflow is using a new sandbox home because the previous sandbox path is too long; no files were moved.\n');
  }
  return selection.home;
}

function scratchRoot() {
  return process.env.FARAVAN_SCRATCH_ROOT || os.tmpdir();
}

// Every filesystem a job's host bytes can land on: the sandbox service's state (VM disk images,
// image layers, logs; descendants may be independent mounts even on macOS), staged
// sources and outputs, temporary files, Faravan's own records, and the host container runtime.
export function hostDiskPaths({ home, cleanupDirectory, platform = process.platform,
  userHome = accountHome() } = {}) {
  const activeSbxHome = sbxHome();
  // The CLI/daemon HOME is isolated from the OS account HOME. Watch the known
  // write destinations under both identities, not only their broad ancestors:
  // auditkit itself can be a mount (or symlink) onto another filesystem.
  const sandboxPaths = platform === 'darwin' ? [userHome, activeSbxHome].filter(Boolean).flatMap(root => {
    const logs = path.join(root, 'Library', 'Logs', 'com.docker.sandboxes');
    return [path.join(root, 'Library', 'Application Support', 'com.docker.sandboxes'),
      logs, path.join(logs, 'sandboxes', 'auditkit')];
  }) : [];
  return [...new Set([activeSbxHome, scratchRoot(), os.tmpdir(), configHome(), userHome, home, cleanupDirectory,
    ...sandboxPaths,
    ...(platform === 'linux' ? ['/var/lib/containerd', '/var/lib/docker'] : [])].filter(Boolean))];
}


// Free bytes on the drive that holds the sandbox images and sandboxes, and on that drive only.
async function storeVolumeFree(disk) {
  const reading = await disk.free();
  const disks = (reading.volumes ?? []).filter(volume => !volume.memory);
  const free = disks.length ? Math.min(...disks.map(volume => volume.free)) : reading.free;
  if (!Number.isFinite(free)) throw policyError('host_disk_unreadable', 'Free space on the sandbox store could not be read.');
  return free;
}

// For the commands that report disk space without the app: the same reading, or null when it cannot be read.
export async function storeFreeBytes({ hostDiskFactory = createHostDisk } = {}) {
  try { return await storeVolumeFree(hostDiskFactory({ paths: () => [sbxHome()] })); } catch { return null; }
}

// The job id of the host's own meter sandbox for one lent attempt (the old host meter session, now removed). It is named from
// the attempt, so a restart can find and remove it from the attempt's pending record alone.
export function lendingMeterJobId(attemptId) {
  return `lending-meter:${attemptId}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Waspflow captures device-flow auth URLs and renders them in its own UI;
 * child CLIs must never reach the user's desktop browser themselves. `sbx
 * login` auto-launches the default browser (xdg-open) on every flow start,
 * which popped Chrome windows on the host each time a sign-in flow began
 * (live finding, 2026-07-22). A no-op xdg-open interposed on PATH (plus
 * BROWSER for CLIs that honor it) blocks the launch; the URL and code still
 * stream to Waspflow's UI, where opening the browser is an explicit click.
 */
export function suppressChildBrowserLaunch(env) {
  const dir = path.join(sbxHome(), 'no-browser-bin');
  const shim = path.join(dir, 'xdg-open');
  if (!existsSync(shim)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(shim, '#!/bin/sh\n# Waspflow no-op: auth URLs surface in the Faravan UI, never a forced browser window.\nexit 0\n', { mode: 0o755 });
  }
  env.PATH = env.PATH ? `${dir}${path.delimiter}${env.PATH}` : dir;
  env.BROWSER = 'true';
  return env;
}

/**
 * The environment that pins where Faravan's sbx identity keeps its Docker
 * sign-in. Every sbx process (CLI, login, daemon) must get exactly this, or
 * the CLI and the daemon can disagree on state and credential store.
 *
 * sbx has no selector for its credential store: it uses the desktop Secret
 * Service when it finds a session bus and falls back to an encrypted file
 * under $XDG_CONFIG_HOME/com.docker.sandboxes when it does not. A bus address
 * that points at a socket that does not exist makes sbx skip the Secret
 * Service without a single connect() (proven with strace, sbx 0.48.0,
 * 2026-10-19) and also stops godbus from rediscovering /run/user/<uid>/bus.
 * The XDG directories are pinned to their defaults under HOME so a login
 * environment that sets them cannot move the file store or the daemon socket.
 * XDG_RUNTIME_DIR is deliberately left alone: sbx never reads the credential
 * store from it, and a private one was not qualified for sandbox start.
 * Windows and macOS use their own native store, so only HOME is pinned there.
 */
export function credentialStoreEnv(home = sbxHome(), platformName = process.platform) {
  const env = { HOME: home };
  if (platformName !== 'linux') return env;
  return {
    ...env,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(home, 'no-session-bus')}`,
  };
}

/** Names of the pinned variables whose value in `environ` differs from the pin. */
export function credentialStoreMismatches(environ, expected) {
  return Object.keys(expected).filter((key) => environ?.[key] !== expected[key]);
}

// sbx runs each sandbox as a containerd shim process started under the
// identity's HOME. Match the whole shim family, including GPU sandboxes.
const SANDBOX_SHIM_PREFIX = 'containerd-shim-nerdbox';

// Returns the matching processes, and whether the scan saw everything: a /proc that cannot be listed, or a process
// that is still there but cannot be read, makes the scan incomplete. Only a process that exited meanwhile is skipped.
async function scanIdentityProcesses(matches, { procRoot, home }) {
  let entries;
  try { entries = await readdir(procRoot); } catch { return { complete: false, found: [] }; }
  const found = [];
  let complete = true;
  const exited = (error) => error?.code === 'ENOENT' || error?.code === 'ESRCH';
  for (const entry of entries.filter((name) => /^\d+$/.test(name))) {
    let argv;
    try { argv = (await readFile(path.join(procRoot, entry, 'cmdline'), 'utf8')).split('\0'); }
    catch (error) { if (!exited(error)) complete = false; continue; }
    if (!matches(argv)) continue;
    try {
      const environ = {};
      for (const line of (await readFile(path.join(procRoot, entry, 'environ'), 'utf8')).split('\0')) {
        const at = line.indexOf('=');
        if (at > 0) environ[line.slice(0, at)] = line.slice(at + 1);
      }
      if (environ.HOME === home) found.push({ pid: Number(entry), environ });
    } catch (error) { if (!exited(error)) complete = false; } // a matching process we cannot read may be ours
  }
  return { complete, found };
}

/**
 * Finds running `sbx daemon start` processes of this identity (same HOME) and
 * their environments. A daemon keeps the environment it started with, so this
 * is the only way to know which credential store it really uses.
 */
export function inspectIdentityDaemons({ procRoot = '/proc', home = sbxHome() } = {}) {
  const names = new Set(['sbx', path.basename(sbxBin())]);
  return scanIdentityProcesses((argv) => names.has(path.basename(argv[0])) && argv[1] === 'daemon' && argv[2] === 'start', { procRoot, home })
    .then((scan) => scan.complete ? scan.found : null); // null: unknown, never "none" or "unique"
}

/**
 * Finds the running sandboxes of this identity without asking sbx. `sbx ls`
 * needs a Docker sign-in, which is exactly what is missing when the
 * credential store is the thing being repaired.
 */
export async function inspectIdentitySandboxes({ procRoot = '/proc', home = sbxHome() } = {}) {
  const scan = await scanIdentityProcesses((argv) => path.basename(argv[0]).startsWith(SANDBOX_SHIM_PREFIX), { procRoot, home });
  return scan.complete || scan.found.length > 0 ? scan.found : null; // null: unknown, never "none"
}

// Legacy absence needs host-wide evidence, independent of the daemon's HOME.
export async function inspectLegacySandboxReferences(names,{procRoot='/proc',fs:procFs={readdir,readFile,readlink,stat},uid=process.getuid?.()}={}) {
  const references=[];
  let entries;
  try {entries=await procFs.readdir(procRoot);}catch{return {complete:false,references};}
  for(const pid of entries.filter(name=>/^[0-9]+$/.test(name))) {
    try {
      const command=await procFs.readFile(path.join(procRoot,pid,'cmdline'),'utf8');
      const owner=await procFs.stat(path.join(procRoot,pid));
      if(!Number.isSafeInteger(owner.uid)||!Number.isSafeInteger(uid))return {complete:false,references};
      const cwd=await procFs.readlink(path.join(procRoot,pid,'cwd')).catch(async error=>{
        // Other users and kernel processes can expose cmdline but deny cwd.
        if(['EACCES','EPERM'].includes(error.code)&&owner.uid!==uid)return '';
        if(['ENOENT','ESRCH'].includes(error.code)){
          await procFs.stat(path.join(procRoot,pid)); // Only a PID that vanished can be skipped.
          throw policyError('cessation_unverified','A live process has an unreadable working directory.');
        }
        throw error;
      });
      const matches=names.filter(name=>command.includes(name)||cwd.includes(name));
      if(matches.length)references.push(...matches);
      else if(path.basename(command.split('\0')[0]).startsWith(SANDBOX_SHIM_PREFIX))references.push('unmapped sandbox shim');
    }catch(error){if(!['ENOENT','ESRCH'].includes(error.code))return {complete:false,references};}
  }
  return {complete:true,references:[...new Set(references)]};
}

// ps must be complete: execFile rejects timeout/buffer overflow, and -ax includes
// other users. Refuse every sandbox reference, including receipt names, rather
// than guessing which unrelated shim belongs to this job.
export async function inspectMacSandboxReferences(names, {runCommand=runPreflightCommand}={}) {
  try {
    const result=await runCommand('/bin/ps',['-ww','-axo','pid,ppid,command'],{env:process.env,timeout:PREFLIGHT_COMMAND_TIMEOUT_MS});
    if(result?.code!==0||result.timedOut||result.killed||result.truncated||result.errorCode||result.stderr?.trim())
      return {complete:false,references:[]};
    const text=String(result.stdout??'');
    if(!text.endsWith('\n'))return {complete:false,references:[]};
    const lines=text.trimEnd().split('\n');
    if(!/^\s*PID\s+PPID\s+COMMAND\s*$/.test(lines.shift())||!lines.length)return {complete:false,references:[]};
    const references=[];
    for(const line of lines) {
      const row=/^\s*([0-9]+)\s+([0-9]+)\s+(\S.*)$/.exec(line);
      if(!row)return {complete:false,references:[]};
      const command=row[3];
      if(names.some(name=>command.includes(name))||/wf-[0-9a-f]{16}/.test(command)||command.includes(SANDBOX_SHIM_PREFIX))
        references.push(row[1]);
    }
    return {complete:true,references};
  }catch{return {complete:false,references:[]};}
}

// The shim inventory proves HOME only. It does not prove a sandbox name or
// owning unit, so a timed-out stop cannot safely escalate to a process kill.
export async function killIdentitySandboxes() {
  return false;
}

/**
 * macOS finds the user's keychains through $HOME/Library/Keychains. With HOME
 * pinned to the sandbox home, every sbx store (the Docker sign-in and each
 * agent secret) failed with "a keychain cannot be found to store ..." (live on
 * macOS 26.7, 2026-10-27; `security default-keychain -d user` fails the same
 * way). A link to the account's own Keychains folder restores the login
 * keychain without moving sbx state out of the sandbox home. An existing
 * entry is never replaced.
 */
export function linkAccountKeychains(home = sbxHome(), { platformName = process.platform, userHome = accountHome() } = {}) {
  if (platformName !== 'darwin' || !userHome || path.resolve(home) === path.resolve(userHome)) return false;
  const link = path.join(home, 'Library', 'Keychains');
  try { lstatSync(link); return false; } catch (error) { if (error?.code !== 'ENOENT') return false; }
  try {
    mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
    symlinkSync(path.join(userHome, 'Library', 'Keychains'), link);
    return true;
  } catch { return false; }
}

/** Builds the sanitized, profile-isolated env every `sbx` child process gets. */
export function sbxChildEnv() {
  const env = sanitizedEnv(process.env);
  Object.assign(env, credentialStoreEnv());
  linkAccountKeychains(env.HOME);
  return suppressChildBrowserLaunch(env);
}

export function spawnSbxChild(runtime,args,{mode='buffered',callback,fenceSignal,...options}={},primitives={execFile,execFileCb,spawn,spawnSync,execve:process.execve}) {
  assertSbxRuntime(runtime,{signal:fenceSignal??options.signal,env:options.env});
  if(mode==='delegated'){
    const {command,delegatedArgs,...childOptions}=options;
    const helper=fileURLToPath(new URL('./sbx-exec-launch.mjs',import.meta.url));
    return primitives.execFile(command,[...delegatedArgs,process.execPath,helper,Buffer.from(JSON.stringify(describeSbxRuntime(runtime))).toString('base64url'),...args],childOptions);
  }
  if(mode==='spawn')return primitives.spawn(runtime.path,args,options);
  if(mode==='sync')return primitives.spawnSync(runtime.path,args,options);
  if(mode==='callback')return primitives.execFileCb(runtime.path,args,options,callback);
  if(mode==='execve')return primitives.execve(runtime.path,[runtime.path,...args],options.env??process.env);
  if(mode!=='buffered')throw policyError('claude_account_unavailable','Unknown sandbox process transport.');
  return primitives.execFile(runtime.path,args,options);
}
function launchRuntime({sbxRuntime,binary,beforeSpawn}={}) {
  return sbxRuntime??(binary&&beforeSpawn?createSbxRuntime({path:binary,fence:beforeSpawn}):null)??currentSbxRuntime();
}
export function hostSbxCallback(binary,args,options,callback) {
  const runtime=currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,binary,env:options?.env??sbxChildEnv()});
  return spawnSbxChild(runtime,args,{...options,mode:'callback',callback});
}
async function runSbx(args, { input, beforeSpawn, binary, sbxRuntime, ...options } = {}) {
  const runtime=launchRuntime({sbxRuntime,binary,beforeSpawn});
  const started=performance.now();
  return withSbxRuntime(runtime,async()=>{
  let dispatchRefused=false;
  try {
    const {pending} = await dispatchSbx(args, options, (transportBinary,transportEnv) => {
      const childOptions = {
        env: transportEnv,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30_000,
        killSignal: 'SIGKILL',
        ...options,
      };
      // A refusal at the process boundary (the runtime fence) is not a command result.
      dispatchRefused=true;
      const child = spawnSbxChild(runtime,args,childOptions);
      dispatchRefused=false;
      // Only a secret value is ever written to sbx's stdin, and it is written in the same turn as the launch so that no
      // await separates the runtime fence from the value. Always close it: an agent run through `sbx exec` otherwise
      // prints "Reading additional input from stdin..." and waits forever (seen live with codex, 2026-10-18).
      // The caller awaits the result next; a result that fails first is its to handle, not an unhandled rejection.
      child.catch?.(() => {});
      recordDaemonLaunch(child.child);
      child.child?.stdin?.on('error', () => {});
      child.child?.stdin?.end(input);
      return {pending:child};
    });
    const { stdout, stderr } = await pending;
    return { code: 0, stdout, stderr };
  } catch (error) {
    if(['ls','create','run'].includes(args[0]))bindSandboxCommandDiagnostic(error,sandboxCommandDiagnosticOf(error)??sandboxCommandDiagnostic({
      ...error,timedOut:error?.code==='ETIMEDOUT'||error?.code==null&&error?.killed===true&&options.timeout>0,
      truncated:error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER',stderr:error?.stderr??error?.message,
    },{...daemonJobContext.getStore()?.commandObservation,subcommand:args[0]==='ls'?'ls --json':args[0],runtime_path:runtime?.path,duration_ms:performance.now()-started}));
    if (dispatchRefused || error && ['ENOENT','cessation_unverified','claude_account_unavailable'].includes(error.code)) throw error;
    if ([DOCKER_SIGNED_OUT, DOCKER_SIGNIN_STATE_UNAVAILABLE].includes(error?.code)) throw error;
    if (error instanceof SbxDaemonVerificationError) {
      return bindSandboxCommandDiagnostic({ code: 1, stdout: '', stderr: error.message, errorCode: error.code, status: error.status },sandboxCommandDiagnosticOf(error));
    }
    // `exited` is true only when the command ran to an exit code. A timeout, a kill and a transport error
    // carry no exit code, so the caller cannot treat them as a refusal.
    // execFile's killed flag can be false for an external signal (including OOM).
    const failed = { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout || '', stderr: error.stderr || String(error.message || error),
      exited: Number.isInteger(error.code) && !error.killed && !error.signal,
      ...(error.signal ? {signal:error.signal} : {}),
      ...(error.code ? {errorCode:error.code} : {}), ...(error.killed === true ? {killed:true} : {}),
      ...(error.probe_subcause ? {probe_subcause:error.probe_subcause} : {}) };
    return bindSandboxCommandDiagnostic(failed,sandboxCommandDiagnosticOf(error));
  }
  });
}

// Daemon preparation may wait. Every raw exec transport checks protection
// afterwards, then checks cancellation and launches without another await.
async function dispatchSbx(args, {signal,env,beforeExec} = {}, launch) {
  if (needsSbxDaemon(args)) await ensureSbxDaemon({env,commandArgs:args});
  const transportBinary=sbxBin(),transportEnv=sbxChildEnv(),start=()=>launch(transportBinary,transportEnv);
  if(needsSbxDaemon(args)&&['exec','create','run'].includes(args[0])) {
    const check=beforeExec??daemonJobContext.getStore()?.beforeExec;
    if(!check)throw policyError('sandbox_start_failed','The sandbox execution gate is unavailable. Please retry.',{probe_subcause:'execution_gate_refused'});
    return check(()=>{signal?.throwIfAborted();return start();});
  }
  signal?.throwIfAborted();
  return start();
}

// The normal helper intentionally buffers short sbx control commands. Agent
// execution is different: callers need provider events while the command is
// still running, so preserve the same sanitized environment while forwarding
// chunks as they arrive.
async function runSbxStreaming(args, onLog, signal, onExecutionStarted, budget, {beforeSpawn,binary,sbxRuntime} = {}) {
  const runtime=launchRuntime({sbxRuntime,binary,beforeSpawn});
  return withSbxRuntime(runtime,async()=>{
  const child = await dispatchSbx(args,{signal},(transportBinary,transportEnv)=>spawnSbxChild(runtime,args,{env:transportEnv,stdio:['ignore','pipe','pipe'],signal,killSignal:'SIGKILL',mode:'spawn'}));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let outputExceeded = false;
    recordDaemonLaunch(child);
    const append = (current, chunk) => `${current}${chunk}`.slice(-16 * 1024 * 1024);
    const receive = (stream, chunk) => {
      if (outputExceeded) return;
      if (budget && chunk.byteLength > budget.remaining) {
        outputExceeded = true;
        child.kill('SIGKILL');
        return;
      }
      if (budget) budget.remaining -= chunk.byteLength;
      if (stream === 'stdout') stdout = append(stdout, chunk); else stderr = append(stderr, chunk);
      onLog?.({ stream, chunk });
    };
    child.stdout.on('data', chunk => receive('stdout', chunk));
    child.stderr.on('data', chunk => receive('stderr', chunk));
    child.once('error', (error) => resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout, stderr: `${stderr}${error.message || error}` }));
    child.once('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr, outputExceeded });
    });
  });
  });
}

// Binary transport: no UTF-8 decoding, log forwarding, or whole-output buffer.
// Consuming code owns the byte budget; early iterator return kills the copy.
async function* streamSbxOutput(handle, source, { signal,beforeExec } = {}) {
  const command = 'test -f "$1" && test ! -L "$1" && exec cat -- "$1"';
  const args = ['exec', handle.sandbox_id, '--', 'sh', '-c', command, 'sh', source];
  const runtime=handle._sbxRuntime;
  const child = await withSbxRuntime(runtime,()=>daemonJobContext.run({handle, agentRun:false},()=>dispatchSbx(args,{signal,beforeExec},(transportBinary,transportEnv)=>spawnSbxChild(runtime,args,{
    env: transportEnv, stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL', mode:'spawn',
  }))));
  let stderr = '';
  let spawnError;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error; });
    child.once('close', code => resolve({ code, error: spawnError }));
  });
  try {
    for await (const chunk of child.stdout) yield chunk;
    const result = await closed;
    if (result.error || result.code !== 0) throw policyError('output_copy_failed', `Output stream failed: ${result.error?.message || stderr || `exit ${result.code}`}`);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await closed;
  }
}

function outputOf(result) {
  // sbx diagnose uses ANSI styling in an interactive-capable terminal. The
  // readiness facts must not depend on whether its output was colorized.
  return `${result?.stdout || ''}\n${result?.stderr || ''}`.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim();
}

/**
 * Extracts the account name from Docker Sandboxes' own diagnostic output.
 * `sbx diagnose` is human-facing and version-dependent, so absence is an
 * honest null rather than a failed contribution or a guessed host identity.
 */
export function parseDockerAccount(diagnoseOutput) {
  const output = String(diagnoseOutput || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
  const match = /(?:\bSigned in as|\bAuthentication\s*[—:-]\s*(?:authenticated\s+)?(?:as|account)\s*[:=]?|\bDocker account\s*[:=]|\busername\s*[:=])\s*\[?([^\s\],()]+)/i.exec(output);
  return match ? match[1] : null;
}

/**
 * Reads the authenticated Docker username under the same isolated child env
 * as jobs. Current `sbx diagnose` exposes only an authentication boolean;
 * when it says authenticated, `sbx login` is a non-interactive status read
 * (`You are signed in [username: …]`). Never invoke login when diagnose does
 * not confirm authentication, because that path can legitimately begin the
 * interactive sign-in flow.
 */
export async function readDockerAccount() {
  const runtime=currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,env:sbxChildEnv()});
  const diagnose = await runSbx(['diagnose'],{sbxRuntime:runtime});
  const diagnoseOutput = outputOf(diagnose);
  const fromDiagnose = parseDockerAccount(diagnoseOutput);
  if (fromDiagnose) return fromDiagnose;
  if (!/\bAuthentication\b[^\n]*\bauthenticated\b/i.test(diagnoseOutput)) return null;
  const login = await runSbx(['login'],{sbxRuntime:runtime});
  return parseDockerAccount(outputOf(login));
}

function diagnosticsOf(result) {
  return `${result?.stdout || ''}${result?.stderr ? `\n${result.stderr}` : ''}`.trim();
}

function commandWorked(result) {
  return result && result.code === 0;
}

function packageIsInstalled(result, packageName) {
  return commandWorked(result) && new RegExp(`^${packageName}\\tinstalled\\t`, 'm').test(result.stdout || '');
}

function containerdIsV2(result) {
  return commandWorked(result) && /(?:^|\s)v?2\./.test(outputOf(result));
}

function hasDiagnostic(text, pattern) {
  return pattern.test(text || '');
}

const LOGIN_UNKNOWN_MESSAGE = 'Faravan could not list Docker sandboxes. Open Setup and choose Check again. If asked, select Sign in to Docker.';
const LOGIN_REFRESH_UNAVAILABLE = /docker login service unavailable/i;
function dockerLoginState(loginProbe) {
  const loginDiagnostics = outputOf(loginProbe);
  // A working listing permits trying a create, but proves no Docker identity.
  if (commandWorked(loginProbe)) return { missing: false, ok: true, signinVerified: false };
  if (dockerSessionRefused(loginProbe?.stderr)) return { missing: true, ok: false };
  if (hasDiagnostic(loginDiagnostics, LOGIN_REFRESH_UNAVAILABLE) && /could not be refreshed/i.test(loginDiagnostics)) return { missing: false, ok: false, refreshUnavailable: true };

  // Diagnostics cannot prove a failed sandbox listing is usable.
  return { missing: false, ok: false, unknown: true };
}

// The readiness checks this module reports. The telemetry catalog's readiness_check enum is generated from this list.
export const READINESS_CHECKS = Object.freeze([
  'guard_runtime', 'docker_login', 'docker_runtime', 'hypervisor_platform', 'kvm_access', 'network_policy', 'sbx_cli_contract',
  'host_disk', 'sbx_credential_store', 'sbx_daemon', 'sbx_diagnostics', 'sbx_install', 'sbx_keychain', 'sbx_version', 'socket_path_length', 'windows_file_permissions',
]);

function check(name, ok, detail, fix, diagnostics = '') {
  return { name, ok, detail, fix, diagnostics };
}

export function socketPathLengthCheck(home = sbxHome(), platform = process.platform) {
  const socketPath = containerdSocketPathForSbxHome(home);
  const socketPathBytes = Buffer.byteLength(socketPath);
  const ok = socketPathFits(socketPath, platform);
  return check(
    'socket_path_length',
    ok,
    ok ? `The sandbox files are at a path that is ${socketPathBytes} bytes long.` : 'The sandbox files live at a path that is too long for the system.',
    ok ? '' : 'Set FARAVAN_SBX_HOME to a shorter directory.',
    `Sandbox path length: ${socketPathBytes} bytes.`,
  );
}

function sbxCliContractCheck(version, runHelp) {
  const fix = 'Install a Docker Sandboxes version Faravan supports, or update Faravan.';
  if (!commandWorked(version) || !commandWorked(runHelp)) {
    return check('sbx_cli_contract', false, 'Could not read the Docker Sandboxes command options.', fix, diagnosticsOf(runHelp));
  }
  const options = new Set();
  for (const line of outputOf(runHelp).split(/\r?\n/)) {
    // Only the option declaration at the start of a line, never its description.
    const declaration = /^\s*(-{1,2}[A-Za-z0-9][A-Za-z0-9-]*(?:,\s*-{1,2}[A-Za-z0-9][A-Za-z0-9-]*)*)(?=\s|$)/.exec(line);
    if (declaration) for (const flag of declaration[1].split(/,\s*/)) options.add(flag);
  }
  const missing = SBX_RUN_OPTIONS.filter((flag) => !options.has(flag));
  return check('sbx_cli_contract', missing.length === 0,
    missing.length ? `This Docker Sandboxes version does not accept options Faravan uses: ${missing.join(', ')}.` : 'Docker Sandboxes accepts the options Faravan uses.',
    missing.length ? fix : '', diagnosticsOf(runHelp));
}

export {daemonRestartNeeded} from './sandbox-remediation.mjs';

function usesDefaultSbxHome() { return !process.env.FARAVAN_SBX_HOME && !process.env.FARAVAN_SBX_HOME; }

function daemonUpdateChecks(checks, needed) {
  if (!needed) return checks;
  // A failed call during an update says nothing about login, policy, or accepted run flags.
  return [...checks.filter(c => !['sbx_daemon','network_policy','docker_login','sbx_cli_contract'].includes(c.name)),
    {...check('sbx_daemon', false, 'Docker Sandboxes needs to restart to finish its update.',
      usesDefaultSbxHome() ? 'Faravan restarts Docker Sandboxes when the current job finishes.' : 'Restart Docker Sandboxes', ''),
      automatic: usesDefaultSbxHome(), cause: 'daemon_restart_required'}];
}

function preflightChecks({ platformName, version, runHelp, packages, dockerVersion, containerdVersion, diagnose, dockerLoginProbe, observation = false, policy, kvmReadable, kvmWritable, hypervisorPlatform, daemonEnvironments = [], sbxHome: activeSbxHome = sbxHome(), userHome = accountHome(), realpathPath = realpathSync, restartNeeded = [version, diagnose].some(value=>daemonRestartNeeded(value))||daemonRestartNeeded(policy,{source:'policy'}) }) {
  const diagnostics = outputOf(diagnose);
  const diagnoseDiagnostics = diagnosticsOf(diagnose);
  const policyOutput = outputOf(policy);
  const policyDiagnostics = diagnosticsOf(policy);
  const sbxPresent = version?.errorCode !== 'ENOENT';
  const sbxInstallOk = sbxPresent && commandWorked(version)
    && (platformName !== 'linux' || packageIsInstalled(packages, 'docker-sbx'));
  const sbxInstallDetail = !sbxPresent
    ? 'sbx was not found on PATH.'
    : !commandWorked(version)
      ? 'Docker Sandboxes could not be verified.'
      : platformName === 'linux' && !packageIsInstalled(packages, 'docker-sbx')
        ? 'sbx is present, but docker-sbx is not installed as an apt package; a copied binary skips required dependencies.'
        : 'Docker Sandboxes is installed.';
  const sbxInstallFix = platformName === 'darwin'
    ? 'brew trust docker/tap && brew install docker/tap/sbx'
    : platformName === 'win32'
      ? 'winget install -h Docker.sbx'
      : UBUNTU_INSTALL_FIX;

  const transferPluginFailure = hasDiagnostic(diagnostics, /io\.containerd\.transfer\.v1:\s*no plugins registered/i);
  const dockerRuntimeOk = platformName !== 'linux' || (
    packageIsInstalled(packages, 'docker-ce')
    && packageIsInstalled(packages, 'containerd.io')
    && commandWorked(dockerVersion)
    && containerdIsV2(containerdVersion)
    && !transferPluginFailure
  );
  const dockerRuntimeDetail = platformName !== 'linux'
    ? 'not checked on this platform (Docker Sandboxes manages the runtime outside Ubuntu apt).'
    : transferPluginFailure
      ? 'sbx reported io.containerd.transfer.v1: no plugins registered; this is the Ubuntu docker.io/containerd mismatch.'
      : !packageIsInstalled(packages, 'docker-ce') || !packageIsInstalled(packages, 'containerd.io')
        ? 'Docker CE and containerd.io must be installed from download.docker.com; Ubuntu docker.io is not sufficient.'
        : !commandWorked(dockerVersion) || !containerdIsV2(containerdVersion)
          ? 'Docker CE and containerd v2 could not be verified.'
          : 'Docker CE and containerd v2 are ready.';

  // `sbx diagnose` exits non-zero when a different check (for example Docker
  // login) fails. Its explicit daemon line is still authoritative for this
  // separate prerequisite, so do not misdiagnose a healthy daemon as broken.
  // An explicit authentication refusal is a response from the service, not a stopped daemon.
  const loginState = dockerLoginState(dockerLoginProbe);
  const signinRefused = loginState.missing || loginState.refreshUnavailable;
  const daemonOk = signinRefused || (observation ? commandWorked(dockerLoginProbe) : hasDiagnostic(diagnostics, /daemon\b[^\n]{0,30}\bhealthy/i));
  // A read that timed out is no evidence either way: report unknown, never stopped or signed out.
  const daemonUnknown = !daemonOk && (observation ? dockerLoginProbe?.timedOut === true : diagnose?.timedOut === true);
  const daemonDetail = daemonOk
    ? observation ? 'The sandbox service responded.' : 'sbx diagnose reports Daemon healthy.'
    : observation ? 'The sandbox service could not be verified.' : 'The sandbox service is not running yet.';

  const policyMissing = hasDiagnostic(policyOutput, /global network policy has not been initialized/i);
  // Rule rows on top of deny-all are scoped exceptions (Faravan's own provider
  // hosts or the owner's); the per-sandbox egress check gates those, so only a
  // listing without deny-all counts as wrong.
  const policyWrong = commandWorked(policy) && !policyMissing && !/deny-all/i.test(policyOutput) && (
    /\b(?:balanced|allow-all|allow all hosts|custom)\b/i.test(policyOutput) ||
    /\b(?:allow|deny)\s+(?!all\b)\S+/i.test(policyOutput));
  const policyOk = commandWorked(policy) && !policyMissing && !policyWrong;
  const policyDetail = policyOk
    ? (/deny-all/i.test(policyOutput) ? 'Global network policy is initialized as deny-all.' : 'Existing global policy is retained; per-sandbox verification is required.')
    : policyMissing
      ? 'global network policy has not been initialized.'
      : 'The sandbox network policy could not be verified.';


  const kvmDiagnosticFailure = hasDiagnostic(diagnostics, /KVM error:\s*Permission denied/i);
  // The AUTHORITATIVE signal is sbx's own runtime diagnostic ("KVM error:
  // Permission denied") — the `test -r/-w /dev/kvm` probes are ADVISORY only.
  // Found live: on a host granting /dev/kvm via a POSIX ACL, `test -r`
  // returns 1 from non-interactive contexts even though sbx microVMs run
  // perfectly — hard-failing on the probe blocked a fully-capable machine.
  const kvmProbesSayNo = platformName === 'linux' && (!commandWorked(kvmReadable) || !commandWorked(kvmWritable));
  const kvmOk = platformName !== 'linux' || !kvmDiagnosticFailure;
  const kvmDetail = platformName !== 'linux'
    ? 'not applicable on this platform.'
    : kvmDiagnosticFailure
      ? 'sbx reported KVM error: Permission denied (os error 13).'
      : kvmProbesSayNo
        ? '/dev/kvm probe was inconclusive (ACL setups can report this) — no KVM failure observed from sbx itself.'
        : '/dev/kvm is readable and writable by this user.';

  const { missing: loginMissing, ok: loginOk, refreshUnavailable, unknown: loginUnknown } = loginState;
  const loginDetail = loginUnknown ? LOGIN_UNKNOWN_MESSAGE : refreshUnavailable ? DOCKER_SIGNIN_REFRESH_MESSAGE : loginOk
    ? 'No Docker sign-in refusal has been observed.'
    : loginMissing
      ? "The sandbox service isn't signed in to Docker yet."
      : 'Docker sign-in could not be verified.';
  const loginDiagnostics = diagnosticsOf(dockerLoginProbe);

  if (platformName === 'win32') return daemonUpdateChecks([...windowsPreflightChecks({ version, dockerLoginProbe, hypervisorPlatform }),
    networkPolicyCheck({ policyOk, policyMissing, policyWrong, policyDetail, policyOutput, policyDiagnostics, loginOk }),
    sbxVersionCheck(version), sbxCliContractCheck(version, runHelp), socketPathLengthCheck(activeSbxHome, platformName)], restartNeeded);

  return daemonUpdateChecks([
    check('sbx_install', sbxInstallOk, sbxInstallDetail, sbxInstallOk ? '' : sbxInstallFix, diagnosticsOf(version)),
    sbxVersionCheck(version),
    sbxCliContractCheck(version, runHelp),
    check('docker_runtime', dockerRuntimeOk, dockerRuntimeDetail, dockerRuntimeOk ? '' : UBUNTU_INSTALL_FIX, `${diagnosticsOf(packages)}\n${diagnosticsOf(dockerVersion)}\n${diagnosticsOf(containerdVersion)}\n${diagnoseDiagnostics}`.trim()),
    sbxDaemonCheck({ daemonOk, daemonUnknown, daemonDetail, diagnostics: observation ? diagnosticsOf(dockerLoginProbe) : diagnoseDiagnostics }),
    ...(platformName === 'linux' ? [credentialStoreCheck(daemonEnvironments, activeSbxHome)] : []),
    ...(platformName === 'darwin' ? [sbxKeychainCheck(activeSbxHome, userHome, realpathPath)] : []),
    networkPolicyCheck({ policyOk, policyMissing, policyWrong, policyDetail, policyOutput, policyDiagnostics, loginOk }),
    { ...check('kvm_access', kvmOk, kvmDetail, kvmOk ? '' : 'sudo usermod -aG kvm $USER && newgrp kvm (on a VM, also enable nested virtualization)', diagnoseDiagnostics),
      ...(kvmOk && kvmProbesSayNo ? { status: 'inconclusive' } : {}) },
    { ...check('docker_login', loginOk, loginDetail, loginUnknown ? 'Open Setup and choose Check again. If asked, select Sign in to Docker.' : refreshUnavailable ? 'Open Setup and select Sign in to Docker.' : loginOk ? '' : 'Open Faravan and select Sign in to Docker.', loginDiagnostics), ...(loginOk ? {signinVerified:false} : {}), ...(refreshUnavailable ? {cause:'docker_signin_refresh_unavailable'} : {}), ...(loginUnknown ? { unknown: true } : {}) },
    socketPathLengthCheck(activeSbxHome, platformName),
  ], restartNeeded);
}

// Faravan starts the sandbox service by itself only for the stopped or unreachable shape (daemonNeedsStart). Any other
// failure, including a service Faravan refused to use, stays until the person acts, so it never promises a self-repair.
function sbxDaemonCheck({ daemonOk, daemonUnknown, daemonDetail, diagnostics }) {
  if (daemonOk) return check('sbx_daemon', true, daemonDetail, '', diagnostics);
  const unknown = daemonUnknown ? { unknown: true } : {};
  if (DAEMON_UNREACHABLE.test(diagnostics || '')) return { ...check('sbx_daemon', false, daemonDetail, '', diagnostics), automatic: true, ...unknown };
  return { ...check('sbx_daemon', false, daemonUnknown ? daemonDetail : 'Faravan could not confirm that its sandbox service is working, so it did not use it.',
    'Choose Check again. If it stays this way, open Settings and save a support report.', diagnostics), automatic: false, ...unknown };
}

function sbxKeychainCheck(home, userHome, resolvePath) {
  const accountKeychains = userHome && path.join(userHome, 'Library', 'Keychains');
  let linkedKeychains = null, resolvedAccountKeychains = null;
  try { linkedKeychains = resolvePath(path.join(home, 'Library', 'Keychains')); } catch {}
  try { if (accountKeychains) resolvedAccountKeychains = resolvePath(accountKeychains); } catch {}
  const ok = !!linkedKeychains && !!resolvedAccountKeychains && linkedKeychains === resolvedAccountKeychains;
  return { ...check('sbx_keychain', ok,
    ok ? 'The sandbox service can use the account Keychains folder.' : 'The sandbox service cannot find the account Keychains folder.',
    ok ? '' : 'Faravan links the account Keychains folder automatically.', ''), ...(!ok ? { automatic: true } : {}) };
}

// `automatic: true` marks a failure Faravan repairs by itself (ensureSbxIdentity
// starts the daemon and sets the policy in its own home), so the app shows no command for
// it. The CLI doctor still prints `fix`. sbx reads no policy while it is signed
// out, so then the policy only waits for the Docker sign-in.
function networkPolicyCheck({ policyOk, policyMissing, policyWrong, policyDetail, policyOutput, policyDiagnostics, loginOk }) {
  if (policyOk) return { ...check('network_policy', true, policyDetail, '', policyDiagnostics), ...(!/deny-all/i.test(policyOutput) ? { severity: 'notice' } : {}) };
  if (!loginOk && !policyMissing) {
    return { ...check('network_policy', false, 'Waits for the Docker sign-in.', 'Sign in to Docker. Faravan then sets the sandbox network policy by itself.', policyDiagnostics), automatic: true, waitsFor: 'docker_login' };
  }
  if (policyWrong) return { ...check('network_policy', false, 'Faravan’s sandbox network policy must be deny-all.', 'Reset sandbox network rules', policyDiagnostics), automatic: false, needsInitialization: true, repair:'policy_confirm' };
  if (policyMissing) return { ...check('network_policy', false, policyDetail, 'faravan doctor --fix-policy', policyDiagnostics), automatic: true };
  return { ...check('network_policy', false, 'Docker Sandboxes could not read the network rules. Open Settings to save a support report.', 'Open Settings', policyDiagnostics), automatic: false, repair:'support' };
}

// A running daemon keeps the environment it started with, so a daemon that
// started before Faravan pinned its credential store keeps using the desktop
// keyring no matter what later CLI calls pass in.
function credentialStoreCheck(daemonEnvironments, activeSbxHome) {
  if (!Array.isArray(daemonEnvironments)) return check('sbx_credential_store', false,
    'The sandbox service could not be checked: Faravan could not read every running process.',
    'Check again. If this keeps failing, restart the computer.', '');
  const expected = credentialStoreEnv(activeSbxHome, 'linux');
  const stale = daemonEnvironments
    .map(({ pid, environ }) => ({ pid, keys: credentialStoreMismatches(environ, expected) }))
    .filter((daemon) => daemon.keys.length > 0);
  if (stale.length === 0) {
    return check('sbx_credential_store', true,
      daemonEnvironments.length > 0
        ? 'The sandbox service keeps its Docker sign-in in Faravan\'s own folder.'
        : 'The sandbox service will keep its Docker sign-in in Faravan\'s own folder when it starts.', '', '');
  }
  return check('sbx_credential_store', false,
    'The running sandbox service still keeps its Docker sign-in in your desktop keyring.',
    legacyDaemonMessage({...oldDaemonEnv(daemonEnvironments[0]?.environ), HOME:activeSbxHome}),
    stale.map((daemon) => `daemon pid ${daemon.pid} differs on ${daemon.keys.join(', ')}`).join('\n'));
}

function windowsPreflightChecks({ version, dockerLoginProbe, hypervisorPlatform }) {
  const sbxInstallOk = commandWorked(version);
  const hypervisorEnabled = commandWorked(hypervisorPlatform) && /\benabled\b/i.test(outputOf(hypervisorPlatform));
  const { missing: loginMissing, ok: loginOk, refreshUnavailable, unknown: loginUnknown } = dockerLoginState(dockerLoginProbe);
  const loginDiagnostics = diagnosticsOf(dockerLoginProbe);

  return [
    check('sbx_install', sbxInstallOk,
      sbxInstallOk ? 'Docker Sandboxes is installed.' : 'Docker Sandboxes is not installed on this computer.',
      sbxInstallOk ? '' : 'Run the Faravan installer\'s Repair action. If repair is unavailable, this device cannot contribute yet.', diagnosticsOf(version)),
    check('hypervisor_platform', hypervisorEnabled,
      hypervisorEnabled ? 'Windows Hypervisor Platform is enabled.' : 'Windows Hypervisor Platform is not enabled.',
      hypervisorEnabled ? '' : 'Reinstall or run the Faravan installer\'s Repair action. Last resort for an administrator: Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart', diagnosticsOf(hypervisorPlatform)),
    {...check('docker_login', loginOk,
      loginUnknown ? LOGIN_UNKNOWN_MESSAGE : refreshUnavailable ? DOCKER_SIGNIN_REFRESH_MESSAGE : loginOk ? 'No Docker sign-in refusal has been observed.' : loginMissing
        ? "The sandbox service isn't signed in to Docker yet."
        : 'Docker sign-in could not be verified.',
      loginUnknown ? 'Open Setup and choose Check again. If asked, select Sign in to Docker.' : refreshUnavailable ? 'Open Setup and select Sign in to Docker.' : loginOk ? '' : 'Open Faravan and select Sign in to Docker. If that action is unavailable, this device cannot contribute yet.', loginDiagnostics), ...(loginOk ? {signinVerified:false} : {}), ...(refreshUnavailable ? {cause:'docker_signin_refresh_unavailable'} : {}), ...(loginUnknown ? {unknown:true} : {})},
    check('windows_file_permissions', true,
      'Windows file permissions are managed by the Faravan installer.',
      '', ''),
  ];
}

// How long a created sandbox may take to answer its first command. `sbx run -d` and `sbx create` return before the
// sandbox can run a command: image layers and the microVM boot finish later, and on slow or nested-virtualized hosts
// that takes many seconds (found live, see the readiness loop in prepare()). This budget exists for that reason.
const sandboxReadyTimeoutMs = () => Number(process.env.FARAVAN_SANDBOX_READY_TIMEOUT_MS) || 180_000;
// No bound for the create command is declared by sbx, its contract tests or this repo, and the command used to run with no
// timeout. It now gets the app's existing ready budget. A create that exceeds it is refused (the client is killed) and its
// reserved name remains fenced.
const SANDBOX_CREATE_TIMEOUT_MS = () => { const ms = sandboxReadyTimeoutMs(); return ms > 0 ? ms : 180_000; };
// How long lending waits, with successful listings showing the sandbox absent, before it resumes while a dispatched create
// is still watched. This is a client wait, not proof that the create ended: the daemon is not bound by the client's timeout,
// so no real maximum create time exists, and nothing here or in sbx's CLI shows a daemon restart drops an accepted create.
// The safety guarantee is not this number. It is (1) verified revocation of the credential and network rules scoped to the
// reserved name before the wait can end, and (2) inertness: every create is `sbx create`, which starts no entrypoint, so a
// sandbox that appears late runs no job. Old absent creates can release resources only after a durable name reservation
// takes over late-create removal; the client timeout never supplies a materialization receipt.
// How old a cleanup status may be when it is only shown to a person (cleanupStatusForDisplay).
export const CLEANUP_DISPLAY_MAX_AGE_MS = 15000;
// An unchanged journal directory lets a display reading be kept past CLEANUP_DISPLAY_MAX_AGE_MS, but never longer than this.
export const CLEANUP_DISPLAY_UNCHANGED_MAX_AGE_MS = 300000;
const CREATE_CESSATION_BOUND_MS = () => 2 * SANDBOX_CREATE_TIMEOUT_MS();

const PREFLIGHT_COMMAND_TIMEOUT_MS = 15000;
// Preparation (create, policy install and verification, workspace and source setup) runs on its own clock, separate
// from the job's wall_seconds run budget. A loaded host takes ~40-80 s here; the bound keeps a stuck prepare finite.
export const PREPARATION_BUDGET_MS = 120_000;
const PREFLIGHT_CANCEL_GRACE_MS = 2000;
let sbxDiagnosticSequence = 0;
const HOST_PREFLIGHT_COMMANDS=new Set(['dpkg-query','docker','containerd','test','powershell.exe','systemctl','systemd-run','/bin/ps']);
async function runPreflightCommand(command, args, { env = sbxChildEnv(), signal, timeout = PREFLIGHT_COMMAND_TIMEOUT_MS, skipDaemonGate = false, sbxDelegate = null } = {}) {
  const sandboxCommand=command===sbxBin()||command===currentSbxRuntime()?.path||!HOST_PREFLIGHT_COMMANDS.has(command);
  try {
    const runtime=sandboxCommand?(currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,binary:command,env})):null;
    if(command==='systemd-run'&&!sbxDelegate&&!(args.length===1&&args[0]==='--version'))
      throw policyError('claude_account_unavailable','A sandbox service start needs its qualified runtime binding.');
    if (!skipDaemonGate && sandboxCommand && needsSbxDaemon(args)) await ensureSbxDaemon({ env, commandArgs: args,sbxRuntime:runtime });
    const execution={env,timeout,killSignal:'SIGKILL',maxBuffer:16*1024*1024};
    const pending = sbxDelegate
      ? spawnSbxChild(currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,env}),sbxDelegate.args,{...execution,fenceSignal:signal,mode:'delegated',command,delegatedArgs:sbxDelegate.prefix})
      : sandboxCommand
      ? spawnSbxChild(runtime,args,{...execution,fenceSignal:signal})
      : execFile(nonSbxCommand(command,env),args,execution);
    const closed=pending.child?new Promise(resolve=>pending.child.once('close',resolve)):Promise.resolve();
    // execFile's signal path may reject and clear its timeout after SIGTERM. Ask the client to stop
    // first, then kill it, so a client ignoring SIGTERM cannot pin the close wait.
    let killTimer;
    const abort=()=>{pending.child?.kill('SIGTERM');killTimer=setTimeout(()=>pending.child?.kill('SIGKILL'),PREFLIGHT_CANCEL_GRACE_MS);};
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    pending.child?.stdin?.end();
    let result;
    try {result=await pending;} finally {await closed;clearTimeout(killTimer);signal?.removeEventListener('abort',abort);}
    signal?.throwIfAborted();
    const { stdout, stderr } = result;
    return { code: 0, stdout, stderr };
  } catch (error) {
    const timedOut = signal?.aborted ? signal.reason?.name === 'TimeoutError'
      : error?.code === 'ETIMEDOUT' || (error?.code == null && error?.killed === true && timeout > 0);
    const failed = {
      code: typeof error?.code === 'number' ? error.code : 1,
      stdout: error?.stdout || '',
      stderr: error?.stderr || String(error?.message || error),
      errorCode: timedOut ? 'ETIMEDOUT' : error?.code ?? undefined,
      killed: error?.killed === true,
      ...(error?.signal?{signal:error.signal}:{}),
      ...(error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?{truncated:true}:{}),
      ...(error?.status ? { status: error.status } : {}),
      ...(timedOut ? { timedOut:true } : {}),
    };
    return failed;
  }
}

// A stubbed command runner means an offline test: never read the host's real processes then.
function defaultInspectDaemons(runCommand) {
  return runCommand === runPreflightCommand ? inspectIdentityDaemons : async () => [];
}
function defaultInspectSandboxes(runCommand) {
  return runCommand === runPreflightCommand ? inspectIdentitySandboxes : async () => [];
}

/**
 * Read-only install preflight for the exact `sbx` profile Faravan uses.
 * The optional command runner makes every classification independently testable
 * without a live Docker installation.
 */
export async function probeSbxPreflight({ runCommand = runPreflightCommand, platformName = process.platform, inspectDaemons = defaultInspectDaemons(runCommand), signal, env = sbxChildEnv(), sbxHomePath = sbxHome(), userHome = accountHome(), realpathPath = realpathSync, commandTimeoutMs = PREFLIGHT_COMMAND_TIMEOUT_MS, observation = false, diagnosticResult = null, diagnosticsObservedAt = null, binaryReads } = {}) {
  const probedAt = new Date().toISOString();
  let restartNeeded = false;
  const run = async (command, args, {timeout = commandTimeoutMs} = {}) => {
    const timeoutSignal=timeout===undefined?null:AbortSignal.timeout(timeout);
    const commandSignal=timeoutSignal?(signal?AbortSignal.any([signal,timeoutSignal]):timeoutSignal):signal;
    const pending=runCommand(command,args,{env,signal:commandSignal,...(timeout===undefined?{}:{timeout})});
    const timedOut=timeoutSignal?new Promise(resolve=>{
      const finish=()=>resolve({code:1,stdout:'',stderr:'The sandbox check timed out.',errorCode:'ETIMEDOUT',timedOut:true});
      if(timeoutSignal.aborted)finish();else timeoutSignal.addEventListener('abort',finish,{once:true});
    }):null;
    // The real runner waits for child close, including after a kill.
    const result=timedOut&&runCommand!==runPreflightCommand?await Promise.race([pending,timedOut]):await pending;
    if(command === sbxBin()&&(['version','diagnose'].includes(args[0])||args[0]==='policy'&&args[1]==='ls'))
      restartNeeded ||= daemonRestartNeeded(result,{source:args[0]});
    return result;
  };
  const binaryRead=async args=>{
    const key=args.join(' ');
    if(observation&&binaryReads?.has(key))return binaryReads.get(key);
    const result=await run(sbxBin(),args);
    if(commandWorked(result))binaryReads?.set(key,result);else binaryReads?.delete(key);
    return result;
  };
  const windows = platformName === 'win32';
  const version = await binaryRead(['version']);
  const linux = platformName === 'linux';
  const sbxAvailable = commandWorked(version);
  const diagnosticSequence=!observation&&sbxAvailable?++sbxDiagnosticSequence:null;
  const [packages, dockerVersion, containerdVersion, diagnose, dockerLoginProbe, policy, kvmReadable, kvmWritable, hypervisorPlatform, runHelp, daemonEnvironments] = await Promise.all([
    linux ? run('dpkg-query', ['-W', '-f=${binary:Package}\\t${db:Status-Status}\\t${Version}\\n', 'docker-sbx', 'docker-ce', 'containerd.io']) : Promise.resolve({ code: 0, stdout: '' }),
    linux ? run('docker', ['version', '--format', '{{.Server.Version}}']) : Promise.resolve({ code: 0, stdout: '' }),
    linux ? run('containerd', ['--version']) : Promise.resolve({ code: 0, stdout: '' }),
    observation ? Promise.resolve(diagnosticResult ?? {code:1,stderr:'Diagnostics have not been checked.'}) : sbxAvailable ? run(sbxBin(), ['diagnose']) : Promise.resolve({ code: 1, stderr: 'sbx is not installed' }),
    sbxAvailable ? run(sbxBin(), ['ls', '-q'],{timeout:commandTimeoutMs}).catch(error => ({ code: 1, stderr: String(error?.message || 'Could not check Docker sign-in.') })) : Promise.resolve({ code: 1, stderr: 'sbx is not installed' }),
    sbxAvailable ? run(sbxBin(), ['policy', 'ls']) : Promise.resolve({ code: 0, stdout: '' }),
    linux ? run('test', ['-r', '/dev/kvm']) : Promise.resolve({ code: 0, stdout: '' }),
    linux ? run('test', ['-w', '/dev/kvm']) : Promise.resolve({ code: 0, stdout: '' }),
    windows ? run('powershell.exe', ['-NoProfile', '-Command', '(Get-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform).State']) : Promise.resolve({ code: 0, stdout: '' }),
    sbxAvailable ? binaryRead(['run', '--help']) : Promise.resolve({ code: 1, stderr: 'sbx is not installed' }),
    linux ? Promise.resolve().then(inspectDaemons).catch(() => null) : Promise.resolve([]),
  ]);
  const checks = preflightChecks({ platformName, version, runHelp, packages, dockerVersion, containerdVersion, diagnose, dockerLoginProbe, observation, policy, kvmReadable, kvmWritable, hypervisorPlatform, daemonEnvironments, sbxHome: sbxHomePath, userHome, realpathPath, restartNeeded });
  if(observation&&!commandWorked(diagnosticResult))checks.push(check('sbx_diagnostics',false,'Sandbox diagnostics need a successful check.','Choose Check again.'));
  const result = {
    schema_version: SBX_PREFLIGHT_SCHEMA_VERSION,
    backend_id: BACKEND_ID,
    ok: checks.every((entry) => entry.ok),
    cached: false,
    probed_at: probedAt,
    checks,
    version: commandWorked(version) ? outputOf(version) : undefined,
    diagnostics_observed_at: observation ? diagnosticsObservedAt : sbxAvailable ? new Date().toISOString() : null,
  };
  Object.defineProperty(result, '_diagnosticResult', {value:diagnose});
  Object.defineProperty(result, '_diagnosticExecuted', {value:!observation&&sbxAvailable});
  Object.defineProperty(result, '_diagnosticSequence', {value:diagnosticSequence});
  // Only a diagnose that ran in this probe counts; an observation reuses an older one.
  return result;
}

// structuredClone drops the non-enumerable diagnostic evidence that later observation reads depend on.
function copyPreflight(result) {
  const copy = structuredClone(result);
  for(const key of ['_diagnosticResult','_diagnosticExecuted','_diagnosticSequence'])
    if (result && Object.hasOwn(result, key)) Object.defineProperty(copy, key, {value:result[key]});
  return copy;
}

function namedCheck(preflight, name) {
  return preflight.checks.find((entry) => entry.name === name);
}

// A missing "Daemon healthy" line can also result from unrelated failures.
// Only start the daemon for the concrete stopped/unreachable shape; starting
// it cannot repair a broken install or a Docker login failure.
const DAEMON_UNREACHABLE = /(?:daemon.*(?:connection refused|not running|stopped|unavailable)|connection refused)/i;
function daemonNeedsStart(check) {
  return !check?.ok && DAEMON_UNREACHABLE.test(check.diagnostics || '');
}

function policyNeedsInitialization(check) {
  return !check?.ok && (check?.needsInitialization === true || /global network policy has not been initialized/i.test(check.diagnostics || ''));
}

const SBX_DAEMON_READY_TIMEOUT_MS = 20_000;
const SBX_DAEMON_READY_POLL_MS = 250;
const SYSTEMD_COMMAND_TIMEOUT_MS = 5_000;
const SBX_DAEMON_ENV_ALLOWLIST = new Set([
  'HOME', 'PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME',
  'DBUS_SESSION_BUS_ADDRESS', 'BROWSER', 'LANG', 'LC_ALL', 'TMPDIR',
]);
const SBX_DAEMON_OWNER_ENV = 'FARAVAN_SBXD_OWNER_ID';
const SBX_DAEMON_START_ENV = 'FARAVAN_SBXD_START_TOKEN';

// `sbx daemon status` prints "Status:  stopped", or "Status:  ● running" with a marker, and never starts a daemon itself.
const sbxDaemonRunning = (result) => result?.code === 0 && /^\s*Status:\s*\W*running\b/im.test(outputOf(result));
const sbxDaemonStopped = (result) => /^\s*Status:\s*\W*stopped\b/im.test(outputOf(result)) || DAEMON_UNREACHABLE.test(outputOf(result));

// FARAVAN_SBX_DAEMON_GATE=off leaves the daemon to sbx itself: no first-contact gate and no service unit. The test suite sets
// it so that no test can start a real service or wait on a real daemon.
const daemonGateOff = () => process.env.FARAVAN_SBX_DAEMON_GATE === 'off';

// Only these exact help reads skip the gate. A `--help` anywhere else may be a guest argument or an option value.
const PURE_HELP_ARGV = [['run', '--help'], ['policy', 'reset', '--help']];

// The control commands that find, start or stop the daemon never wait for it.
function needsSbxDaemon(args) {
  if (PURE_HELP_ARGV.some((help) => help.length === args.length && help.every((word, index) => word === args[index]))) return false;
  return !(args[0] === 'version' || (args[0] === 'daemon' && ['status', 'start', 'stop'].includes(args[1])));
}

function processIsAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

function daemonFailure(status, stderr) {
  return { code: 1, status, stdout: '', stderr };
}

function sbxDaemonCommandKey(commandArgs) {
  if (!Array.isArray(commandArgs) || commandArgs.length === 0) return 'no-command';
  if (commandArgs[0] === 'exec' || commandArgs[0] === 'stop') return `${commandArgs[0]}:${commandArgs[1] || ''}`;
  if (commandArgs[0] === 'rm') return `rm:${commandArgs.includes('--force') ? 'force' : 'no-force'}:${commandArgs[2] || ''}`;
  if (commandArgs[0] === 'ls') return `ls:${commandArgs.slice(1).join('\0')}`;
  return commandArgs[0];
}

function systemdProperties(stdout) {
  const properties = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

// `systemctl show -p Environment` prints one line. Each assignment is its own token: bare when every character is plain,
// otherwise one double-quoted token that backslash-escapes ", \, ` and $ (so a data folder with a space arrives as
// "NAME=/a b"). Tokens are split on whitespace outside quotes; a quoted part may also follow NAME= (NAME="a b").
// Escapes inside quotes: \\ \" \' \$ \` \n \r \t \xNN. A stray backslash or an unterminated quote makes the whole
// line unreadable (null), so every caller fails closed.
const SYSTEMD_ESCAPES = { n: '\n', r: '\r', t: '\t' };
function unescapeSystemdQuoted(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const next = body[++i];
    if (next === 'x' && /^[0-9a-f]{2}$/i.test(body.slice(i + 1, i + 3))) { out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16)); i += 2; }
    else if (next !== undefined && Object.hasOwn(SYSTEMD_ESCAPES, next)) out += SYSTEMD_ESCAPES[next];
    else if (next !== undefined && '\\"\'$`'.includes(next)) out += next;
    else return null;
  }
  return out;
}

export function parseSystemdEnvironment(environment) {
  const text = String(environment || '');
  const assignments = [];
  let token = null;
  const flush = () => {
    if (token === null) return true;
    const separator = token.indexOf('=');
    if (separator < 1) return false;
    assignments.push({ name: token.slice(0, separator), value: token.slice(separator + 1) });
    token = null;
    return true;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (/\s/.test(char)) { if (!flush()) return null; continue; }
    token ??= '';
    if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
      if (end >= text.length) return null;
      const body = unescapeSystemdQuoted(text.slice(i + 1, end));
      if (body === null) return null;
      token += body;
      i = end;
    } else if (char === '\\') return null;
    else token += char;
  }
  return flush() ? assignments : null;
}

export function systemdEnvironmentValue(environment, name) {
  return parseSystemdEnvironment(environment)?.find((assignment) => assignment.name === name)?.value;
}

export function isFaravanSbxDaemonUnit(info, home, { startToken, owner = readSbxOwner(), dataHome = configHome(), root = installRoot } = {}) {
  if (info?.loadState !== 'loaded' || info.description !== sbxDaemonDescription()) return false;
  const command = String(info.execStart || '').match(/(?:^|[;{]\s*)path=([^;]+)\s*;\s*argv\[\]=([^;]+)(?:;|$)/);
  if (!owner || !command) return false;
  const direct=command[1].trim()===owner.executable&&command[2].trim()===`${owner.executable} daemon start`;
  if(!direct){
    const helper=fileURLToPath(new URL('./sbx-exec-launch.mjs',import.meta.url));
    const prefix=`${process.execPath} ${helper} `,argv=command[2].trim();
    if(command[1].trim()!==process.execPath||!argv.startsWith(prefix)||!argv.endsWith(' daemon start'))return false;
    try{const descriptor=JSON.parse(Buffer.from(argv.slice(prefix.length,-' daemon start'.length),'base64url').toString('utf8'));
      if(descriptor.binary.path!==owner.executable)return false;
      restoreSbxRuntime(descriptor,{currentEnv:sbxChildEnv,env:{...process.env,...credentialStoreEnv(home),FARAVAN_SBX_BIN:owner.executable},home});
    }catch{return false;}
  }
  const allowedNames = new Set([...SBX_DAEMON_ENV_ALLOWLIST, SBX_DAEMON_OWNER_ENV, SBX_DAEMON_START_ENV, 'FARAVAN_SBXD_INSTALL_ROOT', 'FARAVAN_SBXD_DATA_HOME']);
  const assignments = parseSystemdEnvironment(info.environment);
  if (!assignments) return false;
  const names = assignments.map((assignment) => assignment.name);
  if (names.some((name) => !allowedNames.has(name)) || new Set(names).size !== names.length) return false;
  const value = (name) => assignments.find((assignment) => assignment.name === name)?.value;
  const expectedEnvironment = credentialStoreEnv(home, 'linux');
  if (!Object.entries(expectedEnvironment).every(([name, expected]) => value(name) === expected)) return false;
  if (value('FARAVAN_SBXD_INSTALL_ROOT') !== root || value('FARAVAN_SBXD_DATA_HOME') !== dataHome) return false;
  if (value(SBX_DAEMON_OWNER_ENV) !== owner.id) return false;
  return startToken === undefined || value(SBX_DAEMON_START_ENV) === startToken;
}

// The packaged app unit hides the desktop session bus from every child on purpose. Only the systemctl and systemd-run
// calls need the per-user manager bus, so they get it here and nothing else does. Without the socket the call fails
// closed exactly as before.
// The runtime directory counts only when its `bus` entry is a real socket (not a symlink) owned by this user.
function userBusRuntimeDir(uid, { lstat = lstatSync, runtimeRoot = '/run/user' } = {}) {
  if (!Number.isInteger(uid)) return null;
  const runtimeDir = `${runtimeRoot}/${uid}`;
  try {
    const entry = lstat(`${runtimeDir}/bus`);
    return entry.isSocket() && !entry.isSymbolicLink() && entry.uid === uid ? runtimeDir : null;
  } catch { return null; }
}
let busRuntimeDir = userBusRuntimeDir; // tests replace this through _internal; production never does

function systemdManagerEnv(base = process.env) {
  if (base.XDG_RUNTIME_DIR && base.DBUS_SESSION_BUS_ADDRESS) return base;
  const runtimeDir = busRuntimeDir(process.getuid?.());
  if (!runtimeDir) return base;
  return { ...base, XDG_RUNTIME_DIR: runtimeDir, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus` };
}

async function readUserSystemdManager(runCommand, { signal } = {}) {
  let manager;
  try {
    manager = await runCommand('systemctl', ['--user', 'is-system-running'], {
      env: systemdManagerEnv(), signal, timeout: SYSTEMD_COMMAND_TIMEOUT_MS,
    });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.errorCode === 'ENOENT') {
      return { kind: 'no-manager', status: 'no_systemd_user_manager', detail: 'systemctl is not installed.' };
    }
    return { kind: 'unavailable', status: 'systemd_probe_failed', detail: 'The systemd user-manager probe failed.' };
  }
  if (manager?.errorCode === 'ENOENT') {
    return { kind: 'no-manager', status: 'no_systemd_user_manager', detail: 'systemctl is not installed.' };
  }
  const state = String(manager?.stdout || '').trim();
  if ((manager?.code === 0 && state === 'running') || (manager?.code === 1 && state === 'degraded')) return { kind: 'ready', status: 'systemd_manager_ready', degraded: state === 'degraded', detail: 'The systemd user manager is ready.' };
  if (state) return { kind: 'unavailable', status: 'systemd_manager_not_ready', detail: `The systemd user manager is not ready (${state}).` };
  return { kind: 'unavailable', status: 'systemd_probe_failed', detail: 'The systemd user-manager probe failed.' };
}

// This result separates a missing manager from a failed or unusable manager probe.
async function probeSbxSystemdUserManager(runCommand = runPreflightCommand, {
  signal,
  platformName = process.platform,
  systemd = runCommand === runPreflightCommand && !daemonGateOff() && existsSync('/run/systemd/system'),
} = {}) {
  if (platformName !== 'linux' || !systemd) {
    return { kind: 'no-manager', status: 'no_systemd_user_manager', detail: 'No systemd user manager applies on this platform.' };
  }
  const options = { env: systemdManagerEnv(), signal, timeout: SYSTEMD_COMMAND_TIMEOUT_MS };
  const manager = await readUserSystemdManager(runCommand, { signal });
  if (manager.kind !== 'ready') return manager;
  let version;
  try { version = await runCommand('systemd-run', ['--version'], options); }
  catch { return { kind: 'unavailable', status: 'systemd_probe_failed', detail: 'The systemd-run probe failed.' }; }
  if (version?.code !== 0) return { kind: 'unavailable', status: 'systemd_probe_failed', detail: 'The systemd-run probe failed.' };
  return { ...manager, kind: 'ready', status: 'systemd_manager_ready', detail: 'The systemd user manager is ready.' };
}

async function readSbxDaemonUnit(runCommand, unit, manager) {
  let result;
  const properties = ['LoadState', 'ActiveState', 'MainPID', 'InvocationID', 'Description', 'ExecStart', 'Environment'];
  try { result = await runCommand('systemctl', ['--user', 'show', ...properties.flatMap(name => ['-p', name]), unit], manager); }
  catch { return { loadState: 'unknown', state: 'unknown', pid: 0 }; }
  if (result?.code !== 0) return { loadState: 'unknown', state: 'unknown', pid: 0 };
  return sbxDaemonUnitEvidence(result.stdout);
}

export function sbxDaemonUnitEvidence(stdout) {
  const shown = systemdProperties(stdout);
  const loadState = shown.LoadState || 'unknown';
  return {
    loadState, state: shown.ActiveState || (loadState === 'not-found' ? 'inactive' : 'unknown'), pid: Number(shown.MainPID) || 0,
    invocationId: shown.InvocationID || '', description: shown.Description || '', execStart: shown.ExecStart || '',
    environment: shown.Environment || '',
  };
}

// A user manager reports "degraded" whenever any unit failed, so a stray failed unit from another program says nothing
// about the sandbox service. Only a failed unit of this installation, or a failed-unit list that cannot be read, keeps
// the refusal.
const DEGRADED_REFUSALS = Object.freeze({
  own_failed: 'The sandbox service Faravan started earlier has failed, so Faravan did not start a new one. Signing out of this computer and back in clears it, then choose Check again.',
  unreadable: 'Faravan could not read which services failed on this computer, so it did not start its sandbox service. Choose Check again.',
  unit_state: 'The computer reports a failed service, and Faravan could not confirm that its own sandbox service is safe to use. Choose Check again after the failed service is cleared.',
});

function degradedRefusal(reason) {
  return daemonFailure('systemd_manager_degraded', DEGRADED_REFUSALS[reason]);
}

function failedUnitBelongsToThisInstallation(name, home, owner) {
  const unit = String(name).replace(/[.]service$/, '');
  const prefix = `faravan-sbxd-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
  if (unit === prefix) return true; // an earlier release named its unit without an owner id
  if (owner) return sbxUnitBelongsToOwner(`${unit}.service`, owner);
  return unit.startsWith(`${prefix}-`); // no owner record: any unit of this HOME could be ours
}

async function readFailedUserUnitNames(runCommand, manager) {
  let listed;
  try { listed = await runCommand('systemctl', ['--user', 'list-units', '--state=failed', '--plain', '--no-legend'], manager); }
  catch { return null; }
  if (listed?.code !== 0 || typeof listed.stdout !== 'string') return null;
  const names = [];
  for (const line of listed.stdout.split('\n')) {
    if (!line.trim()) continue;
    const name = line.trim().split(/\s+/)[0];
    if (!/^[A-Za-z0-9:_.\\@-]+[.](?:service|scope|socket|target|device|mount|automount|swap|timer|path|slice)$/.test(name)) return null;
    names.push(name);
  }
  return names;
}

// `unit` is the read state of this installation's own service. Only an absent or stopped service may be created while
// the manager is degraded; a failed, unknown or half-started one keeps its refusal.
async function degradedManagerAllowsCreate(runCommand, unit, home, manager) {
  if (unit.state === 'failed') return degradedRefusal('own_failed');
  if (unit.state !== 'inactive') return degradedRefusal('unit_state');
  const failed = await readFailedUserUnitNames(runCommand, manager);
  if (failed === null) return degradedRefusal('unreadable');
  const owner = readSbxOwner();
  if (failed.some((name) => failedUnitBelongsToThisInstallation(name, home, owner))) return degradedRefusal('own_failed');
  return null;
}

async function reconcileStartedSbxDaemonUnit({ runCommand, unit, manager, timeoutMs, pollMs }) {
  const readManager = { ...manager, signal: undefined };
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await readSbxDaemonUnit(runCommand, unit, readManager);
    if (state.loadState !== 'not-found' || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function stopStartedSbxDaemon({ runCommand, unit, manager, home, startToken, invocationId, timeoutMs, pollMs, isProcessAlive }) {
  const cleanupManager = { ...manager, signal: undefined };
  let state = await readSbxDaemonUnit(runCommand, unit, cleanupManager);
  if (state.loadState === 'not-found') return true;
  if (!isFaravanSbxDaemonUnit(state, home, { startToken })) return false;
  if (invocationId && state.invocationId && state.invocationId !== invocationId) return false;
  if (['active', 'activating', 'deactivating'].includes(state.state)) {
    let stopped;
    try { stopped = await runCommand('systemctl', ['--user', 'stop', unit], cleanupManager); }
    catch { return false; }
    if (stopped?.code !== 0) return false;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    state = await readSbxDaemonUnit(runCommand, unit, cleanupManager);
    if (state.loadState === 'not-found') return true;
    if (!isFaravanSbxDaemonUnit(state, home, { startToken })) return false;
    if (invocationId && state.invocationId && state.invocationId !== invocationId) return false;
    if (!['active', 'activating', 'deactivating'].includes(state.state)) return !isProcessAlive(state.pid);
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function daemonMatchesMainPid(inspectDaemons, home, pid) {
  const daemons = await Promise.resolve().then(inspectDaemons).catch(() => null);
  return Array.isArray(daemons) && daemons.length === 1 && daemons[0]?.environ?.HOME === home && Number(daemons[0].pid) === Number(pid);
}

async function waitForSbxDaemon({ runCommand, env, signal, timeoutMs, pollMs, unit, manager, home, startToken, invocationId, isProcessAlive, inspectDaemons }) {
  for (const deadline = Date.now() + timeoutMs; ;) {
    if (signal?.aborted) return daemonFailure('sandbox_check_cancelled', 'Sandbox check cancelled.');
    let status;
    try { status = await runCommand(sbxBin(), ['daemon', 'status'], { env, signal, timeout: PREFLIGHT_COMMAND_TIMEOUT_MS }); }
    catch { return daemonFailure('daemon_status_unknown', 'The sandbox daemon status could not be read.'); }
    if (unit) {
      const service = await readSbxDaemonUnit(runCommand, unit, manager);
      if (service.state === 'unknown') return daemonFailure('systemd_unit_state_unknown', 'The managed sandbox service state could not be verified.');
      if (home && !isFaravanSbxDaemonUnit(service, home, { startToken })) {
        return daemonFailure('systemd_unit_conflict', 'The managed sandbox service is not owned by Faravan.');
      }
      if (invocationId && service.invocationId && service.invocationId !== invocationId) {
        return daemonFailure('systemd_unit_conflict', 'The managed sandbox service changed while it was starting.');
      }
      if (service.state === 'active' && !isProcessAlive(service.pid)) return daemonFailure('systemd_unit_mainpid_not_alive', 'The managed sandbox service has no live main process.');
      if (service.state === 'active' && sbxDaemonRunning(status) && !await daemonMatchesMainPid(inspectDaemons, home, service.pid)) return daemonFailure('systemd_unit_mainpid_mismatch', 'The managed sandbox service MainPID does not match a unique sandbox daemon.');
      if (service.state === 'active' && sbxDaemonRunning(status)) return { code: 0, status: 'managed_daemon_ready', stdout: status.stdout || '', stderr: '' };
      if (!['active', 'activating'].includes(service.state)) return daemonFailure('systemd_unit_not_active', `The managed sandbox service is ${service.state || 'unknown'}.`);
    } else if (sbxDaemonRunning(status)) {
      return { code: 0, status: 'detached_daemon_ready', stdout: status.stdout || '', stderr: '' };
    }
    if (Date.now() >= deadline) return daemonFailure('daemon_not_ready', `The sandbox service did not become ready.${diagnosticsOf(status) ? `\n${diagnosticsOf(status)}` : ''}`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** The Linux service for one installation, data profile and sbx HOME. */
export function sbxDaemonUnitName(home = sbxHome()) {
  const owner = readSbxOwner();
  return `faravan-sbxd-${createHash('sha256').update(home).digest('hex').slice(0, 12)}-${owner?.id ?? 'unproven'}`;
}

/**
 * The description every daemon service of one channel carries. One install can reach more than one sbx HOME (the data
 * home depends on how the app was started), so uninstall and packaging/scripts/remove.sh find the channel's services by
 * this description, never by a derived HOME and never by the name pattern alone.
 */
export function sbxDaemonDescription(channel = channelIdentity()) {
  return `Faravan sandbox service (${channel.id})`;
}

/** Restore a lost record only from a unit bound to this installation and sandbox home. */
export function repairSbxDaemonOwner(options = {}) {
  return withDaemonLifecycle(async () => {
    const {runCommand = runPreflightCommand, signal, platformName = process.platform, isProcessAlive = processIsAlive} = options;
    if (readSbxOwner()) return {ok:false, detail:'Sandbox ownership is already recorded. Ownership was left unchanged.'};
    const refused = {ok:false, detail:'No unique live sandbox unit proves this installation, executable and HOME. Ownership was left unchanged.'};
    if (platformName !== 'linux') return refused;
    const manager = {env:systemdManagerEnv(), signal, timeout:SYSTEMD_COMMAND_TIMEOUT_MS};
    const listed = await runCommand('systemctl', ['--user','list-units','--all','--plain','--no-legend','--type=service','faravan-sbxd-*'], manager);
    if (listed?.code !== 0) return refused;
    const units = String(listed.stdout || '').split('\n').map(line => line.trim().split(/\s+/)[0]).filter(name => /^faravan-sbxd-[0-9a-f]{12}-[0-9a-f]{64}[.]service$/.test(name));
    let executable;
    try { executable = resolveSbxExecutable(sbxBin(), sbxChildEnv()); } catch { return refused; }
    const matches = [];
    for (const unit of units) {
      const info = await readSbxDaemonUnit(runCommand, unit.replace(/[.]service$/, ''), manager);
      const id = unit.slice(-72,-8);
      const owner = {id, executable};
      const expectedName = `faravan-sbxd-${createHash('sha256').update(sbxChildEnv().HOME).digest('hex').slice(0,12)}-${id}.service`;
      if (unit !== expectedName || info.state !== 'active' || !isProcessAlive(info.pid) ||
          systemdEnvironmentValue(info.environment, 'FARAVAN_SBXD_INSTALL_ROOT') !== installRoot ||
          !isFaravanSbxDaemonUnit(info, sbxChildEnv().HOME, {owner})) continue;
      matches.push(owner);
    }
    if (matches.length !== 1) return refused;
    restoreSbxOwner(matches[0]);
    resetSbxDaemonGate();
    return {ok:true, detail:'Sandbox service ownership restored from this installation’s live unit.'};
  });
}

/**
 * Safe, profile-isolated repair for a stopped Faravan sbx daemon.
 * A daemon belongs to the cgroup of whatever started it, so one started by the coordinator's own service
 * died with every restart of it, and took the running sandboxes along. On Linux with a ready systemd user manager
 * the daemon therefore runs as its own transient service, one per installation, profile and sbx HOME. An unavailable or unverified manager
 * fails closed. Only platforms without a systemd user manager use sbx's detached start (macOS daemons already
 * outlive the app).
 */
export function startSbxDaemon(options) {
  return withDaemonLifecycle(() => startSbxDaemonLocked(options));
}

async function startSbxDaemonLocked({ runCommand = runPreflightCommand, signal, commandTimeoutMs=PREFLIGHT_COMMAND_TIMEOUT_MS, platformName = process.platform, systemd = runCommand === runPreflightCommand && !daemonGateOff() && existsSync('/run/systemd/system'), readyTimeoutMs = SBX_DAEMON_READY_TIMEOUT_MS, readyPollMs = SBX_DAEMON_READY_POLL_MS, isProcessAlive = processIsAlive, inspectDaemons = defaultInspectDaemons(runCommand) } = {}) {
  resetSbxDaemonGate();
  if (signal?.aborted) return daemonFailure('sandbox_check_cancelled', 'Sandbox check cancelled.');
  const env = sbxChildEnv();
  const probe = await probeSbxSystemdUserManager(runCommand, { platformName, systemd, signal });
  if (probe.kind === 'no-manager') {
    if (!readSbxOwner()) {
      try { ensureSbxOwner(sbxBin(), env); }
      catch { return daemonFailure('daemon_owner_initialization_failed', 'Sandbox ownership could not be initialized. Check the owner record before a manual daemon restart.'); }
      const status = await runCommand(sbxBin(), ['daemon', 'status'], {env, signal, timeout:commandTimeoutMs}).catch(() => null);
      if (sbxDaemonRunning(status)) return {code:0, status:probe.status};
    }
    let result;
    try { result = await runCommand(sbxBin(), ['daemon', 'start', '--detach'], { env, signal, timeout: commandTimeoutMs }); }
    catch { return daemonFailure('detached_start_failed', 'The detached sandbox daemon could not be started.'); }
    return result?.code === 0 ? { ...result, status: probe.status } : { ...result, status: 'detached_start_failed' };
  }
  if (probe.kind !== 'ready') return daemonFailure(probe.status, probe.detail);

  if (!readSbxOwner()) {
    const status = await runCommand(sbxBin(), ['daemon', 'status'], {env, signal, timeout:commandTimeoutMs}).catch(() => null);
    const repairRequired = () => daemonFailure('daemon_owner_repair_required', daemonFailureMessage('daemon_owner_repair_required'));
    if (!sbxDaemonStopped(status)) return repairRequired();
    const manager = {env:systemdManagerEnv(), signal, timeout:SYSTEMD_COMMAND_TIMEOUT_MS};
    const listed = await runCommand('systemctl', ['--user','list-units','--all','--plain','--no-legend','--type=service','faravan-sbxd-*'], manager).catch(()=>null);
    if (listed?.code !== 0) return repairRequired();
    const prefix = `faravan-sbxd-${createHash('sha256').update(env.HOME).digest('hex').slice(0,12)}-`;
    for (const line of String(listed.stdout || '').split('\n')) {
      const name = line.trim().split(/\s+/)[0];
      if (!name.startsWith(prefix)) continue;
      const unit = await readSbxDaemonUnit(runCommand, name, manager);
      if (unit.state === 'unknown' || ['active','activating','deactivating'].includes(unit.state) || isProcessAlive(unit.pid)) return repairRequired();
    }
    try { quarantineUnreadableSbxOwner(); } catch { return repairRequired(); }
  }
  try { ensureSbxOwner(sbxBin(), env); } catch { return daemonFailure('systemd_unit_conflict', classifySbxDaemonCause('unit_conflict').detail); }
  const unit = sbxDaemonUnitName(env.HOME);
  // systemd tools need the login session's own environment; only the daemon gets the pinned allowlist.
  const manager = { env: systemdManagerEnv(), signal, timeout: SYSTEMD_COMMAND_TIMEOUT_MS };
  const deadline = Date.now() + readyTimeoutMs;
  let state = await readSbxDaemonUnit(runCommand, unit, manager);
  while (['deactivating', 'activating'].includes(state.state)) {
    if (Date.now() >= deadline) {
      const status = state.state === 'deactivating' ? 'systemd_unit_deactivating' : 'systemd_unit_activating';
      return daemonFailure(status, `The managed sandbox service is still ${state.state}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, readyPollMs));
    state = await readSbxDaemonUnit(runCommand, unit, manager);
  }
  if (state.state === 'unknown' || !state.state) return daemonFailure('systemd_unit_state_unknown', 'The managed sandbox service state could not be read.');
  if (state.loadState !== 'not-found' && !isFaravanSbxDaemonUnit(state, env.HOME)) {
    return daemonFailure('systemd_unit_conflict', 'A service with the managed sandbox service name is not owned by Faravan.');
  }
  if (probe.degraded && state.state !== 'active') {
    const refusal = await degradedManagerAllowsCreate(runCommand, state, env.HOME, manager);
    if (refusal) return refusal;
  }
  if (state.state === 'active') {
    if (!isProcessAlive(state.pid)) return daemonFailure('systemd_unit_mainpid_not_alive', 'The managed sandbox service has no live main process.');
    return waitForSbxDaemon({ runCommand, env, signal, timeoutMs: readyTimeoutMs, pollMs: readyPollMs, unit, manager, home: env.HOME, invocationId: state.invocationId, isProcessAlive, inspectDaemons });
  }
  if (state.state === 'failed') {
    let reset;
    try { reset = await runCommand('systemctl', ['--user', 'reset-failed', unit], manager); }
    catch { return daemonFailure('systemd_reset_failed', 'The failed managed sandbox service could not be reset.'); }
    if (reset?.code !== 0) return daemonFailure('systemd_reset_failed', 'The failed managed sandbox service could not be reset.');
  } else if (state.state !== 'inactive') {
    return daemonFailure('systemd_unit_state_unknown', `The managed sandbox service is ${state.state}.`);
  }

  // systemd-run copies only the daemon's explicit allowlist. Its manager environment is cleared for every other name.
  const daemonEnv = Object.fromEntries(Object.entries(env).filter(([key]) => SBX_DAEMON_ENV_ALLOWLIST.has(key)));
  let owner;
  try { owner = ensureSbxOwner(sbxBin(), env, {refreshExecutable:true}); } catch { return daemonFailure('pinned_executable_missing', 'The sandbox executable for the next verified start is missing.'); }
  const ownerId = owner.id;
  const startToken = randomUUID();
  daemonEnv[SBX_DAEMON_OWNER_ENV] = ownerId;
  daemonEnv.FARAVAN_SBXD_INSTALL_ROOT = installRoot;
  daemonEnv.FARAVAN_SBXD_DATA_HOME = configHome();
  daemonEnv[SBX_DAEMON_START_ENV] = startToken;
  const runnerEnv = { ...daemonEnv };
  delete runnerEnv.DBUS_SESSION_BUS_ADDRESS;
  const busEnv = systemdManagerEnv();
  if (busEnv.DBUS_SESSION_BUS_ADDRESS !== undefined) runnerEnv.DBUS_SESSION_BUS_ADDRESS = busEnv.DBUS_SESSION_BUS_ADDRESS;
  if (busEnv.XDG_RUNTIME_DIR !== undefined) runnerEnv.XDG_RUNTIME_DIR = busEnv.XDG_RUNTIME_DIR;
  const names = Object.keys(daemonEnv).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)).sort();
  const setenv = names.map((key) => (key === 'DBUS_SESSION_BUS_ADDRESS' ? `--setenv=${key}=${daemonEnv[key]}` : `--setenv=${key}`));
  const shown = await runCommand('systemctl', ['--user', 'show-environment'], manager);
  if (shown?.code !== 0) return daemonFailure('systemd_environment_unavailable', 'The systemd user environment could not be read.');
  const inherited = new Set([...Object.keys(process.env), ...String(shown.stdout || '').split('\n').map((line) => line.split('=')[0])]);
  const unset = [...inherited].filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !Object.hasOwn(daemonEnv, key));
  const unsetProperty = unset.length ? [`--property=UnsetEnvironment=${unset.join(' ')}`] : [];
  let started;
  try {
    const prefix=['--user', `--unit=${unit}`, '--collect', '--quiet', `--description=${sbxDaemonDescription()}`, '--property=KillMode=mixed', ...unsetProperty, ...setenv, '--'];
    started = await runCommand('systemd-run', [...prefix, owner.executable, 'daemon', 'start'], { ...manager, env: runnerEnv, timeout: commandTimeoutMs,sbxDelegate:{prefix,args:['daemon','start']} });
  } catch (error) { started = { code: 1, errorCode: error?.code, timedOut: error?.code === 'ETIMEDOUT' || error?.killed === true }; }
  const ambiguousStart = started?.timedOut || signal?.aborted;
  const afterStart = ambiguousStart
    ? await reconcileStartedSbxDaemonUnit({ runCommand, unit, manager, timeoutMs: readyTimeoutMs, pollMs: readyPollMs })
    : await readSbxDaemonUnit(runCommand, unit, { ...manager, signal: undefined });
  const belongsToStart = isFaravanSbxDaemonUnit(afterStart, env.HOME, { startToken });
  const failStart = daemonFailure('systemd_start_failed', started?.timedOut
    ? 'systemd-run timed out before the managed sandbox service could be verified.'
    : started?.code !== 0 ? 'systemd-run refused to start the managed sandbox service.'
      : 'systemd-run could not start the managed sandbox service.');
  if (started?.code !== 0) {
    if (!belongsToStart) return failStart;
    const cleaned = await stopStartedSbxDaemon({ runCommand, unit, manager, home: env.HOME, startToken, invocationId: afterStart.invocationId, timeoutMs: readyTimeoutMs, pollMs: readyPollMs, isProcessAlive });
    if (!cleaned) return daemonFailure('systemd_start_cleanup_failed', `${failStart.stderr} Faravan could not verify that its service stopped.`);
    return signal?.aborted ? daemonFailure('sandbox_check_cancelled', 'Sandbox check cancelled.') : failStart;
  }
  if (!belongsToStart) return daemonFailure('systemd_unit_state_unknown', 'The service started, but Faravan could not verify its ownership.');
  const ready = await waitForSbxDaemon({ runCommand, env, signal, timeoutMs: readyTimeoutMs, pollMs: readyPollMs, unit, manager, home: env.HOME, startToken, invocationId: afterStart.invocationId, isProcessAlive, inspectDaemons });
  if (ready.code === 0) return ready;
  const cleaned = await stopStartedSbxDaemon({ runCommand, unit, manager, home: env.HOME, startToken, invocationId: afterStart.invocationId, timeoutMs: readyTimeoutMs, pollMs: readyPollMs, isProcessAlive });
  return cleaned ? ready : daemonFailure('systemd_start_cleanup_failed', `${ready.stderr} Faravan could not verify that its service stopped.`);
}

// Each sbx gate runs within the lifecycle queue and verifies the service again.
let sbxDaemonGate = null;

export function resetSbxDaemonGate() { sbxDaemonGate = null; daemonLifecycleGeneration++; }

class SbxDaemonVerificationError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'SbxDaemonVerificationError';
    this.code = 'SBX_DAEMON_UNVERIFIED';
    this.status = status;
  }
}

// HOME and XDG_STATE_HOME select the daemon socket. A terminal's XDG state
// directory must not send a manual command to a different daemon.
// An unverified test-workspace cleanup never hides the classified start
// failure: a refused create keeps its cause and adds the cleanup fact.
function cleanupUnverified(failure, diagnostic) {
  const diagnostics = [failure?.diagnostics, diagnostic].filter(Boolean).join('\n');
  if (failure) return { ...failure, cleanup: 'unverified', diagnostics };
  return { ok: false, cause: 'unknown', cleanup: 'unverified',
    detail: 'Faravan could not confirm that the test workspace was removed.',
    fix: 'Restart Docker Sandboxes and run Faravan doctor again.', diagnostics };
}

function sandboxRemovalCommand(home, name, env = sbxChildEnv()) {
  const prefix = env.XDG_STATE_HOME === undefined ? `env -u XDG_STATE_HOME HOME=${shellQuote(home)}` : `env HOME=${shellQuote(home)} XDG_STATE_HOME=${shellQuote(env.XDG_STATE_HOME)}`;
  return `${prefix} ${shellQuote(sbxBin())} rm --force ${shellQuote(name)}`;
}

function legacyDaemonMessage(env = sbxChildEnv()) {
  return `Sandbox daemon ownership could not be proven for sandbox HOME '${env.HOME}'. Another Faravan install or tool may use this daemon, so Faravan leaves it running. To give this install its own sandbox daemon, set FARAVAN_SBX_HOME to an empty folder only this install uses, then restart Faravan.`;
}

export function classifySbxDaemonCause(cause,{detail,env=sbxChildEnv()}={}) {
  if (cause==='owner_missing' && !readSbxOwner()) return {repair:'owner_repair',fix:'faravan sandbox repair-owner --yes',detail:detail??'Sandbox ownership is missing or unreadable. Run faravan sandbox repair-owner --yes to verify and repair this installation.'};
  if (cause==='legacy') return {repair:'legacy_isolate',fix:'Set FARAVAN_SBX_HOME to an empty folder only this install uses, then restart Faravan.',detail:detail??legacyDaemonMessage(env)};
  return {repair:'refused',fix:'',detail:detail??'Sandbox service ownership could not be verified. The sandbox call was refused.'};
}

function daemonFailureMessage(status) {
  if (status === 'daemon_not_managed' || status === 'legacy_daemon_drain_only') return legacyDaemonMessage();
  return ({
    no_systemd_user_manager: 'No systemd user manager applies on this platform.',
    systemd_probe_failed: 'The systemd user-manager probe failed. The sandbox call was refused.',
    systemd_manager_not_ready: 'The systemd user manager is not ready. The sandbox call was refused.',
    systemd_manager_degraded: DEGRADED_REFUSALS.unit_state,
    systemd_environment_unavailable: 'The systemd user environment could not be verified. The sandbox call was refused.',
    systemd_unit_state_unknown: 'The managed sandbox service state could not be verified. The sandbox call was refused.',
    systemd_unit_conflict: classifySbxDaemonCause('unit_conflict').detail,
    systemd_unit_mainpid_not_alive: 'The managed sandbox service has no live main process. The sandbox call was refused.',
    systemd_unit_not_active: 'The managed sandbox service is not active. The sandbox call was refused.',
    systemd_unit_deactivating: 'The managed sandbox service is still stopping. Retry after it has stopped.',
    systemd_unit_activating: 'The managed sandbox service is still starting. Retry after it is ready.',
    systemd_reset_failed: 'The failed managed sandbox service could not be reset. The sandbox call was refused.',
    systemd_start_cleanup_failed: 'Faravan could not verify that its failed sandbox service stopped. The sandbox call was refused.',
    systemd_start_failed: 'systemd-run could not start the managed sandbox service. The sandbox call was refused.',
    daemon_start_failed: 'The sandbox daemon could not be started. The sandbox call was refused.',
    detached_start_failed: 'The detached sandbox daemon could not be started. The sandbox call was refused.',
    systemd_unit_mainpid_mismatch: 'The managed sandbox service MainPID does not match a unique sandbox daemon.',
    daemon_owner_repair_required: classifySbxDaemonCause('owner_missing').detail,
    pinned_executable_missing: 'The executable for the next verified sandbox service start is missing. Install Docker Sandboxes, then retry.',
    daemon_status_unknown: 'The sandbox daemon status could not be verified. The sandbox call was refused.',
    daemon_not_ready: 'The sandbox service did not become ready. The sandbox call was refused.',
    managed_daemon_not_ready: 'The managed sandbox daemon is not ready. The sandbox call was refused.',
    sandbox_check_cancelled: 'Sandbox check cancelled.',
  })[status] ?? 'The sandbox daemon could not be verified. The sandbox call was refused.';
}

function refuseUnverifiedDaemon(result) {
  throw new SbxDaemonVerificationError(result.status, result.status === 'systemd_manager_degraded' && result.stderr ? result.stderr : daemonFailureMessage(result.status));
}

function sbxCommandTarget(args) {
  for (let index = 1; index < args.length; index++) {
    if (['-w','--workdir','-e','--env','-u','--user'].includes(args[index])) { index++; continue; }
    if (args[index].startsWith('-')) continue;
    return args[index];
  }
}

function legacyDrainTarget(commandArgs, rows) {
  if (!Array.isArray(commandArgs)) return false;
  if (commandArgs[0] === 'ls') return true;
  const target = sbxCommandTarget(commandArgs);
  const sandbox = rows.find((row) => row.name === target);
  if (!sandbox) return false;
  if (commandArgs[0] === 'exec') {
    const context = daemonJobContext.getStore();
    return !context?.agentRun && context?.handle?.sandbox_id === target && launchedDaemonHandles.has(context.handle) && typeof sandbox.status === 'string' && sandbox.status !== 'stopped';
  }
  const context = daemonJobContext.getStore();
  if (context?.handle?.sandbox_id !== target || !launchedDaemonHandles.has(context.handle)) return false;
  if (commandArgs[0] === 'stop') return true;
  if (commandArgs[0] === 'rm') return commandArgs[2] === sandbox.name && commandArgs.includes('--force') && sandbox.status === 'stopped';
  return false;
}

async function allowLegacyDaemonDrain({ runCommand, env, signal, commandArgs, inspectDaemons, isProcessAlive }) {
  const daemons = await Promise.resolve().then(inspectDaemons).catch(() => null);
  if (!Array.isArray(daemons)) return 'unverified';
  const matching = daemons.filter((daemon) => daemon?.environ?.HOME === env.HOME && isProcessAlive(daemon.pid));
  if (matching.length !== 1) return 'unverified';
  if (commandArgs?.[0] === 'ls') return 'allow';
  const listing = await runCommand(sbxBin(), ['ls', '--json'], {
    env, signal, timeout: PREFLIGHT_COMMAND_TIMEOUT_MS, skipDaemonGate: true,
  }).catch(() => null);
  if (!parseSbxListing(listing)) return 'unverified';
  const rows = JSON.parse(String(listing.stdout || ''));
  return legacyDrainTarget(commandArgs, rows) ? 'allow' : 'drain-only';
}

// One verified managed daemon per preparation (and then per its sandbox handle). After a full managed-active
// verification (systemd unit, MainPID, unique daemon at the sandbox HOME), the later sbx commands of that preparation
// skip those subprocess reads while the same process still runs: same PID, same /proc start time and command line, same
// binary, HOME, runtime and lifecycle generation. A daemon exit, replacement, restart or any key change drops the proof,
// and the next command verifies in full. There is no time-based reuse: only a live identity match carries the proof.
const daemonProofScope = new AsyncLocalStorage();
// The daemon's own endpoint: sbx routes a command by the socket file under the command's XDG state directory, so a surviving
// daemon process whose socket file was removed or replaced is no longer what a command reaches. One stat, no subprocess.
function readEndpointIdentity(env) {
  try {
    const state = env?.XDG_STATE_HOME ?? (env?.HOME ? path.join(env.HOME, '.local', 'state') : null);
    if (!state) return null;
    const st = statSync(path.join(state, 'sandboxes', 'sandboxes', 'sandboxd', 'sandboxd.sock'), { bigint: true });
    return st.isSocket() ? `${st.dev}:${st.ino}:${st.ctimeNs}` : null;
  } catch { return null; }
}
function readProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${Number(pid)}/stat`, 'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return start ? `${start}\0${readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8')}` : null;
  } catch { return null; }
}

/**
 * Makes sure the Faravan sbx daemon runs before an sbx call. A legacy daemon can serve drain commands only
 * for handles launched by this process through the managed service. Unproven ownership refuses new work and restart. An env of another identity and a `bin` other than the configured sbx binary are left alone.
 */
export function ensureSbxDaemon(options) {
  const runtime=options?.sbxRuntime??currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,env:options?.env??sbxChildEnv()});
  const observation=daemonJobContext.getStore()?.commandObservation??{};
  const started=performance.now();
  return withSbxRuntime(runtime,()=>withDaemonLifecycle(async () => {
    const batch=observationDaemonContext.getStore();
    const args=options?.commandArgs;
    const read=args?.length===2&&(args[0]==='ls'&&args[1]==='-q'||args[0]==='policy'&&args[1]==='ls');
    const env=options?.env??sbxChildEnv();
    const binary=sbxBinaryIdentity(env);
    const key=[binary,env.HOME,env.XDG_STATE_HOME,daemonLifecycleGeneration,runtime.key];
    const scoped=read&&binary===sbxBinaryIdentity()&&!daemonJobContext.getStore()&&(options?.bin===undefined||options.bin===sbxBin());
    if(batch&&scoped&&batch.proof?.every((part,i)=>part===key[i]))return;
    const context=daemonJobContext.getStore();
    const holder=context?.recovery?undefined:context?.handle?._daemonProofScope??daemonProofScope.getStore();
    const identityOf=options?.processIdentity??readProcessIdentity;
    const endpointOf=options?.endpointIdentity??readEndpointIdentity;
    const standing=holder?.proof;
    if(standing) {
      if(standing.key.every((part,i)=>part===key[i])&&standing.identity===identityOf(standing.pid)&&standing.endpoint===endpointOf(env)&&!daemonGateOff()) {
        if(context)context.managed=true;
        return;
      }
      holder.proof=null;
    }
    const proofOut={};
    const verified=await ensureSbxDaemonLocked({...options,commandObservation:observation,proofOut});
    if(batch&&scoped&&verified===true)batch.proof=key;
    if(holder&&verified===true&&Number.isSafeInteger(proofOut.pid)) {
      const identity=identityOf(proofOut.pid),endpoint=endpointOf(env);
      if(identity&&endpoint)holder.proof={key,pid:proofOut.pid,identity,endpoint};
    }
  })).catch(error=>{
    bindSandboxCommandDiagnostic(error,sandboxCommandDiagnostic(observation.daemon_status_passed===false?observation.daemonResult??error:error,{
      subcommand:'daemon status',runtime_path:runtime.path,duration_ms:performance.now()-started,
      daemon_status_passed:observation.daemon_status_passed,stage:observation.daemon_status_passed===false&&observation.daemonResult?undefined:'fence'}));
    assertSbxRuntime(runtime,{signal:options?.signal,env:options?.env??sbxChildEnv()});throw error;
  });
}

async function ensureSbxDaemonLocked({ runCommand = runPreflightCommand, env, bin, ...startOptions } = {}) {
  if (daemonGateOff()) {
    if(daemonJobContext.getStore()?.recovery){
      const pinned=sbxChildEnv();
      if(env&&(env.HOME!==pinned.HOME||env.XDG_STATE_HOME!==pinned.XDG_STATE_HOME))refuseUnverifiedDaemon(daemonFailure('daemon_status_unknown','The recorded sandbox environment changed.'));
      const status=await runCommand(sbxBin(),['daemon','status'],{env:pinned,signal:startOptions.signal,timeout:PREFLIGHT_COMMAND_TIMEOUT_MS,skipDaemonGate:true}).catch(()=>null);
      if(startOptions.commandObservation)Object.assign(startOptions.commandObservation,{daemonResult:status,daemon_status_passed:sbxDaemonRunning(status)});
      if(!sbxDaemonRunning(status))refuseUnverifiedDaemon(daemonFailure('daemon_status_unknown','No live daemon proves the recorded sandbox HOME.'));
    }
    return;
  }
  if (bin !== undefined && bin !== sbxBin()) return; // a stand-in binary is its own daemon's business
  const pinned = sbxChildEnv();
  if (env && (env.HOME !== pinned.HOME || env.XDG_STATE_HOME !== pinned.XDG_STATE_HOME)) return;
  const commandArgs = startOptions.commandArgs;
  const inspectDaemons = startOptions.inspectDaemons ?? defaultInspectDaemons(runCommand);
  const isProcessAlive = startOptions.isProcessAlive ?? processIsAlive;
  const context = daemonJobContext.getStore();
  const authorization = context?.agentRun ? 'launch' : context?.handle && launchedDaemonHandles.has(context.handle) ? 'drain' : 'untrusted';
  const key = `${context?.recovery?'recovery':'active'}\0${authorization}\0${currentSbxRuntime().key}\0${pinned.HOME}\0${sbxDaemonCommandKey(commandArgs)}`;
  if (sbxDaemonGate?.key === key && sbxDaemonGate.pending) return sbxDaemonGate.pending;
  const gate = { key, pending: null };
  gate.pending = (async () => {
    const platformName = startOptions.platformName ?? process.platform;
    const systemd = startOptions.systemd ?? (runCommand === runPreflightCommand && !daemonGateOff() && existsSync('/run/systemd/system'));
    let managed = platformName === 'linux' && systemd;
    if (managed) {
      const manager = await readUserSystemdManager(runCommand, { signal: startOptions.signal });
      if (manager.kind === 'unavailable') refuseUnverifiedDaemon(daemonFailure(manager.status, manager.detail));
      managed = manager.kind === 'ready';
      if (manager.degraded) {
        const unitManager = {env:systemdManagerEnv(), signal:startOptions.signal, timeout:SYSTEMD_COMMAND_TIMEOUT_MS};
        const service = await readSbxDaemonUnit(runCommand, sbxDaemonUnitName(pinned.HOME), unitManager);
        if (service.state === 'active') {
          if (!isFaravanSbxDaemonUnit(service, pinned.HOME) || !isProcessAlive(service.pid)) refuseUnverifiedDaemon(degradedRefusal('unit_state'));
        } else {
          const refusal = await degradedManagerAllowsCreate(runCommand, service, pinned.HOME, unitManager);
          if (refusal) refuseUnverifiedDaemon(refusal);
        }
      }
    }
    let status;
    try { status = await runCommand(sbxBin(), ['daemon', 'status'], { env: pinned, signal: startOptions.signal, timeout: PREFLIGHT_COMMAND_TIMEOUT_MS }); }
    catch(error) {
      if(startOptions.commandObservation)Object.assign(startOptions.commandObservation,{daemonResult:error,daemon_status_passed:false});
      refuseUnverifiedDaemon(daemonFailure('daemon_status_unknown', 'The sandbox daemon status could not be read.'));
    }
    if(startOptions.commandObservation)Object.assign(startOptions.commandObservation,{daemonResult:status,daemon_status_passed:sbxDaemonRunning(status)});
    if (context?.recovery&&!sbxDaemonRunning(status)) refuseUnverifiedDaemon(daemonFailure('daemon_status_unknown','No live daemon proves the recorded sandbox HOME.'));
    if (managed && sbxDaemonRunning(status)) {
      const manager = { env: systemdManagerEnv(), signal: startOptions.signal, timeout: SYSTEMD_COMMAND_TIMEOUT_MS };
      const unit = sbxDaemonUnitName(pinned.HOME);
      const service = await readSbxDaemonUnit(runCommand, unit, manager);
      if (service.state === 'unknown') refuseUnverifiedDaemon(daemonFailure('systemd_unit_state_unknown', 'The managed sandbox service state could not be verified.'));
      if (service.state === 'deactivating') refuseUnverifiedDaemon(daemonFailure('systemd_unit_deactivating', 'The managed sandbox service is still stopping.'));
      if (service.state === 'activating') refuseUnverifiedDaemon(daemonFailure('systemd_unit_activating', 'The managed sandbox service is still starting.'));
      if (service.state === 'active' && !isFaravanSbxDaemonUnit(service, pinned.HOME)) {
        refuseUnverifiedDaemon(daemonFailure('systemd_unit_conflict', 'A service with the managed sandbox service name is not owned by Faravan.'));
      }
      if (service.state !== 'active') {
        const legacy = await allowLegacyDaemonDrain({ runCommand, env: pinned, signal: startOptions.signal, commandArgs, inspectDaemons, isProcessAlive });
        if (legacy === 'allow') return;
        if (legacy === 'drain-only') refuseUnverifiedDaemon(daemonFailure('legacy_daemon_drain_only', legacyDaemonMessage(pinned)));
        refuseUnverifiedDaemon(daemonFailure('daemon_not_managed', legacyDaemonMessage(pinned)));
      }
      if (!isProcessAlive(service.pid)) refuseUnverifiedDaemon(daemonFailure('systemd_unit_mainpid_not_alive', 'The managed sandbox service has no live main process.'));
      if (!await daemonMatchesMainPid(inspectDaemons, pinned.HOME, service.pid)) refuseUnverifiedDaemon(daemonFailure('systemd_unit_mainpid_mismatch', 'The managed sandbox service MainPID does not match a unique sandbox daemon.'));
      if (context) context.managed = true;
      if (startOptions.proofOut) startOptions.proofOut.pid = Number(service.pid);
      return true;
    }
    if (managed && !sbxDaemonStopped(status)) {
      refuseUnverifiedDaemon(daemonFailure('daemon_status_unknown', 'The sandbox daemon is neither verifiably running nor stopped.'));
    }
    if (!managed && sbxDaemonRunning(status) && readSbxOwner()) return true;
    if (!managed && sbxDaemonRunning(status)) {
      if (context?.recovery) refuseUnverifiedDaemon(daemonFailure('daemon_owner_repair_required', daemonFailureMessage('daemon_owner_repair_required')));
      const initialized = await startSbxDaemon({runCommand, ...startOptions, platformName, systemd});
      if (initialized.code !== 0) refuseUnverifiedDaemon(initialized);
      return;
    }
    if (!sbxDaemonStopped(status)) refuseUnverifiedDaemon(daemonFailure('daemon_status_unknown', 'The sandbox daemon is neither verifiably running nor stopped.'));
    const started = await startSbxDaemon({ runCommand, ...startOptions, platformName, systemd });
    if (started.code === 0 && context) context.managed = managed;
    if (started.code !== 0) refuseUnverifiedDaemon(started.status ? started : daemonFailure('daemon_start_failed', 'The sandbox daemon could not be started.'));
  })();
  sbxDaemonGate = gate;
  try { return await gate.pending; }
  finally { if (sbxDaemonGate === gate) sbxDaemonGate = null; }
}

const OLD_DAEMON_ENV_KEYS = ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'DBUS_SESSION_BUS_ADDRESS'];

// The CLI finds its daemon through $XDG_STATE_HOME, so an old daemon is only
// reachable with the environment it started with, not the pinned one.
function oldDaemonEnv(environ) {
  const env = sbxChildEnv();
  for (const key of OLD_DAEMON_ENV_KEYS) {
    if (environ[key] === undefined) delete env[key]; else env[key] = environ[key];
  }
  return env;
}

export async function waitForProcessExit(pid, { timeoutMs = 15_000, signal, kill = process.kill.bind(process) } = {}) {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (signal?.aborted) return false;
    // Only ESRCH proves the process is gone. EPERM means it is alive but not ours to signal.
    // Any other error leaves its state unknown (null): callers must not treat that as exited.
    try { kill(pid, 0); } catch (error) {
      if (error?.code === 'ESRCH') return true;
      if (error?.code !== 'EPERM') return null;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/**
 * The shared stop / exit-wait / start path for credential-store repairs and CLI updates.
 * Credential-store repairs require an authoritative empty process scan or sbx listing.
 * An update needs the same complete empty inventory, or an explicit owner confirmation
 * if both inventories are unknown. A busy inventory always vetoes the restart. The
 * caller fences new preparations and writers. No daemon is killed if graceful stop fails.
 */
export function restartSbxDaemon(options) {
  return withDaemonLifecycle(() => restartSbxDaemonLocked(options));
}

async function restartSbxDaemonLocked({ runCommand = runPreflightCommand, inspectDaemons = defaultInspectDaemons(runCommand), daemons, sandboxes = null, waitForExit = waitForProcessExit, signal, update = false, jobRunning = () => false, confirmedRestart = false, commandTimeoutMs=PREFLIGHT_COMMAND_TIMEOUT_MS, inspectSandboxes = defaultInspectSandboxes(runCommand), platformName = process.platform, systemd = runCommand === runPreflightCommand && !daemonGateOff() && existsSync('/run/systemd/system'), isProcessAlive = processIsAlive , profileHome = configHome()} = {}) {
  resetSbxDaemonGate();
  const refuse = (detail, diagnostics = '') => ({ ok: false, detail, diagnostics });
  const cancelled = () => refuse('The sandbox check was cancelled.');
  if (signal?.aborted) return cancelled();
  const uninstalling = () => uninstallInProgress(profileHome);
  if (uninstalling()) return refuse('Faravan is being uninstalled, so it left the sandbox service alone.');
  if (!update && !daemons?.length) return refuse('No sandbox service of this Faravan identity is running.');
  const busy = 'A sandbox is running, so Faravan left the sandbox service alone. It switches Docker sign-in storage once the sandbox finishes.';
  if (jobRunning()) return refuse('Faravan is waiting for running jobs or sign-ins to finish before restarting Docker Sandboxes.');
  if (sandboxes?.length > 0) return refuse(update ? 'Faravan is waiting for running jobs or sign-ins to finish before restarting Docker Sandboxes.' : busy, sandboxes.map((sandbox) => `sandbox process ${sandbox.pid}`).join('\n'));
  const env = daemons?.length ? oldDaemonEnv(daemons[0].environ) : sbxChildEnv();
  // macOS has no /proc inventory. Only Faravan's private default identity can
  // use the app's job/writer fence when the update itself prevents listing.
  const privateMacUpdate = update && platformName === 'darwin' && usesDefaultSbxHome() &&
    env.HOME === sbxHome() && isPrivateSbxHome(env.HOME);
  const active = activeSandboxNames(await runCommand(sbxBin(), ['ls', '--json'], { env, signal, timeout:commandTimeoutMs }));
  if (signal?.aborted) return cancelled();
  if (active?.length > 0) return refuse(update ? 'Faravan is waiting for running jobs or sign-ins to finish before restarting Docker Sandboxes.' : busy, active.join('\n'));
  if (!Array.isArray(sandboxes) && !Array.isArray(active) && !confirmedRestart && !privateMacUpdate) {
    return {...refuse('Faravan could not confirm that no sandbox is running. Confirm the restart to continue.',
      'process scan incomplete and sbx ls unreadable'),requiresConfirmation:true};
  }
  const latest=await Promise.resolve().then(inspectSandboxes).catch(()=>null);
  if(signal?.aborted)return cancelled();
  if(latest?.length>0)return refuse(update?'Faravan is waiting for running jobs or sign-ins to finish before restarting Docker Sandboxes.':busy);
  if(!Array.isArray(latest)&&!Array.isArray(active)&&!confirmedRestart&&!privateMacUpdate)return {
    ...refuse('Faravan could not confirm that no sandbox is running. Confirm the restart to continue.'),requiresConfirmation:true};
  if (jobRunning()) return refuse('Faravan is waiting for running jobs or sign-ins to finish before restarting Docker Sandboxes.');
  if (privateMacUpdate) {
    if (uninstalling()) return refuse('Faravan is being uninstalled, so it left the sandbox service alone.');
    const stopped = await runCommand(sbxBin(), ['daemon', 'stop'], {env, signal, timeout:commandTimeoutMs});
    if (signal?.aborted) return cancelled();
    if (stopped.code !== 0) return refuse('The sandbox service could not be stopped.', diagnosticsOf(stopped));
    for (const {pid} of daemons ?? []) {
      if (await waitForExit(pid, {signal}) !== true) return refuse('Faravan could not confirm that the sandbox service stopped.');
      if (signal?.aborted) return cancelled();
    }
    const started = await startSbxDaemon({runCommand, signal, commandTimeoutMs, platformName, systemd, isProcessAlive, inspectDaemons});
    return started.code === 0 ? {ok:true, detail:'Docker Sandboxes restarted.', diagnostics:''} : refuse('The sandbox service could not be started.', diagnosticsOf(started));
  }
  if (Array.isArray(daemons) && daemons.length === 0) {
    const started = await startSbxDaemon({runCommand, signal, commandTimeoutMs, platformName, systemd, isProcessAlive, inspectDaemons});
    return started.code === 0 ? {ok:true, detail:'Docker Sandboxes restarted.', diagnostics:''} : refuse('The sandbox service could not be started.', diagnosticsOf(started));
  }
  const refusal = (detail, repair = 'refused', extra = {}) => ({...refuse(detail),...classifySbxDaemonCause(repair==='legacy_isolate'?'legacy':repair==='owner_repair'?'owner_missing':'unit_conflict',{detail,env}), status:'daemon_owner_repair_required', repair, ...extra});
  if (platformName !== 'linux' || !systemd) return refusal('Faravan cannot verify sandbox daemon ownership without a systemd user manager. A manual restart is needed after running jobs finish.', 'manual_restart');
  if (!Array.isArray(daemons)) return refusal('Sandbox daemon ownership could not be proven: the daemon inventory is unreadable.');
  if (daemons.length > 1) return refusal(`Sandbox daemon ownership could not be proven: found ${daemons.length} daemons for this sandbox HOME (PIDs ${daemons.map(d=>d.pid).join(', ')}).`);
  const owner = readSbxOwner();
  if (!owner) return refusal(daemonFailureMessage('daemon_owner_repair_required'), 'owner_repair');
  const unit = sbxDaemonUnitName(env.HOME);
  const manager = {env:systemdManagerEnv(), signal, timeout:SYSTEMD_COMMAND_TIMEOUT_MS};
  const service = platformName === 'linux' && systemd && owner ? await readSbxDaemonUnit(runCommand, unit, manager) : null;
  if (service?.loadState === 'not-found') return refusal(legacyDaemonMessage(env), 'legacy_isolate');
  if (!service || service.state !== 'active') return refusal(`Sandbox daemon ownership could not be proven: the sandbox unit is ${service?.state || 'unavailable'}.`);
  if (!isFaravanSbxDaemonUnit(service, env.HOME)) return refusal('Sandbox daemon ownership could not be proven: the sandbox unit does not belong to this Faravan installation.');
  if (Number(daemons[0].pid) !== Number(service.pid)) return refusal(`Sandbox daemon ownership could not be proven: daemon PID ${daemons[0].pid} does not match unit MainPID ${service.pid}.`);
  if (!isProcessAlive(service.pid)) return refusal(`Sandbox daemon ownership could not be proven: unit MainPID ${service.pid} is not alive.`);
  const finalProcesses = await Promise.resolve().then(inspectSandboxes).catch(()=>null);
  const finalNames = parseSbxListing(await runCommand(sbxBin(), ['ls','--json'], {env, signal, timeout:commandTimeoutMs}));
  if (signal?.aborted) return cancelled();
  if (jobRunning() || finalProcesses?.length > 0 || finalNames?.length > 0) return refuse('Faravan is waiting for running jobs or sign-ins to finish before restarting Docker Sandboxes.');
  if (!Array.isArray(finalProcesses) && !Array.isArray(finalNames)) return refuse('Faravan could not confirm that no sandbox is running. Confirm the restart to continue.');
  if (uninstalling()) return refuse('Faravan is being uninstalled, so it left the sandbox service alone.');
  // Stop only the instance that was checked: a unit restarted meanwhile is another daemon.
  const current = await readSbxDaemonUnit(runCommand, unit, manager);
  if (signal?.aborted) return cancelled();
  if (!service.invocationId || current.invocationId !== service.invocationId) return refuse('The sandbox service changed while Faravan checked it. Check again.');
  const stop = await runCommand('systemctl', ['--user', 'stop', unit], manager);
  if (signal?.aborted) return cancelled();
  if (stop.code !== 0) return refuse('The sandbox service could not be stopped.', diagnosticsOf(stop));
  resetSbxDaemonGate();
  for (const { pid } of daemons ?? []) {
    const exited = await waitForExit(pid, {signal});
    if (signal?.aborted) return cancelled();
    if (exited === null) return refuse('Faravan could not confirm that the sandbox service stopped.', `daemon pid ${pid} could not be checked`);
    if (!exited) return refuse('The sandbox service did not stop in time.', `daemon pid ${pid} is still running`);
  }
  const start = await startSbxDaemon({ runCommand, signal, commandTimeoutMs, platformName, systemd, isProcessAlive, inspectDaemons });
  if (signal?.aborted) return cancelled();
  if (start.code !== 0) return refuse('The sandbox service could not be started again.', diagnosticsOf(start));
  if (update) return {ok:true,detail:'Docker Sandboxes restarted.',diagnostics:''};
  return { ok: true, detail: 'Faravan now keeps its Docker sign-in in its own folder. Sign in again to Docker and to each agent you lend: sign-ins kept in your desktop keyring are not moved.', diagnostics: '' };
}

// Compatibility for the existing credential-store repair callers.
export {restartSbxDaemon as restartSbxDaemonForCredentialStore};

function replacePreflightCheck(preflight, name, fields) {
  preflight.checks=preflight.checks.map(c=>c.name===name?{...c,...fields}:c);
  preflight.ok=preflight.checks.every(c=>c.ok);
  return preflight;
}

function repairFailure(preflight, name, step, result) {
  const text=outputOf(result);
  const permission=/permission denied|access.*denied/i.test(text);
  const prompt=/cannot prompt|stdin is not a terminal/i.test(text);
  const initialized=/already.{0,30}initiali[sz]ed/i.test(text);
  const detail=permission ? `Docker Sandboxes denied permission to ${step}.`
    : prompt ? `Docker Sandboxes required a terminal confirmation to ${step}; Faravan could not finish the repair.`
    : initialized ? 'Docker Sandboxes kept its existing network rules instead of initializing deny-all.'
    : `Docker Sandboxes could not ${step}.`;
  return replacePreflightCheck(preflight,name,{ok:false,automatic:false,repair:'support',fix:'Open Settings',
    detail:detail+' Open Settings to save a support report.'});
}

async function sandboxInventory({runCommand=runPreflightCommand,inspectSandboxes=defaultInspectSandboxes(runCommand),signal}={}) {
  const processes=await Promise.resolve().then(inspectSandboxes).catch(()=>null);
  const listing=activeSandboxNames(await runCommand(sbxBin(),['ls','--json'],{env:sbxChildEnv(),signal}).catch(()=>null));
  return processes?.length>0||listing?.length>0 ? 'busy'
    : Array.isArray(processes)||Array.isArray(listing) ? 'idle' : 'unknown';
}

async function repairNetworkPolicy(preflight, options={}) {
  const policy=namedCheck(preflight,'network_policy');
  if(!policyNeedsInitialization(policy)||namedCheck(preflight,'docker_login')?.ok!==true)return {preflight,recovered:false};
  const {runCommand=runPreflightCommand,signal,jobRunning=()=>false,confirmedPolicy=false,confirmedInit=false}=options;
  if(policy.needsInitialization&&!confirmedPolicy)return {preflight:replacePreflightCheck(preflight,'network_policy',{
    detail:'This sandbox policy already has network rules. Confirm before removing its custom rules.',
    fix:'Reset sandbox network rules',automatic:false,repair:'policy_confirm'}),recovered:false};
  const inventory=await sandboxInventory(options);
  if(signal?.aborted)return {preflight,recovered:false};
  if(jobRunning()||inventory==='busy')return {preflight:replacePreflightCheck(preflight,'network_policy',{
    detail:'Faravan is waiting for running jobs or sign-ins to finish before changing the network rules.',fix:'',automatic:true,repair:undefined}),recovered:false};
  if((inventory==='unknown'||!usesDefaultSbxHome())&&!confirmedPolicy&&!confirmedInit)return {preflight:replacePreflightCheck(preflight,'network_policy',{
    detail:'Faravan could not confirm that no other sandbox is running. Confirm before initializing the missing network policy.',
    fix:'Initialize sandbox network rules',automatic:false,repair:'policy_init_confirm'}),recovered:false};
  const fail=(step,result)=>({preflight:repairFailure(preflight,'network_policy',step,result),recovered:false});
  // Local init is one-time. Reset deletes all custom policy and stops the daemon (sbx help).
  if(policy.needsInitialization) {
    const help=await runCommand(sbxBin(),['policy','reset','--help'],{env:sbxChildEnv(),signal});
    if(help.code!==0||!/(?:^|\s)--force(?:\s|$)/m.test(outputOf(help)))return fail('reset the network rules with this version',help);
    const latest=await sandboxInventory(options);
    if(signal?.aborted||jobRunning()||latest==='busy')return {preflight,recovered:false};
    const reset=await runCommand(sbxBin(),['policy','reset','--force'],{env:sbxChildEnv(),signal});
    if(reset.code!==0)return fail('reset the network rules',reset);
    if(signal?.aborted)return {preflight,recovered:false};
    const start=await startSbxDaemon(options);
    if(start.code!==0)return fail('start the sandbox service after resetting its rules',start);
  }
  if(signal?.aborted||jobRunning())return {preflight,recovered:false};
  const initialized=await initializeDefaultSbxPolicy(options);
  if(initialized.code!==0)return fail('initialize the network rules',initialized);
  preflight=await probeSbxPreflight(options);
  if(namedCheck(preflight,'network_policy')?.ok!==true)return fail('verify the new network rules',{});
  return {preflight,recovered:true};
}

/** Safe, profile-isolated default policy initialization. */
export async function initializeDefaultSbxPolicy({ runCommand = runPreflightCommand, signal } = {}) {
  if (signal?.aborted) return {code: 1, stdout: '', stderr: 'Sandbox check cancelled.'};
  return runCommand(sbxBin(), ['policy', 'init', 'deny-all'], { env: sbxChildEnv(), signal });
}

/**
 * Makes the Waspflow-owned sbx identity ready for a contribution without
 * widening the user-facing setup surface. Every repair is followed by a
 * fresh probe, so unrelated installation, KVM, and login failures remain
 * explicit rather than being hidden behind a repair attempt.
 */
async function ensureSbxIdentity({ runCommand = runPreflightCommand, platformName = process.platform, inspectDaemons = defaultInspectDaemons(runCommand), inspectSandboxes = defaultInspectSandboxes(runCommand), waitForExit = waitForProcessExit, commandTimeoutMs=PREFLIGHT_COMMAND_TIMEOUT_MS, signal, sbxHomePath, userHome, realpathPath, jobRunning=()=>false , profileHome} = {}) {
  const probe = () => probeSbxPreflight({ runCommand, platformName, inspectDaemons, signal, sbxHomePath, userHome, realpathPath });
  let preflight = await probe();
  const repairs = [];
  if (signal?.aborted) return { preflight, repairs };
  if (namedCheck(preflight, 'sbx_version')?.ok === false) return { preflight, repairs };

  if (namedCheck(preflight, 'sbx_keychain')?.ok === false) {
    linkAccountKeychains(sbxHome(), { platformName });
    if (signal?.aborted) return { preflight, repairs };
    preflight = await probe();
    const repaired = namedCheck(preflight, 'sbx_keychain')?.ok === true;
    repairs.push({ name: 'sbx_keychain', ok: repaired, detail: repaired ? 'The account Keychains folder was linked.' : 'The account Keychains folder could not be linked.', diagnostics: '' });
    if (signal?.aborted || namedCheck(preflight, 'sbx_keychain')?.ok === false) return { preflight, repairs };
  }

  if (namedCheck(preflight, 'sbx_credential_store')?.ok === false) {
    if(!usesDefaultSbxHome()||jobRunning())return {preflight,repairs};
    const sandboxes = await Promise.resolve().then(inspectSandboxes).catch(() => null); // a failed scan is unknown, not empty
    if (signal?.aborted) return { preflight, repairs };
    const daemons = await inspectDaemons();
    if (signal?.aborted) return { preflight, repairs };
    const restart = await restartSbxDaemon({ runCommand, daemons, sandboxes, waitForExit, signal, inspectSandboxes, ...(profileHome ? {profileHome} : {}) });
    repairs.push({ name: 'sbx_credential_store', ok: restart.ok, detail: restart.detail, diagnostics: restart.diagnostics });
    if (signal?.aborted) return { preflight, repairs };
    if (restart.ok) preflight = await probe();
    if (signal?.aborted) return { preflight, repairs };
    // The old daemon is still up: starting another one beside it would split the identity in two.
    if (namedCheck(preflight, 'sbx_credential_store')?.ok === false) return { preflight, repairs };
  }

  const daemon = namedCheck(preflight, 'sbx_daemon');
  if (daemonNeedsStart(daemon)) {
    if (signal?.aborted) return { preflight, repairs };
    const result = await startSbxDaemon({ runCommand, signal, commandTimeoutMs });
    repairs.push({ name: 'sbx_daemon', ok: result.code === 0, detail: result.code === 0 ? 'The sandbox service started.' : 'The sandbox service could not be started.', diagnostics: diagnosticsOf(result) });
    if (signal?.aborted) return { preflight, repairs };
    if (result.code === 0) preflight = await probe();
    if (signal?.aborted) return { preflight, repairs };
  }

  if(policyNeedsInitialization(namedCheck(preflight,'network_policy'))) {
    const repaired=await repairNetworkPolicy(preflight,{runCommand,platformName,inspectDaemons,inspectSandboxes,signal,sbxHomePath,userHome,realpathPath,jobRunning});
    preflight=repaired.preflight;
    repairs.push({name:'network_policy',ok:repaired.recovered,detail:namedCheck(preflight,'network_policy')?.detail,diagnostics:''});
  }

  return { preflight, repairs };
}

function isSafeRelativeOutputPath(candidate) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (candidate.startsWith('/') || candidate.includes('\0')) return false;
  const parts = candidate.split('/');
  return parts.every((part) => part !== '..' && part !== '.' && part.length > 0);
}

const WORKSPACE_FAILURES = Object.freeze({
  daemon_restart_required: ['Docker Sandboxes needs to restart to finish its update.', 'Faravan restarts it when the current job finishes.'],
  credential_writer_unresolved: ['A previous sign-in may still be changing credentials.', 'Contact support to verify the previous sign-in has stopped. Do not delete its records.'],
  daemon_unavailable: ["Docker Sandboxes isn't running.", 'Faravan will try to start the sandbox service again.'],
  credential_store: ['Docker Sandboxes could not read its saved Docker sign-in.', 'Check Docker sign-in storage, then resume lending.'],
  option_rejected: ['Docker Sandboxes rejected an option Faravan uses.', 'Update Faravan.'],
  not_signed_in: ["The sandbox service isn't signed in to Docker yet.", 'Open Faravan and sign in to Docker.'],
  kvm: ['This computer could not start the workspace using hardware virtualization.', 'Enable hardware virtualization and allow Docker Sandboxes to use it.'],
  disk_full: ['Docker Sandboxes ran out of disk space while it started the test workspace.', 'Free some disk space. Faravan tries the test again by itself.'],
  image_unavailable: ['Docker Sandboxes could not load the test workspace image.', 'Check your connection and run Faravan doctor again.'],
  // A slow start is not a broken service: the existing readiness retry runs the test again. A trusted daemon update has its own restart cause.
  timeout: ['The test workspace took too long to start.', 'Run Faravan doctor again, or choose Check again in the app.'],
  unknown: ['Faravan could not start a test workspace.', 'Restart Docker Sandboxes and run Faravan doctor again.'],
});

export function workspaceFailure(error, version) {
  const diagnostics = String(error?.stderr || error?.message || error || '');
  const cause = error?.code === DOCKER_SIGNED_OUT ? 'not_signed_in'
    : error?.code==='daemon_restart_required' ? 'daemon_restart_required'
    : error?.code === 'credential_writer_unresolved' ? 'credential_writer_unresolved'
    : ['policy_unenforceable', 'limits_unenforceable', 'storage_unenforceable', 'credential_scope_unenforceable', 'input_copy_failed'].includes(error?.code) ? 'unknown'
    : DISK_FULL_PATTERN.test(diagnostics) ? 'disk_full'
    : error?.code === 'wall_timeout' || /timed? ?out|timeout|deadline exceeded|never became ready/i.test(diagnostics) ? 'timeout'
    : error?.code === 'sandbox_credential_store_failed' || /failed to decrypt secret|invalid pkcs7 padding|credential.*decrypt/i.test(diagnostics) ? 'credential_store'
    : /(?:daemon|sandboxd).*(?:connection refused|not running|stopped|unavailable|no such file)|cannot connect to (?:the )?(?:daemon|sandbox service)/i.test(diagnostics) ? 'daemon_unavailable'
    : /unknown (?:flag|option)|unrecognized (?:flag|option)|flag provided but not defined/i.test(diagnostics) ? 'option_rejected'
    : dockerSessionRefused(diagnostics) ? 'not_signed_in'
    : /\bkvm\b|hardware virtualization|virtualization (?:unavailable|disabled)/i.test(diagnostics) ? 'kvm'
    : /(?:image|manifest|template).*(?:not found|unavailable|failed|denied)|(?:pull|download).*(?:failed|denied)/i.test(diagnostics) ? 'image_unavailable'
    : 'unknown';
  let [detail, fix] = WORKSPACE_FAILURES[cause];
  // Only a parsed version token may enter primary copy, never raw command output.
  const parsedVersion = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:[^\d]|$)/.exec(version || '')?.[1];
  if (cause === 'option_rejected' && parsedVersion) detail = `Docker Sandboxes ${parsedVersion} rejected an option Faravan uses.`;
  return { ok: false, cause, detail, fix, diagnostics };
}

/**
 * Docker's own session refusal, in the forms sbx prints: a whole line saying the session is missing, with an optional
 * "error:" or "sbx create failed for sandbox …:" lead. Advice ("try: sbx login"), a command name inside other text, and a provider's own session error are not
 * refusals. This is the one place that decides it, for the readiness latch and for failure causes alike.
 */
export function dockerSessionRefused(text) {
  return /^\s*(?:sbx \w+ failed for sandbox \S+:\s*)?(?:error:\s*)?(?:not signed in to docker|(?:user is|you are) not authenticated to docker|no valid user session,?\s+(?:please\s+)?sign in to docker)(?:: no default account profile set: secret not found)?[.!]?\s*$/im.test(String(text ?? ''));
}

const SIGN_IN_RECOVERY_MS = 60_000;

/** The caller stops waiting when the signal fires; the read itself is not cancelled and starts nothing. */
function abortable(work, signal) {
  if (!signal) return work;
  return Promise.race([work, new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })]);
}

/** Shared readiness entry point; callers may inject a backend for offline tests. */
export async function testWorkspace({ backend = new DockerSbxBackend(), ...options } = {}) {
  try { return await backend.testWorkspace(options); }
  catch (error) { return workspaceFailure(error, options.version); }
}

/** Guard timings (design "Parameters"): SIGINT grace 20 s, then SIGTERM 10 s; soft deadline 60 s before the wall cap. */
export const GUARD_DEFAULTS = Object.freeze({ heartbeat_ms: 10_000, heartbeat_loss_ms: 35_000, sigint_grace_ms: 20_000, sigterm_grace_ms: 10_000,
  soft_deadline_margin_s: 60, stop_answer_ms: 30_000, meter_start_ms: 60_000, meter_loss_ms: 120_000 });
// How long a host disk halt may take to stop every writer in a sandbox; the disk watch projects this far
// ahead. `sbx stop` gets the first four fifths of it, and a stop that fails or overruns escalates to SIGKILL.
export const DISK_HALT_MS = 5_000;
// A create's lease is short and renewed while the create is pending, so a pull of any length stays
// covered and a process that died stops being covered within one TTL.
export const CREATE_LEASE_TTL_MS = 10 * 60 * 1000;
export const CREATE_LEASE_RENEW_MS = 2 * 60 * 1000;
const INNER_CONTAINERS_OFF = 'command -v docker >/dev/null 2>&1 || exit 0; ids=$(docker ps -aq); [ -z "$ids" ] || { docker update --restart=no $ids; docker kill $ids; } >/dev/null 2>&1; true';

/**
 * A lent run's guard settings, checked before anything reaches the guest.
 * `{agent:'claude'|'codex', budget: null | {unit:'claude_usd', limit} | {unit:'codex_credits', limit, weights:{input,cached_input,output}},
 *   soft_deadline_s?}`. Claude's own `--max-budget-usd` (limit minus headroom) is the adapter's job; here `limit` is the full budget.
 */
export function normalizeLendingBudget(value) {
  if (!value || typeof value !== 'object' || !GUARD_MODES.includes(value.agent)) throw policyError('policy_unenforceable', 'Unknown agent for the lending guard.');
  let budget = null;
  if (value.budget != null) {
    const { unit, limit, weights } = value.budget;
    if (!Number.isFinite(limit) || limit <= 0) throw policyError('policy_unenforceable', 'Lending budget must be a positive number.');
    if (value.agent === 'claude' && unit !== 'claude_usd') throw policyError('policy_unenforceable', 'Claude budgets are in claude_usd.');
    if (value.agent === 'codex') {
      if (unit !== 'codex_credits') throw policyError('policy_unenforceable', 'Codex budgets are in codex_credits.');
      const w = weights || {};
      if (!['input', 'cached_input', 'output'].every((key) => Number.isFinite(w[key]) && w[key] >= 0)) throw policyError('policy_unenforceable', 'Codex budgets need credit weights per token class.');
      budget = { unit, limit, weights: { input: w.input, cached_input: w.cached_input, output: w.output } };
    } else budget = { unit, limit };
  }
  const soft = value.soft_deadline_s;
  if (soft != null && !(Number.isFinite(soft) && soft > 0)) throw policyError('policy_unenforceable', 'Invalid soft deadline.');
  return { agent: value.agent, budget, soft_deadline_s: soft ?? null };
}

// Only structured failures belong in the lender's local error, never the agent's reply.
function codexErrorTail(stdout) {
  const messages = [];
  for (const line of String(stdout ?? '').slice(-64 * 1024).split(/\r?\n/)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.type === 'error' ? event.message :
      event?.type === 'turn.failed' ? event.error?.message : null;
    if (typeof message === 'string') messages.push(message);
  }
  return messages.slice(-3).map(message => message
    .replace(/[A-Za-z0-9_+\/=-]{32,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(-400)).join(' | ');
}

/**
 * Splits a byte stream into lines and drops the lender's allowance before anyone else sees it:
 * guard lines on stderr go to `onGuard` (parsed, untrusted), and any Claude `rate_limit_event` on stdout
 * is dropped here too, in case the in-guest guard was killed or bypassed.
 */
function lendingFilter({ onLog, onGuard }) {
  const rest = { stdout: '', stderr: '' };
  const kept = { stdout: '', stderr: '' };
  const keep = (stream, line) => {
    if (stream === 'stderr' && line.startsWith('{"type":"faravan.')) { const entry = parseGuardLine(line); if (entry) onGuard(entry); return; }
    if (stream === 'stderr' && /"type"\s*:\s*"faravan\./.test(line)) return;
    if (stream === 'stdout' && /"type"\s*:\s*"rate_limit_event"/.test(line)) return;
    kept[stream] = `${kept[stream]}${line}\n`.slice(-16 * 1024 * 1024);
    onLog?.({ stream, chunk: Buffer.from(line + '\n') });
  };
  return {
    push({ stream, chunk }) {
      rest[stream] += chunk.toString('utf8');
      let at;
      while ((at = rest[stream].indexOf('\n')) >= 0) { keep(stream, rest[stream].slice(0, at)); rest[stream] = rest[stream].slice(at + 1); }
      if (rest[stream].length > 4 * 1024 * 1024) { keep(stream, rest[stream]); rest[stream] = ''; }
    },
    end() { for (const stream of ['stdout', 'stderr']) if (rest[stream]) { keep(stream, rest[stream]); rest[stream] = ''; } return { ...kept }; },
  };
}

// A sandbox reaches the broker only through its network policy, which names an HTTPS host.
export function guestBrokerOriginProblem(origin) {
  let url;
  try { url=new URL(origin); } catch { return 'invalid_origin'; }
  if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password) return 'not_guest_reachable_https_origin';
  return null;
}

export class DockerSbxBackend extends SandboxBackend {
  // Budgeted lending may run checks here because prepareCheck makes every supported strategy provider-free: a native
  // generation is never copied (provider-file-generation); a global sbx sign-in stays bound but is denied and verified
  // (docker-native-oauth, docker-stored-secret); a key variable is verified absent (guest-env-api-key); host-env-proxy
  // (the GitHub CLI) never starts a check. See prepareCheck.
  checkWithoutProvider = true;

  constructor({ deadlineTimers = { setTimeout, clearTimeout }, runCommand = runSbx, streamOutput = streamSbxOutput, monotonic = () => performance.now(), now = Date.now, guardTimings = {}, storage, guestRuntime = stageGuestRuntime,
    hostDisk, hostDiskFactory = createHostDisk, home = configHome(), diskHaltMs = DISK_HALT_MS, diskTimers, killSandboxes = killIdentitySandboxes,
    cleanupListingTimeoutMs=12000,cleanupListingRetryMs=15000,cleanupListingSleep=(ms,{signal})=>sleep(ms,undefined,{signal}),
    cleanupDirectory=path.join(home,'v1','sandbox-cleanup'),removeScratch=dir=>rm(dir,{recursive:true,force:true}),autoRepair=true,
    scratchJournal=null, legacyDaemonOptions={}, imagePins=loadImagePins(),sandboxDeadlines,sharedSandboxWatcherFactory=createSharedSandboxWatcher,deadlineClock=sandboxDeadlineClock,diskLedger=null,
    onReaperSummary=record=>console.error(JSON.stringify(record)), onDiagnostic=()=>{} } = {}) {
    super();
    this._onDiagnostic = onDiagnostic;
    this._diskLedger = diskLedger;
    this.diskLease = { ttlMs: CREATE_LEASE_TTL_MS, renewMs: CREATE_LEASE_RENEW_MS };
    // A cache is ours the moment the app writes it.
    // A runtime directory is recorded as ours only when staging made it new, in this very call. A directory
    // that was already there (an earlier release, another tool, a foreign writer) is used but never owned.
    this.guestRuntime = async options => { const runtime = await guestRuntime(options); if (runtime?.created === true) this._recordCache(runtime.dir); return runtime; };
    this.guardTimings = { ...GUARD_DEFAULTS, ...guardTimings };
    this.autoRepair = autoRepair;
    this._scratchJournal = scratchJournal;
    this._imagePins = imagePins;
    this._profileHome=home;
    this._cleanupDirectory=cleanupDirectory;
    this._cleanupListingTimeoutMs=Number.isFinite(cleanupListingTimeoutMs)&&cleanupListingTimeoutMs>0?cleanupListingTimeoutMs:12000;
    this._cleanupListingRetryMs=Number.isFinite(cleanupListingRetryMs)&&cleanupListingRetryMs>=0?cleanupListingRetryMs:15000;
    this._cleanupListingFailure=null;this._cleanupListingFlight=null;
    this._cleanupListingSleep=cleanupListingSleep;
    this._legacyDaemonOptions = {
      inspectDaemons:runCommand===runSbx?inspectIdentityDaemons:async()=>[],
      isProcessAlive:processIsAlive,platformName:process.platform,selectHome:selectSbxHome,
      inspectProcesses:runCommand===runSbx?inspectLegacySandboxReferences:async()=>({complete:false,references:[]}),
      runProcessCommand:runCommand===runSbx?runPreflightCommand:async()=>({code:1}),
      runCommand:runCommand===runSbx?(args,options)=>runPreflightCommand(sbxBin(),args,{...options,skipDaemonGate:true}):runCommand,
      ...legacyDaemonOptions,
    };
    this.deadlineTimers = deadlineTimers;
    this._preparing = 0;
    this._checkTail = Promise.resolve();
    this._checkContext = new AsyncLocalStorage();
    this.credentialWriterBusy = () => false;
    this._healthRecovery = null;
    this._ownedStartupRecovery = null;
    this._ownedStartupProof = null;
    this._lenderSessions = 0;
    this._lendingContext = new AsyncLocalStorage();
    this._ownedStartupGeneration = 0;
    this._repairState = new Map();
    this._signInState = createDockerSignInState({home, sbxHome:sbxHome()});
    this._signInStateHome = sbxHome();
    this._signInRefusal = this._signInState.read();
    this._refusalEpoch = 0;
    // When Docker last accepted a sandbox create. A listing proves nothing about sign-in. A refusal clears it.
    this._createAcceptedAt = null;
    this._signInRecoveryContext = new AsyncLocalStorage();
    this.signInGeneration = 0;
    this._recovery = null;
    this._diagnosticEvidence = null;
    this._verifiedIdentityPolicies = new Map();
    this.preflightCache = null;
    this.preflightGeneration = 0;
    this._observationCache = null;
    this._binaryReads = new Map();
    this._binaryReadKey = null;
    this._injectedTransport=runCommand!==runSbx;
    const countedRun = runCommand===runSbx?runCommand:function(args,...options){countReaperCommand(sbxBin(),args);return runCommand.call(this,args,...options);};
    this.runSbx = (args,options={})=>{
      const runtime=launchRuntime(options)??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,env:options.env??sbxChildEnv(),profileHome:home,ownerScope:sandboxOwnerScope()});
      return withSbxRuntime(runtime,()=>countedRun.call(this,args,{...options,sbxRuntime:runtime,binary:runtime.path,
        beforeSpawn:()=>assertSbxRuntime(runtime,{signal:options.signal,env:options.env??sbxChildEnv()})}));
    };
    if(runCommand!==runSbx||legacyDaemonOptions.runCommand) {
      const run=this._legacyDaemonOptions.runCommand;
      this._legacyDaemonOptions.runCommand=function(args,...options){countReaperCommand(sbxBin(),args);return run.call(this,args,...options);};
    }
    if(this._legacyDaemonOptions.runProcessCommand!==runPreflightCommand) {
      const run=this._legacyDaemonOptions.runProcessCommand;
      this._legacyDaemonOptions.runProcessCommand=function(command,args,...options){countReaperCommand(command,args);return run.call(this,command,args,...options);};
    }
    this._watchInventories=new WeakSet();
    const deadlineRun=(command,args,options)=>runDeadlineCommand(command,args,{...options,onCommand:countReaperCommand});
    this.sandboxDeadlines=sandboxDeadlines??createSandboxDeadlineManager({binary:()=>resolveSbxExecutable(sbxBin(),sbxChildEnv()),clock:deadlineClock,directory:cleanupDirectory,
      run:deadlineRun,processStart:pid=>deadlineProcessIdentity(pid,{run:deadlineRun})});
    this.deadlineClock=deadlineClock;
    this._sharedSandboxWatcherFactory=sharedSandboxWatcherFactory;
    this._sharedSandboxWatch=null;
    this._deadlineRecovery=null;
    this._deadlineRecoveryHold=null;
    this._deadlineRecoveryReport=null;
    this.streamOutput = (handle,source,options={}) => streamOutput(handle,source,{...options,beforeExec:launch=>this._dispatchProtected(handle,options.signal,launch)});
    this.monotonic = monotonic;
    this._now = now;
    this._storageForHome=storage?()=>storage:home=>createStoragePool({home:()=>home,run:args=>this._runStorageCommand(args)});
    this.storage = storage ?? createStoragePool({ home: sbxHome, run: (args,{handle}={}) => handle ? this._runJobCommand(handle,args) : this._runStorageCommand(args) });
    this.hostDisk = hostDisk ?? hostDiskFactory({ paths: () => hostDiskPaths({ home, cleanupDirectory }) });
    // The one drive that holds the images and sandboxes. The disk report and the low-space warning read this
    // volume only; the all-volume reading above is for the job guard.
    this.storeDisk = hostDiskFactory({ paths: () => [sbxHome()] });
    this.diskHaltMs = diskHaltMs;
    this.diskTimers = diskTimers;
    this.killSandboxes = killSandboxes;
    this._diskSentries = new Map();
    this._diskRemoved = new Set();
    this.removeScratch = removeScratch;
    this.cleanupJournal = createSandboxCleanupJournal({directory:cleanupDirectory,scratchRoot,monotonic,home:sbxHome,inspectLegacy:(row,options)=>this._legacyInventory(row,options),removalCommand:row=>sandboxRemovalCommand(row.sbx_home,row.sandbox_id),destroy:(handle,options)=>this.destroy(handle,options),
      inspectPass:(rows,options)=>this._reapInventory(rows,options),disposePass:snapshot=>this._watchInventories.delete(snapshot),
      runPass:(summary,work)=>reaperPassContext.run(summary,work),onSummary:onReaperSummary,
      retryWatchDebts:(row,options)=>this._retryWatchedCleanupDebts(row,options),resolveAdopted:(row,options)=>this._resolveAdoptedWatch(row,options),
      reapAbandoned:(rows,options)=>this._reapAbandonedCreates(rows,options)});
  }

  // Auxiliary checks share daemon settings and credential publication. Queue the whole
  // lifecycle, including cleanup, before any workspace deadline is armed.
  async withSandboxCheck(work, { signal } = {}) {
    if (this._checkContext.getStore()?.active) return work();
    const previous = this._checkTail;
    let release;
    this._checkTail = new Promise(resolve => { release = resolve; });
    try {
      if (!signal) await previous;
      else await Promise.race([previous, new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      })]);
    } catch (error) {
      // Leave the queue in order: the next check still waits for the one that was ahead of this one.
      previous.then(release, release);
      throw error;
    }
    const owner = { active: true };
    try { return await this._checkContext.run(owner, work); }
    finally { owner.active = false; release(); }
  }

  _rowHomeMatches(row) { return typeof row.sbx_home==='string'&&path.isAbsolute(row.sbx_home)&&row.sbx_home===sbxHome(); }

  isSandboxHomeCurrent(home) { return this._rowHomeMatches({sbx_home:home}); }

  async _rowRun(row,args,options={}) {
    const recovery=deadlineRecoveryContext.getStore();
    const started=performance.now(),observation=options.commandObservation??{};
    const diagnose=result=>bindSandboxCommandDiagnostic(result,sandboxCommandDiagnostic(result,{...observation,duration_ms:performance.now()-started}));
    const failed=error=>{
      if(!recovery)return;
      const hold=recoveryHoldFor(error,{platformName:this._legacyDaemonOptions.platformName});
      // Keep the strongest fixed classification when cleanup makes several
      // failed calls. The underlying result/error stays internal to this flight.
      if(!recovery.failure||hold.cause_code==='host_not_awake') {recovery.failure=hold;recovery.cause=error;}
    };
    try {
      if((row.owner_scope||row.sbx_home)&&!this._rowHomeMatches(row))throw policyError('cessation_unverified','The recorded sandbox HOME differs from the current HOME.');
      const run=(signal=options.signal,commandObservation=observation)=>{
        const env=row.sbx_home?{...sbxChildEnv(),...credentialStoreEnv(row.sbx_home)}:options.env;
        const runtime=this._cleanupRuntime(row,env??sbxChildEnv(),{recorded:row._image===undefined});
        commandObservation.runtime_path=runtime.path;
        const launch={sbxRuntime:runtime,binary:runtime.path,beforeSpawn:()=>assertSbxRuntime(runtime,{signal,env:env??sbxChildEnv()})};
        return daemonJobContext.run({...daemonJobContext.getStore(),recovery:true,commandObservation},()=>this.runSbx(args,{...options,signal,...launch,...(env?{env}:{})}));
      };
      const result=args[0]==='ls'&&args[1]==='--json'
        ?await this._retryCleanupListing(run,options):await run();
      if(args[0]==='ls'&&(parseSbxListing(result)===null||!completeSbxListing(result))) {
        diagnose(result);
        failed(result);
        if(recovery?.abortOnListingFailure) {
          const error=this._noteCleanupListingFailure(result,recovery.rowCount,row.sbx_home);
          recovery.failure=error.recovery_hold;recovery.cause=error;recovery.listingFailure=true;
          recovery.controller.abort(error);throw error;
        }
      }
      return result;
    }catch(error){
      if(args[0]==='ls')diagnose(error);
      if(args[0]==='ls'&&recovery?.abortOnListingFailure&&!recovery.listingFailure&&!options.signal?.aborted&&this._rowHomeMatches(row)){
        const refusal=this._noteCleanupListingFailure(error,recovery.rowCount,row.sbx_home);
        recovery.failure=refusal.recovery_hold;recovery.cause=error;recovery.listingFailure=true;recovery.controller.abort(refusal);
      }
      if(!recovery?.listingFailure)failed(error);throw error;
    }
  }

  async _retryCleanupListing(run,{signal}={}) {
    // Retry availability only. A valid inventory (including a present sandbox)
    // returns immediately; only the exhausted result reaches the hold logic.
    let failedDiagnostic;
    for(let attempt=0;attempt<3;attempt++) {
      signal?.throwIfAborted();
      const started=performance.now(),observation={};
      let result,error,timer,onAbort;
      const controller=new AbortController();
      const bounded=new Promise((_,reject)=>{
        onAbort=()=>{controller.abort(signal.reason);reject(signal.reason);};
        signal?.addEventListener('abort',onAbort,{once:true});
        timer=setTimeout(()=>{const error=Object.assign(Error('Sandbox listing timed out.'),{timedOut:true});controller.abort(error);reject(error);},this._cleanupListingTimeoutMs);
      });
      try {
        result=await Promise.race([Promise.resolve().then(()=>run(controller.signal,observation)),bounded]);
        signal?.throwIfAborted();
        if(parseSbxListing(result)!==null&&completeSbxListing(result)){
          if(failedDiagnostic) {
            try{await this._onDiagnostic({at:new Date(this._now()).toISOString(),code:'listing_retry_recovered',phase:'deadline_recovery',
              details:{sandbox_command:{...failedDiagnostic,attempts:attempt+1}}});}catch{}
          }
          signal?.throwIfAborted();
          return result;
        }
      }catch(cause){signal?.throwIfAborted();error=cause;}
      finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
      const failure=error??result;
      failedDiagnostic={...sandboxCommandDiagnostic(failure,{...observation,duration_ms:performance.now()-started}),attempts:attempt+1};
      bindSandboxCommandDiagnostic(failure,failedDiagnostic);
      if(attempt===2){if(error)throw error;return result;}
      await this._cleanupListingSleep(attempt===0?1000:3000,{signal});
    }
  }

  async _runStorageCommand(args,options={}) {
    // Storage inspection/removal must remain available to recovery. Only a
    // command that creates compute crosses the startup deadline barrier.
    if(args[0]==='create'||args[0]==='run') {
      await (this.ensureSandboxAdmission?.({signal:options.signal})??this.recoverSandboxDeadlines({signal:options.signal}));
      const nameIndex=args.indexOf('--name');
      this.assertDeadlineTargetClear({sandbox_id:nameIndex>=0?args[nameIndex+1]:args.find(arg=>arg.startsWith('--name='))?.slice(7),sbx_home:sbxHome()});
    }
    return this.runSbx(args,options);
  }

  _cleanupRuntime(row,env=sbxChildEnv(),{recorded=false}={}) {
    const context=daemonJobContext.getStore();
    const handle=row._sbxRuntime?row:context?.handle&&context.handle.sandbox_id===row.sandbox_id?context.handle:null;
    const descriptor=row.sbx_runtime??(row.runtime_id?this.cleanupJournal.runtimeForScratch(row):null);
    // A journal record written before runtimes were recorded (no runtime_recorded marker), or a HOME-only inventory call, names no scoped account (the bare provider key is the host's own login). It runs on the
    // host default runtime for the current HOME. A record that names a scoped account and has no descriptor stays refused.
    if(recorded&&!handle?._sbxRuntime&&!descriptor&&accountIdOfKey(row.account_key)===null&&!row.runtime_id&&!row.runtime_recorded)return cleanupSbxRuntime(hostDefaultSbxRuntime({currentEnv:sbxChildEnv,env,profileHome:this._profileHome,ownerScope:row.owner_scope??null}));
    return cleanupSbxRuntime(handle?._sbxRuntime??restoreSbxRuntime(descriptor,{currentEnv:sbxChildEnv,env,home:row.sbx_home,profileHome:this._profileHome,ownerScope:row.owner_scope}));
  }

  sandboxOwnership() { return {owner_scope:sandboxOwnerScope(),sbx_home:sbxHome()}; }

  // Disk ownership. The store (lib/disk-store.mjs) is keyed by the sbx HOME and is not optional: its
  // ledger and its gate are the only way to create, reuse, renew or remove anything the sweep may
  // collect. A ledger is injected only by tests and tools that stand in for it; it is still the
  // ledger that decides, and the gate is keyed by the same directory.
  get diskLedger() { return this._diskLedger ?? this._diskStore().ledger; }
  set diskLedger(value) { this._diskLedger = value; this._coordinator = null; }
  _diskStore() { return openDiskStore({ home: sbxHome(), legacyLedgerFile: path.join(this._profileHome, 'v1', 'disk-ledger.json') }); }
  _diskCoordinator() {
    const dir = this._diskLedger ? (this._diskLedger.dir ?? sbxHome()) : sbxHome();
    if (this._coordinator?.dir !== dir) this._coordinator = this._diskLedger ? createStoreCoordinator({ dir }) : this._diskStore().coordinator;
    return this._coordinator;
  }
  // A lease is written to the ledger and renewed until it is released. `acquireLease` here runs under
  // the gate (the callers hold it). Renewal and re-admission run under the gate as well, with the same
  // conflict check: a lease that ran out is never revived blindly. Its holder is `valid: false`, and must
  // not use the resource, until it is admitted again.
  _leaseHold(ledger, item, pin = null) {
    const { ttlMs, renewMs } = this.diskLease;
    const hold = { id: ledger.acquireLease({ item, ttlMs, ...(pin ? { pin } : {}) }), timer: null, item, pin, valid: true, released: false, renewing: false };
    hold.timer = setInterval(() => {
      if (hold.renewing || hold.released) return;
      hold.renewing = true;
      this._diskCoordinator().exclusive(async () => this._renewHoldUnderGate(hold), { waitMs: renewMs })
        .catch(() => { /* the next renewal tries again; the sandbox record roots a running job meanwhile */ })
        .finally(() => { hold.renewing = false; });
    }, renewMs);
    hold.timer.unref?.();
    return hold;
  }
  // Under the gate. Renews a lease that is still current. A lease that ran out or was dropped makes its
  // holder invalid; it is admitted again only when no open removal takes what it uses and, for a runtime
  // cache, the directory is still there.
  _renewHoldUnderGate(hold) {
    const ledger = this.diskLedger;
    if (!hold || hold.released) return false;
    const { ttlMs } = this.diskLease;
    if (ledger.renewLease?.(hold.id, ttlMs)) { hold.valid = true; return true; }
    hold.valid = false;
    const runtimeDir = hold.item.startsWith('cache:') ? hold.item.slice('cache:'.length) : null;
    const sandbox = hold.item.startsWith('sandbox:') ? hold.item.slice('sandbox:'.length) : null;
    if (this._removalConflicts(ledger, { pin: hold.pin, runtimeDir, sandbox })) return false;
    if (runtimeDir) { try { if (!lstatSync(runtimeDir).isDirectory()) return false; } catch { return false; } }
    hold.id = ledger.acquireLease({ item: hold.item, ttlMs, ...(hold.pin ? { pin: hold.pin } : {}) });
    hold.valid = true;
    return true;
  }
  _dropHold(hold) {
    if (!hold) return;
    hold.released = true;
    clearInterval(hold.timer);
    try { this.diskLedger.releaseLease(hold.id); } catch { /* it expires by itself */ }
  }
  // An open removal blocks a job only when the job would use the very thing being removed.
  _removalConflicts(ledger, { pin = null, runtimeDir = null, sandbox = null }) {
    for (const op of ledger.openOps()) {
      // A removal that never reported that it finished keeps its sandbox name for good.
      if (op.kind === 'sandbox' && sandbox && op.ref === sandbox) return op;
      if (op.kind === 'image' && pin && imageMatchesDigests(op.imageId, [pin]) !== false) return op;
      if (op.kind === 'cache' && runtimeDir && op.ref === runtimeDir) return op;
    }
    return null;
  }
  _protectionUnavailable(error) {
    const message = error?.code === 'removal_open' ? 'The sandbox store is being cleaned up, so no new sandbox starts yet. Try again shortly.'
      : error?.code === 'store_busy' ? 'Another sandbox is still being started or cleaned up in the same store, so this one waits. Try again shortly.'
      : 'The disk records of this computer cannot be written, so no new sandbox starts. Free some disk space and try again.';
    return policyError('disk_protection_unavailable', message, { cause: error });
  }
  // The exact runtime directory a job will mount is protected under the gate BEFORE it is obtained or
  // reused, so a sweep that already read its roots cannot remove it between the read and the use.
  async _holdRuntime(home, signal) {
    const ledger = this.diskLedger;
    if (ledger.damaged) return null;
    try {
      const dir = await intendedRuntimeDir({ home });
      if (!dir) return null;
      return await this._diskCoordinator().exclusive(async () => {
        if (this._removalConflicts(ledger, { runtimeDir: dir })) throw Object.assign(new Error('The runtime directory is being removed.'), { code: 'removal_open' });
        return this._leaseHold(ledger, `cache:${dir}`);
      }, { signal });
    } catch (error) { if (signal?.aborted) throw error; throw this._protectionUnavailable(error); }
  }
  // Protection is durable before anything is dispatched, and the gate is held from before the create
  // until it is attributed. Under the gate, in one step: refuse a job that would use something an open
  // removal is taking, list the assembled images that exist now, and write the run's lease (the
  // sandbox and the image pin it comes from). The run lease already exists when the create command is
  // dispatched, so the create-to-run handoff has no gap. Every writer of this store takes the gate, so
  // an image that is new once the create ends is this create's (lib/disk-ownership.mjs). If any of it
  // cannot be written, nothing is dispatched. A damaged ledger admits the job without a lease: every
  // sweep, in every process of this store, removes nothing while the ledger is damaged.
  async _admitDiskJob(sandboxId, pin, signal, runtimeHold = null, handle) {
    const ledger = this.diskLedger;
    if (ledger.damaged) return null;
    let gate;
    try {
      gate = await this._diskCoordinator().acquire({ signal });
      if (this._removalConflicts(ledger, { pin, sandbox: sandboxId })) throw Object.assign(new Error('An earlier cleanup of the sandbox store has not finished.'), { code: 'removal_open' });
      // The runtime directory this job will mount must still be held. A holder whose lease ran out is
      // admitted again here, under the gate, or the job does not start.
      if (runtimeHold && !runtimeHold.released) {
        this._renewHoldUnderGate(runtimeHold);
        if (!runtimeHold.valid) throw Object.assign(new Error('The runtime directory is no longer held.'), { code: 'removal_open' });
      }
      const listing = parseFullImageListing(await (handle ? this.runSbx(['template', 'ls', '--all', '--digests', '--no-trunc', '--json'], {signal, sbxRuntime:handle._sbxRuntime}) : this._diskRunSbx(['template', 'ls', '--all', '--digests', '--no-trunc', '--json'])));
      const run = this._leaseHold(ledger, `sandbox:${sandboxId}`, pin);
      return { gate, run, before: listing ? imagesBefore(listing) : null };
    } catch (error) {
      gate?.release();
      if (signal?.aborted || error?.code === 'claude_account_unavailable') throw error;
      throw this._protectionUnavailable(error);
    }
  }
  _endRunLease(sentry) {
    const hold = sentry?.runLease;
    this._dropHold(sentry?.runtimeLease);
    if (sentry) sentry.runtimeLease = null;
    if (!hold) return;
    sentry.runLease = null;
    this._dropHold(hold);
  }
  // The create has ended. Only a create that succeeded can have produced images of ours, and they are
  // recorded as ours only when they are new since the listing taken under the same gate before the
  // dispatch. A failed create, or an unreadable listing, records nothing. The gate is released last.
  async _settleDiskCreate(hold, { created }, handle) {
    if (!hold) return;
    try {
      if (!created || !hold.before) return;
      const images = parseFullImageListing(await this._diskRunSbx(['template', 'ls', '--all', '--digests', '--no-trunc', '--json'], {}, handle));
      if (images) {
        ownCreatedImages({ ledger: this.diskLedger, before: hold.before, images,
          generation: this._kitGenerationForReport(hold) });
      }
    } catch { /* nothing is recorded */ } finally { hold.gate.release(); }
  }
  // Pure, best-effort inputs for the single ownership transaction. A legacy
  // ledger keeps its original call shape; a real ledger records unknown inputs
  // conservatively in the same write as ownership.
  _kitGenerationForReport(hold) {
    const unknown = { digests: null, inputDigest: null };
    try {
      if (typeof this.diskLedger.recordKitImages !== 'function') return null;
      const agents = this._imagePins?.agents;
      if (!agents || typeof agents !== 'object' || Array.isArray(agents)) return unknown;
      const values = Object.values(agents);
      if (!values.length || values.some(value => value !== null && (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)))) return unknown;
      const digests = values.filter(Boolean).map(value => value.slice(7));
      return digests.length ? { digests, inputDigest: hold.run?.pin ?? null } : unknown;
    } catch { return unknown; }
  }
  _diskRunSbx(args, options = {}, handle) {
    const context=daemonJobContext.getStore();
    const accountHandle=handle??context?.handle;
    if(accountHandle)return this._rowRun(accountHandle,args,options);
    return daemonJobContext.run({ ...context, recovery: true }, () => this.runSbx(args, options));
  }
  _recordCache(dir) {
    if (!dir) return;
    try { this.diskLedger.ownCache(dir, CREATED_REASON); } catch { /* an unrecorded cache is left alone */ }
  }
  _storeFree() { return storeVolumeFree(this.storeDisk); }
  // What the disk sweep needs from this backend. Everything is read-only except the exact-name
  // removals the sweep itself issues through `runSbx`.
  diskSweepAdapters() {
    const live = () => new Set(this._diskSentries.keys());
    return {
      runSbx: (args, options = {}) => this._diskRunSbx(args, options),
      coordinator: this._diskCoordinator(),
      journal: this.cleanupJournal,
      referenced: live,
      retentionLimitBytes: 20 * 1024 ** 3,
      // Sandboxes of jobs whose workspace is still retained, whether or not their sandbox is still listed.
      // A scratch root that cannot be read in full is unknown, not empty: this throws, and the sweep removes nothing.
      retained: () => {
        let names;
        try { names = readdirSync(scratchRoot()); } catch (error) { if (error?.code === 'ENOENT') return new Set(); throw error; }
        const retained = new Set();
        for (const name of names) {
          const id = /^wf-job-(wf-[0-9a-f]{16})-/.exec(name)?.[1];
          if (!id) continue;
          retained.add(id);
          if (retained.size > 20_000) throw Object.assign(new Error('The scratch root holds too many retained jobs.'), { code: 'too_large' });
        }
        return retained;
      },
      // Where workspaces, logs and the runtime cache live; measured for the per-category report.
      usage: { scratchRoot: scratchRoot(), logsDir: path.join(this._profileHome, 'v1', 'logs'), cacheRoot: path.join(sbxHome(), 'guest-runtime') },
      pins: () => Object.values(this._imagePins.agents).filter(Boolean).map(digest => digestHex(`x@${digest}`)).filter(Boolean),
      // Free space on the drive that holds the images and sandboxes, for the watermarks, the report and the
      // low-space warning. Only that drive: another drive filling or emptying says nothing about this store.
      hostFree: () => this._storeFree(),
      measureFree: () => this._storeFree(),
      // Superseded guest runtime copies. A running job may still mount an older one, so with
      // any job live (or the current hash unknown) none is offered for removal; the root is
      // always given so existing copies can be recorded.
      caches: () => {
        let current = null;
        try {
          const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../guest-runtime/manifest.json', import.meta.url)), 'utf8'));
          const hash = manifest[`linux-${process.arch}`]?.sha256;
          if (/^[a-f0-9]{64}$/.test(hash)) current = hash;
        } catch { /* the current hash is unknown */ }
        return { root: path.join(sbxHome(), 'guest-runtime'), current, offer: current !== null && this._diskSentries.size === 0 && !(this._preparing > 0) };
      },
    };
  }
  // The sandbox record names the image pin and the runtime cache the sandbox mounts, so every
  // process knows what the sandbox uses without asking the one that created it.
  async _recordSandboxImage(name, imageArgs, cache = null, handle) {
    const pin = digestHex(imageArgs.flags[1] ?? imageArgs.positional);
    // The sbx id comes from the listing, read while the gate is still held from before the create. Without
    // it the record still roots the image and the cache, but the sweep will not remove the sandbox.
    let id = null;
    try {
      const rows = JSON.parse(String((await this._diskRunSbx(['ls', '--json'], {}, handle)).stdout || '[]'));
      const row = Array.isArray(rows) ? rows.find(candidate => candidate?.name === name) : null;
      if (typeof row?.id === 'string' && row.id) id = row.id;
    } catch { /* the sandbox stays unowned */ }
    try { this.diskLedger.recordSandbox(name, { pin, cache, id }); } catch { /* the sweep then treats its image and cache as unknown and keeps them */ }
    return pin;
  }

  _legacyInventory(row,options={}) {
    let runtime;
    try{runtime=row.sbx_runtime?cleanupSbxRuntime(restoreSbxRuntime(row.sbx_runtime,{currentEnv:sbxChildEnv,env:sbxChildEnv(),home:row.sbx_home,profileHome:this._profileHome,ownerScope:row.owner_scope})):this._cleanupRuntime({...row,_sbxRuntime:undefined},sbxChildEnv(),{recorded:true});}
    catch{return Promise.resolve({names:null,detail:'The recorded sandbox runtime cannot be verified.'});}
    return withSbxRuntime(runtime,()=>this._legacyInventoryQualified(row,options));
  }
  async _legacyInventoryQualified(row,{signal,sourceDirectory,legacyNames=[row.sandbox_id]}={}) {
    let home=row.sbx_home;
    const inferredHome=home===undefined||home===null;
    // Unscoped records never establish HOME or profile authority themselves.
    if(process.env.FARAVAN_SBX_HOME!==undefined||process.env.FARAVAN_SBX_HOME!==undefined)return {names:null,detail:'The legacy sandbox HOME is unknown while an override is set.'};
    try {
      const select=this._legacyDaemonOptions.selectHome,current=select(),normal=select({override:null,pathExists:()=>false});
      if(current.migration!==null||current.home!==normal.home||(home!=null&&home!==current.home))return {names:null,detail:'The historical sandbox HOME cannot be verified.'};
      const profile=realpathSync(configHome()),source=realpathSync(sourceDirectory);
      const ownJournal=path.resolve(this._cleanupDirectory),ownPending=path.join(profile,'v1');
      // Old scratch records also lived in the default sandbox HOME's journal.
      let defaultScratch=false;
      if(this._scratchJournal===null)try{defaultScratch=source===realpathSync(path.join(current.home,'scratch-journal'));}catch{/* No default journal. */}
      if(realpathSync(this._profileHome)!==profile||!(source===ownPending||defaultScratch||source===ownJournal&&source.startsWith(profile+path.sep)))return {names:null,detail:'The legacy record is not from this profile’s exact journal or pending directory.'};
      const scratch=row.scratch_dir??row.scratchDir;
      const canonical=canonicalScratchPath(scratch,scratchRoot());
      if(!canonical)return {names:null,detail:'The legacy scratch directory cannot be verified.'};
      try {const info=lstatSync(canonical);if(!info.isDirectory()||info.isSymbolicLink())return {names:null,detail:'The legacy scratch directory is unsafe.'};}
      catch(error){if(error.code!=='ENOENT')throw error;}
      home=current.home;
    }catch{return {names:null,detail:'The legacy record location or scratch could not be verified.'};}
    if (typeof home!=='string'||!path.isAbsolute(home)) return {names:null,detail:'The legacy record has no verified sandbox HOME.'};
    const options=this._legacyDaemonOptions;
    let env={...sbxChildEnv(),...credentialStoreEnv(home,options.platformName)};
    if(options.platformName!=='darwin') {
      const daemons=await options.inspectDaemons({home}).catch(()=>null);
      const live=daemons?.filter(daemon=>daemon.environ?.HOME===home&&options.isProcessAlive(daemon.pid));
      if (live?.length!==1) return {names:null,detail:'No unique live daemon proves the legacy sandbox HOME.'};
      env={...oldDaemonEnv(live[0].environ),HOME:home};
    }
    // macOS has no /proc evidence. A successful status call at this HOME must
    // prove liveness before the read-only listing; it never starts a daemon.
    const runOptions={env,signal,timeout:PREFLIGHT_COMMAND_TIMEOUT_MS,skipDaemonGate:true};
    const status=await options.runCommand(['daemon','status'],runOptions).catch(()=>null);
    if (!sbxDaemonRunning(status)) return {names:null,detail:'The legacy daemon is not verifiably running.'};
    const names=parseSbxListing(await options.runCommand(['ls','--json'],runOptions).catch(()=>null));
    const command=name=>sandboxRemovalCommand(home,name,env);
    if(names&&!legacyNames.some(name=>names.includes(name))&&['linux','darwin'].includes(options.platformName)) {
      const scan=await (options.platformName==='darwin'?inspectMacSandboxReferences(legacyNames,{runCommand:options.runProcessCommand}):options.inspectProcesses(legacyNames)).catch(()=>({complete:false,references:[]}));
      if(!scan?.complete||scan.references?.length)return {names:null,detail:'Host process evidence cannot prove the old sandbox name absent.'};
    }
    return {names,command,home,inferredHome};
  }

  // Records from before create receipts are read only. A verified listing can
  // add the exact removal command; absence never closes the record or its hold.
  // Only a pending attempt opts in with `closeWhenAbsent`: the same verified
  // evidence (HOME, live daemon, listing, process scan) then proves compute is
  // gone, as the previous release's own removal did.
  async _legacyReport(row,names,{signal,sourceDirectory,closeWhenAbsent=false}={}) {
    const evidence=await this._legacyInventory(row,{signal,sourceDirectory,legacyNames:names});
    const present=evidence.names?names.filter(name=>evidence.names.includes(name)):[];
    if(closeWhenAbsent&&evidence.names&&!present.length)return {removed:true,sbx_home:evidence.home,source:'legacy-listing',observed_at:new Date().toISOString()};
    return {removed:false,code:'cessation_unverified',...(evidence.names?{}:{detail:evidence.detail??'The legacy sandbox listing could not be read.'}),
      remediation:present.length?present.map(name=>({name,home:evidence.home,reason:OLD_RECORD,command:evidence.command(name)})):[{name:names[0],home:evidence.home??row.sbx_home??null,reason:OLD_RECORD}]};
  }

  // This is only a background hint. Startup/admission never receive it.
  _watchInventoryCurrent(snapshot) {
    if(!this._watchInventories.has(snapshot))return false;
    if(snapshot.home===sbxHome()&&snapshot.binary===sbxBinaryIdentity()&&snapshot.generation===daemonLifecycleGeneration)return true;
    this._watchInventories.delete(snapshot);return false;
  }
  async _reapInventory(rows,{signal,passId}) {
    const row=rows.find(row=>this._rowHomeMatches(row));if(!row)return null;
    const binding={home:sbxHome(),binary:sbxBinaryIdentity(),generation:daemonLifecycleGeneration};
    const result=await this._rowRun(row,['ls','--json'],{signal}),names=parseSbxListing(result);
    if(!names||!completeSbxListing(result))throw policyError('sandbox_inventory_incomplete','Background inventory is incomplete.');
    const snapshot=Object.freeze({...binding,names:Object.freeze(names),observed_at:this._now(),pass_id:passId});
    this._watchInventories.add(snapshot);
    if(!this._watchInventoryCurrent(snapshot)){this._watchInventories.delete(snapshot);return null;}
    return snapshot;
  }

  _sharedSandboxWatcher() {
    const home=sbxHome(),owner=sandboxOwnerScope();
    if(!this._sharedSandboxWatch||this._sharedSandboxWatch.home!==home||this._sharedSandboxWatch.owner!==owner)
      this._sharedSandboxWatch={home,owner,watcher:this._sharedSandboxWatcherFactory({home,owner,
        binary:()=>resolveSbxExecutable(sbxBin(),sbxChildEnv())})};
    return this._sharedSandboxWatch.watcher;
  }
  // Fresh work waits only for global service/owner evidence. Row recovery is
  // independent and keeps each old name and account slot reserved.
  async ensureSandboxAdmission({signal,force=false}={}) {
    const home=sbxHome(),checked=await this._cleanupListingReady({signal,force});
    signal?.throwIfAborted();
    if(home!==sbxHome())throw policyError('cessation_unverified','The sandbox HOME changed during admission.',{recovery_scope:'target',retryable:true});
    if(checked&&this._deadlineRecoveryHold?.error_code==='sbx_daemon_unavailable')this._deadlineRecoveryHold=null;
    const hold=this.deadlineRecoveryHold();if(hold)throw deadlineRecoveryError(hold);
    return true;
  }
  sandboxAdmissionPending() { return this._cleanupListingFlight?.home===sbxHome(); }
  reconcileLendingAdmission({signal}={}) {
    const home=sbxHome(),generation=this._ownedStartupGeneration;
    if(this._ownedAdmissionFlight?.home===home&&this._ownedAdmissionFlight.generation===generation)return this._ownedAdmissionFlight.promise;
    const flight={home,generation};
    flight.promise=Promise.resolve().then(()=>this.ensureSandboxAdmission({signal})).then(()=>{
      signal?.throwIfAborted();
      const proof={removed:false,admission_allowed:home===sbxHome()&&generation===this._ownedStartupGeneration&&!this.deadlineRecoveryHold(),sbx_home:home,
        cleanup_debt:this.cleanupJournal.obligations?.()??[]};
      if(proof.admission_allowed)this._ownedAvailabilityAdmission=proof;
      return proof;
    });
    this._ownedAdmissionFlight=flight;
    const clear=()=>{if(this._ownedAdmissionFlight===flight)this._ownedAdmissionFlight=null;};
    flight.promise.then(clear,clear);return flight.promise;
  }
  // Inside fn (which must be synchronous) every cleanup answer comes from one reading of the journal and of the local
  // failure flag, taken at the start, as if all reads ran at that instant. Outside it each call reads fresh.
  withCleanupSnapshot(fn) {
    if(this._cleanupSnapshot)throw Object.assign(new Error('withCleanupSnapshot does not nest'),{code:'cleanup_snapshot_misuse'});
    this._cleanupSnapshot={rows:Object.freeze(this.cleanupJournal.obligations?.()??[]),localFailure:this._localCleanupFailure};
    try{
      const result=fn();
      if(typeof result?.then==='function')throw Object.assign(new Error('withCleanupSnapshot needs a synchronous function'),{code:'cleanup_snapshot_misuse'});
      return result;
    }finally{this._cleanupSnapshot=null;}
  }
  _cleanupView() {
    const snapshot=this._cleanupSnapshot;
    return snapshot?{rows:snapshot.rows,localFailure:snapshot.localFailure}:{rows:this.cleanupJournal.obligations?.()??[],localFailure:this._localCleanupFailure};
  }
  cleanupSlotHold(accountKey,{slot=0,fallback=false,knownAccounts=null,slots=1}={}) {
    const {rows,localFailure}=this._cleanupView();
    if(!rows.length&&localFailure)return fallback?'cessation_unverified':null;
    const held=rows.some(row=>{
      if(!row.compute_may_run)return false;
      const known=row.account_key&&(!knownAccounts||knownAccounts.includes(row.account_key));
      if(!known)return fallback;
      const ownedSlot=Math.min(row.account_slot,Math.max(0,slots-1));
      return row.account_key===accountKey&&ownedSlot===slot;
    });
    return held?'cessation_unverified':null;
  }
  // Cleanup debts that name no account this machine knows may still be running compute, and nothing says whose slot they
  // hold, so together they reserve one machine slot (not one each: they cannot be told apart).
  unknownCleanupDebts(knownAccounts=null) {
    const {rows,localFailure}=this._cleanupView();
    const unknown=row=>row.compute_may_run&&!(row.account_key&&(!knownAccounts||knownAccounts.includes(row.account_key)));
    return rows.some(unknown)||(!rows.length&&localFailure)?1:0;
  }
  async _retryWatchedCleanupDebts(handle,{signal}={}) {
    const row=this.cleanupJournal.authority(handle);
    if(!row||row.watch_state!=='watch_adopted'||!this._rowHomeMatches(row))return {policy_revoked:false};
    const bounded=AbortSignal.any([AbortSignal.timeout(30000),...(signal?[signal]:[])]);
    const run=args=>this._rowRun(row,args,{signal:bounded});
    const github=await removeSandboxGitHub(run,row.sandbox_id).catch(()=>null);
    if(github!==true)return {policy_revoked:false,revocation:{step:'github_secret',error:github===null?'listing_failed':'value_remains'}};
    const detail={};
    const policy=await removeSandboxPolicies(run,row.sandbox_id,detail,{leaveProvisioned:true})
      .catch(()=>{detail.failure='listing_failed';return false;});
    if(policy!==true)return {policy_revoked:false,revocation:{step:'network_policy',error:detail.failure??'listing_failed'}};
    // A watched name can still appear. Scratch, storage and its reservation
    // remain explicit debt; neither adoption nor absence proves cessation.
    return {policy_revoked:github===true&&policy===true};
  }
  _noteCleanupListingFailure(result,rowCount,home=sbxHome()) {
    const retryAt=this._now()+this._cleanupListingRetryMs;
    const hold=sandboxServiceUnavailableHold(result,{rowCount,retryAt});
    if(sbxHome()===home)this._cleanupListingFailure={home,hold,retryAt};
    return deadlineRecoveryError(hold);
  }
  // Availability is not an absence proof. Fail before touching any row or
  // upgrading guards, and cache only refusals so one outage is not retried for
  // every saved create. All removal paths still require their own fresh reads.
  // `display:true` is for the idle reaper only: it decides whether to probe the daemon from a display-age status. Admission
  // and every other caller leave it unset and read the journal fresh.
  async _cleanupListingReady({signal,force=false,display=false}={}) {
    signal?.throwIfAborted();
    const home=sbxHome(),cached=this._cleanupListingFailure;
    if(!force&&cached?.home===home&&this._now()<cached.retryAt)throw deadlineRecoveryError(cached.hold);
    let count;try{const status=(display===true&&!force?this._cleanupDisplayReading().status:this.cleanupJournal.status?.())??{};count=Math.max(...['compute_cleanup_pending','policy_cleanup_pending','data_cleanup_pending','unknown'].map(k=>status[k]??0));}catch{count=1;}
    if(!count&&this._deadlineRecoveryHold?.error_code==='sbx_daemon_unavailable')count=1;
    if(!count){this._cleanupListingFailure=null;return false;}
    const context=deadlineRecoveryContext.getStore();if(context)context.rowCount=count;
    if(this._cleanupListingFlight?.home===home)return this._cleanupListingFlight.promise;
    const flight={home};
    flight.promise=Promise.resolve().then(async()=>{
      let result;
      try {
        result=await this._rowRun({sbx_home:home},['ls','--json'],{signal,timeout:this._cleanupListingTimeoutMs});
        signal?.throwIfAborted();
        if(parseSbxListing(result)!==null&&completeSbxListing(result)){
          if(sbxHome()===home)this._cleanupListingFailure=null;
          return true;
        }
      }catch(error){if(signal?.aborted)throw error;result=error;}
      const error=this._noteCleanupListingFailure(result,count,home);
      if(context){context.failure=error.recovery_hold;context.cause=error;}
      throw error;
    }).finally(()=>{if(this._cleanupListingFlight===flight)this._cleanupListingFlight=null;});
    this._cleanupListingFlight=flight;return flight.promise;
  }
  reapCleanup(options={}) {
    const context={failure:null,cause:undefined,controller:new AbortController()};
    const signal=options.signal?AbortSignal.any([options.signal,context.controller.signal]):context.controller.signal;
    return deadlineRecoveryContext.run(context,()=>Promise.resolve()
      .then(()=>this._cleanupListingReady({...options,signal,force:options.force??true}))
      .then(()=>{context.abortOnListingFailure=true;return this.sandboxDeadlines.pruneStatuses?.({signal});})
      .then(()=>this.cleanupJournal.reap({...options,signal}))
      .then(report=>{if(context.listingFailure)throw context.cause;return report;}))
      // An owner-asked cleanup shows its result at once; the idle timer's pass keeps the snapshot (it is at most 15 s old anyway).
      .finally(()=>{if(options.force!==false)this._cleanupDisplay=null;});
  }

  // This is an abandonment delay, not a daemon-side maximum create time.
  // Cleanup can release data only after a durable fence takes over late names.
  _oldAbsentCreate(row) {
    return row.create==='dispatched'&&row.compute_created===false&&row.create_settled!==true&&
      Number.isFinite(row.absent_since)&&this._now()-row.absent_since>=CREATE_CESSATION_BOUND_MS();
  }

  // Veto every process referencing this physical name, regardless of owner.
  // The guard carries the name in its payload too, so only create/run clients
  // count here. An incomplete process inventory is never an absence proof.
  async _createClientAbsent(row) {
    try {
      const result=await this._legacyDaemonOptions.runProcessCommand('/bin/ps',['-ww','-axo','pid,ppid,command'],
        {env:{LC_ALL:'C'},timeout:PREFLIGHT_COMMAND_TIMEOUT_MS});
      if(result?.code!==0||!completeSbxListing(result))return false;
      const text=String(result.stdout??'');
      if(!text.endsWith('\n'))return false;
      const lines=text.trimEnd().split('\n');
      if(!/^\s*PID\s+PPID\s+COMMAND\s*$/.test(lines.shift())||!lines.length)return false;
      for(const line of lines) {
        const match=/^\s*\d+\s+\d+\s+(\S.*)$/.exec(line);
        if(!match)return false;
        if(match[1].includes(row.sandbox_id)&&/\s(?:create|run)(?:\s|$)/.test(match[1]))return false;
      }
      return true;
    }catch{return false;}
  }

  async _reapAbandonedCreates(rows,{signal}={}) {
    // A definitively refused create cannot materialize later. Its permanent
    // name fence remains, but needs no daemon inventory after cleanup finished.
    rows=rows.filter(row=>row.create_refused!==true||row.cleanup_pending===true);
    if(!rows.length)return {removed:true};
    const result=await this._rowRun(rows[0],['ls','--json'],{signal});
    const names=parseSbxListing(result);
    if(!names||!completeSbxListing(result))return {removed:false};
    let removed=true;
    for(const row of rows) {
      signal?.throwIfAborted();
      // A live row retries its own compute on every pass; the late-name sweep
      // handles closed or stopped rows, including policy-only retry backoff.
      const current=this.cleanupJournal.authority?.(row);
      if(current&&current.compute_stopped!==true)continue;
      const present=names.includes(row.sandbox_id);
      if(!this._rowHomeMatches(row)){removed=false;continue;}
      if(!present&&row.cleanup_pending!==true)continue;
      let owner,computeGone=!present;
      try {
        owner=acquireRecordOwner({directory:watchProofDirectory(row.sbx_home),name:row.sandbox_id,role:'app',binding:{create_incarnation:row._cleanupId}});
        const run=(args)=>this._rowRun(row,args,{signal});
        owner.assertCurrent();
        if(present) {
          if(!this.cleanupJournal.markAbandoned(row,true,{computeMayRun:true})){removed=false;continue;}
          owner.assertCurrent();
          await run(['rm','--force',row.sandbox_id]);
          const after=await run(['ls','--json']),namesAfter=parseSbxListing(after);
          owner.assertCurrent();
          if(!completeSbxListing(after)||namesAfter===null||namesAfter.includes(row.sandbox_id)){removed=false;continue;}
          computeGone=true;
        }
        owner.assertCurrent();
        this.cleanupJournal.markAbandoned(row,true,{computeMayRun:false});
        const github=await removeSandboxGitHub(run,row.sandbox_id);
        owner.assertCurrent();
        const policy=await removeSandboxPolicies(run,row.sandbox_id,{}, {leaveKit:row.retired_name===true});
        owner.assertCurrent();
        if(github&&policy)this.cleanupJournal.markAbandoned(row,false);
      }catch(error){if(!computeGone)removed=false;if(signal?.aborted)throw error;}
      finally{owner?.release();}
    }
    return {removed};
  }

  // Resolve an old hand-off under the proof owner lock. A never-created
  // sandbox can release resources only after a permanent late-name fence;
  // materialized compute still requires its bound present-then-absent proof.
  async _resolveAdoptedWatch(row,{signal}={}) {
    if(!this._rowHomeMatches(row))return {};
    if(row.compute_stopped===true&&!this.cleanupJournal.nameReserved?.(row))return {watching:true};
    const proofs=watchProofStore({home:row.sbx_home,owner:row.owner_scope});
    if(this.cleanupJournal.nameReserved?.(row)&&(row.compute_stopped===true||this._oldAbsentCreate(row)||proofs.gone(row))){
      let owner;
      try {
        owner=proofs.own(row,{role:'app'});
        const listed=await this._rowRun(row,['ls','--json'],{signal}),names=parseSbxListing(listed);
        owner.assertCurrent();
        if(names!==null&&completeSbxListing(listed)&&!names.includes(row.sandbox_id)){
          if(this._oldAbsentCreate(row))this.cleanupJournal.abandon?.(row);
          this.cleanupJournal.retireName(row);
          await this._finishDestroy(row,true,{signal,recordOwner:owner});return {};
        }
      }catch(error){if(error?.code==='lock_busy'||error?.code==='owner_lost')return {watching:true};throw error;}
      finally{owner?.release();}
    }
    if(!proofs.gone(row)) {
      let tenure;
      try{tenure=proofs.own(row,{role:'app'});}
      catch{return {watching:true};} // Another owner holds the record, or its ownership cannot be read.
      try {
        // Each listing is stamped before it starts, so one that arrives late cannot undo a later sighting. One listing of the
        // record is in flight at a time.
        const look=async()=>{
          const end=tenure.beginListing();
          try {
            const listedAt=await proofs.stamp(),listed=await this._rowRun(row,['ls','--json'],{signal}),names=parseSbxListing(listed);
            if(!names||!completeSbxListing(listed))return null;
            const here=names.includes(row.sandbox_id);
            await proofs.observe(row,here,{listedAt,tenure});
            return here;
          }finally{end();}
        };
        const here=await look();
        if(here===null)return {watching:true};
        if(!here&&!Number.isFinite(row.absent_since)) {
          const since=this._now();
          if(!this.cleanupJournal.mark(row,{absent_since:since}))return {watching:true};
          row={...row,absent_since:since};
        }
        if(!here&&(this.cleanupJournal.abandoned?.(row)===true||this._oldAbsentCreate(row))&&this.cleanupJournal.abandon?.(row)===true) {
          await this._finishDestroy(row,true,{signal,recordOwner:tenure});
          return {};
        }
        if(here) {
          const reserved=this.cleanupJournal.nameReserved?.(row)===true;
          if(!proofs.mayRemove(row)&&!reserved)return {watching:true,unknown:'present_without_receipt'};
          if(reserved&&!this.cleanupJournal.retireName(row,{computeMayRun:true}))return {watching:true};
          // The first listing was taken before this check: look again as the owner, then remove under the same tenure.
          const still=await look();
          if(still) {
            tenure.assertCurrent();
            await this._rowRun(row,['rm','--force',row.sandbox_id],{signal});
            tenure.assertCurrent();
            await look();
          }
        }
      }catch(error){if(error?.code==='owner_lost')return {watching:true};throw error;}
      finally{tenure.release();}
    }
    if(!proofs.gone(row))return {watching:true};
    // Scratch, network rules, the GitHub value and the storage reservation are released here; `finish` then closes the row.
    await this._finishDestroy(row,true,{signal});
    return {watching:false};
  }
  deadlineRecoveryHold() { const hold=this._cleanupListingFailure?.hold??this._deadlineRecoveryHold;return ['sbx_daemon_unavailable','daemon_owner_repair_required'].includes(hold?.error_code)?hold:null; }
  deadlineRecoveryPending() { return this._deadlineRecovery!=null; }
  recoverSandboxDeadlines({signal,force=true}={}) {
    const home=sbxHome();
    if(this._deadlineRecoveryHome!==home){this._deadlineRecovery=null;this._deadlineRecoveryReport=null;this._ownedCleanupDebt=[];this._deadlineRecoveryHome=home;}
    if(!this._deadlineRecovery) {
      const context={failure:null,cause:undefined,controller:new AbortController()};
      const workSignal=signal?AbortSignal.any([signal,context.controller.signal]):context.controller.signal;
      const pending=Promise.resolve().then(()=>deadlineRecoveryContext.run(context,async()=>{await this._cleanupListingReady({signal:workSignal,force});context.abortOnListingFailure=true;return daemonJobContext.run({recovery:true},
        // The watcher is resolved only when a row is handed over: resolving it here would read the sandbox owner on every
        // pass, so an unreadable owner would hold all lending even with nothing to hand over.
        ()=>this.cleanupJournal.recoverDeadlines(this.sandboxDeadlines,
          {signal:workSignal,clock:this.deadlineClock,watcher:this._sharedSandboxWatcher&&{acknowledge:row=>this._sharedSandboxWatcher().acknowledge(row)},validateRow:row=>row.sbx_home===home&&this._rowHomeMatches(row)}));}))
        .then(report=>{
          signal?.throwIfAborted();
          if(context.listingFailure)throw context.cause;
          // Row actions retain their own debt. Only service availability and
          // unproven daemon ownership close global admission.
          const settled=row=>row.status==='resolved'||['watching','protected'].includes(row.status)&&row.protected===true;
          const valid=report&&typeof report.complete==='boolean'&&Array.isArray(report.rows)&&report.rows.every(row=>
            row&&typeof row.id==='string'&&row.id.length>0&&['resolved','watching','protected','foreign_locked','failed','in_progress'].includes(row.status)&&
            (row.name===undefined||typeof row.name==='string'&&/^wf-[a-f0-9]{16}$/.test(row.name))&&
            (row.home===undefined||typeof row.home==='string'&&row.home.startsWith('/')&&!/[\0\r\n]/.test(row.home))&&
            (row.protected===undefined||typeof row.protected==='boolean')&&(!['watching','protected'].includes(row.status)||row.protected===true))&&
            (!report.complete||report.rows.every(settled));
          if(report===true?context.failure:report?.fatal||!valid)throw context.cause??false;
          // Cleanup counts are obligations on their own names and slots.
          // An invalidated/older flight cannot clear a newer hold or release an
          // admission waiting on it. Join the current flight, or retry if the
          // proof was invalidated before a replacement flight began.
          if(this._deadlineRecovery!==pending) {
            if(this._deadlineRecovery)return this._deadlineRecovery;
            if(this._deadlineRecoveryHold)throw deadlineRecoveryError(this._deadlineRecoveryHold);
            return this.recoverSandboxDeadlines({signal});
          }
          this._deadlineRecoveryHold=null;this._localCleanupFailure=false;
          this._deadlineRecoveryReport=report===true?{complete:true,rows:[]}:report;
          this._ownedStartupProof=null;
          this._ownedStartupAdmission=null;
          return report;
        }).catch(error=>{
          // Cancellation is still the caller's original abort, not a new
          // diagnostic. It must never clear a hold from an earlier attempt.
          if(signal?.aborted) {
            if(this._deadlineRecovery===pending)this._deadlineRecovery=null;
            throw error;
          }
          let rowCount=null;
          try{rowCount=error?.recovery_hold?.row_count??this.cleanupJournal.status().compute_cleanup_pending;}catch{/* Unreadable journal: count is unknown. */}
          const hold=recoveryHoldFor(context.failure??error,{rowCount,platformName:this._legacyDaemonOptions.platformName});
          const ownsFlight=this._deadlineRecovery===pending;
          if(ownsFlight){this._deadlineRecoveryHold=hold;this._deadlineRecovery=null;this._ownedStartupProof=null;this._ownedStartupAdmission=null;}
          if(!['sbx_daemon_unavailable','daemon_owner_repair_required'].includes(hold.error_code)){
            if(ownsFlight){this._deadlineRecoveryHold=null;this._localCleanupFailure=true;}
            const debt=this.cleanupJournal.obligations?.()??[];
            const report={complete:false,rows:(debt.length?debt:[{id:'journal'}]).map(r=>({id:r.id,status:'failed'}))};
            if(ownsFlight)this._deadlineRecoveryReport=report;return report;
          }
          throw deadlineRecoveryError(hold,{cause:error});
        });
      this._deadlineRecovery=pending;
      // Share concurrent work only. An unresolved row and a live guard must be
      // observed again, never cached as permanent recovery or cessation proof.
      const clear=()=>{if(this._deadlineRecovery===pending)this._deadlineRecovery=null;};
      pending.then(clear,clear);
    }
    return this._deadlineRecovery;
  }
  deadlineTargetDebt(target={}) {
    const home=target.sbx_home??target.home??sbxHome(),name=target.sandbox_id??target.name,id=target._cleanupId??target.id;
    const retired=this.cleanupJournal.retiredTarget?.(name,home);
    return [...this.deadlineRecoveryDebt(),...(this.cleanupJournal.obligations?.()??[]),...(retired?[retired]:[])].filter(row=>id&&row.id===id||name&&row.name===name&&(!row.home||row.home===home));
  }
  deadlineRecoveryDebt() {
    const rows=(this._deadlineRecoveryReport?.rows??[]).filter(row=>!(row.status==='resolved'||['watching','protected'].includes(row.status)&&row.protected===true));
    return [...rows,...(this._ownedCleanupDebt??[]).filter(row=>!rows.some(known=>row.id&&row.id===known.id||row.name&&row.name===known.name&&row.home===known.home))];
  }
  assertDeadlineTargetClear(target) {
    const debt=this.deadlineTargetDebt(target);
    if(debt.length) {
      // Only the original handle's still-owned registration lease can use its
      // own in-progress row. A copied id/name, recovery lease, or old lock is
      // never a fresh admission. Sync managers verify the guard here; async-only
      // managers use recovery's protected-row observation. Final dispatch then
      // rechecks active() and the exact owned binding before launch.
      const row=this.cleanupJournal.admissionAuthority?.(target);
      if(row&&debt.every(item=>item.status==='in_progress'&&item.id===row._cleanupId&&item.name===row.sandbox_id&&item.home===row.sbx_home)&&
        this._rowHomeMatches(row)&&row.deadline_enforcer&&sandboxDeadlineRemaining(row,this.deadlineClock())>0&&(typeof this.sandboxDeadlines.activeSync==='function'?this.sandboxDeadlines.activeSync(row):debt.every(item=>item.protected===true)))return;
    }
    if(debt.length)throw policyError('cessation_unverified','This sandbox name is reserved for cleanup. A different fresh sandbox may proceed.',
      {retryable:true,recovery_scope:'target',target_debt:debt});
  }
  async inspectCleanupRemediation(options) { return this.cleanupJournal.inspectRemediation(options); }
  // DISPLAY ONLY (home, status, readiness, heartbeat blockers): the last cleanup status, up to CLEANUP_DISPLAY_MAX_AGE_MS old, so a
  // poller does not rescan every retired fence on every read. Nothing that admits, claims, reserves, reaps or frees a sandbox may
  // call this: those read the journal fresh (cleanupStatus, obligations, _cleanupView). The snapshot lives in its own field,
  // which no decision path reads.
  cleanupStatusForDisplay() { return structuredClone(this._cleanupDisplayReading().status); }
  // One field of the display reading, so a poller that needs only that field never copies every cleanup row.
  cleanupDisplayField(field) { return structuredClone(this._cleanupDisplayReading().status[field]); }
  // The home summary, projected once per display reading (rows capped, counts exact). Each poll copies only the summary.
  cleanupSummaryForDisplay() {
    const reading=this._cleanupDisplayReading();
    reading.summary??=cleanupStatusSummary(reading.status);
    return structuredClone(reading.summary);
  }
  // The held display reading, refreshed when it is too old or a local journal write happened since. Callers must not change it.
  _cleanupDisplayReading() {
    const held=this._cleanupDisplay,now=this._cleanupDisplayNow?.()??Date.now();
    if(held&&now-held.at>=0&&held.generation===this.cleanupJournal.writeGeneration?.()) {
      if(now-held.at<CLEANUP_DISPLAY_MAX_AGE_MS)return held;
      // Past the display age: when the journal directory is unchanged, keep the reading instead of rereading every row.
      const print=held.fingerprint==null?null:this.cleanupJournal.directoryFingerprint?.();
      if(print!=null&&print===held.fingerprint&&now-held.scannedAt<CLEANUP_DISPLAY_UNCHANGED_MAX_AGE_MS){held.at=now;return held;}
    }
    this.cleanupStatus();
    return this._cleanupDisplay;
  }
  _cleanupDisplayNow() { return Date.now(); }
  // The idle reaper asks this to decide WHETHER to run a pass: true only when a display-age reading shows no journal record, no
  // debt and no recovery or watch state at all. It never decides what a pass does to a row: the pass reads each row fresh under
  // its locks. A reading up to CLEANUP_DISPLAY_MAX_AGE_MS old can delay a pass for new work by at most that long.
  cleanupDisplayIdle() {
    if(this._localCleanupFailure||this._deadlineRecoveryHold||this._cleanupListingFailure)return false;
    const status=this._cleanupDisplayReading().status;
    return status.state==='clear'&&status.records===0&&!status.items?.length&&!status.create_watch&&!status.shared_watch&&
      !status.remediation?.length&&!(status.deadline_recovery&&status.deadline_recovery.complete!==true);
  }
  cleanupStatus(options) {
    const gen=this.cleanupJournal.writeGeneration?.(),print=this.cleanupJournal.directoryFingerprint?.()??null,status=this.cleanupJournal.status(options);status.items=this.cleanupJournal.obligations?.()??[];
    if(this._localCleanupFailure&&!status.items.length)status.items=[{id:'journal',name:null,compute_may_run:true,reason:'cleanup_check_failed'}];
    const report=this._deadlineRecoveryReport;
    if(status.create_watch>0||this._sharedSandboxWatch) {
      try{status.shared_watch=this._sharedSandboxWatcher().status();}
      catch{status.shared_watch={healthy:false,count:status.create_watch??null,listing_failed:false,message:'Shared workspace watcher needs attention.'};}
    }
    if(report){const debt=this.deadlineRecoveryDebt();status.deadline_recovery={complete:report.complete===true&&!debt.length,rows:report.rows,debt};}
    const out=this._legacyScratchRemediation?.length?{...status,remediation:[...(status.remediation??[]),...this._legacyScratchRemediation]}:status;
    // A caller that passed options (onBlocked) wants rows reported to it, so its reading is not a display snapshot.
    if(!options){const at=this._cleanupDisplayNow?.()??Date.now();this._cleanupDisplay={at,scannedAt:at,generation:gen,fingerprint:print,status:structuredClone(out)};}
    return out;
  }

  _invalidateOwnedStartupRecovery() {
    this._ownedAvailabilityAdmission=null;this._ownedAdmissionFlight=null;
    this._deadlineRecovery=null;
    this._verifiedIdentityPolicies = new Map();
    this._ownedStartupGeneration++;
    this._ownedStartupRecovery=null;
    this._ownedStartupProof=null;
    this._ownedStartupAdmission=null;
  }

  isOwnedSandboxProofCurrent(proof) {
    return proof?.removed===true&&proof.sbx_home===sbxHome()&&proof===this._ownedStartupProof&&!this.deadlineRecoveryHold();
  }

  isOwnedSandboxAdmissionCurrent(proof) {
    return proof?.admission_allowed===true&&proof.sbx_home===sbxHome()&&(proof===this._ownedStartupAdmission||proof===this._ownedAvailabilityAdmission)&&!this.deadlineRecoveryHold();
  }

  beginLendingSession({accountKey=null,slot=0}={}) {
    if(this._lenderSessions++===0)this._invalidateOwnedStartupRecovery();
    const session={accountKey,slot,active:true,unproven:new Set(),
      invalidate:()=>this._invalidateOwnedStartupRecovery()};
    const release=()=>{
      if(!session.active)return;
      session.active=false;this._lenderSessions--;
      // A sibling may keep this backend alive. Its cached startup proof predates
      // this session's compute and cannot discharge an unproven shutdown.
      if(session.unproven.size)this._invalidateOwnedStartupRecovery();
    };
    // The lender scopes execute (including nested clone/check prepares) here.
    // Preparations outside that context remain conservatively locked/blocked;
    // they are not exempted as live siblings by a mutable "current lender" guess.
    release.run=callback=>this._lendingContext.run(session,callback);
    return release;
  }

  reconcileOwnedSandboxes({signal}={}) {
    // New-target admission is separate from cessation. Every unresolved old
    // row keeps its own debt and target fence; it cannot become removed proof.
    if(this._ownedStartupHome&&this._ownedStartupHome!==sbxHome())this._invalidateOwnedStartupRecovery();
    if(!this._ownedStartupRecovery) {
      const home=this._ownedStartupHome=sbxHome(),generation=this._ownedStartupGeneration;
      let recoveryReport;
      const flight=daemonJobContext.run({recovery:true},async()=>{
        let report;
        try{report=await this.recoverSandboxDeadlines({signal});}
        catch{recoveryReport=this._deadlineRecoveryReport;return {removed:false,admission_allowed:!this.deadlineRecoveryHold(),cleanup_debt:this.deadlineRecoveryDebt()};}
        recoveryReport=this._deadlineRecoveryReport;
        const debt=(report?.rows??[]).filter(row=>!(row.status==='resolved'||['watching','protected'].includes(row.status)&&row.protected===true));
        // Never send an unresolved/unsafe recovery row through another cleanup
        // route. It remains watched, byte-unchanged, and has no removal proof.
        let proof;
        try {
          proof=await this.cleanupJournal.reconcileOwned({
            signal,validateRow:row=>this._rowHomeMatches(row),deferredIds:new Set(debt.map(row=>row.id)),
            inventory:async rows=>{
              if(!rows.length)return parseSbxListing(await this._rowRun({sbx_home:home},['ls','--json'],{signal}));
              for(const row of rows)assertSbxRuntime(this._cleanupRuntime(row,sbxChildEnv(),{recorded:true}),{signal,env:sbxChildEnv()});
              return parseSbxListing(await this._rowRun(rows[0],['ls','--json'],{signal}));
            },
          });
          if(proof?.fatal||!proof||typeof proof.removed!=='boolean')throw false;
        }catch(error) {
          if(signal?.aborted)throw error;
          this._deadlineRecoveryHold=recoveryHoldFor(error,{platformName:this._legacyDaemonOptions.platformName});
          return {removed:false,admission_allowed:!this.deadlineRecoveryHold(),cleanup_debt:debt};
        }
        // A watched name is shown to the owner but is not a block: the shared watcher already holds that name and keeps it fenced.
        const extraDebt=(proof.remediation??[]).filter(row=>row.watched!==true&&(row.name||!debt.length)&&!debt.some(known=>row.name&&row.name===known.name))
          .map(row=>({...row,home:row.home??home,status:'failed'}));
        this._ownedCleanupDebt=extraDebt;
        const cleanupDebt=[...debt,...extraDebt];
        return {...proof,removed:proof.removed===true&&!cleanupDebt.length,admission_allowed:true,cleanup_debt:cleanupDebt};
      }).then(proof=>{
        if(signal?.aborted||generation!==this._ownedStartupGeneration||recoveryReport!==this._deadlineRecoveryReport||this.deadlineRecoveryHold())
          return {...proof,removed:false,admission_allowed:false};
        proof={...proof,sbx_home:home};
        this._ownedStartupProof=proof.removed===true?proof:null;
        this._ownedStartupAdmission=proof.admission_allowed===true?proof:null;
        return proof;
      });
      this._ownedStartupRecovery=flight;
      // Recheck the per-row set every time; a current admission token is not a
      // cached claim that all previous compute has ceased or is protected.
      const clear=()=>{if(this._ownedStartupRecovery===flight)this._ownedStartupRecovery=null;};
      flight.then(clear,clear);
    }
    return this._ownedStartupRecovery;
  }

  /**
   * Repair service updates while idle, then read and repair the owned network policy.
   * Shared-home updates need confirmation. An unreadable policy is never overwritten.
   */
  async waitForHealth({signal}={}){
    signal?.throwIfAborted();
    if(!this._healthRecovery)return;
    let abort;
    try {await Promise.race([this._healthRecovery.catch(()=>{}),new Promise((_,reject)=>{
      abort=()=>reject(signal.reason);signal?.addEventListener('abort',abort,{once:true});
    })]);} finally {signal?.removeEventListener('abort',abort);}
  }

  // A test harness can keep its scratch records apart from another app on the same sandbox home.
  _scratchJournalPath() { return this._scratchJournal ?? path.join(sbxHome(), 'scratch-journal'); }

  recoverHealth(options = {}) {
    if(this.autoRepair===false)return Promise.resolve({recovered:false});
    if(this._healthRecovery)return options.confirmedRestart||options.confirmedPolicy||options.confirmedInit
      ? this._healthRecovery.catch(()=>{}).then(()=>this.recoverHealth(options)) : this._healthRecovery;
    const timeout=AbortSignal.timeout(options.commandTimeoutMs??PREFLIGHT_COMMAND_TIMEOUT_MS);
    const signal=options.signal?AbortSignal.any([options.signal,timeout]):timeout;
    this._healthRecovery = this._recoverHealth({...options,signal}).finally(()=>{this._healthRecovery=null;});
    return this._healthRecovery;
  }

  _applyRepairState(preflight) {
    for(const [name,state] of this._repairState) {
      const current=namedCheck(preflight,name);
      if(current?.ok||state.version!==preflight.version){this._repairState.delete(name);continue;}
      replacePreflightCheck(preflight,name,state.check);
    }
    return preflight;
  }

  /**
   * `sbx create` refused with Docker's "not signed in" while the sandbox listing worked. Each refusal is a new epoch. The
   * mark fails docker_login with the sign-in remedy and only a create that was dispatched after the latest refusal and
   * was accepted clears it, as does a completed owner login for the same epoch. Listings and `sbx diagnose` never clear it. Every change drops cached readings
   * and moves `signInGeneration`, so readers above this class can drop theirs. Holds no output from sbx.
   */
  _refreshSignInRefusal() {
    if (this._signInStateHome !== sbxHome()) {
      this._signInState = createDockerSignInState({home:this._profileHome, sbxHome:sbxHome()});
      this._signInStateHome = sbxHome();
    }
    const current = this._signInState.read();
    if (current?.epoch !== this._signInRefusal?.epoch || current?.error !== this._signInRefusal?.error) {
      this._signInRefusal = current;
      this._invalidateSignIn();
    }
    return current;
  }

  _invalidateSignIn() {
    this.signInGeneration++;
    this.preflightGeneration++;
    this.preflightCache = null;
    this._observationCache = null;
  }

  _noteCreateAccepted() {
    const first = this._createAcceptedAt === null;
    this._createAcceptedAt = Date.now();
    if (first) this._invalidateSignIn();
  }

  _setSignInRefusal(on, expectedEpoch = this._signInRefusal?.epoch) {
    this._refreshSignInRefusal();
    if (on) this._createAcceptedAt = null;
    try {
      this._signInRefusal = on ? this._signInState.refuse() : this._signInState.clear(expectedEpoch);
    } catch {
      // Persistence failure remains a distinct fail-closed blocker, never raw filesystem output.
      this._signInRefusal = this._signInState.read();
    }
    this._refusalEpoch++;
    this._invalidateSignIn();
  }

  signInRefused() { return this._refreshSignInRefusal() !== null; }
  dockerSignInBlocker() {
    const state = this._refreshSignInRefusal();
    return state ? (state.error ? dockerSignInStateError() : dockerSignedOutError()) : null;
  }
  _assertCreateSignIn() {
    const blocker = this.dockerSignInBlocker();
    if (blocker && (blocker.code === DOCKER_SIGNIN_STATE_UNAVAILABLE || !this._signInRecoveryContext.getStore())) throw blocker;
  }
  signInConfirming() { return this._recovery !== null && this._recovery !== undefined; }
  signInRefusalEpoch() { return this._refreshSignInRefusal()?.epoch ?? null; }
  confirmDockerSignIn(epoch) {
    if (epoch !== null && epoch !== undefined) this._setSignInRefusal(false, epoch);
    return !this.signInRefused();
  }

  /** The same bounded check and single flight as recoverSignIn, without an earlier refusal: a sign-in that finished with no create to back it. */
  confirmSignIn() {
    const flight = this.recoverSignIn({ force: true });
    // Rows read while the check runs say so, and rows read after it say what it found.
    this._invalidateSignIn();
    flight.finally(() => this._invalidateSignIn()).catch(() => {});
    return flight;
  }

  /**
   * One bounded explicit create: the app's own throwaway check sandbox. An accepted create clears the refusal. The single
   * flight is owned until the check and its cleanup finish; the deadline reaches the queue, storage and prepare, so a
   * timeout never leaves a second check behind it.
   */
  recoverSignIn({ force = false } = {}) {
    if (!force && !this.signInRefused()) return Promise.resolve(null);
    if (this._recovery) return this._recovery;
    const stop = new AbortController();
    const timer = this.deadlineTimers.setTimeout(() => stop.abort(policyError('wall_timeout', 'The Docker sign-in check timed out.')), SIGN_IN_RECOVERY_MS);
    timer?.unref?.();
    this._recovery = this.testWorkspace({ signal: stop.signal }).catch(() => stop.signal.aborted ? workspaceFailure(stop.signal.reason) : null)
      .finally(() => { this.deadlineTimers.clearTimeout(timer); this._recovery = null; });
    return this._recovery;
  }

  _applySignInRefusal(preflight) {
    const observedLogin = namedCheck(preflight, 'docker_login');
    if (observedLogin?.ok === false && dockerSessionRefused(observedLogin.diagnostics) && !this.signInRefused())
      this._setSignInRefusal(true);
    if (!this.signInRefused()) {
      const login = namedCheck(preflight, 'docker_login');
      // A working listing proves nothing. Docker's acceptance of a create proves that sandboxes start, not which account
      // is signed in: a store with no account can still create. The row says exactly that and no more.
      if (this._createAcceptedAt !== null && login?.ok === true)
        return replacePreflightCheck(preflight, 'docker_login', {createAccepted: true, detail: "Docker accepted Faravan's request to start a test workspace."});
      return this.signInConfirming() && login?.ok === true ? replacePreflightCheck(preflight, 'docker_login', {checking: true}) : preflight;
    }
    const row = namedCheck(preflight, 'docker_login');
    // A sleeping host keeps its existing recovery instruction rather than becoming signed out.
    if (!row || row.cause === 'docker_signin_refresh_unavailable') return preflight;
    const unavailable = Boolean(this._signInRefusal.error);
    delete row.unknown;
    return replacePreflightCheck(preflight,'docker_login',{ok:false,signinVerified:false,
      cause:unavailable ? 'docker_signin_state_unavailable' : DOCKER_SIGNED_OUT,
      detail:unavailable ? 'Docker sign-in state could not be saved or read.' : DOCKER_SIGNED_OUT_MESSAGE,
      fix:unavailable ? 'Check access to the app data folder, then restart Faravan.' : 'Open Faravan and select Sign in to Docker.',diagnostics:''});
  }

  _rememberRepairState(preflight) {
    for(const check of preflight.checks){
      if(check.repair)this._repairState.set(check.name,{version:preflight.version,check});
      else this._repairState.delete(check.name);
    }
    return preflight;
  }

  async _recoverHealth(options) {
    const evidence=this._diagnosticsFor(options);
    if(options.observation) options={...options,diagnosticResult:evidence?.result,diagnosticsObservedAt:evidence?.at};
    if(options.observation&&!options.diagnosticResult)return {preflight:{checks:[]},recovered:false};
    const {jobRunning:unusedJob,confirmedRestart,confirmedPolicy,confirmedInit,inspectSandboxes,diagnosticResult,diagnosticsObservedAt,...observationOptions}=options;
    let preflight=this._applyRepairState(options.observation
      ? (await this.lenderCapabilities({...observationOptions,idle:options.idle??true})).preflight
      : await probeSbxPreflight(options));
    let restarted = false;
    const finish=(recovered=false)=>{
      if(options.signal?.reason?.name==='TimeoutError') {
        preflight=replacePreflightCheck(preflight,'sbx_daemon',{ok:false,automatic:true,repair:'retry',
          detail:'The sandbox service check timed out. Check again to retry.',fix:'Check again'});
        recovered=false;
      }
      return {preflight:this._rememberRepairState(preflight),recovered,...(restarted?{restarted:true}:{})};
    };
    if(options.observation&&this._diagnosticEvidence?.version!==preflight.version)return finish();
    if(namedCheck(preflight,'sbx_version')?.ok===false)return finish();
    if(preflight.checks.some(c=>c.repair==='support'))return finish();
    const jobRunning=()=>options.jobRunning?.()===true||this.credentialWriterBusy?.()===true||this._preparing>0||this._diskSentries.size>0;
    const update=namedCheck(preflight,'sbx_daemon')?.cause==='daemon_restart_required';
    if(update) {
      if(!usesDefaultSbxHome()&&!options.confirmedRestart)return finish();
      const runCommand=options.runCommand??runPreflightCommand;
      const inspectSandboxes=options.inspectSandboxes??defaultInspectSandboxes(runCommand);
      const inspectDaemons=options.inspectDaemons??defaultInspectDaemons(runCommand);
      const sandboxes=await Promise.resolve().then(inspectSandboxes).catch(()=>null);
      const daemons=await Promise.resolve().then(inspectDaemons).catch(()=>null);
      const restart=await restartSbxDaemon({...options,profileHome:this._profileHome,runCommand,daemons,sandboxes,update:true,jobRunning,inspectSandboxes});
      if(!restart.ok) {
        const waiting=/waiting for|sandbox is running/i.test(restart.detail);
        preflight=restart.requiresConfirmation
          ? replacePreflightCheck(preflight,'sbx_daemon',{detail:restart.detail,automatic:false,repair:'restart_confirm',fix:'Restart Docker Sandboxes'})
          : restart.status==='daemon_owner_repair_required' ? replacePreflightCheck(preflight,'sbx_daemon',{detail:restart.detail,automatic:false,repair:restart.repair,fix:restart.fix||(restart.repair==='owner_repair'?'faravan sandbox repair-owner --yes':'')})
          : waiting ? replacePreflightCheck(preflight,'sbx_daemon',{detail:restart.detail})
          : repairFailure(preflight,'sbx_daemon','restart the sandbox service',{stderr:restart.diagnostics});
        return finish();
      }
      restarted = true;
      this._verifiedIdentityPolicies = new Map();
      preflight=await probeSbxPreflight(options);
      if(namedCheck(preflight,'sbx_daemon')?.cause==='daemon_restart_required') {
        preflight=repairFailure(preflight,'sbx_daemon','finish the sandbox service update',{});return finish();
      }
    }
    if(namedCheck(preflight,'sbx_version')?.ok!==true||namedCheck(preflight,'sbx_credential_store')?.ok===false)return finish();
    let recovered=update;
    if(daemonNeedsStart(namedCheck(preflight,'sbx_daemon'))) {
      if(jobRunning())return finish();
      const started=await startSbxDaemon(options);
      if(started.code!==0){
        preflight=started.status==='daemon_owner_repair_required'
          ? replacePreflightCheck(preflight,'sbx_daemon',{ok:false,detail:started.stderr,automatic:false,repair:'owner_repair',fix:'faravan sandbox repair-owner --yes'})
          : started.status==='systemd_manager_degraded' ? replacePreflightCheck(preflight,'sbx_daemon',{ok:false,detail:started.stderr,automatic:false,fix:'Check again'})
          : repairFailure(preflight,'sbx_daemon','start the sandbox service',started);
        return finish();
      }
      this._verifiedIdentityPolicies = new Map();
      preflight=await probeSbxPreflight(options);recovered=namedCheck(preflight,'sbx_daemon')?.ok===true;
      if(!recovered)return finish();
    }
    const policy=await repairNetworkPolicy(preflight,{...options,jobRunning});
    preflight=policy.preflight;
    return finish(recovered||policy.recovered);
  }

  /** Deletes added Claude account values that no account names, under the lock `accounts add` publishes under.
   * A home with no generations has nothing to sweep; a busy lock skips the sweep until the next start. */
  async removeOrphanClaudeAccounts() {
    const home=sbxHome();
    if(!existsSync(path.join(home,'credential-generations')))return [];
    return withCredentialPreparation(home,()=>removeOrphanClaudeGenerations(home),{isolatedSources:true,lockWaitMs:0});
  }

  /** Supplies the Faravan sign-in that lent Claude jobs run on: {lease({wallSeconds}), report(code|null)}. */
  setLentClaudeCredential(provider) { this._lentClaude = provider; }
  setLentCodexCredential(provider) { this._lentCodex = provider; }

  /** What a scoped check is valid for: a new sbx or a changed shipped mixin needs a new check. */
  async claudeAccountRuntime({runtime:qualified,beforeSpawn}={}) {
    const binary=qualified?.binary??claudeBinaryIdentity();
    const kitDigest=qualified?.kitDigest??await claudeKitDigest();
    const runtime={binary,kitDigest};
    const boundary=()=>{
      beforeSpawn?.();
      if(!claudeRuntimeFenceHolds(runtime))throw policyError('claude_account_unavailable','Docker Sandboxes changed. Retry the scoped sign-in check.');
    };
    const version=await this.runSbx(['version'],{binary:binary.path,beforeSpawn:boundary});
    if(version.code!==0)throw policyError('claude_account_unavailable', 'Docker Sandboxes version could not be checked.');
    boundary();
    return {...runtime,version:version.stdout.trim()};
  }

  /** A lent job's scoped value must be the one that answers: control value 401, real value 200. Anything else starts no job. */
  async _verifyScopedValue(handle,lent,report,{url,headers,control,push}) {
    const ask=async()=>{
      const result=await this._runJobCommand(handle,['exec',handle.sandbox_id,'--','curl','-sS','--max-time','30','-o','/dev/null','-w','%{http_code}',
        ...headers.flatMap(header=>['-H',header]),url]);
      return result.code===0?Number(result.stdout.trim())||0:0;
    };
    let outcome;
    try {
      await push(control);const controlStatus=await ask();
      if(controlStatus===200)outcome=claudeCheckOutcome(200,200);
      else {await push(lent.value);outcome=claudeCheckOutcome(await ask(),controlStatus);}
    } catch(error) {report(error?.code??'claude_account_unavailable');throw error;}
    finally {lent.value=undefined;}
    if(!outcome.ok){
      report('claude_account_unavailable');
      throw policyError('claude_account_unavailable','The scoped sign-in was not the one that answered ('+outcome.reason+').');
    }
    report(null);
    handle._execution??={};
    Object.assign(handle._execution,{scoped_check:'account_200_control_401',token_lifetime_seconds:lent.lifetimeSeconds??null,scoped_generation:lent.generation??null});
  }

  async checkClaudeAccount(accountKey,{signal}={}) {
    const {buildValidatedJobSpec}=await import('./executor.mjs');
    const {getHarnessAdapter}=await import('./harnesses/index.mjs');
    const id=accountIdOfKey(accountKey);
    if(!id || !accountKey.startsWith('claude:'))throw policyError('claude_account_unavailable', 'Choose an additional Claude account.');
    const account=await readClaudeAccount(sbxHome(),id),runtime=await this.claudeAccountRuntime();
    // Nothing may pass on the old answer while the check runs.
    const checkOp=await beginClaudeAccountCheck(sbxHome(),account);
    // One fresh sandbox per probe: the account's value, then (only after a 200) a control value on the same route.
    const probe=async mode=>{
      const job=buildValidatedJobSpec({taskDigest:randomUUID().replaceAll('-','').repeat(2),
        harness:getHarnessAdapter('claude-code-subscription').lendingSpec,executionScope:'borrowed',entrypointWithPrompt:'true',network:'disabled',
        resources:{cpu:1,memory_mib:512,storage_mib:512,wall_seconds:180,output_bytes:16384,network_bytes:1048576,max_processes:32}});
      let handle,status=0,clean=false;
      try {
        handle=await this.prepare(job,{signal,accountKey,accountSelfCheck:mode,accountRuntime:runtime});
        const result=await this._runJobCommand(handle,['exec',handle.sandbox_id,'--','curl','-sS','--max-time','30','-o','/dev/null','-w','%{http_code}',
          '-H','anthropic-version: 2023-06-01','https://api.anthropic.com/v1/models']);
        if(result.code===0)status=Number(result.stdout.trim());
      } finally {
        if(handle){const result=await this.destroy(handle);clean=result.removed&&result.policy_removed&&result.scratch_removed;}
      }
      return clean?status:0;
    };
    let status=0,controlStatus=0,written=false,checkError;
    try {
      status=await probe('account');
      if(status===200)controlStatus=await probe('control');
    } catch(error) {checkError=error;} finally {
      written=await recordClaudeAccountCheck(sbxHome(),account,{...runtime,status,controlStatus},checkOp);
    }
    // A newer check owns the record now. This answer may be stale, so it never enables the account.
    if(!written)return {...claudeCheckSuperseded(),status,controlStatus};
    if(checkError)throw checkError;
    return {...claudeCheckOutcome(status,controlStatus),status,controlStatus};
  }

  /** Exercise the actual job path without running a model or signing in. */
  testWorkspace(options = {}) {
    return this.withSandboxCheck(() => this._signInRecoveryContext.run(true, () => this._testWorkspace(options)), { signal: options.signal });
  }

  async _testWorkspace({ version, harnessName, signal } = {}) {
    const { buildValidatedJobSpec, resolveHarness } = await import('./executor.mjs');
    const { DEFAULT_IDENTITY_PROBE_HARNESSES } = await import('./harnesses/index.mjs');
    // Not enough room to start: report the disk shortage before creating a sandbox.
    const diskWaits = createDiskWait({ hostDisk: () => this.hostDisk });
    const lowDisk = await abortable(diskWaits.check(), signal);
    if (lowDisk) return { ok: false, cause: 'disk_wait', detail: lowDisk.copy, fix: 'Free disk space, then run Faravan doctor again.', diagnostics: '' };
    const bounded = await abortable(this.storage.supported?.(version), signal);
    signal?.throwIfAborted();
    const job = buildValidatedJobSpec({
      taskDigest: randomUUID().replaceAll('-', '').repeat(2),
      harness: resolveHarness(harnessName ?? DEFAULT_IDENTITY_PROBE_HARNESSES[0]),
      entrypointWithPrompt: 'true', network: 'disabled',
      resources: { cpu: 1, memory_mib: 512, storage_mib: bounded ? 8192 : 512,
        wall_seconds: 60, output_bytes: 16384, network_bytes: 1, max_processes: 16 },
    });
    if (bounded) job.required_limits = [...ENFORCED_LIMITS, 'guest_block_device_capacity'];
    let handle, cleanup, failure, witness;
    try {
      handle = await this.prepare(job, { signal, separatePreparationClock: true, egressWitness: true });
      signal?.throwIfAborted();
      witness = handle._egressWitness;
      await this.start(handle, { signal });
      signal?.throwIfAborted();
    } catch (error) {
      failure = workspaceFailure(error, version);
      if (failure.cause === 'disk_full') failure = { ...failure, detail: (await diskWaits.fault()).copy, fix: 'Free disk space, then run Faravan doctor again.' };
      cleanup = error.cleanup_receipt;
    } finally {
      try {
        // A failed prepare already resolved its own record through its create
        // receipt. Without a receipt there is nothing this check may remove.
        if (handle) cleanup = await this.destroy(handle);
        if (cleanup && (cleanup.removed !== true || cleanup.scratch_removed === false))
          failure = cleanupUnverified(failure, 'Test workspace cleanup could not be verified.');
      } catch (error) {
        failure = cleanupUnverified(failure, String(error?.message || error));
      }
    }
    if (!failure && signal?.aborted) failure = workspaceFailure(signal.reason, version);
    return failure || { ok: true, cause: null,
      detail: 'Faravan started and removed a test workspace.', fix: '', diagnostics: '', ...(witness ? { egress_witness: witness } : {}) };
  }

  /** Free space on every filesystem a job writes to. A failed read fails closed. */
  async _hostDiskCheck() {
    let reading;
    try { reading = validateHostDiskReading(await this.hostDisk.free()); }
    catch (error) {
      return { ...check('host_disk', false, hostDiskUnreadable(error),
        'Check access to the named filesystem, then choose Check again.'), reason: 'host_disk_unreadable' };
    }
    const ok = reading.free >= HOST_DISK_HEADROOM_BYTES;
    const gib = (reading.free / 1024 ** 3).toFixed(1);
    return { ...check('host_disk', ok,
      ok ? `${Number.isFinite(reading.free) ? gib + ' GiB free.' : 'No disk-backed volumes.'} Faravan watches free disk space and stops a lent job when it runs low.` : hostDiskLow(reading),
      ok ? '' : 'Free up disk space on the named filesystem, then choose Check again.'), reason: ok ? null : 'host_disk_low' };
  }

  /**
   * Read-only evidence, never the repairing probeCapabilities path. Background callers use observation;
   * a job's readiness recheck always probes. `cached` alone retains the legacy full-preflight cache.
   */
  invalidateLendingCapabilities(){
    this.preflightGeneration++;
    this.preflightCache=null;
    this._observationCache=null;
  }

  async lenderCapabilities({ cached = false, ...options } = {}) {
    if(options.observation&&!options.observationBatch)return this.observeCapabilities(options);
    const {observationBatch,...probeInput}=options;
    const binaryKey=[sbxBinaryIdentity(options.env),options.runCommand];
    if(!this._binaryReadKey?.every((part,i)=>part===binaryKey[i])){
      this._binaryReadKey=binaryKey;this._binaryReads=new Map();
    }
    const scope=this._diagnosticScope(options);
    const scopeCurrent=()=>{const current=this._diagnosticScope(options);return scope.every((part,i)=>part===current[i]);};
    let generation = this.preflightGeneration;
    const invalidated = () => generation !== this.preflightGeneration;
    const invalidate = () => {
      generation = ++this.preflightGeneration;
      this.preflightCache = null;
    };
    const evidence=this._diagnosticsFor(options);
    const probeOptions={...probeInput,binaryReads:this._binaryReads,...(options.observation?{diagnosticResult:evidence?.result,diagnosticsObservedAt:evidence?.at}:{})};
    const preflight = cached && !options.observation ? await this.cachedPreflight(probeOptions) : await probeSbxPreflight(probeOptions);
    if(!options.observation&&scopeCurrent()){
      const current=this._diagnosticsFor(options);
      // Actual diagnostics order independently of unrelated preflight failures. Cache hits and skipped diagnoses add no evidence.
      if(preflight._diagnosticExecuted&&!preflight.cached&&preflight._diagnosticSequence>(current?.sequence??0))
        this._diagnosticEvidence={result:preflight._diagnosticResult,at:preflight.diagnostics_observed_at,version:preflight.version,scope,sequence:preflight._diagnosticSequence};
      else if(!preflight._diagnosticExecuted)this._diagnosticEvidence=current;
    }
    else if(options.observation && this._diagnosticEvidence&&this._diagnosticEvidence.version!==preflight.version) {
      preflight.checks.push(check('sbx_diagnostics',false,'Sandbox diagnostics are from another version.','Choose Check again.'));
      preflight.ok=false;
    }
    // Retry obsolete successes, never failed results: failures already fail closed.
    if (preflight.ok === true && (invalidated()||!scopeCurrent())) return this.lenderCapabilities({ cached:false, ...options });
    this._applyRepairState(preflight);
    this._applySignInRefusal(preflight);
    const versionGate = preflight.checks.find(entry => entry.name === 'sbx_version');
    const versionKnown = versionGate?.ok === true && /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/.test(preflight.version || '');
    // Every failure supersedes older evidence, including cache-bypassing calls.
    // Remember our own generation so it cannot cause a retry loop.
    if (preflight.ok !== true || !versionKnown) invalidate();
    const storage = versionKnown && await this.storage.available(preflight.version);
    const disk = await this._hostDiskCheck();
    if (!disk.ok) invalidate();
    // Refresh durable sign-in evidence after storage/disk awaits, including other backend instances.
    this._applySignInRefusal(preflight);
    // Fence every successful report after all awaits, including fresh job rechecks.
    if (preflight.ok === true && versionKnown && disk.ok && (invalidated()||!scopeCurrent())) return this.lenderCapabilities({ cached:false, ...options });
    preflight.checks.push(disk);
    return { available: preflight.ok === true && versionKnown && disk.ok, reason: disk.reason, backend_id: BACKEND_ID,
      guest_block_device_capacity: storage, host_storage_protection: false,
      capabilities: ['verify_v1'], pinned_git: true, egress: ['internet', 'provider-only'],
      enforced_limits: Object.keys(V1_LIMIT_NAMES).filter(key => ENFORCED_LIMITS.includes(V1_LIMIT_NAMES[key])),
      max_limits: { ...V1_MAX_LIMITS }, preflight };
  }

  _diagnosticScope(options) {
    return [sbxBinaryIdentity(options.env),sbxHome(),daemonLifecycleGeneration,options.sbxHomePath,options.userHome,
      options.platformName??process.platform,JSON.stringify(options.env),options.runCommand];
  }

  _diagnosticsFor(options) {
    const evidence=this._diagnosticEvidence, scope=this._diagnosticScope(options);
    return evidence?.scope?.every((part,i)=>part===scope[i])?evidence:null;
  }

  // Background callers share only observations. Admission and removal never use this cache.
  async observeCapabilities({idle=false,signal,...options}={}) {
    signal?.throwIfAborted();
    const currentKey=()=>{
      this._refreshSignInRefusal();
      return [sbxBinaryIdentity(options.env),sbxHome(),daemonLifecycleGeneration,this.preflightGeneration,this._diagnosticEvidence,
        ...Object.keys(options).sort().flatMap(name=>[name,name==='env'?JSON.stringify(options[name]):options[name]])];
    };
    const key=currentKey();
    let entry=this._observationCache;
    const matches=entry&&entry.key.length===key.length&&entry.key.every((part,i)=>part===key[i]);
    const ttl=entry?.result?.available===true&&idle?60000:15000;
    const reused=matches&&(entry.pending||this.monotonic()-entry.started<ttl);
    if(!reused){
      entry={key,started:this.monotonic(),pending:true,result:null};
      this._observationCache=entry;
      const batch={};
      entry.probe=observationDaemonContext.run(batch,()=>this.lenderCapabilities({...options,observation:true,observationBatch:true})).then(result=>{
        entry.result=result;
        // A failed batch advances the failure fence; its own cooldown still applies.
        if(!result.available)entry.key[3]=this.preflightGeneration;
        return result;
      }).catch(error=>{entry.key[3]=this.preflightGeneration;throw error;}).finally(()=>{entry.pending=false;batch.proof=null;});
      // Retain rejected probes for the same cooldown too.
      entry.probe.catch(()=>{});
    }
    let abort;
    const aborted=signal&&new Promise((resolve,reject)=>{
      abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
    });
    let report;
    try {report=structuredClone(await (aborted?Promise.race([entry.probe,aborted]):entry.probe));}
    finally {if(abort)signal.removeEventListener('abort',abort);}
    const consumedKey=[...entry.key];
    const stillCurrent=()=>{const current=currentKey();return consumedKey.length===current.length&&consumedKey.every((part,i)=>part===current[i]);};
    if(report.available&&!stillCurrent())return this.observeCapabilities({idle,signal,...options});
    report.preflight.cached=Boolean(reused);
    // Local disk safety stays fresh even when daemon evidence is shared.
    if(reused){
      const disk=await this._hostDiskCheck();
      if(!disk.ok){
        report.available=false;report.reason=disk.reason;report.preflight.ok=false;
        this.preflightGeneration++;this.preflightCache=null;
        // Fence other readers waiting on local bytes without starting another sbx batch.
        if(this._observationCache===entry){
          entry.key[3]=this.preflightGeneration;
          entry.result.available=false;entry.result.reason=disk.reason;entry.result.preflight.ok=false;
        }
      }
      report.preflight.checks=report.preflight.checks.map(check=>check.name==='host_disk'?disk:check);
    }
    signal?.throwIfAborted();
    if(report.available&&!stillCurrent())return this.observeCapabilities({idle,signal,...options});
    if(report.available&&this.monotonic()-entry.started>=(idle?60000:15000)){
      report.available=false;
      replacePreflightCheck(report.preflight,'sbx_daemon',{ok:false,detail:'The sandbox observation is too old.',fix:'Choose Check again.'});
    }
    return report;
  }

  /**
   * A successful probe is reused within PREFLIGHT_TTL_MS, only for the same sbx binary, home, platform and runner.
   * Every caller gets its own copy: callers add checks and repair state to the preflight they receive.
   */
  cachedPreflight(options) {
    // Unkeyed probe options (including future ones) must never reuse another call's evidence.
    if (Object.keys(options).some(key => key !== 'platformName' && key !== 'runCommand' && key !== 'binaryReads')) return probeSbxPreflight(options).then(copyPreflight);
    const key = [sbxBin(), sbxHome(), options.platformName ?? process.platform, options.runCommand ?? null];
    const now = this.monotonic(), hit = this.preflightCache;
    // lenderCapabilities fences successes across its whole async read. Retrying
    // failed shared probes here would let their generation changes retry each other.
    const read = (entry, cached) => entry.probe.then(result => Object.assign(copyPreflight(result), { cached }));
    if (hit && hit.key.every((part, i) => part === key[i]) && now < hit.until) return read(hit, true);
    const generation = this.preflightGeneration;
    const probe = probeSbxPreflight(options);
    const entry = { key, until: now + PREFLIGHT_TTL_MS, probe, generation };
    this.preflightCache = entry;
    const forget = () => { if (this.preflightCache === entry) this.preflightCache = null; };
    probe.then(result => { if (result?.ok !== true) forget(); }, forget);
    return read(entry, false);
  }

  async protectionSummary(requirements = {}, options = {}) {
    const report = await this.lenderCapabilities(options);
    // Always recheck local bytes, including when daemon evidence came from the idle cache.
    const runtime = await guardRuntimeReadiness({ home: sbxHome() }, this.guestRuntime);
    report.preflight.checks.push({ ...check('guard_runtime', runtime.ok,
      runtime.ok ? 'The sandbox job guard runtime is ready.' : RUNTIME_HELP,
      runtime.ok ? '' : 'Update Faravan; if it still fails, reinstall Faravan.'),
      ...(runtime.ok ? {} : { reason: runtime.code }) });
    if (!runtime.ok) {
      report.available = false;
      report.reason = runtime.code;
      report.preflight.ok = false;
    }
    const requested = Object.keys(requirements.limits || {});
    const required = requested.filter(key => requirements.limit_modes?.[key] !== 'preferred');
    const preferred = requested.filter(key => requirements.limit_modes?.[key] === 'preferred');
    const enforced = requested.filter(key => report.enforced_limits.includes(key));
    const supported = key => enforced.includes(key) && Number.isFinite(requirements.limits[key]) && requirements.limits[key] > 0 && requirements.limits[key] <= report.max_limits[key]
      && (key !== 'memory_bytes' || (requirements.limits[key] >= 512 * 1048576 && requirements.limits[key] % 1048576 === 0));
    const limits = { required, preferred, enforced, unenforced: requested.filter(key => !enforced.includes(key)), satisfied: required.every(supported) };
    const gate = report.preflight.checks.find(entry => entry.name === 'sbx_version');
    const version_gate = { ok: gate?.ok === true && /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[^\d]|$)/.test(report.preflight.version || ''), status: gate?.status || 'unknown', detail: gate?.detail || 'Version not verified.' };
    const egress = { requested: requirements.egress ?? null, enforceable: report.egress.includes(requirements.egress), source_enforceable: true };
    if (options.source?.kind === 'git' && requirements.egress === 'provider-only') {
      let hostname;
      try { hostname = new URL(options.source.url).hostname; } catch {}
      const hosts = Array.isArray(options.providerHosts) ? options.providerHosts : [];
      const covered = hostname && hosts.some(host => typeof host === 'string' && (host === hostname ||
        (host.startsWith('**.') && (hostname === host.slice(3) || hostname.endsWith('.' + host.slice(3)))) ||
        (host.startsWith('*.') && hostname.endsWith('.' + host.slice(2)) && hostname.split('.').length === host.slice(2).split('.').length + 1)));
      // Mirror the current executor's GitHub-only provider-policy admission.
      // This is deliberately conservative; preflight never adds network access.
      egress.source_enforceable = hostname === 'github.com' || Boolean(covered && hosts.some(host => host === 'github.com' || host === '**.github.com'));
      if (!egress.source_enforceable) egress.source_reason = 'git_source_egress_unsupported';
    }
    return { source: 'read-only-preflight', backend_id: BACKEND_ID, observed_at: report.preflight.probed_at,
      sandbox_ready: report.available, reason: report.reason, version_gate, egress, limits,
      satisfied: report.available && limits.satisfied && egress.enforceable && egress.source_enforceable, preflight: report.preflight };
  }

  /** Pending identities are durable local records, never names from a remote job. */
  async reconcileOrphanedScratch() { return daemonJobContext.run({recovery:true},()=>this._reconcileOrphanedScratch()).catch(()=>({removed:false,code:'cessation_unverified'})); }

  async _reconcileOrphanedScratch() {
    const journal = this._scratchJournalPath();
    const candidates = await deadScratchOwners(journal, scratchRoot(), { withGeneration: true });
    this._legacyScratchRemediation=[];
    const legacyProofs=[];
    if (!candidates.length) return;
    if(candidates.some(row=>row.owner_scope===sandboxOwnerScope()&&!this._rowHomeMatches(row)))return {removed:false,code:'cessation_unverified'};
    if (candidates.some(row=>row.owner_scope&&row.owner_scope===sandboxOwnerScope())) {
      const names=parseSbxListing(await this._rowRun(candidates.find(row=>row.owner_scope===sandboxOwnerScope()),['ls','--json']));
      if(!names)return;
    }
    for (const candidate of candidates) {
      const name = candidate.id;
      if (candidate.owner_scope && candidate.owner_scope!==sandboxOwnerScope()) continue;
      await withSandboxScratchLock(name, journal, async () => {
        const current = await deadScratchOwners(journal, scratchRoot(), { withGeneration: true });
        if (!current.some(row => row.id === name && row.generation === candidate.generation)) return;
        if (!candidate.owner_scope) {
          const proof=await this._legacyReport(candidate,[name],{sourceDirectory:journal});
          legacyProofs.push(proof);this._legacyScratchRemediation.push(...(proof.remediation??[]));
          return;
        }
        // The cleanup journal owns any record that reserved this name, with
        // its create receipt. This path never stops or removes compute.
        if (this.cleanupJournal.recorded(name)) return;
        // Inventory again under the identity lock: a stale listing cannot
        // authorize release for a replacement generation.
        const present = parseSbxListing(await this._rowRun(candidate,['ls', '--json']));
        if (!present || present.includes(name)) return;
        if (await recoverSandboxScratch(name, scratchRoot(), journal)) await this._storageForHome(candidate.sbx_home).release(name);
      });
    }
    if(legacyProofs.length)return {removed:legacyProofs.every(proof=>proof.removed),remediation:this._legacyScratchRemediation};
  }

  // Read-only recovery: an unknown historical HOME or incomplete process scan cannot discharge a hold.
  async proveHoldAbsent({attemptId,jobId,pending}) {
    const refuse=reason=>({absent:false,attemptId,reason});
    const platform=this._legacyDaemonOptions.platformName;
    if(!['linux','darwin'].includes(platform))return refuse('platform_unsupported');
    if(typeof attemptId!=='string'||!attemptId||typeof jobId!=='string'||!jobId)return refuse('job_identity_unknown');
    if(pending&&!pending.owner_scope)return this._proveLegacyHoldAbsent({attemptId,jobId,pending,refuse,platform});
    try {
      if(!pending||pending.owner_scope!==sandboxOwnerScope()||!this._rowHomeMatches(pending)||
        pending.attemptId!==attemptId||pending.jobId!==jobId)return refuse('sandbox_home_unverified');
    }catch{return refuse('sandbox_home_unverified');}
    let result;
    try {result=await this._rowRun(pending,['ls','--json'],{timeout:PREFLIGHT_COMMAND_TIMEOUT_MS});}
    catch{return refuse('sandbox_inventory_failed');}
    if(!completeSbxListing(result))return refuse('sandbox_inventory_incomplete');
    const listing=parseSbxListing(result);
    if(!listing)return refuse('sandbox_inventory_unreadable');
    if(listing.length)return refuse('sandbox_present');
    try {
      const scan=platform==='darwin'
        ? await inspectMacSandboxReferences([attemptId,jobId],{runCommand:this._legacyDaemonOptions.runProcessCommand})
        : await this._legacyDaemonOptions.inspectProcesses([attemptId,jobId]);
      if(scan?.complete!==true||!Array.isArray(scan.references))return refuse('process_scan_incomplete');
      if(scan.references.length)return refuse('process_present');
      const jobIds=[...['','-git','-check','-check-git'].map(suffix=>jobId+suffix),lendingMeterJobId(attemptId)];
      if(this.cleanupJournal?.jobsStopped(jobIds,{validateRow:row=>row.sbx_home===pending.sbx_home&&this._rowHomeMatches(row)})!==true)
        return refuse('sandbox_cleanup_unverified');
      return {absent:true,attemptId};
    }catch{return refuse('process_scan_failed');}
  }

  // A pending attempt from before sandbox ownership has no scope or HOME of its
  // own. The listing evidence is the one reconcilePending uses: this install's
  // HOME, one live daemon, a readable listing and a complete process scan.
  async _proveLegacyHoldAbsent({attemptId,jobId,pending,refuse,platform}) {
    if(pending.attemptId!==attemptId||pending.jobId!==jobId||pending.attempt?.attempt_id!==attemptId)return refuse('sandbox_home_unverified');
    const jobIds=[...['','-git','-check','-check-git'].map(suffix=>jobId+suffix),lendingMeterJobId(attemptId)];
    const names=jobIds.map(legacySandboxNameFor);
    if(pending.sandboxId){if(!/^wf-[0-9a-f]{16}$/.test(pending.sandboxId))return refuse('sandbox_home_unverified');names[0]=pending.sandboxId;}
    let evidence;
    try {evidence=await this._legacyInventory(pending,{sourceDirectory:path.join(configHome(),'v1'),legacyNames:names});}
    catch{return refuse('sandbox_inventory_failed');}
    if(!evidence.names)return refuse(!evidence.detail?'sandbox_inventory_failed':/process/i.test(evidence.detail)?'process_evidence_unverified':'sandbox_home_unverified');
    if(names.some(name=>evidence.names.includes(name)))return refuse('sandbox_present');
    try {
      const scan=platform==='darwin'
        ? await inspectMacSandboxReferences([attemptId,jobId,...names],{runCommand:this._legacyDaemonOptions.runProcessCommand})
        : await this._legacyDaemonOptions.inspectProcesses([attemptId,jobId,...names]);
      if(scan?.complete!==true||!Array.isArray(scan.references))return refuse('process_scan_incomplete');
      if(scan.references.length)return refuse('process_present');
    }catch{return refuse('process_scan_failed');}
    // This is the one write here: old cleanup records close on the evidence above, so lending resumes without a restart.
    try {if((await this.cleanupJournal.resolveJobs(jobIds)).resolved!==true)return refuse('sandbox_cleanup_unverified');}
    catch{return refuse('sandbox_cleanup_unverified');}
    // The proof holds only while the HOME its listing ran under is still the current HOME.
    try {if(!this._rowHomeMatches({sbx_home:evidence.home}))return refuse('sandbox_home_unverified');}
    catch{return refuse('sandbox_home_unverified');}
    return {absent:true,attemptId};
  }

  async reconcilePending(pending, options={}) { return daemonJobContext.run({recovery:true},()=>this._reconcilePending(pending,options)).catch(()=>({removed:false,attemptId:pending?.attemptId,code:'cessation_unverified'})); }

  async _reconcilePending(pending, { signal,sourceDirectory } = {}) {
    const unknown = { removed: false, attemptId: pending?.attemptId, code: 'cessation_unverified' };
    if (!pending?.attemptId || typeof pending.jobId !== 'string' || !pending.jobId ||
        pending.attempt?.attempt_id !== pending.attemptId) return unknown;
    // The main sandbox, its Git helper, its checks and the attempt's meter.
    const jobIds = [...['', '-git', '-check', '-check-git'].map(suffix => pending.jobId + suffix), lendingMeterJobId(pending.attemptId)];
    if (!pending.owner_scope) {
      const names=jobIds.map(legacySandboxNameFor);
      if(pending.sandboxId){if(!/^wf-[0-9a-f]{16}$/.test(pending.sandboxId))return unknown;names[0]=pending.sandboxId;}
      const report=await this._legacyReport(pending,names,{signal,sourceDirectory,closeWhenAbsent:true});
      if(report.removed!==true)return {...report,attemptId:pending.attemptId};
      // The listing proves the compute gone. Old cleanup records of these jobs
      // close on the same evidence; one that cannot close keeps the hold.
      const outcome=await this.cleanupJournal.resolveJobs(jobIds,{signal});
      if(!outcome.resolved||signal?.aborted)return {...unknown,...(outcome.remediation?{remediation:outcome.remediation}:{})};
      // Usage of an old attempt is unknown, so the lender charges it in full.
      // The proof names the HOME its listing ran under, and only while that is still the current HOME.
      if(!this._rowHomeMatches(report))return unknown;
      return {...report,attemptId:pending.attemptId,full_charge:true,scratch_removed:outcome.scratch_removed};
    }
    if (pending.owner_scope!==sandboxOwnerScope()) return {...unknown,foreign:[pending.sandboxId??pending.jobId]};
    if(!this._rowHomeMatches(pending))return unknown;
    // Each target is resolved only through its own record and create receipt.
    // A job with no record never dispatched a create, so it has no compute.
    const outcome=await this.cleanupJournal.resolveJobs(jobIds,{signal,allowWatching:true,validateRow:row=>row.sbx_home===pending.sbx_home&&this._rowHomeMatches(row)});
    if((!outcome.resolved||outcome.watching>0)&&!signal?.aborted){
      const stopped=this.cleanupJournal.stoppedJobs(jobIds,{validateRow:row=>row.sbx_home===pending.sbx_home&&this._rowHomeMatches(row)});
      if(stopped){const listed=await this._rowRun({sbx_home:pending.sbx_home},['ls','--json'],{signal}),names=parseSbxListing(listed);
        if(completeSbxListing(listed)&&names!==null&&stopped.every(name=>!names.includes(name)))return {removed:true,scratch_removed:false,policy_removed:false,attemptId:pending.attemptId,sbx_home:pending.sbx_home,source:'cleanup-journal',observed_at:new Date().toISOString()};}
    }
    if (!outcome.resolved || signal?.aborted) return {...unknown,...(outcome.remediation?{remediation:outcome.remediation}:{})};
    // A watched create is neither removed nor unknown: its row keeps the sandbox name, scratch, policy and storage, and the
    // caller must not read cessation or cleanup facts from this answer.
    if (outcome.watching>0) return {...unknown,watching:true,sbx_home:pending.sbx_home};
    return { removed: true, scratch_removed:outcome.scratch_removed,policy_removed:outcome.policy_removed,
      ...(!outcome.policy_removed&&outcome.policy_blocked?{policy_blocked:true}:{}),
      data_cleanup:outcome.scratch_removed?'removed':'pending',attemptId: pending.attemptId,sbx_home:pending.sbx_home,
      source: 'cleanup-journal', observed_at: new Date().toISOString(),
      ...(this.cleanupJournal.wasNeverCreated?.(pending.jobId,{sandboxId:pending.sandboxId})===true?{never_started:true}:{}) };
  }

  /** @returns {Promise<import('./runtime.mjs').CapabilityReport>} */
  async probeCapabilities(options) {
    const result=this.autoRepair===false||this._repairState.size ? {preflight:this._applyRepairState(await probeSbxPreflight(options)),repairs:[]} : await ensureSbxIdentity({...options,profileHome:this._profileHome,jobRunning:()=>this.credentialWriterBusy?.()===true||options?.jobRunning?.()===true||this._preparing>0||this._diskSentries.size>0});
    const {preflight,repairs}=result;
    this._rememberRepairState(preflight);
    this._applySignInRefusal(preflight);
    const disk = await this._hostDiskCheck();
    this._applySignInRefusal(preflight);
    preflight.checks.push(disk);
    if (!disk.ok) preflight.ok = false;
    const sbxCheck = preflight.checks.find((entry) => entry.name === 'sbx_install');
    if (!sbxCheck?.ok) {
      return {
        available: false,
        backend_id: BACKEND_ID,
        missing_prerequisites: [sbxCheck?.detail || 'sbx CLI (Docker Sandboxes) not found on PATH'],
        install_hint: INSTALL_HINT,
        preflight,
        identity_repairs: repairs,
      };
    }
    if (!preflight.ok) {
      return {
        available: false,
        backend_id: BACKEND_ID,
        missing_prerequisites: preflight.checks.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.detail}`),
        install_hint: INSTALL_HINT,
        preflight,
        identity_repairs: repairs,
      };
    }
    return { available: true, backend_id: BACKEND_ID, version: preflight.version, preflight, identity_repairs: repairs };
  }

  /**
   * @param {object} validatedJob
   * @returns {Promise<import('./runtime.mjs').SandboxHandle>}
   */
  async admitJob(job,{version,accountBroker=false}={}) {
    await (this.ensureSandboxAdmission?.()??this.recoverSandboxDeadlines());
    this.assertDeadlineTargetClear(job);
    // Refuse native lending before storage probes, even on a storage-capable backend.
    if (job.execution_scope !== 'owner' && !borrowedCredentialMechanismAllowed(job, { accountBroker })) return admitDockerJob(job);
    return admitDockerJob(job, { accountBroker, storage: job.required_limits?.includes('guest_block_device_capacity') && await (this.storage.supported?.(version) ?? this.storage.available()) });
  }

  async prepareSignIn(job) {
    if (job.image !== 'codex' || job.auth_strategy !== 'docker-native-oauth' || job.execution_scope !== 'owner')
      throw policyError('policy_unenforceable', 'Only the owner Codex sign-in flow can use this preparation.');
    const bootstrap = { ...structuredClone(job), entrypoint: 'true', inputs: [], output_manifest: [] };
    signInJobs.add(bootstrap);
    return this.prepare(bootstrap);
  }

  getPreparationObservation(context) {
    const record = preparationObservations.get(this);
    if (!record || record.signal?.aborted || record.failed ||
        context && (context.jobId !== record.jobId || context.attemptId !== record.attemptId ||
          context.generation !== record.generation)) return preparationView(null);
    if (!record.handle) return preparationView(record);
    try {
      const row = this.cleanupJournal.admissionAuthority(record.handle);
      if (!row || this.cleanupJournal.closed(record.handle) ||
          row._cleanupId !== record.cleanupId || row.sandbox_id !== record.sandboxId ||
          row.job_id !== record.jobId || row.create !== 'dispatched' ||
          row.compute_created !== true || row.create_settled !== true ||
          row.compute_stopped === true || row.create_abandoned === true ||
          row.exec_fenced === true || row.watch_state === 'watch_adopted') return preparationView(null);
      // Display-only lifetime proof: never await cleanup or run an async guard probe.
      const localAlive=()=>{
        const deadline=record.handle._deadline,now=this.monotonic();
        return deadline?.expired!==true && deadline?.controller?.signal.aborted!==true &&
          Number.isFinite(deadline?.endsAt) && Number.isFinite(now) && now<deadline.endsAt;
      };
      if (!localAlive() || !validSandboxDeadline(row) ||
          sandboxDeadlineRemaining(row,this.deadlineClock())<=0 || !row.deadline_enforcer ||
          typeof this.sandboxDeadlines?.activeSync!=='function' ||
          this.sandboxDeadlines.activeSync(row)!==true) return preparationView(null);
      // A synchronous observer may expose a concurrent journal replacement.
      const current=this.cleanupJournal.admissionAuthority(record.handle);
      if (!current || JSON.stringify(current)!==JSON.stringify(row) || !localAlive() ||
          sandboxDeadlineRemaining(current,this.deadlineClock())<=0) return preparationView(null);
      return preparationView(record);
    } catch { return preparationView(null); }
  }
  recoverAccountRun(binding) { return this.cleanupJournal.accountRun(binding); }
  // The same test gates what the lender advertises: an account the sandbox cannot reach is never offered.
  // The private exec-channel tunnel is this backend's own route to the host broker; it needs no hostname and opens no network egress.
  accountTunnelOrigin() { return TUNNEL_ORIGIN; }
  acceptsAccountBrokerOrigin(origin) { return origin===TUNNEL_ORIGIN||guestBrokerOriginProblem(origin)===null; }
  async openAccountTunnel(handle,{handler,signal,readyTimeoutMs}={}) {
    const args=['exec','-i',handle.sandbox_id,'--',...guestRelayArgv()];
    const runtime=handle._sbxRuntime;
    const child=await withSbxRuntime(runtime,()=>daemonJobContext.run({handle,agentRun:false},()=>dispatchSbx(args,
      {signal,beforeExec:launch=>this._dispatchProtected(handle,signal,launch)},
      (transportBinary,transportEnv)=>spawnSbxChild(runtime,args,{env:transportEnv,stdio:['pipe','pipe','ignore'],signal,killSignal:'SIGKILL',mode:'spawn'}))));
    const tunnel=attachGuestBrokerTunnel({child,handler,signal,...(readyTimeoutMs===undefined?{}:{readyTimeoutMs})});
    try { await tunnel.ready; } catch (error) { tunnel.close(); throw policyError('adapter_unsupported','The sandbox could not open its private route to the account broker.',{cause:error}); }
    return tunnel;
  }
  async prepareAccountRun(job,{signal,selection,attempt,brokerOrigin,wallRemainingMs,separatePreparationClock}={}) {
    if(!selection?.accountId||!attempt?.leaseProof?.signedEnvelope||job.job_id!==attempt.jobId)
      throw policyError('job_binding_mismatch','Missing account launch binding.');
    // A broker key is installed only by the later RunSpec binding. Preparation
    // makes the ordinary credential mechanisms inert, including native files.
    const tunneled=brokerOrigin===TUNNEL_ORIGIN;
    if(!tunneled&&guestBrokerOriginProblem(brokerOrigin))
      throw policyError('adapter_unsupported','Configure a guest-reachable HTTPS broker origin.');
    // The tunnel is not a network route: no broker host is opened in the sandbox policy.
    // A caller that owns the signed lease clock asks for the split: preparation on its own bound, run clock at the handoff.
    const split=separatePreparationClock===true&&typeof wallRemainingMs==='function'?{wallRemainingMs,separatePreparationClock:true}:{};
    return this.prepare(job,{signal,providerAccess:false,brokerOnly:true,...split,brokerHosts:tunneled?[]:[new URL(brokerOrigin).host],
      preparationContext:{jobId:attempt.jobId,attemptId:attempt.attemptId,generation:attempt.generation,accountId:selection.accountId,providerId:selection.providerId}});
  }
  async prepare(validatedJob, deadlineOrOptions = null, options = {}) {
    const supplied = deadlineOrOptions && typeof deadlineOrOptions === 'object' &&
      ['signal','identityProbe','accountKey','accountSelfCheck','sbxRuntime','providerAccess','githubKit','wallRemainingMs','preparationContext','separatePreparationClock']
        .some(key => Object.hasOwn(deadlineOrOptions,key)) ? deadlineOrOptions : options;
    const context = supplied.preparationContext;
    preparationObservations.delete(this);
    let record;
    if (preparationId(context?.jobId) && context.jobId === validatedJob.job_id &&
        preparationId(context?.attemptId) && Number.isSafeInteger(context.generation) && context.generation >= 0) {
      record = {jobId:context.jobId,attemptId:context.attemptId,generation:context.generation,state:'pending',signal:supplied.signal,observedAtMs:this._now()};
      preparationObservations.set(this,record);
    }
    try {
      const handle = await this._prepareWithOptions(validatedJob,deadlineOrOptions,options);
      if (record && preparationObservations.get(this) === record) {
        record.handle = handle;
        record.cleanupId = handle?._cleanupId;
        record.sandboxId = handle?.sandbox_id;
        record.state = 'prepared';
        record.observedAtMs = this._now();
        if (this.getPreparationObservation().state !== 'prepared') record.failed = true;
      }
      return handle;
    } catch (error) {
      if (record) record.failed = true;
      throw error;
    }
  }
  async _prepareWithOptions(validatedJob, deadlineOrOptions = null, options = {}) {
    const bootstrap = signInJobs.has(validatedJob);
    validatedJob = structuredClone(validatedJob);
    if (bootstrap) signInJobs.add(validatedJob);
    let sharedDeadline=deadlineOrOptions;
    if(deadlineOrOptions&&typeof deadlineOrOptions==='object'&&(Object.hasOwn(deadlineOrOptions,'preparationContext')||Object.hasOwn(deadlineOrOptions,'signal')||Object.hasOwn(deadlineOrOptions,'identityProbe')||Object.hasOwn(deadlineOrOptions,'accountKey')||Object.hasOwn(deadlineOrOptions,'accountSelfCheck')||Object.hasOwn(deadlineOrOptions,'sbxRuntime')||Object.hasOwn(deadlineOrOptions,'providerAccess')||Object.hasOwn(deadlineOrOptions,'githubKit')||Object.hasOwn(deadlineOrOptions,'wallRemainingMs')||Object.hasOwn(deadlineOrOptions,'separatePreparationClock'))) {
      options=deadlineOrOptions;
      sharedDeadline=options.sharedDeadline??null;
    }
    options.signal?.throwIfAborted?.();
    // Capture the reservation's clocks before preparation waits. Clones/checks inherit the same end; the grace never
    // renews that budget. A job that owns its deadline gets a bounded preparation clock first and its wall_seconds run
    // clock at the agent handoff (start). Both are capped by the caller's lease, so neither phase outlives its authority.
    const entryAt=this.monotonic();
    const wallMs=validatedJob.resources.wall_seconds*1000;
    let remaining,runClock=null;
    if(sharedDeadline)remaining=Math.min(wallMs,Math.max(0,sharedDeadline.endsAt-entryAt));
    else if(options.separatePreparationClock===true) {
      const lease=options.wallRemainingMs?.()??Infinity;
      if(!(wallMs>0)||!Number.isFinite(wallMs)||!(lease>0))throw policyError('wall_timeout','Sandbox wall-clock deadline exceeded.');
      remaining=Math.min(PREPARATION_BUDGET_MS,lease);
      runClock={wallMs,leaseEndsAt:entryAt+lease,outerEndsAt:entryAt+Math.min(PREPARATION_BUDGET_MS+wallMs,lease)};
    } else remaining=Math.min(wallMs,options.wallRemainingMs?.()??Infinity);
    if(!Number.isFinite(remaining)||remaining<=0)throw policyError('wall_timeout','Sandbox wall-clock deadline exceeded.');
    const reservation=sandboxDeadlineReservation(runClock?runClock.outerEndsAt-entryAt:remaining,this.deadlineClock(),sharedDeadline?.externalDeadlineAt===undefined?undefined:
      {deadline_at:sharedDeadline.externalDeadlineAt,deadline_clock:sharedDeadline.externalDeadlineClock});
    options={...options,deadlineAt:reservation.deadline_at,deadlineClockData:reservation.deadline_clock,
      localDeadlineAt:entryAt+remaining,runClock};
    await (this.ensureSandboxAdmission?.({signal:options.signal})??this.recoverSandboxDeadlines({signal:options.signal}));
    this.assertDeadlineTargetClear(validatedJob);
    // Cleanup holds take precedence over Docker sign-in. A deferred prepare
    // must not read or change sign-in refusal state before its target is clear.
    this._assertCreateSignIn();
    if(this._healthRecovery) {
      const remaining=sharedDeadline?sharedDeadline.endsAt-this.monotonic():(validatedJob.resources?.wall_seconds*1000||PREFLIGHT_COMMAND_TIMEOUT_MS);
      const deadline=AbortSignal.timeout(Math.max(0,Math.ceil(remaining)));
      await this.waitForHealth({signal:options.signal?AbortSignal.any([options.signal,deadline]):deadline});
    }
    this._preparing++;
    try { return await daemonProofScope.run({proof:null},()=>options.sbxRuntime?withSbxRuntime(options.sbxRuntime,()=>this._prepare(validatedJob,sharedDeadline,options)):this._prepare(validatedJob,sharedDeadline,options)); } finally { this._preparing--; }
  }

  async _prepare(validatedJob, sharedDeadline = null, { githubKit = true, signal, providerAccess = true, brokerOnly = false, brokerHosts = [], preparationContext = null, identityProbe = false,deadlineAt,deadlineClockData,localDeadlineAt,runClock=null, accountKey = null, accountSelfCheck = false, accountRuntime = null, sbxRuntime = null, egressWitness = false } = {}) {
    // Checks and broker account jobs make native provider credentials inert.
    // Account jobs may allow their explicit broker host while direct provider
    // hosts stay denied. Omitted providerAccess retains the legacy path.
    const providerFree = providerAccess !== true;
    if(providerFree&&accountIdOfKey(accountKey)!==null){
      const inherited=sbxRuntime??currentSbxRuntime();
      let descriptor;try{descriptor=describeSbxRuntime(inherited);}catch{/* No admission binding. */}
      if(descriptor?.kind!=='account'||descriptor.accountFenceKey.accountId!==accountIdOfKey(accountKey))
        throw policyError('claude_account_unavailable','The selected Claude account needs its admitted sandbox runtime.');
    }
    if (providerFree && !Object.hasOwn(PROVIDER_SERVICE_BY_IMAGE, validatedJob.image))
      throw policyError('policy_unenforceable', 'A provider-free check needs a known provider for this agent image.');
    if (providerFree && !brokerOnly && validatedJob.egress === 'internet')
      throw policyError('policy_unenforceable', 'A provider-free check must have restricted egress.');
    // Only Claude has additional accounts. Any other account key has no credential route here, so it never runs on
    // this computer's default sign-in by accident.
    if(accountIdOfKey(accountKey)!==null && (validatedJob.image!=='claude' || !accountKey.startsWith('claude:')))
      throw Object.assign(policyError('claude_account_unavailable', 'This agent runs only on the computer\'s default account.'),
        {cleanup_receipt:{removed:true,scratch_removed:true,policy_removed:true}});
    if(providerAccess===true && validatedJob.image==='claude' && accountIdOfKey(accountKey)!==null)
      validatedJob={...validatedJob,auth_strategy:'docker-native-oauth'};
    let initialClaudeRuntime=null;
    if(!providerFree&&validatedJob.image==='claude'&&accountIdOfKey(accountKey)!==null){
      try {initialClaudeRuntime=await this.claudeAccountRuntime({runtime:accountRuntime,beforeSpawn:()=>signal?.throwIfAborted()});}
      catch(error){error.cleanup_receipt={removed:true,scratch_removed:true,policy_removed:true};throw error;}
    }
    const admission = await this.admitJob(validatedJob,{version:initialClaudeRuntime?.version,accountBroker:brokerOnly&&providerFree});
    signal?.throwIfAborted?.();
    if (!admission.ok) throw policyError(admission.code, admission.reason, { admission });
    if (!githubKit && validatedJob.image === 'wf-gh-cli')
      throw policyError('policy_unenforceable', 'This agent image cannot start without the GitHub task kit.');
    // The agent image is named by checked-in digest, never by a floating tag. Refuse before any workspace exists.
    let imageArgs;
    try { imageArgs = createImageArgs(validatedJob.image, this._imagePins); }
    catch (error) { if (error.code === IMAGE_UNPINNED) throw policyError('policy_unenforceable', error.message); throw error; }
    const jobId = validatedJob.job_id;
    // The cleanup journal reserves this dispatch's own name before any create.
    const sandboxId = freshSandboxName();
    this.assertDeadlineTargetClear({sandbox_id:sandboxId,sbx_home:sbxHome()});
    // A later sandbox of the same job (clone or checks) gets only the time that remains.
    if (sharedDeadline && (sharedDeadline.expired || this.monotonic() >= sharedDeadline.endsAt))
      throw policyError('wall_timeout', 'Sandbox wall-clock deadline exceeded.');

    const handle = {
      backend_id: BACKEND_ID,
      ...this.sandboxOwnership(),
      job_id: jobId,
      ...(brokerOnly&&preparationContext?{account_attempt:structuredClone(preparationContext)}:{}),
      sandbox_id: sandboxId,
      deadline_at:deadlineAt,
      deadline_clock:deadlineClockData,
      scratch_dir: null,
      _image: validatedJob.image,
      _providerFree: providerFree,
      _executionScope: validatedJob.execution_scope,
      _authStrategy: validatedJob.auth_strategy,
      _entrypoint: validatedJob.entrypoint,
      _inputs: validatedJob.inputs,
      _prepareSignal: signal,
      // Only the status-only caller opts in; never infer this from a job's fields.
      ...(identityProbe === true ? { _identityPolicyChecks: [], _identityPolicyRules: [] } : {}),
      _resources: { ...validatedJob.resources },
      _mountless: admission.enforced_limits.includes('guest_block_device_capacity'),
      _egress: validatedJob.egress,
      _providerHosts: providerFree ? [...brokerHosts] : [...validatedJob.provider_hosts],
      _deniedProviderHosts: providerFree ? [...validatedJob.provider_hosts] : [],
      _registryHosts: (validatedJob.registries || []).flatMap(name => REGISTRY_HOSTS[name]),
      _sourceHosts: [...(validatedJob.source_hosts || [])],
      _execution: { egress_evidence: null, enforced_limits: [...admission.enforced_limits], unenforced: [...admission.unenforced] },
    };

    const bindRuntime=runtime=>{
      Object.defineProperty(handle,'_sbxRuntime',{value:runtime,configurable:true,enumerable:false});
      Object.defineProperty(handle,'_daemonProofScope',{value:daemonProofScope.getStore(),configurable:true,enumerable:false});
      handle.sbx_runtime=describeSbxRuntime(runtime);
    };
    bindRuntime(sbxRuntime??currentSbxRuntime()??hostDefaultSbxRuntime({currentEnv:sbxChildEnv,env:sbxChildEnv(),profileHome:this._profileHome,ownerScope:handle.owner_scope}));
    let lentClaude=null,lentCodex=null,credentialGeneration,providerGeneration,claudeAccount,inertServices=[],releasePreparation,admitClaude=null,claudeCheckGeneration=null,claudeRuntime=initialClaudeRuntime,claudeEnabled=null,claudeCheckSnapshot=null;
    if(!providerFree && validatedJob.image==='claude' && accountIdOfKey(accountKey)!==null) {
      try {
      const id=accountIdOfKey(accountKey);
      if(!accountKey.startsWith('claude:') || !id)throw policyError('claude_account_unavailable', 'The selected Claude account is invalid.');
      // Qualification probes may start disabled, but cannot switch account/value or runtime while preparing.
      const assertAccount=(expected,enabled)=>{
        try {
          const current=createAccountRegistry({file:path.join(this._profileHome,'v1','lending-accounts.json')}).get(id);
          const record=readClaudeAccountSync(sbxHome(),id);
          if(!current || current.provider!=='claude' || current.legacy_provider ||
            (accountSelfCheck?current.enabled!==enabled:!current.enabled) || record.id!==expected.id || record.digest!==expected.digest ||
            accountSelfCheck&&claudeCheckSnapshot&&currentClaudeCheckGeneration(sbxHome(),record)!==claudeCheckSnapshot.generation)throw policyError('claude_account_unavailable','The selected Claude account changed.');
        } catch {throw policyError('claude_account_unavailable','The selected Claude account is unavailable. Retry its scoped sign-in check.');}
      };
      admitClaude=async()=>{
        const account=createAccountRegistry({file:path.join(this._profileHome,'v1','lending-accounts.json')}).get(id);
        if(!account || account.provider!=='claude' || (!account.enabled&&!accountSelfCheck) || account.legacy_provider)throw policyError('claude_account_unavailable', 'The selected Claude account is unavailable.');
        const record=await readClaudeAccount(sbxHome(),id);
        await readClaudeAccountValue(sbxHome(),record);
        if(accountSelfCheck)claudeCheckSnapshot??={generation:currentClaudeCheckGeneration(sbxHome(),record)};
        const enabled=claudeEnabled??account.enabled;
        const runtime=await this.claudeAccountRuntime({runtime:claudeRuntime,beforeSpawn:()=>assertAccount(claudeAccount??record,enabled)});
        if(claudeAccount&&(record.id!==claudeAccount.id||record.digest!==claudeAccount.digest))throw policyError('claude_account_unavailable','The selected Claude account changed. Retry its scoped sign-in check.');
        if(!accountSelfCheck){
          const generation=await claudeAccountCheckGeneration(sbxHome(),record,runtime);
          if(generation===null || (claudeCheckGeneration!==null&&generation!==claudeCheckGeneration))
            throw policyError('claude_account_unavailable','The selected Claude account needs a successful scoped sign-in check.');
          claudeCheckGeneration=generation;
        }
        claudeEnabled=enabled;
        claudeRuntime=runtime;
        handle._claudeBinary=runtime.binary.path;
        Object.defineProperty(handle,'_claudeRuntime',{value:runtime,configurable:true,enumerable:false});
        return record;
      };
      claudeAccount=await admitClaude();
      const fenceClaude=()=>{
        assertAccount(claudeAccount,claudeEnabled);
        if(!claudeRuntimeFenceHolds(claudeRuntime) || !accountSelfCheck&&!claudeAccountFenceHolds(sbxHome(),claudeAccount,claudeCheckGeneration))
          throw policyError('claude_account_unavailable','The selected Claude account is unavailable. Try again after its sign-in check passes.');
      };
      bindRuntime(qualifiedSbxRuntime(runtimeDescriptor({binary:claudeRuntime.binary,kitDigest:claudeRuntime.kitDigest,version:claudeRuntime.version,
        home:sbxHome(),profileHome:this._profileHome,ownerScope:handle.owner_scope,
        accountFenceKey:{accountId:id,generationId:claudeAccount.id,digest:claudeAccount.digest,checkGeneration:accountSelfCheck?claudeCheckSnapshot.generation:claudeCheckGeneration,selfCheck:Boolean(accountSelfCheck),enabled:claudeEnabled}}),
        {fence:fenceClaude,env:sbxChildEnv}));
      Object.defineProperty(handle,'_admitClaude',{value:admitClaude,enumerable:false});
      Object.defineProperty(handle,'_fenceClaude',{value:fenceClaude,enumerable:false});
      } catch(error) {
        // No sandbox or scoped credential exists before this account check.
        error.cleanup_receipt={removed:true,scratch_removed:true,policy_removed:true};
        throw error;
      }
    } else if(!providerFree&&validatedJob.image==='claude'&&validatedJob.execution_scope==='borrowed'&&this._lentClaude) {
      // A lent job on the computer's own Claude sign-in runs on Faravan's sign-in: its current access token, pushed into this
      // sandbox only. A store that cannot supply one long enough for the job stops the job here; no other sign-in answers.
      try {
        lentClaude=await this._lentClaude.lease({wallSeconds:validatedJob.resources.wall_seconds});
        claudeAccount={id:lentClaude.generation,digest:lentClaude.digest,kind:'subscription-token'};
      } catch(error) {
        throw Object.assign(policyError(error?.code==='agent_signed_out'?'agent_signed_out':'claude_account_unavailable',
          'Claude is not ready to lend: its Faravan sign-in is missing or could not be prepared.'),{cleanup_receipt:{removed:true,scratch_removed:true,policy_removed:true}});
      }
    }
    else if(!providerFree&&validatedJob.image==='codex'&&validatedJob.execution_scope==='borrowed'&&this._lentCodex) {
      // A lent Codex job runs on Faravan's Codex sign-in: its access token, scoped to this sandbox under the built-in `openai`
      // service. Without a token that outlives the job, nothing starts, so the computer's global login never answers.
      try { lentCodex=await this._lentCodex.lease({wallSeconds:validatedJob.resources.wall_seconds}); }
      catch(error) {
        throw Object.assign(policyError(error?.code==='agent_signed_out'?'agent_signed_out':'claude_account_unavailable',
          'Codex is not ready to lend: its Faravan sign-in is missing or could not be prepared.'),{cleanup_receipt:{removed:true,scratch_removed:true,policy_removed:true}});
      }
    }
    else if(!providerFree&&validatedJob.image==='codex'&&validatedJob.execution_scope==='owner'&&
      validatedJob.auth_strategy==='provider-file-generation'&&this._lentCodex) {
      // An owner's own Codex job gets a copy that cannot refresh (below), so Faravan stays the one refresher of this sign-in.
      // Renew it here first if its access token would not outlive the job. An owner job's outcome is not a lending fault.
      try { await this._lentCodex.lease({wallSeconds:validatedJob.resources.wall_seconds,report:false}); }
      catch(error) {
        throw Object.assign(policyError(error?.code==='agent_signed_out'?'agent_signed_out':'claude_account_unavailable',
          'Codex is not ready: its Faravan sign-in is missing or could not be renewed.'),{cleanup_receipt:{removed:true,scratch_removed:true,policy_removed:true}});
      }
    }
    const run=(args,options={})=>this.runSbx(args,{...options,signal,sbxRuntime:handle._sbxRuntime,binary:handle._sbxRuntime.path,beforeSpawn:()=>assertSbxRuntime(handle._sbxRuntime,{signal,env:options.env??sbxChildEnv()})});
    const githubGranted = githubKit && (validatedJob.image === 'wf-gh-cli' || validatedJob.github_access_required);
    releasePreparation=await acquireCredentialPreparation(sbxHome(),{isolatedSources:true,signal});
    const scratchDir = await (async () => {
      if(admitClaude)await admitClaude();
      // Keep the native-only fence under the publication lock as well as at
      // admission, including when this preparation is a verification sandbox.
      if (validatedJob.execution_scope !== 'owner' && !borrowedCredentialMechanismAllowed(validatedJob, { accountBroker: brokerOnly && providerFree }))
        throw policyError('native_credentials_owner_only', BORROWED_PROXY_ONLY);
      const {refreshGitHubGeneration}=await import('./github-auth.mjs');
      credentialGeneration=await refreshGitHubGeneration(sbxHome());
      // Native generations are owner-only; borrowed jobs retain Docker's proxy.
      // A provider-free check never reads the lender's provider files.
      providerGeneration=!providerFree&&validatedJob.execution_scope==='owner'&&validatedJob.auth_strategy==='provider-file-generation'
        ? await refreshProviderGeneration(sbxHome(),validatedJob.image) : null;
      if (githubGranted && credentialGeneration) await removeLegacyGitHubSecrets(run);
      // A proxy value an earlier release left under this job's own provider would refuse the native generation.
      if (providerGeneration) await removeNativeProviderGlobalSecret(run, validatedJob, { privateHome: isPrivateSbxHome(sbxHome()), onDiagnostic: this._onDiagnostic, now: this._now });
      inertServices = await restrictCredentialScope(run, validatedJob, sandboxId, credentialGeneration,providerGeneration,{ providerAccess: !providerFree }) ?? [];
      if(claudeAccount) {
        if(claudeAccount.kind==='subscription-token')await ensureClaudeBinding(sbxHome());
        handle.scoped_claude_secret=claudeService(claudeAccount);
      }
      if(lentCodex)handle.scoped_claude_secret='openai';
      // The cleanup record (and whether it owns a scoped GitHub value) is durable before the workspace or value exists.
      if (githubGranted && credentialGeneration) handle.scoped_github_secret = true;
      const scratch = await createSandboxScratch(sandboxId, scratchRoot(), this._scratchJournalPath(), {
        ownerScope:sandboxOwnerScope(),home:sbxHome(),runtime:handle.sbx_runtime,
        beforeCreate: scratch => { handle.scratch_dir = scratch; this.cleanupJournal.register(handle,{session:this._lendingContext.getStore()}); } });
      // The kit names one fixed service, so its image is reused. The pinned generation's value is scoped to this sandbox.
      if (handle.scoped_github_secret) await assignSandboxGitHub(run, sbxHome(), credentialGeneration, sandboxId);
      return scratch;
    })().catch(async error => {
      await releasePreparation();releasePreparation=null;
      this.cleanupJournal.finish(handle, {});
      if(!handle._cleanupId && !handle.scratch_dir)error.cleanup_receipt={removed:true,scratch_removed:true,policy_removed:true};
      throw error;
    });
    if(!claudeAccount&&!lentCodex){await releasePreparation();releasePreparation=null;}

    const state = sharedDeadline || { controller: new AbortController(), expired: false, cleanup: null, handles: new Set(),
      endsAt: localDeadlineAt, phase: runClock ? 'prepare' : 'run', runClock };
    state.endsAt=Math.min(state.endsAt,localDeadlineAt);
    state.externalDeadlineAt??=deadlineAt;
    state.externalDeadlineClock??=deadlineClockData;
    handle._deadline = state;
    state.handles.add(handle);
    // destroy() clears the timer with the last sandbox; a check sandbox arms it again for the remaining time.
    if (!state.timer) this._armDeadlineTimer(state);

    try {
    signal?.throwIfAborted?.();
    // Every job needs headroom; a mountless job also reserves its guest disks against it.
    let reading;
    try { reading = validateHostDiskReading(await this.hostDisk.free()); }
    catch (error) { throw policyError('host_disk_unreadable', hostDiskUnreadable(error), { cause: error, path: error.path }); }
    if (!(reading.free >= HOST_DISK_HEADROOM_BYTES)) throw policyError('host_disk_low', hostDiskLow(reading));
    signal?.throwIfAborted?.();
    // Image pulls, sandbox creation and source staging write to the host too: the watch starts now and lasts
    // until destroy(). The sandbox does not exist until its creation command returns, so until then the halt is the abort.
    this._diskRemoved.delete(handle.sandbox_id); // a retried job can reuse the id of one already removed
    this._diskSentry(handle, { created: false });
    if (handle._mountless) await this.storage.reserve(sandboxId, validatedJob.resources.storage_mib * 1048576);
    signal?.throwIfAborted?.();
    // No provider default session may start before the lender's durable launch_result.
    // The runtime directory is protected under the gate before it is obtained or reused.
    const runtimeLease = await this._holdRuntime(sbxHome(), signal);
    if (runtimeLease) this._diskSentry(handle).runtimeLease = runtimeLease;
    handle._guardRuntimeCheck = await guardRuntimeReadiness({ home: sbxHome() }, this.guestRuntime);
    handle._guardRuntime = handle._guardRuntimeCheck.runtime ?? null;
    const runtimeMount = runtimeWorkspaceArgs(handle._guardRuntime, { mountless: handle._mountless });
    handle._guardRuntimeMounted = runtimeMount.length > 0;
    // Every sandbox is created, never run: a create that lands after its preparer died stays stopped, so it can start no
    // entrypoint and read no credential until the cleanup watch removes it. Work reaches a sandbox only through `exec`.
    const creationCommand = 'create';
    // The stable GitHub kit is identical for every credential generation; the
    // value it requests is scoped to this sandbox above. Legacy profiles retain
    // the static kit. Both inject a GH_TOKEN sentinel; neither mounts the
    // provider's gh config or the raw host snapshot.
    const kitArgs = [...(githubGranted ? ['--kit', credentialGeneration?.kitDirectory || GITHUB_KIT_DIR] : []),
      ...(validatedJob.image==='wf-pi'?['--kit',PI_KIT_DIR]:[]),
      ...(claudeAccount?.kind==='subscription-token'?['--kit',CLAUDE_KIT]:[])];
    const denyArgs = PRIVATE_NETWORK_DENIES.flatMap((range) => ['--deny-network', range]);
    const volumes = handle._mountless ? storageVolumes(validatedJob.resources.storage_mib * 1048576, validatedJob.image) : null;
    // From dispatch on, the create request may materialize even if its command
    // fails. The record must say so before sbx runs; a lost lease means a
    // deadline or failure already resolved this record, so nothing is sent.
    let dispatchedAt = null;
    const dispatch = () => {
      this._assertCreateSignIn();
      if (!this.cleanupJournal.mark(handle, { create: 'dispatched' })) throw policyError('cessation_unverified', 'The sandbox reservation was already closed.');
      // Checked after the mark: an uninstall that took its lock first is seen
      // here, and one that takes it later reads this record. No sbx call ran.
      dispatchedAt = this.signInRefusalEpoch();
      if (uninstallInProgress(this._profileHome)) {
        this.cleanupJournal.mark(handle, { create: 'reserved' });
        throw policyError('cessation_unverified', 'Faravan is being uninstalled, so no new sandbox starts.');
      }
    };
    // The accepted create is this target's receipt, recorded before any
    // cancellation or readiness branch can lose it.
    const accepted = result => {
      if (result.code === 0) {
        this.cleanupJournal.mark(handle, { compute_created: true });
        if (this.signInRefused() && this._signInRefusal.epoch === dispatchedAt) this._setSignInRefusal(false, dispatchedAt);
        if (!this.signInRefused()) this._noteCreateAccepted();
      }
      else if (dockerSessionRefused(result.stderr)) {
        // Keep the refusal even if cancellation or a failed journal write
        // prevents settlement. Transport errors cannot prove a non-create.
        this._setSignInRefusal(true);
        if (Number.isInteger(result.code) && result.code > 0 && result.exited === true &&
            !result.timedOut && !result.killed && !result.signal && !result.outputExceeded &&
            (result.errorCode === undefined || Number.isInteger(result.errorCode)))
          this.cleanupJournal.mark(handle, { create_refused: true, create_settled: true, compute_stopped: true });
      }
    };
    // The supervisor must acknowledge its durable publication before create/run
    // dispatch. It retains protection if that create materializes after app death.
    let enforcer;
    try {
      enforcer=await this.sandboxDeadlines.register(this.cleanupJournal.authority(handle));
      handle._deadlineEnforcer=enforcer;
      if(!this.cleanupJournal.mark(handle,{deadline_enforcer:enforcer}))throw policyError('sandbox_start_failed','The sandbox deadline could not be saved. Please retry.',{retryable:true});
      handle.deadline_enforcer=enforcer;
    }catch(error){
      throw policyError('sandbox_start_failed','The independent sandbox deadline could not be registered. Please retry.',{cause:error,retryable:true,probe_subcause:'deadline_registration_failed'});
    }
    // Creating may pull and assemble an image the sweep has not seen yet. Cover it until the
    // sandbox is recorded (or the create failed), so a sweep never races the create.
    const imagePin = digestHex(imageArgs.flags[1] ?? imageArgs.positional);
    const runtimeCache = handle._guardRuntimeMounted ? handle._guardRuntime?.dir ?? null : null;
    const protection = await this._admitDiskJob(sandboxId, imagePin, signal, this._diskSentry(handle).runtimeLease, handle);
    if (protection) this._diskSentry(handle).runLease = protection.run;
    let runResult;
    try {
    runResult = await this._runJobCommand(handle, [creationCommand, '--name', sandboxId, ...kitArgs,
      '--cpus', String(validatedJob.resources.cpu), '--memory', `${validatedJob.resources.memory_mib}m`,
      '--skills', 'off', ...denyArgs, ...imageArgs.flags,
      imageArgs.positional, ...(handle._mountless ? [] : [scratchDir, ...runtimeMount])], undefined, volumes ? {
        env: { ...sbxChildEnv(), DOCKER_SANDBOXES_ROOT_SIZE: volumes.root / 1048576 + 'm', DOCKER_SANDBOXES_DOCKER_SIZE: volumes.docker / 1048576 + 'm' },
        onDispatch: dispatch, onResult: accepted, timeout: SANDBOX_CREATE_TIMEOUT_MS(),
      } : { onDispatch: dispatch, onResult: accepted, timeout: SANDBOX_CREATE_TIMEOUT_MS() });
    if (runResult.code === 0) await this._recordSandboxImage(sandboxId, imageArgs, runtimeCache, handle);
    } finally {
      await this._settleDiskCreate(protection, { created: runResult?.code === 0 }, handle);
      // A create that did not succeed leaves nothing for the run lease to protect.
      if (protection && runResult?.code !== 0) this._endRunLease(this._diskSentries.get(sandboxId));
    }
    signal?.throwIfAborted?.();
    if (runResult.code !== 0) {
      if (dockerSessionRefused(runResult.stderr)) {
        // The result callback records the refusal before cancellation. Keep the
        // classification boundary fail-closed too: never return a sign-in
        // blocker whose refusal was not saved by an earlier observer.
        if (!this.dockerSignInBlocker()) this._setSignInRefusal(true);
        throw this.dockerSignInBlocker() ?? dockerSignInStateError();
      }
      const failure=workspaceFailure({stderr:runResult.stderr});
      const evidence={probe_subcause:runResult.probe_subcause??(runResult.errorCode==='SBX_DAEMON_UNVERIFIED'?'daemon_unverified'
        :runResult.timedOut===true||runResult.errorCode==='ETIMEDOUT'?'timeout':runResult.killed===true||runResult.signal?'killed':failure.cause),
        // Transport failures use a synthetic code=1; it is not a process exit.
        ...(Number.isInteger(runResult.code)&&runResult.exited===true&&!runResult.killed&&!runResult.timedOut&&
          !runResult.signal?{exitCode:runResult.code}:{})};
      if(failure.cause==='credential_store')throw policyError('sandbox_credential_store_failed', failure.detail, evidence);
      throw policyError('sandbox_start_failed', `sbx ${creationCommand} failed for sandbox ${sandboxId}: ${runResult.stderr || `exit ${runResult.code}`}`, evidence);
    }
    if(claudeAccount) {
      if(/no binding authorizes|credential was not injected/i.test(runResult.stderr||''))throw policyError('claude_account_unavailable', 'The selected Claude account binding is unavailable.');
      // No guest command runs until the scoped value is both stored and listed.
      try{await assignClaudeAccount(run,sbxHome(),claudeAccount,sandboxId,{control:accountSelfCheck==='control',value:lentClaude?.value});}
      catch(error){if(lentClaude)this._lentClaude.report(error?.code??'claude_account_unavailable');throw error;}
      signal?.throwIfAborted?.();
      // The last look before any guest command: a check that failed while the value was being set stops the job here.
      if(admitClaude)await admitClaude();
      handle._credentialEnv=claudeGuestEnv(claudeAccount);
      await releasePreparation();releasePreparation=null;
    }
    if(lentCodex) {
      // No guest command runs until the scoped value is both stored and listed.
      try{await assignLentOpenAI(run,sandboxId,lentCodex.value);}
      catch(error){this._lentCodex.report(error?.code??'claude_account_unavailable');throw error;}
      signal?.throwIfAborted?.();
      await releasePreparation();releasePreparation=null;
    }
    const disk = this._diskSentry(handle);
    disk.created = true;
    // A low reading during creation had no sandbox to halt yet: halt the new one now.
    if (disk.low) { await this._haltForDisk(handle, disk).catch(() => {}); throw policyError(disk.low.reason ?? 'host_disk_low', hostDiskStop(disk.low)); }

    // Use the short `-d`: sbx 0.47 spells the long flag `--detached` and 0.48
    // renamed it `--detach` (the old spelling is now "unknown flag"). Found
    // live 2026-10-18 after an unattended apt upgrade to 0.48.0.
    // `sbx run -d` returns before the sandbox is actually exec-able
    // (image layer builds + microVM boot happen asynchronously — on slow or
    // nested-virtualized hosts that window is many seconds, and a failed boot
    // otherwise surfaces NOWHERE). Found live: the very next `sbx exec` (the
    // auth preflight) failed "no sandbox named <id>" against a sandbox whose
    // creation had just 'succeeded'. Wait for real readiness — a trivial
    // exec — before returning the handle, so every later exec (auth probe,
    // task entrypoint, output collection) can trust the sandbox is booted.
    const readyDeadline = Date.now() + sandboxReadyTimeoutMs();
    for (;;) {
      // A sandbox that answers has materialized: its create request is settled.
      const probe = await this._runJobCommand(handle, ['exec', sandboxId, '--', 'true'], undefined,
        { onResult: result => { if (result.code === 0) this.cleanupJournal.mark(handle, { create_settled: true }); } });
      signal?.throwIfAborted?.();
      if (probe.code === 0) break;
      if (Date.now() > readyDeadline) {
        throw policyError('sandbox_ready_timeout', `sandbox ${sandboxId} never became ready after sbx ${creationCommand} (boot may have failed): ${probe.stderr || `exit ${probe.code}`}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    handle._inertDeny = [...inertServices.flatMap(service => INERT_SERVICE_DENY[service] ?? []), ...handle._deniedProviderHosts];
    await this._configureEgress(handle);
    // Opt-in, additive: the host's own readback and decision checks above stay the proof for every range they cover.
    if (egressWitness === true) await this._witnessGuestEgress(handle, { signal });
    // Another agent's global sign-in was tolerated only because this sandbox cannot reach its service.
    for (const service of inertServices.filter(name => name !== GITHUB_BINDING_GUEST_PROBE && Object.hasOwn(INERT_SERVICE_HOSTS, name))) {
      const exposed = () => { throw policyError('credential_scope_unenforceable', `This sandbox could use the ${service} sign-in.`); };
      await this._verifyDecisions(handle, INERT_SERVICE_HOSTS[service], 'denied', exposed);
      // A provider-free check's own provider is proven by its secret-only check below, not by this list.
      const ownProvider = providerFree && service === PROVIDER_SERVICE_BY_IMAGE[validatedJob.image];
      const names = ownProvider ? [] : INERT_SERVICE_ENV[service];
      if (names.length && (await this._runJobCommand(handle, ['exec', sandboxId, '--', 'sh', '-c',
        names.map(name => `[ -z "\${${name}:-}" ]`).join(' && ')])).code !== 0) exposed();
    }
    // A provider-free check may not reach its provider's hosts or see a provider variable. The provider's own sign-in,
    // if sbx keeps one bound, is denied above; here the provider list is proven denied and the variables absent,
    // before any check command runs.
    if (providerFree) {
      const service = PROVIDER_SERVICE_BY_IMAGE[validatedJob.image];
      const exposed = () => { throw policyError('credential_scope_unenforceable', `This sandbox could use the ${service} sign-in.`); };
      await this._verifyDecisions(handle, handle._deniedProviderHosts.map(host => host.replace(/^\*\*?\./, 'api.')), 'denied', exposed, true);
      if ((await this._runJobCommand(handle, ['exec', sandboxId, '--', 'sh', '-c',
        absentEnvCommand(PROVIDER_SECRET_ENV[service] ?? ALL_PROVIDER_SECRET_ENV)])).code !== 0) exposed();
    }
    if (identityProbe === true) await this._verifyIdentityPolicy(handle);
    // Which sign-in answers is proven before any guest command: a control value must be refused (401) and the real scoped value
    // accepted (200) on the same route. The computer's old global login would answer 200 to both.
    if(lentClaude)await this._verifyScopedValue(handle,lentClaude,this._lentClaude.report,{
      url:'https://api.anthropic.com/v1/models',headers:['anthropic-version: 2023-06-01'],control:claudeControlValue(claudeAccount.kind),
      push:value=>assignClaudeAccount(run,sbxHome(),claudeAccount,sandboxId,{value})});
    if(lentCodex)await this._verifyScopedValue(handle,lentCodex,this._lentCodex.report,{
      url:'https://chatgpt.com/backend-api/wham/usage',headers:['originator: Codex Desktop','User-Agent: codex-tui/0.163.0'],
      control:'faravan-negative-control-'+'0'.repeat(64),push:value=>assignLentOpenAI(run,sandboxId,value)});
    // An open job cannot have GitHub denied, and sbx may apply the lender's generated GitHub binding to it. Ask GitHub
    // from inside the guest which limit applies. A guest that cannot reach GitHub cannot use the token.
    if (inertServices.includes(GITHUB_BINDING_GUEST_PROBE)) {
      const probe = await this._runJobCommand(handle, ['exec', sandboxId, '--', 'sh', '-c',
        'if command -v curl >/dev/null 2>&1; then curl -sS -m 15 -H "Accept: application/vnd.github+json" ' + GITHUB_PROBE_URL +
        '; elif command -v wget >/dev/null 2>&1; then wget -qO- -T 15 --header="Accept: application/vnd.github+json" ' + GITHUB_PROBE_URL +
        '; else exit 127; fi']);
      const verdict = classifyGitHubProbe(probe);
      handle._execution.github_binding_probe = { outcome: verdict.authenticated ? 'authenticated' : 'passed', reason: verdict.reason };
      if (verdict.authenticated) throw policyError('credential_scope_unenforceable', 'This sandbox could use the GitHub sign-in.', { condition: 'github_binding_reached_guest' });
    }
    if (signInJobs.has(validatedJob)) signInHandles.add(handle);
    if (handle._mountless) {
      if (!await this.storage.verify(handle)) {
        await this.storage.recordQualification?.(false);
        throw policyError('storage_unenforceable', STORAGE_BLOCKED);
      }
      await this.storage.recordQualification?.();
      const directory = await this._runJobCommand(handle, ['exec', '-u', 'root', sandboxId, '--', 'sh', '-c',
        'mkdir -p ' + shellQuote(scratchDir) + ' && chown 1000:1000 ' + shellQuote(scratchDir)]);
      if (directory.code !== 0) throw policyError('input_copy_failed', 'Could not create the private guest workspace.');
      handle._workspaceReady = true;
    }

    if(providerGeneration) {
      const destination='/var/tmp/faravan-auth-'+providerGeneration.id;
      const directory=await this._runJobCommand(handle,['exec',sandboxId,'--','mkdir','-m','700',destination]);
      if(directory.code!==0)throw policyError('credential_writer_unresolved','The private credential consumer could not be created.');
      const files=validatedJob.image==='codex'?[providerGeneration.file,'config.toml']:[providerGeneration.file];
      // One holder per Codex sign-in: Codex renews a copied auth.json itself and the provider rotates the refresh token, so a
      // copy that kept it would spend the token Faravan's own refresher holds. The guest gets the access token without it.
      const consumer=validatedJob.image==='codex'?await codexConsumerCopy(sbxHome(),providerGeneration):null;
      try {
        for(const file of files) {
          const from=consumer&&file===providerGeneration.file?consumer.file:path.join(providerGeneration.directory,file);
          const copy=await this._runJobCommand(handle,['cp',from,sandboxId+':'+destination+'/'+file]);
          if(copy.code!==0)throw policyError('credential_writer_unresolved','The credential generation could not be copied.');
        }
      } finally { await consumer?.remove(); }
      // The guest can change its own copy without changing the publication. A Claude copy can still refresh itself.
      // No host generation directory is mounted into a writable guest path.
      handle._credentialEnv=validatedJob.image==='codex'
        ? ['CODEX_HOME='+destination,'OPENAI_API_KEY=','FARAVAN_CREDENTIAL_GENERATION='+providerGeneration.id]
        : ['CLAUDE_CONFIG_DIR='+destination,'ANTHROPIC_API_KEY=','ANTHROPIC_AUTH_TOKEN=','CLAUDE_CODE_OAUTH_TOKEN='];
      handle._ownerProviderGeneration={service:PROVIDER_SERVICE_BY_IMAGE[validatedJob.image],directory:destination};
    }

    // Copy declared inputs into the sandbox's private storage via the
    // backend's copy mechanism — never assume the guest can see scratchDir
    // contents implicitly beyond what `sbx run`'s workspace mount provides.
    for (const input of validatedJob.inputs || []) {
      await this._copyIn(handle, input);
    }

    await this.assertActive(handle);
    signal?.throwIfAborted?.();
    handle._prepareSignal=null;
    return handle;
    } catch (error) {
      if(releasePreparation){await releasePreparation();releasePreparation=null;}
      this._noteCreateCommandFailure(handle,error);
      this._verifiedIdentityPolicies = new Map();
      handle._prepareSignal=null;
      const sentry = this._diskSentries.get(handle.sandbox_id);
      await sentry?.halt;
      if (sentry?.low) error = policyError(sentry.low.reason ?? 'host_disk_low', hostDiskStop(sentry.low), { cause: error });
      const receipt = await this.destroy(handle).catch(() => ({ removed: false, scratch_removed: false }));
      this.cleanupJournal.finish(handle,receipt);
      error.cleanup_receipt = receipt;
      throw error;
    }
  }

  _noteCreateCommandFailure(handle,error) {
    if(handle._createDiagnosticRecorded||!handle._createCommandObservation)return;
    const row=this.cleanupJournal.authority(handle);
    const result=handle._createCommandResult??error;
    if(row?.create_settled===true&&result?.code===0)return;
    const diagnostic=sandboxCommandDiagnostic(result,{
      ...handle._createCommandObservation,duration_ms:performance.now()-handle._createCommandStarted});
    handle._createDiagnosticRecorded=true;
    try{Promise.resolve(this._onDiagnostic({at:new Date(this._now()).toISOString(),code:'sandbox_start_failed',phase:'prepare',
      condition:'create_unsettled',details:{stage:'create',sandbox_command:diagnostic}})).catch(()=>{});}catch{}
  }

  /**
   * The host disk watch of one sandbox, from prepare() to destroy(), keyed by sandbox id so copies of a handle share it.
   * On a low reading it aborts the sandbox's commands and halts it. Once the halt has settled the watch is armed
   * again: a second low reading means the sandbox is halted again and its work is not kept.
   */
  _diskSentry(handle, { created = true } = {}) {
    let sentry = this._diskSentries.get(handle.sandbox_id);
    if (sentry) return sentry;
    sentry = { low: null, again: false, collecting: false, created, halt: null, controller: new AbortController(), failed: new AbortController(), watch: null, closed: false };
    const arm = onLow => {
      sentry.watch = watchHostDisk({ disk: this.hostDisk, haltMs: this.diskHaltMs, monotonic: this.monotonic,
        ...(this.diskTimers ? { timers: this.diskTimers } : {}), onLow });
    };
    arm(detail => {
      sentry.low = { ...detail, at: this.monotonic() };
      sentry.controller.abort();
      sentry.halt = this._haltForDisk(handle, sentry).then(() => {
        if (sentry.closed) return;
        sentry.controller = new AbortController();
        arm(() => { sentry.again = true; sentry.controller.abort(); this._haltForDisk(handle, sentry).catch(() => {}); });
      }, error => { sentry.low.halt_error = error.code ?? 'sandbox_stop_failed'; sentry.failed.abort(); });
    });
    this._diskSentries.set(handle.sandbox_id, sentry);
    handle._diskSentry = sentry; // copies of this handle carry it, so a close can tell its own watch from a replacement's
    return sentry;
  }

  _closeDiskSentry(handle) {
    const sentry = this._diskSentries.get(handle.sandbox_id);
    // A handle bound to an older watch that has already ended must not close the one that took its name.
    if (!sentry || (handle._diskSentry && handle._diskSentry !== sentry)) return;
    sentry.closed = true;
    this._endRunLease(sentry);
    this._diskRemoved.add(handle.sandbox_id);
    sentry.watch?.stop();
    this._diskSentries.delete(handle.sandbox_id);
  }

  /**
   * `sbx stop` within four fifths of the halt time. A stop that overruns escalates to SIGKILL of this identity's
   * sandboxes, itself bounded by the last fifth. A stop that fails at once is reported, not escalated: the kill
   * would also end every other job of this identity.
   */
  async _haltForDisk(handle, sentry) {
    if (!sentry.created) return; // nothing exists yet: the aborted `sbx run` was the halt
    const timers = this.diskTimers ?? { setTimeout, clearTimeout };
    const within = (promise, ms, error) => {
      let timer;
      return Promise.race([promise, new Promise((_, reject) => {
        timer = timers.setTimeout(() => reject(error), ms);
        timer?.unref?.();
      })]).finally(() => timers.clearTimeout(timer));
    };
    const overran = policyError('sandbox_stop_failed', 'sbx stop did not finish in time.');
    const stopping = this.cancel(handle);
    stopping.catch(() => {});
    try {
      await within(stopping, this.diskHaltMs * 4 / 5, overran);
    } catch (error) {
      if (error !== overran) throw error;
      const killing = this.killSandboxes();
      killing.catch(() => {});
      if (!await within(killing, this.diskHaltMs / 5, overran).catch(() => false)) throw error;
    }
  }

  _armDeadlineTimer(state) {
    this.deadlineTimers.clearTimeout(state.timer);
    state.timer = this.deadlineTimers.setTimeout(() => {
      state.expired = true;
      state.controller.abort();
      state.cleanup = Promise.all([...state.handles].map(async (active) => {
        this._noteCreateCommandFailure(active,{timedOut:true});
        await this.cancel(active).catch(() => {});
        return this.destroy(active).catch(() => ({ removed: false, scratch_removed: false }));
      }));
    }, Math.max(0, state.endsAt - this.monotonic()));
    state.timer.unref?.();
  }

  /**
   * The protected agent handoff: the run clock (wall_seconds) starts here, not at preparation entry. The new end is the
   * shortest of the run budget, the caller's lease and the reserved outer end, so the handoff can never renew a lease or
   * outlive the independent supervisor's deadline. Only a job's own deadline is rebased; check clones share the agent's.
   * Callers must have refused an expired preparation (assertActive) first.
   */
  _beginRunClock(handle) {
    const state = handle._deadline;
    if (!state || state.phase !== 'prepare' || !state.runClock) return;
    const { wallMs, leaseEndsAt, outerEndsAt } = state.runClock;
    state.phase = 'run';
    state.endsAt = Math.min(this.monotonic() + wallMs, leaseEndsAt, outerEndsAt);
    this._armDeadlineTimer(state);
  }

  async assertActive(handle, { agentRun = false,guestCommand=false } = {}) {
    // The agent's run settles its own disk stop in start(). After a disk stop, only that start() goes on to
    // collect the work so far; every other step ends here.
    const disk = agentRun ? null : this._diskSentries.get(handle.sandbox_id);
    if (disk?.low?.halt_error) throw policyError(disk.low.reason ?? 'host_disk_low', hostDiskStop(disk.low) + ' The sandbox could not be halted, so its work was not kept.');
    if (disk?.again) throw policyError(disk.low.reason ?? 'host_disk_low', hostDiskStop(disk.low) + ' Its work was not kept.');
    if (disk?.low && !disk.collecting) throw policyError(disk.low.reason ?? 'host_disk_low', hostDiskStop(disk.low));
    const checkWall=async()=>{
      if (handle._deadline?.expired || Number.isFinite(handle._deadline?.endsAt)&&this.monotonic()>=handle._deadline.endsAt) {
        const cleanup = await handle._deadline.cleanup;
        throw policyError('wall_timeout', 'Sandbox wall-clock deadline exceeded.', { cleanup_receipt: cleanup });
      }
    };
    await checkWall();
    if(guestCommand) {
      this.cleanupJournal.assertExecAllowed?.(handle);
      const row=this.cleanupJournal.authority(handle);
      const guardIdentity = row?.deadline_enforcer ? this.sandboxDeadlines.identitySync?.(row) ?? null : null;
      if(!row?.deadline_enforcer||sandboxDeadlineRemaining(row,this.deadlineClock())<=0||!await this.sandboxDeadlines.active(row))
        throw policyError('sandbox_start_failed','The independent sandbox deadline is unavailable. Please retry.',{retryable:true});
      await checkWall();
      if(sandboxDeadlineRemaining(row,this.deadlineClock())<=0)throw policyError('wall_timeout','Sandbox wall-clock deadline exceeded.');
      return guardIdentity;
    }
  }

  async _dispatchProtected(handle, signal, launch, {create=false}={}) {
    if (create) {
      await this.assertActive(handle);
      await (this.ensureSandboxAdmission?.({signal}) ?? this.recoverSandboxDeadlines({signal}));
    }
    const guardIdentity = await this.assertActive(handle,{guestCommand:true});
    this.assertDeadlineTargetClear(handle);
    if(handle.sbx_home&&handle.sbx_home!==sbxHome())this.assertDeadlineTargetClear({sandbox_id:handle.sandbox_id,sbx_home:sbxHome()});
    this.cleanupJournal.assertExecAllowed?.(handle);
    // Original admission owns the row/name locks through this synchronous
    // launch boundary. Cleanup authority alone also accepts stale handles.
    const row=this.cleanupJournal.admissionAuthority?.(handle);
    if(!row||row.watch_state==='watch_adopted')
      throw policyError('sandbox_start_failed','This sandbox is reserved for cleanup.',{retryable:true});
    // Older injected managers expose only active(). Revalidate after that await,
    // then keep ownership, binding, deadline and launch in one synchronous turn.
    const binding=JSON.stringify(row?.deadline_enforcer);
    const protectedNow=row?.deadline_enforcer&&(typeof this.sandboxDeadlines.identitySync==='function'
      ? guardIdentity !== null && this.sandboxDeadlines.identitySync(row) === guardIdentity
      : typeof this.sandboxDeadlines.activeSync==='function'
        ? this.sandboxDeadlines.activeSync(row)
        : await this.sandboxDeadlines.active(row));
    const current=this.cleanupJournal.admissionAuthority?.(handle);
    if(!protectedNow||!current||current._cleanupId!==row._cleanupId||current.sbx_home!==row.sbx_home||
      current.sandbox_id!==row.sandbox_id||JSON.stringify(current.deadline_enforcer)!==binding)
      throw policyError('sandbox_start_failed','The independent sandbox deadline is unavailable. Please retry.',{retryable:true});
    this.cleanupJournal.assertExecAllowed?.(handle);
    if(handle.sbx_home&&handle.sbx_home!==sbxHome())
      throw policyError('sandbox_start_failed','The sandbox HOME changed before dispatch.',{retryable:true});
    if(handle._deadline?.expired||Number.isFinite(handle._deadline?.endsAt)&&this.monotonic()>=handle._deadline.endsAt||sandboxDeadlineRemaining(current,this.deadlineClock())<=0)
      throw policyError('wall_timeout','Sandbox wall-clock deadline exceeded.');
    this.assertDeadlineTargetClear(handle);
    signal?.throwIfAborted();
    return launch();
  }

  async _runJobCommand(handle, args, onLog, { signal: stop, onExecutionStarted, env, agentRun = false, onDispatch, onResult, timeout = 0 } = {}) {
    return withSbxRuntime(handle._sbxRuntime,async()=>{
    // The native transports prove the watchdog in beforeExec after daemon setup.
    // Some injected runners launch without that hook and still need the early proof.
    await this.assertActive(handle,{guestCommand:args[0]==='exec' && this._injectedTransport});
    // A disk stop aborts every command at once, except the agent's run: the halt ends that one, so its output
    // so far comes back. The agent's run is aborted only if the halt fails.
    const disk = this._diskSentries.get(handle.sandbox_id);
    const signals = [handle._deadline?.controller.signal, stop, handle._prepareSignal, agentRun ? disk?.failed.signal : disk?.controller.signal].filter(Boolean);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    if (handle._mountless && handle._workspaceReady && args[0] === 'exec') args = ['exec', '-w', handle.scratch_dir, ...args.slice(1)];
    if(args[0]==='exec' && handle._credentialEnv)args=['exec',...handle._credentialEnv.flatMap(value=>['-e',value]),...args.slice(1)];
    // One raw byte budget across both streams and all streaming commands in
    // this sandbox. Charge before decoding, retaining, or filtering guard lines.
    handle._streamBudget ??= { remaining: Math.min(handle._resources?.output_bytes ?? 16 * 1024 * 1024, 16 * 1024 * 1024) };
    signal?.throwIfAborted();
    const create=args[0]==='create'||args[0]==='run';
    if(create) {
      await (this.ensureSandboxAdmission?.({signal})??this.recoverSandboxDeadlines({signal}));
      const nameIndex=args.indexOf('--name');
      const commandName=nameIndex>=0?args[nameIndex+1]:args.find(arg=>arg.startsWith('--name='))?.slice(7);
      if(commandName!==handle.sandbox_id||handle.sbx_home&&handle.sbx_home!==sbxHome())this.assertDeadlineTargetClear({sandbox_id:commandName,sbx_home:sbxHome()});
    }
    this.assertDeadlineTargetClear(handle);
    const beforeSpawn=()=>{
      signal?.throwIfAborted();
      handle._fenceClaude?.();
    };
    const launchOptions={sbxRuntime:handle._sbxRuntime,beforeSpawn,binary:handle._sbxRuntime?.path};
    let gateEntered=false,launched=false;
    // Injected runners can use the same gate as the real daemon transport.
    const beforeExec=launch=>{
      gateEntered=true;
      return this._dispatchProtected(handle,signal,() => {
        if (create) this._assertCreateSignIn();
        if (onDispatch) onDispatch();
        launched=true;
        return launch();
      },{create});
    };
    const commandStarted=performance.now(),commandObservation={runtime_path:handle._sbxRuntime?.path,
      subcommand:args[0]};
    if(create){handle._createCommandObservation=commandObservation;handle._createCommandStarted=commandStarted;}
    const rememberCreate=result=>{
      if(!create)return;
      const {code,stderr,errorCode,signal,timedOut,killed,truncated,sbxLaunchRefused,message}=result??{};
      handle._createCommandResult=bindSandboxCommandDiagnostic({code,stderr,errorCode,signal,timedOut,killed,truncated,sbxLaunchRefused,message},sandboxCommandDiagnosticOf(result));
    };
    let result;
    try {
      // Legacy injected runners launch synchronously and do not call beforeExec.
      // The real transport marks dispatch after daemon preparation and admission.
      if(this._injectedTransport&&onDispatch)onDispatch();
      result=await daemonJobContext.run({handle,agentRun,beforeExec,commandObservation},()=>onLog||onExecutionStarted
        ?runSbxStreaming(args,onLog,signal,onExecutionStarted,handle._streamBudget,launchOptions)
        :this.runSbx(args,{...launchOptions,signal,timeout,beforeExec,...(env?{env}:{})}));
    }catch(error){
      rememberCreate(error);
      // Runtime fences tag synchronous refusals before the child is spawned.
      if(create&&gateEntered&&(!launched||error?.sbxLaunchRefused===true))this.cleanupJournal.mark(handle,{create:'reserved'});
      throw error;
    }
    rememberCreate(result);
    // Durable facts about the command's result come before any abort check.
    onResult?.(result);
    if (result.outputExceeded) {
      await this.cancel(handle).catch(() => {});
      throw policyError('output_too_large', 'Sandbox execution exceeded the transcript byte limit.');
    }
    await this.assertActive(handle, { agentRun });
    stop?.throwIfAborted?.();
    handle._prepareSignal?.throwIfAborted?.();
    return result;
    });
  }

  /**
   * One guest network witness for every declared private range this host owns an address in: one guest command and two
   * policy-log reads cover all of them (see v1/guest-egress-witness.mjs). It adds evidence; it never replaces the policy
   * readback or decision checks, and the ranges it cannot cover are recorded as `uncovered`. Positive leak evidence fails
   * the job like any policy failure; a missing or ambiguous observation is recorded as inconclusive and fails nothing.
   */
  async _witnessGuestEgress(handle, { signal } = {}) {
    const bounded = AbortSignal.timeout(WITNESS_BUDGET_MS);
    const stop = signal ? AbortSignal.any([signal, bounded]) : bounded;
    const witness = await runGuestEgressWitness({
      ...this._witnessOptions, // tests inject interfaces and listeners
      exec: ({ command, env }) => this._runJobCommand(handle,
        ['exec', ...Object.entries(env).flatMap(([name, value]) => ['-e', `${name}=${value}`]), handle.sandbox_id, '--', 'sh', '-c', command],
        undefined, { signal: stop }),
      audit: async endpoints => {
        const result = await this._runJobCommand(handle, ['policy', 'log', handle.sandbox_id, '--json'], undefined, { signal: stop });
        return result.code === 0 ? parseWitnessAudit(result.stdout, { sandboxId: handle.sandbox_id, endpoints }) : null;
      },
    });
    handle._egressWitness = witness;
    if (witness.state === 'failed')
      throw policyError('policy_unenforceable', 'The sandbox reached an address that only this computer owns.', { policy_verification: { ...handle._policyVerification, egress_witness: witness.reason } });
  }

  /** Rules that apply to this sandbox, read back from sbx. A listing that cannot be parsed fails the job: nothing is proven. */
  async _readPolicy(handle, failPolicy) {
    const result = await this._runJobCommand(handle, ['policy', 'ls', handle.sandbox_id, '--json', '--type', 'network']);
    const listing = result.code === 0 ? parsePolicyListing(result.stdout, handle.sandbox_id) : null;
    if (!listing) failPolicy('The sandbox network policy could not be read back, so it could not be verified.');
    if (handle._identityPolicyRules) {
      const mine = `sandbox:${handle.sandbox_id}`;
      // Hash effective rules, not generated IDs, sandbox names or timestamps.
      // Include inherited denies as well as allowances and the sandbox's rules.
      const active = JSON.parse(result.stdout).rules.filter(rule => rule?.status === 'active' && rule.resource_type === 'network');
      // Reuse needs every rule to name exactly all sandboxes or one sandbox. A pattern or a
      // scope that disagrees with applies_to can reach this sandbox without entering the hash.
      const exact = rule => rule.applies_to === 'all' ? [undefined, 'global'].includes(rule.scope)
        : /^sandbox:wf-[0-9a-f]{16}$/.test(rule.applies_to) && [undefined, rule.applies_to].includes(rule.scope);
      if (!active.every(exact)) handle._identityPolicyNoReuse = true;
      handle._identityPolicyRules.push(active
        .filter(rule => rule.applies_to === 'all' || rule.applies_to === mine)
        .map(rule => ({ scope: rule.applies_to === mine ? 'sandbox' : 'all',
          decision: rule.decision, resources: [...rule.resources].sort() }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    }
    return listing;
  }

  /** `sbx policy check` for each target, a few at a time. Every target must be `expected`. */
  async _verifyDecisions(handle, targets, expected, failPolicy, record = false) {
    const queue = [...new Set(targets)];
    if (handle._identityPolicyChecks) {
      handle._identityPolicyChecks.push({ targets: queue, expected, failPolicy, record });
      return;
    }
    const worker = async () => {
      for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
        const result = await this._runJobCommand(handle, ['policy', 'check', 'network', '--sandbox', handle.sandbox_id, '--json', target]);
        const actual = parseNetworkPolicyDecision(result);
        if (record) handle._policyVerification[target] = actual;
        if (actual !== expected) {
          this._verifiedIdentityPolicies = new Map();
          failPolicy(`Network policy verification failed for ${target}: expected ${expected}, observed ${actual}.`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POLICY_CHECK_WORKERS, queue.length) }, worker));
  }

  /**
   * The ordinary post-install sentinel checks as one bounded read-only group: every `{target, expected}` is checked
   * (no dedupe, so a target named twice is checked against both expectations), at most WORKERS at a time, each through
   * `_runJobCommand` with all its fences. After a failure no further check starts and every check already started
   * settles before this returns, so nothing is still running when the caller fails the phase and cleans up. The
   * outcome is then read in list order: the first failing sentinel in that order is the one reported, with the
   * recorded verification holding only the sentinels up to and including it, exactly as one-at-a-time checking
   * would have left it. A mismatch drops the reusable identity-probe proof, as `_verifyDecisions` does.
   */
  async _verifyDecisionGroup(handle, checks, failPolicy, record = false) {
    const outcomes = new Array(checks.length);
    let next = 0, stopped = false;
    const worker = async () => {
      while (!stopped && next < checks.length) {
        const index = next++, { target, expected } = checks[index];
        try {
          const result = await this._runJobCommand(handle, ['policy', 'check', 'network', '--sandbox', handle.sandbox_id, '--json', target]);
          const actual = parseNetworkPolicyDecision(result);
          outcomes[index] = { actual };
          if (actual !== expected) stopped = true;
        } catch (error) {
          outcomes[index] = { error };
          stopped = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(POLICY_CHECK_WORKERS, checks.length) }, worker));
    for (let index = 0; index < checks.length && outcomes[index]; index++) {
      const { target, expected } = checks[index], { actual, error } = outcomes[index];
      if (error) throw error;
      if (record) handle._policyVerification[target] = actual;
      if (actual !== expected) {
        this._verifiedIdentityPolicies = new Map();
        failPolicy(`Network policy verification failed for ${target}: expected ${expected}, observed ${actual}.`);
      }
    }
  }

  /** Reuse only a complete successful status-probe check, on the same backend and exact policy. */
  async _verifyIdentityPolicy(handle) {
    const checks = handle._identityPolicyChecks;
    delete handle._identityPolicyChecks;
    const hash = createHash('sha256').update(JSON.stringify({
      binary: sbxBin(), home: sbxHome(), version: this._diagnosticEvidence?.version ?? null,
      rules: handle._identityPolicyRules,
      checks: checks.map(({ targets, expected, record }) => ({ targets, expected, record })),
    })).digest('hex');
    delete handle._identityPolicyRules;
    // An unknown sbx version, or a rule the hash cannot describe, is checked every time.
    const reusable = !handle._identityPolicyNoReuse && this._diagnosticEvidence?.version != null;
    delete handle._identityPolicyNoReuse;
    const policies = this._verifiedIdentityPolicies;
    const cached = reusable ? policies.get(hash) : undefined;
    if (cached) {
      handle._policyVerification = { ...cached };
      return;
    }
    for (const { targets, expected, failPolicy, record } of checks)
      await this._verifyDecisions(handle, targets, expected, failPolicy, record);
    await this.assertActive(handle);
    handle._prepareSignal?.throwIfAborted?.();
    // Invalidation replaces the map; in-flight work must not restore an obsolete proof.
    if (reusable && this._verifiedIdentityPolicies === policies) {
      policies.set(hash, { ...handle._policyVerification });
      while (policies.size > IDENTITY_POLICY_CACHE_LIMIT) policies.delete(policies.keys().next().value);
    }
  }

  /** Drop reusable evidence after a probe that did not finish with an answer. */
  forgetIdentityPolicy() { this._verifiedIdentityPolicies = new Map(); }

  async _configureEgress(handle) {
    handle._policyVerification = {};
    const failPolicy = (message) => { throw policyError('policy_unenforceable', message, { policy_verification: { ...handle._policyVerification } }); };
    const restricted = handle._egress !== 'internet';
    const registryHosts = handle._registryHosts || [];
    // A sandbox inherits every global allowance (sbx's default has ~190, among them **.amazonaws.com and GitHub), and a
    // deny beats an allow. So a restricted job denies, per sandbox, each inherited allowance it did not ask for.
    let plan = null;
    const baseline = restricted || handle._identityPolicyChecks ? await this._readPolicy(handle, failPolicy) : null;
    if (restricted) {
      // The agent kit's own allowances were scoped to this sandbox by `sbx run`, before any rule of ours.
      const kit = baseline.ownAllow.flatMap(rule => rule.resources);
      plan = planNetworkDeny({ inherited: baseline.inheritedAllow, agent: [...handle._providerHosts, ...registryHosts], kit, source: handle._sourceHosts || [] });
      if (plan.refused.length) failPolicy('The global network policy allows more than this job asked for, and that cannot be denied without blocking the job.');
      // Kit permissions provision the image; they are not authority granted by
      // the borrower. Remove them before installing the signed run policy.
      // sbx 0.50 refuses to remove a kit-managed rule ("recreated at sandbox create"). A kit rule that stays must then
      // grant nothing beyond the job's own hosts: each of its resources is one the job asked for or one denied by a
      // rule of ours, and a deny beats an allow (checked and probed after the denies are installed, below).
      for (const rule of baseline.ownAllow) {
        if (typeof rule.id !== 'string' || !rule.id) failPolicy('A sandbox allow rule has no removable identity.');
        await this._runJobCommand(handle, ['policy', 'rm', 'network', '--sandbox', handle.sandbox_id, '--id', rule.id, '--force']);
      }
      handle._policyPlan = plan;
      handle._execution ??= {};
      handle._execution.network_kit = { hosts: [...new Set(kit.filter(resource =>
        [...handle._providerHosts, ...registryHosts].some(host => covers(host, resource))).map(resourceHost))].slice(0, 32), wider: [] };
    }
    for (const [action, resources] of [
      // Registries a job did not ask for are denied explicitly: sbx's global policy may allow them.
      ['deny', !restricted ? [...PRIVATE_NETWORK_DENIES, ...(handle._inertDeny ?? [])] : [...PRIVATE_NETWORK_DENIES,
        ...Object.values(REGISTRY_HOSTS).flat().filter(host => !handle._registryHosts?.includes(host)), ...plan.deny, ...(handle._inertDeny ?? [])]],
      ['allow', !restricted ? ['**'] : [...new Set([...handle._providerHosts, ...registryHosts])]],
      // GitHub for the clone gets its own rule, so it can be removed again once the code is in.
      ...(restricted && plan.sourceOnly.length ? [['allow', plan.sourceOnly]] : []),
    ]) {
      // A provider-free check with no registry or source host has nothing to allow.
      if (!resources.length) continue;
      const result = await this._runJobCommand(handle, ['policy', action, 'network', '--sandbox', handle.sandbox_id, [...new Set(resources)].join(',')]);
      if (result.code !== 0) failPolicy('Per-sandbox network policy could not be installed.');
    }
    const provider = handle._providerHosts[0]?.replace(/^\*\*?\./, 'api.');
    const sentinels = [...(provider ? [[provider, 'allowed']] : []), ['10.0.0.1', 'denied'], ['192.168.1.1', 'denied'], ['169.254.169.254', 'denied'],
      ['mcp-gateway.docker.internal:80', 'denied'], ['mcp-gateway.docker.internal:443', 'denied']];
    if (restricted) {
      sentinels.push(['example.com', 'denied']);
      for (const host of new Set(Object.values(REGISTRY_HOSTS).flat()))
        sentinels.push([host, handle._registryHosts?.includes(host) ? 'allowed' : 'denied']);
      for (const host of handle._sourceHosts || []) sentinels.push([host, 'allowed']);
    }
    // A status probe keeps each sentinel as its own recorded check: its reuse proof hashes that exact list.
    if (handle._identityPolicyChecks) for (const [target, expected] of sentinels) await this._verifyDecisions(handle, [target], expected, failPolicy, true);
    else await this._verifyDecisionGroup(handle, sentinels.map(([target, expected]) => ({ target, expected })), failPolicy, true);
    const installedPolicy = restricted || handle._identityPolicyChecks ? await this._readPolicy(handle, failPolicy) : null;
    if (restricted) {
      // Every inherited allowance the job did not ask for must now be denied: the rule is installed, and it takes effect.
      const installed = new Set(installedPolicy.ownDeny);
      // A provider-free check also needs its inert and provider denies in the readback: a deny that did not install
      // would leave the provider reachable.
      const required = [...plan.deny, ...(handle._providerFree ? handle._inertDeny ?? [] : [])];
      const missing = required.filter(resource => !installed.has(resource));
      if (missing.length) failPolicy(`Network policy verification failed: ${missing.length} inherited allowance(s) were not denied.`);
      const needed = [...handle._providerHosts, ...registryHosts, ...plan.sourceOnly];
      const keptDenied = [];
      for (const resource of installedPolicy.ownAllow.flatMap(rule => rule.resources)) {
        if (installed.has(resource)) keptDenied.push(resource);
        else if (!needed.some(host => covers(host, resource))) failPolicy('Sandbox kit permissions grant more than this job asked for.');
      }
      // A kit allowance that stayed is denied only by our rule, so each one is probed, not sampled.
      await this._verifyDecisions(handle, [...sampleForChecks(plan.deny), ...keptDenied].map(probeTarget), 'denied', failPolicy);
    }
  }

  /**
   * A Git source needs GitHub only while the code is fetched, before the agent starts. Remove the clone's allow rule and
   * deny GitHub again, then prove it. sbx applies a rule to a running sandbox at once (checked live, 2026-10-19), and refuses a
   * deny that equals an allow rule in the same sandbox, so the allow goes first. The agent never runs with GitHub open
   * unless its provider is GitHub itself, which the receipt records as `whole_run`.
   */
  async _closeSourceWindow(handle) {
    const plan = handle._policyPlan;
    if (!plan || !handle._sourceHosts?.length) return;
    handle._execution ??= {};
    if (plan.window) {
      const failPolicy = (message) => { throw policyError('policy_unenforceable', message, { policy_verification: { ...handle._policyVerification } }); };
      const remove = new Set(plan.window.remove);
      const own = (await this._readPolicy(handle, failPolicy)).ownAllow.filter(rule => rule.resources.every(resource => remove.has(resource)));
      for (const rule of own) {
        const removed = await this._runJobCommand(handle, ['policy', 'rm', 'network', '--sandbox', handle.sandbox_id, '--id', rule.id, '--force']);
        if (removed.code !== 0) failPolicy('GitHub could not be closed again after the code was fetched.');
      }
      const denied = await this._runJobCommand(handle, ['policy', 'deny', 'network', '--sandbox', handle.sandbox_id, plan.window.deny.join(',')]);
      if (denied.code !== 0) failPolicy('GitHub could not be closed again after the code was fetched.');
      await this._verifyDecisions(handle, [...sampleForChecks(plan.window.deny).map(probeTarget), ...plan.window.remove], 'denied', failPolicy);
      // A provider-free check has no provider host that must stay open after the clone.
      if (handle._providerHosts.length) await this._verifyDecisions(handle, [handle._providerHosts[0].replace(/^\*\*?\./, 'api.')], 'allowed', failPolicy);
    }
    handle._execution.network_scope = plan.scope;
  }

  /**
   * `sbx cp SRC DST`, one side a `SANDBOX:PATH` — confirmed against a real
   * sbx v0.35.0 install's `sbx cp --help`, matching the shape used below.
   * `sbx cp` REQUIRES an absolute guest path ("container path must be
   * absolute (use SANDBOX:/path)") — confirmed live. The guest's absolute
   * workspace directory mirrors the host-side scratch_dir path passed as
   * `sbx run`'s PATH argument (confirmed live: `sbx exec <sandbox> -- pwd`
   * inside a freshly-created sandbox returns the exact host scratch_dir
   * path) — so a declared relative dest is resolved against handle.scratch_dir.
   */
  async _copyIn(handle, input) {
    const localPath = path.join(handle.scratch_dir, '.wf-inputs', input.artifact_id.replace(/[^A-Za-z0-9_.-]/g, '_'));
    await mkdir(path.dirname(localPath), { recursive: true });
    // The artifact-fetch-by-id step (resolving artifact_id to bytes on disk)
    // belongs to the caller/CAS layer, not this backend; this backend only
    // moves already-materialized local bytes into the guest.
    const remoteDest = `${handle.sandbox_id}:${path.posix.join(handle.scratch_dir, input.dest)}`;
    const result = await this._runJobCommand(handle, ['cp', localPath, remoteDest]);
    if (result.code !== 0) {
      throw policyError('input_copy_failed', `sbx cp (input ${input.artifact_id} -> ${input.dest}) failed: ${result.stderr || `exit ${result.code}`}`);
    }
  }

  async syncWorkspace(handle) {
    if (!handle._mountless) return;
    const copied = await this._runJobCommand(handle, ['cp', handle.scratch_dir + '/.', handle.sandbox_id + ':' + handle.scratch_dir]);
    if (copied.code !== 0) throw policyError('input_copy_failed', 'Could not copy the bounded source into the guest.');
  }

  /**
   * Clone an approved GitHub URL in a dedicated wf-gh-cli sandbox, then copy
   * only the resulting working tree into the task sandbox's workspace. The
   * real PAT remains behind the kit proxy throughout; git source bytes are
   * never fetched by the contributor host process.
   */
  async cloneGitSource(handle, { url, ref, commit, kind, object_format } = {}) {
    if (commit !== undefined || kind === 'git') return this._clonePinnedGitSource(handle, { url, commit, object_format });
    if (typeof url !== 'string' || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url)) throw policyError('git_source_invalid', 'git source must be a validated github.com HTTPS repository URL');
    assertSbxRuntime(handle._sbxRuntime,{env:sbxChildEnv()});
    const cloneHandle = await this.prepare({
      job_id: `${handle.job_id}-git`, image: 'wf-gh-cli', entrypoint: 'true', inputs: [], output_manifest: [],
      execution_scope: handle._executionScope, auth_strategy: 'host-env-proxy',
      resources: { ...handle._resources }, egress: handle._egress, provider_hosts: [...(handle._providerHosts || [])],
      ...(handle._egress === 'provider+registries' ? { registries: Object.keys(REGISTRY_HOSTS).filter(name => REGISTRY_HOSTS[name].every(host => handle._registryHosts?.includes(host))) } : {}),
      source_hosts: ['github.com', 'codeload.github.com'],
      required_limits: [...ENFORCED_LIMITS, ...(handle._mountless ? ['guest_block_device_capacity'] : [])],
    }, handle._deadline, {sbxRuntime:handle._sbxRuntime});
    try {
      // Public repos must not require an account at all. Only after the
      // anonymous Git transport fails do we invoke gh, whose kit-proxied
      // static task credential can satisfy a private GitHub repository.
      const anonymousCommand = `git clone --depth 1${ref ? ` --branch ${shellQuote(ref)}` : ''} ${shellQuote(url)} repo`;
      let clone = await this._runJobCommand(cloneHandle, ['exec', cloneHandle.sandbox_id, '--', 'sh', '-c', anonymousCommand]);
      if (clone.code !== 0) {
        const authenticatedCommand = `gh repo clone ${shellQuote(url)} repo${ref ? ` -- --branch ${shellQuote(ref)}` : ''}`;
        clone = await this._runJobCommand(cloneHandle, ['exec', cloneHandle.sandbox_id, '--', 'sh', '-c', authenticatedCommand]);
      }
      if (clone.code !== 0) throw policyError('git_source_unavailable', `Git repository clone failed inside the task sandbox. Set up GitHub access for a private repository, or verify the URL/ref: ${clone.stderr || clone.stdout || `exit ${clone.code}`}`);
      const remoteSource = `${cloneHandle.sandbox_id}:${path.posix.join(cloneHandle.scratch_dir, 'repo')}`;
      const localDestination = path.join(handle.scratch_dir, 'repo');
      const copied = await this._runJobCommand(cloneHandle, ['cp', remoteSource, localDestination]);
      if (copied.code !== 0) throw policyError('git_source_transfer_failed', `Could not transfer the sandbox-cloned Git repository into the task workspace: ${copied.stderr || copied.stdout || `exit ${copied.code}`}`);
    } finally {
      await this.destroy(cloneHandle).catch(() => {});
    }
    await this._closeSourceWindow(handle);
  }

  /** @param {import('./runtime.mjs').SandboxHandle} handle */

  async _clonePinnedGitSource(handle, { url, commit, object_format }) {
    if (handle._execution) delete handle._execution.verified_commit;
    let parsed;
    try { parsed = new URL(url); } catch {}
    if (typeof url !== 'string' || !parsed || parsed.protocol !== 'https:' || !parsed.hostname ||
        parsed.username || parsed.password || parsed.search || parsed.hash || /[\s\\\x00-\x1f]/.test(url) ||
        !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit || '') ||
        (object_format !== undefined && !['sha1','sha256'].includes(object_format)) ||
        (object_format === 'sha1' && commit.length !== 40) || (object_format === 'sha256' && commit.length !== 64)) {
      throw policyError('git_source_invalid', 'Git sources require a credential-free HTTPS URL and an exact lowercase commit matching its object format.');
    }
    // No host git, submodules, gh fallback or credential helper. Redirects are
    // disabled so the validated transport cannot silently change destination.
    const git = 'GIT_TERMINAL_PROMPT=0 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c credential.helper= -c core.askPass= -c http.followRedirects=false -c protocol.allow=never -c protocol.https.allow=always';
    const commands = [
      git + ' clone --no-checkout -- ' + shellQuote(url) + ' repo',
      git + ' -C repo checkout --detach ' + shellQuote(commit),
    ];
    for (const command of commands) {
      const result = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c', command]);
      if (result.code !== 0) throw policyError('git_source_unavailable', 'Pinned Git source could not be cloned and checked out inside the sandbox.');
    }
    const head = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'git', '-C', 'repo', 'rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0 || ![commit, commit + '\n', commit + '\r\n'].includes(head.stdout)) {
      throw policyError('git_commit_mismatch', 'Sandbox Git HEAD did not match the requested commit.');
    }
    handle._execution ??= {};
    handle._execution.verified_commit = commit;
    await this._closeSourceWindow(handle);
  }

  /**
   * Runs the entrypoint. With `lendingBudget` (see normalizeLendingBudget) the agent runs under faravan-guard:
   * `onMeter(reading)` receives each live allowance/usage reading and `onHeartbeat({seq})` each guard beat;
   * neither reaches `onLog`, stdout or stderr kept on the handle. A Faravan-imposed stop (budget, owner,
   * time, provider_limit) returns normally with `{stop}` so the caller collects the work so far.
   * Resolves `{stop: StopRecord|null, meter: last reading|null}`; without a guard, `{stop:null, meter:null}`.
   * Meter readings are the lender's own record: keep them local, never in a public receipt.
   */
  async snapshotEgress(handle, {signal} = {}) {
    try {
      const log=await this._runJobCommand(handle,['policy','log',handle.sandbox_id,'--json'],undefined,{signal});
      return observedEgressCounts(log,handle.sandbox_id);
    }catch {return null;}
  }

  async start(handle, { onLog, signal, reserveSeconds = 0, lendingBudget = null, onMeter, onHeartbeat, onExecutionStarted, onLaunchDurable } = {}) {
    if (signInHandles.has(handle)) throw policyError('policy_unenforceable', 'A sign-in sandbox cannot execute a job.');
    // An added account's check may have failed since this job was prepared.
    if (handle._admitClaude) await handle._admitClaude();
    // The run clock starts at this protected handoff. Before it can be rebased the preparation must be unexpired and the
    // sandbox's independent deadline watchdog and durable binding must still be acknowledged (the same fence every guest
    // command passes). Nothing is replaced: the durable deadline keeps the outer end reserved at prepare.
    // Host-owned bookkeeping commands (source checks, status probe, git base) reuse this method on the same handle before the
    // agent and are not the handoff: they run on the preparation clock.
    const handoff = handle._bookkeeping !== true && handle._deadline?.phase === 'prepare' && Boolean(handle._deadline.runClock);
    // Prove the watchdog before switching clocks. Each guest launch also checks it after daemon preparation.
    await this.assertActive(handle, { agentRun: true, guestCommand: handoff });
    if (handoff) this._beginRunClock(handle);
    // `sbx exec SANDBOX COMMAND [ARG...]` mirrors `docker exec` (confirmed
    // against a real sbx v0.35.0 install) — the correct way to drive a task in
    // a prepared sandbox; provider preparation uses create without a default
    // agent session. `entrypoint` is a HarnessSpec-shaped
    // command STRING (e.g. 'codex exec --dangerously-bypass-approvals-and-
    // sandbox'), not a single guest binary name, so it must be split into
    // argv words the same way the harness-proof script's proven
    // `sbx exec "$sandbox" -- $entrypoint "$TASK_PROMPT"` pattern does
    // (deliberately unquoted there for word-splitting) — passed here through
    // `sh -c` so the guest shell performs that same splitting, keeping this
    // backend's own argv construction free of a second, potentially
    // divergent tokenizer. See docs/history/design/archive/FEDERATION_V0_UAT_REPORT.md
    // "Autonomous fix loop" for the live reproduction of the entrypoint-
    // never-driven bug this replaces.
    let command = handle._entrypoint;
    let agentSeconds = null;
    if (reserveSeconds) {
      if (reserveSeconds !== VERIFY_RESERVE_SECONDS) throw policyError('policy_unenforceable', 'Invalid verification reserve.');
      agentSeconds = Math.floor((handle._deadline.endsAt - this.monotonic()) / 1000) - reserveSeconds;
      if (agentSeconds < 1) throw policyError('wall_timeout', 'No agent time remains before the checks reserve.');
    }
    const lending = lendingBudget ? normalizeLendingBudget(lendingBudget) :
      onExecutionStarted || onLaunchDurable ? { agent: 'generic', budget: null, soft_deadline_s: null } : null;
    const guard = lending ? await this._installGuard(handle, lending, agentSeconds) : null;
    const launchSecret=onLaunchDurable?randomBytes(32).toString('hex'):null;
    if (guard && launchSecret) {
      const expected=createHash('sha256').update(launchSecret).digest('hex');
      command = 'until printf %s '+shellQuote(expected+'  '+guard.ctl+'/launch-ack\n')+
        ' | /usr/bin/sha256sum -c - >/dev/null 2>&1; do sleep 0.1; done; '+command;
    }
    if (guard) {
      // Best-effort wall backstop in the guest, for every guarded run (every lender run has a guard): it kills the agent's
      // process group, which the guard made, at the sandbox deadline plus the guard's stop window, with no host process
      // alive. It does NOT stop an agent that leaves that group (setsid, double fork). On a dead lender such an agent keeps
      // running until the lender restarts; restart recovery force-removes the sandbox before the lender claims again
      // (reconcilePending, lender.mjs main loop). The launch fence's time bound (store.mjs fenceBound) relies on that.
      // The watchdog ends with the run's shell.
      const t = this.guardTimings, hardSeconds = Math.ceil((handle._deadline.endsAt - this.monotonic()) / 1000) +
        Math.ceil((t.sigint_grace_ms + t.sigterm_grace_ms + 2000) / 1000);
      command = 'e=$(($(date +%s)+' + Math.max(1, hardSeconds) + ')); (while kill -0 $$ 2>/dev/null; do ' +
        '[ "$(date +%s)" -lt "$e" ] || kill -KILL 0; sleep 0.2; done) & ' + command;
      command = guestRuntimeCommand(handle._execution.guard_runtime, guardRunCommand({ guardPath: guard.path, runtimePath: handle._execution.guard_runtime.node, config: guard.config, agentCommand: command }));
    }
    if (agentSeconds) command = '/usr/bin/timeout --signal=KILL ' + agentSeconds + 's sh -c ' + shellQuote(command);

    // A disk stop during this run halts the sandbox, which kills every writer in it, root processes and inner
    // containers included. The run then ends as a lender stop and its work so far is collected. A step that
    // collects that work (a copy of the handle, started after the stop) runs as usual.
    // A start after destroy() would open a watch that nothing closes. A deadline that removed the sandbox
    // keeps its own reason.
    if (this._diskRemoved.has(handle.sandbox_id)) {
      if (handle._deadline?.expired) await this.assertActive(handle);
      throw policyError('sandbox_start_failed', `Sandbox ${handle.sandbox_id} was already removed.`);
    }
    const disk = this._diskSentry(handle);
    const lowBefore = disk.low !== null;
    let result;
    try {
    if (guard) {
      handle._lending = { guard, stop: null, meter: null, readings: [], heartbeat_seq: null, hard_stop: null, requested: new Set(), exit: null, executionObserved: false };
      let executionObserved = false;
      const filter = lendingFilter({ onLog, onGuard: (entry) => {
        if (entry.type === 'started') {
          if (entry.nonce === guard.config.nonce && !executionObserved) {
            executionObserved = true;
            handle._lending.executionObserved = true;
            Promise.resolve().then(async () => {
              if(onLaunchDurable) {
                await onLaunchDurable({at:entry.at});
                const ack=await this._runJobCommand(handle,['exec',handle.sandbox_id,'--','sh','-c',
                  'printf %s '+shellQuote(launchSecret)+' > '+shellQuote(guard.ctl+'/launch-ack')],null,{signal});
                if(ack.code!==0)throw policyError('launch_ack_failed','The launch acknowledgement could not be written into the sandbox.');
              }
              return onExecutionStarted?.({at:entry.at});
            }).catch((error) => {
              handle._lending.observationError = error;
              // The agent waits for the acknowledgement, which was not written. Stop it, and report why.
              if (error?.code === 'claude_account_unavailable') { handle._lending.accountError = error; this._hardStop(handle, 'claude_account_unavailable').catch(() => {}); }
            });
          }
          return;
        }
        if (entry.type === 'exit') {
          // Diagnostic only: guest code can forge these lines. Never authorize success or delivery from them.
          if (entry.nonce === guard.config.nonce && executionObserved) handle._lending.exit = entry;
          return;
        }
        if (entry.type === 'heartbeat') { guard.lastBeat = this.monotonic(); handle._lending.heartbeat_seq = entry.seq; onHeartbeat?.({ seq: entry.seq }); return; }
        if (entry.type !== 'meter') return;
        handle._lending.meter = entry;
        if(entry.source==='codex-rollout'&&Number.isFinite(entry.used_units))handle._lending.lastUsageAt=this.monotonic();
        // The kept log is capped; a limit sighting is remembered on its own so the cap cannot hide it.
        if (entry.limit_reached || entry.overage) handle._lending.saw_provider_limit = true;
        if (handle._lending.readings.length < 2000) handle._lending.readings.push(entry);
        onMeter?.(entry);
      } });
      guard.lastBeat = guard.startedAt = this.monotonic();
      const watchdog = setInterval(() => {
        if(handle._lending.hard_stop)return;
        const at=this.monotonic();
        if(at-guard.lastBeat>=this.guardTimings.heartbeat_loss_ms){
          this._hardStop(handle,'guard_heartbeat_lost').catch(()=>{});return;
        }
        // Usage evidence has its own deadline: a heartbeat cannot stand in for it.
        const last=handle._lending.lastUsageAt,age=at-(last??guard.startedAt);
        const limit=last===undefined?guard.config.meter_start_ms:guard.config.meter_loss_ms;
        if(lending.agent==='codex'&&lending.budget&&age>=limit&&!handle._lending.meterStop){
          handle._lending.meterStop=true;this.requestStop(handle,'error').catch(()=>this._hardStop(handle,'meter_unavailable').catch(()=>{}));
        }
      }, Math.min(5_000,this.guardTimings.heartbeat_loss_ms/4,this.guardTimings.meter_start_ms/4));
      watchdog.unref?.();
      const running = this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c', command], (entry) => filter.push(entry), {signal,onExecutionStarted,agentRun:!lowBefore&&!handle._bookkeeping});
      // Resolves true only when the guard process itself exited 0, which it does only after the agent's process group ceased.
      guard.running = running.then((done) => done?.code === 0, () => false);
      try { result = await running; } finally { clearInterval(watchdog); }
      result = { ...result, ...filter.end() };
      guard.finished = true;
      if (handle._lending.accountError) throw handle._lending.accountError;
      if (handle._lending.hard_stop) {
        throw Object.assign(policyError(handle._lending.hard_stop === 'guard_runtime_unavailable' ? 'guard_runtime_unavailable' : handle._lending.hard_stop === 'guard_heartbeat_lost' ? 'guard_heartbeat_lost' : 'stopped_without_delivery',
          handle._lending.hard_stop === 'guard_runtime_unavailable' ? RUNTIME_HELP : handle._lending.hard_stop === 'guard_heartbeat_lost' ? 'The lending guard stopped answering, so the job was stopped.' : 'The job was stopped; its work could not be kept.'), {exitCode: result.code ?? null, guardExit: handle._lending.exit, stdout: result.stdout, stderr: result.stderr});
      }
    } else {
      result = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c', command], onLog, {signal,onExecutionStarted,agentRun:!lowBefore&&!handle._bookkeeping});
    }
    } catch (error) {
      if (lowBefore || !disk.low) throw error;
    }
    if (!lowBefore && disk.low) {
      handle._lending?.requested.add('owner');
      await disk.halt;
      if (disk.low.halt_error) throw policyError(disk.low.reason ?? 'host_disk_low', hostDiskStop(disk.low) + ' The sandbox could not be halted, so its work was not kept.');
      // Collecting the work restarts the halted sandbox, and only boot-time services run then. Inner
      // containers set to restart would write again, so they are stopped for good. The watch is already
      // armed again: until the sandbox is removed, a second low reading halts it and nothing is delivered.
      disk.collecting = true;
      await this._runJobCommand(handle, ['exec', '-u', 'root', handle.sandbox_id, '--', 'sh', '-c', INNER_CONTAINERS_OFF]).catch(() => {});
      handle._lastExecStdout = result?.stdout ?? '';
      handle._lastExecStderr = result?.stderr ?? '';
      handle._execution ??= {};
      handle._execution.host_disk_low = true;
      handle._execution.host_disk_reason = disk.low.reason ?? 'host_disk_low';
      handle._execution.host_disk_detail = hostDiskStop(disk.low);
      if (guard && handle._lending) handle._lending.stop = { schema: 'faravan.stop.v1', nonce: guard.config.nonce, stop_reason: 'owner',
        budget_units: null, used_units: null, agent_exit: null, signal: 'SIGKILL' };
      return { stop: handle._lending?.stop ?? null, meter: handle._lending?.meter ?? null, host_disk_low: true, host_disk_reason: disk.low.reason ?? 'host_disk_low', host_disk_detail: hostDiskStop(disk.low) };
    }
    const reserveBoundary = Boolean(agentSeconds) && [124, 137].includes(result.code);
    // Reaching the reserved boundary stops the agent's process group; checks still run.
    if (result.code !== 0 && !reserveBoundary) {
      // Raw output rides on the error for local classification only; callers never show it.
      const detail = codexErrorTail(result.stdout);
      const diagnostic = guard ? handle._lending?.exit ?? null : null;
      if (guestRuntimeCheckFailed(result) || guard && !handle._lending?.executionObserved && runtimeStartFailed(result)) throw runtimeError();
      let code = 'entrypoint_start_failed';
      if (guard && handle._lending?.executionObserved) {
        code = diagnostic?.group_ceased === false ? 'agent_group_not_ceased' :
          diagnostic && !diagnostic.stop_imposed && !diagnostic.outside_signal &&
          ((diagnostic.agent_exit_code !== null && diagnostic.agent_exit_code !== 0) || diagnostic.agent_signal) ? 'agent_exit_nonzero' : 'agent_run_failed';
      }
      const message = code === 'entrypoint_start_failed' ? 'The agent could not be started.' :
        code === 'agent_group_not_ceased' ? 'The agent exited, but a process it started was still running.' :
        code === 'agent_exit_nonzero' ? 'The agent ended with an error.' : 'The agent stopped before the run could finish.';
      throw Object.assign(new Error(`${message} exit ${result.code ?? 'unknown'}${detail ? '\n' + detail : ''}${result.stderr ? '\n' + result.stderr : ''}`),
        { code, stdout: result.stdout, stderr: result.stderr, exitCode: result.code ?? null, guardExit: diagnostic });
    }
    if (guard && reserveBoundary) {
      // timeout's KILL reached the guard, not the agent's own process group.
      await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c',
        'p=$(head -c 20 ' + shellQuote(guard.ctl + '/agent.pgid') + ' 2>/dev/null) && case "$p" in (*[!0-9]*|"") ;; (*) kill -KILL -- "-$p" 2>/dev/null ;; esac; true']).catch(() => {});
    }
    if (guard && result.code === 0) {
      const read = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c', 'head -c 4097 ' + shellQuote(guard.ctl + '/stop.json') + ' 2>/dev/null; true']);
      const text = read.code === 0 ? read.stdout.trim() : '';
      handle._lending.stop = text ? validateStopRecord(text, { nonce: guard.config.nonce }) : null;
      if (text && !handle._lending.stop) throw policyError('guard_record_invalid', 'The lending guard left a stop record that could not be trusted.');
      if (handle._lending.stop && !this._stopCorroborated(handle, lending, result.stdout)) {
        throw policyError('guard_record_unverified', 'The lending guard reported a stop that Faravan did not see happen, so the work is not delivered as stopped.');
      }
    }
    handle._lastExecStdout = result.stdout;
    handle._lastExecStderr = result.stderr;
    // Read cumulative observations before teardown through the isolated sbx identity.
    // A failed read cannot preserve stale observations from an earlier command.
    handle._execution ??= {};
    handle._execution.egress_evidence = null;
    try {
      const log = await this._runJobCommand(handle, ['policy', 'log', handle.sandbox_id, '--json'], undefined, {signal});
      handle._execution.egress_evidence = handle._egressBaseline===null ? null : parseObservedEgress(log, handle.sandbox_id, {afterCounts:handle._egressBaseline});
    } catch {
      // Observability is optional; execution and cleanup authority are unchanged.
    }
    return { stop: handle._lending?.stop ?? null, meter: handle._lending?.meter ?? null };
  }

  async ensureGuestRuntime(handle) {
    handle._execution ??= {};
    handle._guestRuntimeInstall ??= (async () => {
      const readiness = handle._guardRuntimeCheck ?? await guardRuntimeReadiness({ home: sbxHome() }, this.guestRuntime);
      if (!readiness.ok) throw runtimeError();
      try {
        return handle._execution.guard_runtime = await installGuestRuntime({ runtime: readiness.runtime, mounted: handle._guardRuntimeMounted, sandboxId: handle.sandbox_id, run: args => this._runJobCommand(handle, args) });
      } catch(error) { if(error.code==='claude_account_unavailable')throw error;throw runtimeError(); }
    })();
    return handle._guestRuntimeInstall;
  }

  /** Copies the guard into the guest, outside the workspace, with a fresh control directory and nonce. */
  async _installGuard(handle, lending, agentSeconds) {
    const nonce = randomBytes(16).toString('hex');
    handle._execution ??= {};
    await this.ensureGuestRuntime(handle);
    const dir = '/tmp/faravan-guard-' + nonce.slice(0, 16);
    const guardPath = dir + '/faravan-guard.mjs';
    const ctl = dir + '/ctl';
    const made = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'mkdir', '-p', ctl]);
    if (made.code !== 0) throw policyError('guard_install_failed', 'Could not prepare the lending guard in the sandbox.');
    const copied = await this._runJobCommand(handle, ['cp', GUARD_SOURCE_PATH, `${handle.sandbox_id}:${guardPath}`]);
    if (copied.code !== 0) throw policyError('guard_install_failed', 'Could not copy the lending guard into the sandbox.');
    const remaining = agentSeconds ?? Math.floor((handle._deadline.endsAt - this.monotonic()) / 1000);
    const timings = this.guardTimings;
    const margin = timings.soft_deadline_margin_s;
    const wallSoft = remaining > margin * 2 ? remaining - margin : Math.max(1, Math.floor(remaining * 0.5));
    const soft = lending.agent === 'generic' ? null : lending.soft_deadline_s ? Math.min(lending.soft_deadline_s, wallSoft) : wallSoft;
    return { path: guardPath, ctl, lastBeat: 0, running: null, finished: false, config: {
      v: 1, mode: lending.agent, ctl, nonce, soft_deadline_s: soft, heartbeat_ms: timings.heartbeat_ms,
      sigint_grace_ms: timings.sigint_grace_ms, sigterm_grace_ms: timings.sigterm_grace_ms, meter_start_ms:timings.meter_start_ms,meter_loss_ms:timings.meter_loss_ms,budget: lending.budget } };
  }

  /**
   * Asks a guarded run to stop and keep its work: the guard sends SIGINT, the run ends, and the pending
   * start() resolves with `{stop}` so the caller collects as usual. If the guard does not answer, or the
   * run has not ended within `answerMs` (30 s), falls back to `sbx stop`, which discards the work, and the
   * pending start() rejects with `stopped_without_delivery`.
   * Resolves `{delivered: boolean, fallback: null|'hard', reason}`. Never aborts the caller's signal.
   * `onCessation()` is called once, when the guard's answer ended the run (never after a hard fallback), so a caller can
   * measure the Stop to effective cessation separately from the removal that follows.
   */
  async requestStop(handle, reason, { answerMs = this.guardTimings.stop_answer_ms, onCessation } = {}) {
    if (!STOP_REASONS.includes(reason)) throw new TypeError('unknown stop reason');
    const guard = handle._lending?.guard;
    if (!guard || guard.finished) return { delivered: false, fallback: null, reason, running: false };
    handle._lending.requested.add(reason);
    const asked = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c', guestRuntimeCommand(handle._execution.guard_runtime, guardStopCommand({ guardPath: guard.path, runtimePath: handle._execution.guard_runtime.node, ctl: guard.ctl, reason }))])
      .catch(() => null);
    if (asked?.code === 0) {
      let timer;
      const ended = await Promise.race([guard.running, new Promise((resolve) => { timer = setTimeout(() => resolve(false), answerMs); })]);
      clearTimeout(timer);
      // The guard ended the run: that is effective cessation. A caller measuring the Stop reads it here, before any removal.
      if (ended) { try { onCessation?.(); } catch { /* A measuring callback cannot change the Stop. */ } return { delivered: true, fallback: null, reason }; }
    }
    await this._hardStop(handle, !asked || guestRuntimeCheckFailed(asked) ? 'guard_runtime_unavailable' : 'owner_hard');
    return { delivered: false, fallback: 'hard', reason };
  }

  /**
   * A stop record is only a claim from the guest. Accept its reason only with host-side evidence: the host
   * asked for it (requestStop), the soft deadline really passed on the host clock, Claude's own result says
   * its budget cap ended the run, or the host's meter readings show the budget or a provider limit reached.
   */
  _stopCorroborated(handle, lending, stdout) {
    const { stop, guard, requested, meter } = handle._lending;
    const readings = meter ? [...handle._lending.readings, meter] : handle._lending.readings;
    if (requested.has(stop.stop_reason)) return true;
    switch (stop.stop_reason) {
      case 'time': return this.monotonic() >= guard.startedAt + guard.config.soft_deadline_s * 1000 - 2_000;
      case 'error': return lending.agent==='codex'&&lending.budget&&this.monotonic()-(handle._lending.lastUsageAt??guard.startedAt)>=(handle._lending.lastUsageAt===undefined?guard.config.meter_start_ms:guard.config.meter_loss_ms);
      case 'provider_limit': return handle._lending.saw_provider_limit === true;
      case 'budget':
        if (!lending.budget) return false;
        if (lending.agent === 'claude') return String(stdout || '').split('\n').some((line) => {
          try { const event = JSON.parse(line); return event?.type === 'result' && event.subtype === 'error_max_budget_usd'; } catch { return false; }
        });
        // Price the reported tokens with the host's own weights; the guard's used_units is only its claim.
        return readings.some(({ tokens }) => {
          const { input = 0, cached_input = 0, output = 0 } = tokens || {};
          const { weights } = lending.budget;
          return Math.max(0, input - cached_input) * weights.input + cached_input * weights.cached_input + output * weights.output >= lending.budget.limit;
        });
      default: return false;
    }
  }

  async _hardStop(handle, why) {
    if (!handle._lending || handle._lending.hard_stop) return;
    handle._lending.hard_stop = why;
    await this.cancel(handle).catch(() => {});
  }

  /**
   * A new sandbox for verify_v1 checks, prepared after the agent's sandbox is removed. It gets the returned source, not
   * the agent's processes or changes outside that source. It uses the same image, limits and network policy as the
   * agent and never the GitHub task kit; whatever provider access sbx gives that image itself stays. Its name derives
   * from the job, so crash recovery finds it. The source hosts are allowed only when the check clones the source again:
   * that clone closes them before the check command runs.
   * Ownership and auth strategy are inherited, so borrowed checks also refuse native credential files.
   *
   * Its own deadline is the earlier of the job's and the caller's (`remainingMs`, read by the caller from its own wall
   * clock), less CHECK_REMOVAL_RESERVE_MS, so the check sandbox is gone before either deadline stops the job.
   *
   * `providerAccess: false` makes the check provider-free. A native generation is not read or copied, and no provider
   * variable is set. The provider's hosts are denied, not allowed, and that denial and the absence of provider variables
   * are verified before the check runs; a failed proof refuses the check with `credential_scope_unenforceable`. A global
   * sbx sign-in for the provider stays bound, as another agent's does, but is inert in this sandbox. An open job is
   * clamped to the registries, so its egress is never the open internet. Registry and source hosts are otherwise
   * unchanged. Anything other than `true`, and any budgeted (lending) agent, is provider-free.
   */
  async prepareCheck(agent, { cloneSource = false, remainingMs = Infinity, providerAccess = true } = {}) {
    assertSbxRuntime(agent._sbxRuntime,{env:sbxChildEnv()});
    const now = this.monotonic();
    const endsAt = Math.min(agent._deadline?.endsAt ?? Infinity, now + (Number.isFinite(remainingMs) ? remainingMs : Infinity)) - CHECK_REMOVAL_RESERVE_MS;
    if (!(endsAt > now)) throw policyError('wall_timeout', 'No time is left for a check sandbox.');
    const deadline = { controller: new AbortController(), expired: false, cleanup: null, handles: new Set(), endsAt, timer: null,
      externalDeadlineAt:agent.deadline_at,externalDeadlineClock:agent.deadline_clock };
    // A budgeted (lending) job's sign-in belongs to the lender, so its check is provider-free whatever the caller asked.
    const providerFree = Boolean(agent._lending) || providerAccess !== true;
    // A provider-free open job is clamped to the registries: the open internet can reach hosts a deny list cannot name.
    const clamped = providerFree && agent._egress === 'internet';
    const egress = clamped ? 'provider+registries' : agent._egress;
    return this.prepare({
      job_id: `${agent.job_id}-check`, image: agent._image, entrypoint: 'true', inputs: [], output_manifest: [],
      execution_scope: agent._executionScope,
      auth_strategy: agent._authStrategy,
      resources: { ...agent._resources }, egress, provider_hosts: [...(agent._providerHosts || [])],
      ...(egress === 'provider+registries' ? { registries: clamped ? Object.keys(REGISTRY_HOSTS) :
        Object.keys(REGISTRY_HOSTS).filter(name => REGISTRY_HOSTS[name].every(host => agent._registryHosts?.includes(host))) } : {}),
      ...(cloneSource && agent._sourceHosts?.length ? { source_hosts: [...agent._sourceHosts] } : {}),
      required_limits: [...ENFORCED_LIMITS, ...(agent._mountless ? ['guest_block_device_capacity'] : [])],
    }, deadline, { sbxRuntime:agent._sbxRuntime, githubKit: false, ...(providerFree ? { providerAccess: false } : {}) });
  }

  async verificationFiles(handle, workdir) {
    const command = 'cd ' + shellQuote(workdir) +
      ' && find . -type d \\( -name .git -o -name node_modules -o -name .wf-result -o -name .wf-outputs \\) -prune -o \\( -type f -o -type l \\) -exec sh -c ' +
      shellQuote('for f do h=$( (stat -c %a -- "$f" && if [ -L "$f" ]; then readlink -- "$f"; else cat -- "$f"; fi) | sha256sum) || exit; printf "%s  %s\\0" "\${h%% *}" "$f"; done') + ' sh {} +';
    const result = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c', command]);
    if (result.code !== 0) throw policyError('output_invalid', 'Could not observe test-file changes.');
    return result.stdout;
  }

  /**
   * Run the check command under a host watchdog. Only that timer firing makes `timed_out` true: an exit code (124, 137)
   * or anything the command prints is the command's own. When it fires, the exec is stopped and the sandbox is cancelled
   * before verify returns; the caller then removes it. `timeout_ms` is the limit the watchdog enforced.
   */
  async verify(handle, { cmd, workdir }) {
    const timeoutMs = Math.floor(Math.min(VERIFY_RESERVE_SECONDS * 1000, handle._deadline.endsAt - this.monotonic() - CHECK_STOP_MS));
    if (!(timeoutMs >= 1000)) return {exit:null,timed_out:false,stdout:'',skipped:'time'}; // never started
    const stop = new AbortController();
    let fired = false;
    const watchdog = this.deadlineTimers.setTimeout(() => { fired = true; stop.abort(); }, timeoutMs);
    watchdog.unref?.();
    let result;
    try {
      result = await this._runJobCommand(handle, ['exec', handle.sandbox_id, '--', 'sh', '-c', 'cd ' + shellQuote(workdir) + ' && sh -c ' + shellQuote(cmd)],
        undefined, { signal: stop.signal });
    } catch (error) {
      // Low host disk halts the check sandbox; the check is skipped and the caller removes the sandbox.
      const disk = this._diskSentries.get(handle.sandbox_id);
      if (disk?.low) { await disk.halt; return {exit:null,timed_out:false,stdout:'',skipped:'disk'}; }
      if (!fired) throw error;
    } finally {
      this.deadlineTimers.clearTimeout(watchdog);
    }
    if (fired) {
      // Stopping the host exec client does not stop the guest command; stopping the sandbox does.
      await this.cancel(handle).catch(() => {});
      return {exit:null,timed_out:true,timeout_ms:timeoutMs,stdout:''};
    }
    return {exit:Number.isInteger(result.code)?result.code:null,timed_out:false,timeout_ms:timeoutMs,stdout:result.stdout+'\n'+result.stderr};
  }

  /**
   * @param {import('./runtime.mjs').SandboxHandle} handle
   * @returns {AsyncGenerator<{stream: 'stdout'|'stderr', line: string}>}
   */
  async *streamLogs(handle) {
    const stdoutLines = (handle._lastExecStdout || '').split('\n').filter((line) => line.length > 0);
    const stderrLines = (handle._lastExecStderr || '').split('\n').filter((line) => line.length > 0);
    for (const line of stdoutLines) yield { stream: 'stdout', line };
    for (const line of stderrLines) yield { stream: 'stderr', line };
  }

  /**
   * @param {import('./runtime.mjs').SandboxHandle} handle
   * @param {string[]} manifest
   * @returns {Promise<{path: string, sha256: string, bytes: number}[]>}
   */
  async collectDeclaredOutputs(handle, manifest) {
    await this.assertActive(handle);
    const collected = [];
    let totalBytes = 0;
    for (const declaredPath of manifest || []) {
      if (!isSafeRelativeOutputPath(declaredPath)) {
        throw policyError('output_path_invalid', `refusing to collect unsafe output path: ${declaredPath}`);
      }

      const source = path.posix.join(handle.scratch_dir, declaredPath);
      const signal = handle._deadline?.controller.signal;
      let bytes;
      try {
        bytes = await daemonJobContext.run({handle, agentRun:false}, () => collectOutputStream(this.streamOutput(handle, source, { signal }),
          (handle._resources?.output_bytes ?? V1_MAX_LIMITS.output_bytes) - totalBytes));
      } catch (error) {
        await this.assertActive(handle);
        throw error;
      }
      totalBytes += bytes.size;
      await this.assertActive(handle);
      collected.push({ path: declaredPath, sha256: bytes.sha256, bytes: bytes.size, bytes_content: bytes.buffer });
    }

    return collected;
  }

  /** @param {import('./runtime.mjs').SandboxHandle} handle */
  async cancel(handle) {
    if((handle.owner_scope||handle.sbx_home)&&!this._rowHomeMatches(handle))throw policyError('cessation_unverified','The recorded sandbox HOME differs from the current HOME.');
    // Only this target's own create receipt authorizes a stop of its name.
    if(this.cleanupJournal.authority(handle)?.compute_created!==true)throw policyError('cessation_unverified','Faravan has no record that it created this sandbox, so it did not stop it.');
    // `sbx stop` preserves sandbox state (vs. `sbx rm`, which deletes it) —
    // appropriate for cancel, since destroy() is the caller's separate,
    // explicit teardown step.
    const result = await daemonJobContext.run({handle, agentRun:false}, () => this._rowRun(handle,['stop', handle.sandbox_id]));
    if (result.code !== 0) {
      throw policyError('sandbox_stop_failed', `sbx stop failed for sandbox ${handle.sandbox_id}: ${result.stderr || `exit ${result.code}`}`);
    }
  }

  /**
   * @param {import('./runtime.mjs').SandboxHandle} handle
   * @returns {Promise<import('./runtime.mjs').CleanupReceipt>}
   */
  async destroy(handle,{signal,watchInventory}={}) {
    // The watchdog can reach this path outside the executor. Keep the stopped
    // sandbox and scratch until the collected-output writer confirms retention.
    if (handle._outputHandoff && !await handle._outputHandoff) return {removed:false,scratch_removed:false};
    this._closeDiskSentry(handle);
    handle._deadline?.handles.delete(handle);
    if (!handle._deadline?.handles.size) {
      this.deadlineTimers.clearTimeout(handle._deadline?.timer);
      if (handle._deadline) handle._deadline.timer = null;
    }
    const compute = await this._resolveCompute(handle,{signal,watchInventory}).catch(error => {
      if(error?.recovery_hold?.error_code==='sbx_daemon_unavailable')throw error;
      return {removed:false};
    });
    if(compute.shared_watch)return {removed:false,watching:true,scratch_removed:false,policy_removed:false,sbx_home:handle.sbx_home};
    if(compute.background_watch)return {removed:false};
    return this._finishDestroy(handle,compute.removed,{signal,unknown:compute.unknown,watching:compute.watching,
      revocation:compute.revocation,removalObservation:compute.removalObservation});
  }

  // Resolve one target's compute through its own durable record. A create
  // receipt authorizes removal of a present sandbox. A never-observed create
  // can release resources only after fresh absence and its durable late-name
  // fence; client timeout alone is never materialization evidence.
  async _resolveCompute(handle,{signal,watchInventory}={}) {
    const snapshotCurrent=this._watchInventoryCurrent(watchInventory);
    if(!this._rowHomeMatches(handle))return {removed:false};
    let row=this.cleanupJournal.authority(handle);
    if(!row)return {removed:this.cleanupJournal.closed(handle)};
    if(row.watch_state==='watch_adopted')return {removed:false,watching:true,shared_watch:true};
    assertSbxRuntime(this._cleanupRuntime(handle,sbxChildEnv(),{recorded:handle._image===undefined}),{signal,env:sbxChildEnv()});
    if(row.create!=='dispatched')return {removed:true};
    if(row.create_refused===true&&row.create_settled===true&&row.compute_created===false&&row.compute_stopped===true)return {removed:true};
    // Saved observations establish materialization, but fresh inventory must
    // still prove absence before cleanup can complete.
    if(row.create_settled!==true&&this.sandboxDeadlines.observed?.(row)===true) {
      // Consume the bound supervisor observation under the journal's existing
      // locks. Keep version 2 and the established create flags for rollback.
      if(!this.cleanupJournal.mark(row,{compute_created:true,create_settled:true}))return {removed:false};
      row={...row,compute_created:true,create_settled:true};
    }
    // Only the record's owner lists or removes its name, and the deadline guard takes the same handle (without waiting) before it
    // removes. So this side takes it too, without waiting: a record the guard or a watcher holds is theirs for now, and the
    // answer is "someone else is acting on it". The handle is released before this returns. A record that names no create has no
    // owner handle (nothing else can bind to it), so there is nothing to take.
    let owner=null;
    if(/^wf-[a-f0-9]{16}$/.test(row.sandbox_id)&&createIdOf(row)!==null) {
      try{owner=acquireRecordOwner({directory:watchProofDirectory(row.sbx_home),name:row.sandbox_id,role:'app',binding:{create_incarnation:createIdOf(row)}});}
      catch(error){if(error?.code==='lock_busy')return {removed:false,watching:true,shared_watch:true};throw error;}
    }
    const run=(args,options)=>this._rowRun(row,args,options);
    try{return await daemonJobContext.run({handle,agentRun:false,recovery:true},async()=>{
      signal?.throwIfAborted();
      const cached=establishedAbsentWatch(row)&&(typeof this.cleanupJournal.abandon!=='function'||!this._oldAbsentCreate(row))&&snapshotCurrent&&!watchInventory.names.includes(row.sandbox_id);
      const beforeResult=cached?null:await run(['ls','--json'],{signal});
      const before=cached?watchInventory.names:parseSbxListing(beforeResult);
      if(!before||!cached&&!completeSbxListing(beforeResult))return {removed:false};
      if(before.includes(row.sandbox_id)) {
        // The sandbox was observed, so its create is no longer in flight.
        if(row.create_settled!==true)this.cleanupJournal.mark(row,{create_settled:true});
        // A name this install reserved, durably dispatched, and first saw absent is ours when it appears late: the
        // earlier empty listing is the watch that gives the removal its authority.
        const watched=Number.isFinite(row.absent_since);
        const reserved=this.cleanupJournal.nameReserved?.(row)===true;
        if(row.compute_created!==true&&!watched&&!reserved)return {removed:false,unknown:'present_without_receipt'};
        if(reserved&&!this.cleanupJournal.retireName(row,{computeMayRun:true}))return {removed:false};
        const beforeAt=new Date().toISOString();
        await run(['rm','--force',row.sandbox_id],{signal});
        const afterResult=await run(['ls','--json'],{signal});
        const after=parseSbxListing(afterResult);
        const removed=completeSbxListing(afterResult)&&Array.isArray(after)&&!after.includes(row.sandbox_id);
        // Only the locked, previously materialized incarnation provides a removal observation.
        const removalObservation=removed&&owner&&row.compute_created===true
          ?{create_incarnation:createIdOf(row),before_at:beforeAt,after_at:new Date().toISOString()}
          :undefined;
        return {removed,removalObservation};
      }
      if(row.create_settled===true)return {removed:true};
      // The deadline prevents another dispatch under this admission. Require
      // both fresh daemon absence and no live create client before releasing
      // its resources; the permanent fence still catches late daemon work.
      if(!cached&&typeof this.cleanupJournal.abandon==='function'&&row.compute_created===false&&Number.isSafeInteger(row.deadline_at)&&
        sandboxDeadlineRemaining(row,this.deadlineClock())<=0) {
        if(await this._createClientAbsent(row)!==true)return {removed:false,unknown:'creation_unproven'};
        if(this.cleanupJournal.abandon?.(row)===true)return {removed:true};
      }
      // Fresh complete absence plus the persistent late-name fence permits
      // resource cleanup without claiming a timed-out daemon request ended.
      if((this.cleanupJournal.abandoned?.(row)===true||this._oldAbsentCreate(row))&&this.cleanupJournal.abandon?.(row)===true)return {removed:true};
      // Dispatched but never observed. One empty listing does not show the create cannot still appear, so the row, its
      // scratch and its storage stay as a watch: each later listing re-checks, and a late sandbox is removed above.
      const at=this._now();
      let since=row.absent_since;
      if(!Number.isFinite(since)){since=at;this.cleanupJournal.mark(row,{absent_since:since});}
      const empty=at-since;
      // A late sandbox must find no credential or network rule bound to its name. Admission waits for verified revocation of
      // both (idempotent, retried on every pass); a failed or thrown revocation keeps the hold with its own reason.
      const revoke=args=>this._rowRun(row,args,{signal});
      // The failed step and a short class of the failure are kept for the owner, never sbx output.
      let revocation=null;
      const github=await removeSandboxGitHub(revoke,row.sandbox_id).catch(()=>null);
      if(github!==true)revocation={step:'github_secret',error:github===null?'listing_failed':'value_remains'};
      else {
        const detail={};
        const policy=await removeSandboxPolicies(revoke,row.sandbox_id,detail,{leaveProvisioned:cached||completeSbxListing(beforeResult)}).catch(()=>{detail.failure='listing_failed';return false;});
        if(policy!==true)revocation={step:'network_policy',error:detail.failure??'listing_failed'};
        else if(detail.left>0&&!cached)this.cleanupJournal.mark(row,{policy_rules_left:detail.left});
      }
      if(revocation)return {removed:false,unknown:'credential_revocation_pending',revocation};
      // No receipt, hold release, deadline cancellation or row rewrite from cached absence.
      if(cached){this._watchInventoryCurrent(watchInventory);return {removed:false,background_watch:true};}
      // Only the admission hold is released here, never the obligation. Time alone never discharges the row.
      return empty>=CREATE_CESSATION_BOUND_MS()?{removed:false,watching:true}:{removed:false,unknown:'creation_unproven'};
    });}finally{owner?.release();}
  }

  async _finishDestroy(handle,removed,{signal,unknown,watching,revocation,recordOwner,removalObservation}={}) {
    if((handle.owner_scope||handle.sbx_home)&&!this._rowHomeMatches(handle))removed=false;
    const deadlineRow=this.cleanupJournal.authority(handle);
    if(removed&&deadlineRow?.deadline_at!==undefined) {
      // Keep enforcement if compute removal was not proven. After proven removal the app does not signal the guard: it ends itself
      // when its record shows the removal, or at its own deadline. Physical sandbox names are never reused.
      this.cleanupJournal.mark(handle,{deadline_at:undefined,deadline_clock:undefined,deadline_enforcer:undefined});
    }
    if(removed&&deadlineRow&&this.cleanupJournal.nameReserved?.(deadlineRow)){
      this.cleanupJournal.retireName(deadlineRow);this.cleanupJournal.mark(handle,{compute_stopped:true});
    }
    const policySignal=AbortSignal.any([AbortSignal.timeout(30_000),...(signal?[signal]:[])]);
    const policy={};
    const scoped = args => this._rowRun(handle,args,{signal:policySignal});
    // Sandbox-scoped residue: network rules and, for a GitHub job, its GitHub value. Both count as policy cleanup.
    const githubRemoved = !handle.scoped_github_secret&&deadlineRow?.create_abandoned!==true || (removed && await removeSandboxGitHub(scoped, handle.sandbox_id).catch(() => false));
    let rulesRemoved = removed && await removeSandboxPolicies(scoped, handle.sandbox_id,policy).catch(() => false);
    // A partial create can leave daemon-provisioned metadata even with no VM.
    // Only the permanent name fence authorizes retrying native name cleanup;
    // neither a successful command nor a revoked rule substitutes for readback.
    if(removed&&!rulesRemoved&&policy.blocked&&deadlineRow?.create_abandoned===true&&this.cleanupJournal.abandoned?.(deadlineRow)===true) {
      let owner=recordOwner,acquired=false;
      try {
        if(!owner){owner=acquireRecordOwner({directory:watchProofDirectory(handle.sbx_home),name:handle.sandbox_id,role:'app',binding:{create_incarnation:createIdOf(deadlineRow)}});acquired=true;}
        owner.assertCurrent();
        await scoped(['rm','--force',handle.sandbox_id]);
        const after=await scoped(['ls','--json']),namesAfter=parseSbxListing(after);
        owner.assertCurrent();
        if(!completeSbxListing(after)||namesAfter===null||namesAfter.includes(handle.sandbox_id))removed=false;
        else {
          rulesRemoved=await removeSandboxPolicies(scoped,handle.sandbox_id,policy);
          owner.assertCurrent();
        }
      }catch{removed=false;rulesRemoved=false;}
      finally{if(acquired)owner?.release();}
    }
    if(removed&&!rulesRemoved&&policy.kitOnly&&deadlineRow&&this.cleanupJournal.nameReserved?.(deadlineRow)){
      const listed=await scoped(['ls','--json']),names=parseSbxListing(listed);
      if(completeSbxListing(listed)&&names!==null&&!names.includes(handle.sandbox_id)){
        rulesRemoved=await removeSandboxPolicies(scoped,handle.sandbox_id,policy,{leaveKit:true});
        if(rulesRemoved&&!this.cleanupJournal.recordPolicyResidue(deadlineRow,policy.residue??[]))rulesRemoved=false;
      }
    }
    const claudeRemoved = !handle.scoped_claude_secret || (removed && await verifyClaudeAccountRemoved(scoped,handle.sandbox_id,handle.scoped_claude_secret).catch(()=>false));
    const policyRemoved = rulesRemoved && githubRemoved && claudeRemoved;
    if (!githubRemoved) {policy.blocked = false;revocation={step:'github_secret',error:'listing_failed'};}
    else if(!claudeRemoved) {policy.blocked = false;revocation={step:'claude_secret',error:'removal_unverified'};}
    else if(!rulesRemoved)revocation={step:'network_policy',error:policy.failure??'listing_failed'};

    let scratchRemoved = false;
    try {
      if (!removed) throw policyError('cessation_unverified', 'Scratch remains while sandbox removal is unverified.');
      signal?.throwIfAborted();
      // A directory outside this app's scratch root was not made by this process: it is left exactly as it is.
      if (handle.scratch_outside === true) scratchRemoved = true;
      else {
        await this.removeScratch(handle.scratch_dir);
        await stat(handle.scratch_dir).then(
          () => { scratchRemoved = false; },
          (error) => { scratchRemoved = error && error.code === 'ENOENT'; },
        );
      }
      if (scratchRemoved && handle.scratch_outside !== true && /^wf-[0-9a-f]{16}$/.test(handle.sandbox_id))
        scratchRemoved = await recoverSandboxScratch(handle.sandbox_id, scratchRoot(), this._scratchJournalPath());
    } catch {
      scratchRemoved = false;
    }
    if (removed && /^wf-[0-9a-f]{16}$/.test(handle.sandbox_id)) {
      try {await (handle.sbx_home?this._storageForHome(handle.sbx_home):this.storage).release(handle.sandbox_id);}
      catch (error) {throw Object.assign(error ?? new Error('Storage release failed'),{cleanup_failure:'storage_release_failed'});}
    }

    const receipt = {
      job_id: handle.job_id,
      sandbox_id: handle.sandbox_id,
      sbx_home:handle.sbx_home,
      removed,
      policy_removed: policyRemoved,
      ...(policy.blocked?{policy_blocked:true}:{}),
      scratch_removed: scratchRemoved,storage_removed:removed,
      ...(removed&&removalObservation?{removal_observation:removalObservation}:{}),
      ...(unknown ? { unknown } : {}),
      ...(revocation ? { revocation } : {}),
      ...(watching&&!removed ? { watching: true } : {}),
      at: new Date().toISOString(),
    };
    this.cleanupJournal.finish(handle,receipt);
    // The cleanup journal now holds any scratch retry; the per-sandbox record must not block a new prepare.
    if (!scratchRemoved && handle._cleanupId && handle.scratch_outside !== true) await releaseSandboxScratchRecord(handle.sandbox_id, handle.scratch_dir, this._scratchJournalPath()).catch(() => {});
    return receipt;
  }

  async _sandboxExists(sandboxId,options={}) {
    options.signal?.throwIfAborted();
    const names = parseSbxListing(await this.runSbx(['ls', '--json'],options));
    // If we can't list, we cannot honestly claim removal is verified.
    return names === null ? true : names.includes(sandboxId);
  }

  /** @param {import('./runtime.mjs').SandboxHandle} handle */
  async inspect(handle) {
    const unknown = {job_id: handle.job_id, status: 'unknown'};
    const owner = this.cleanupJournal.authority(handle);
    if (!owner || !handle._cleanupId || owner._cleanupId !== handle._cleanupId ||
        ((handle.owner_scope || handle.sbx_home) && !this._rowHomeMatches(handle))) return unknown;
    const result = await this._rowRun(handle, ['ls', '--json']);
    const names = parseSbxListing(result);
    if (names === null || !completeSbxListing(result)) return unknown;
    const row = JSON.parse(result.stdout).find(entry => entry.name === handle.sandbox_id);
    if (!row) return owner.create_settled === true
      ? {job_id: handle.job_id, status: 'destroyed'} : unknown;
    const status = row.status === 'running' ? 'running'
      : ['stopped', 'exited'].includes(row.status) ? 'exited'
      : ['pending', 'creating'].includes(row.status) ? 'pending' : 'unknown';
    return {job_id: handle.job_id, status};
  }
}

// Re-exported so tests can exercise directory-listing helpers without
// duplicating fs plumbing.
export const _internal = { readEndpointIdentity, withDaemonProofScope: (scope, action) => daemonProofScope.run(scope, action), withDaemonJob: (context, action) => daemonJobContext.run(context, action), isSafeRelativeOutputPath, sbxHome, scratchRoot, preflightChecks, packageIsInstalled, containerdIsV2, daemonNeedsStart, policyNeedsInitialization, selectSbxHome, containerdSocketPathForSbxHome, socketPathLengthCheck, runPreflightCommand, needsSbxDaemon, userBusRuntimeDir, useBusRuntimeDir: (probe) => { const previous = busRuntimeDir; busRuntimeDir = probe; return () => { busRuntimeDir = previous; }; } };

export function verifySbxDaemonUnitForRemoval(info, unit, {dataHome = configHome(), root = installRoot} = {}) {
  const owner = readSbxOwner(dataHome, root);
  const home = systemdEnvironmentValue(info.environment, 'HOME');
  return Boolean(home && path.isAbsolute(home) && sbxUnitBelongsToOwner(unit, owner) &&
    isFaravanSbxDaemonUnit(info, home, {owner, dataHome, root}));
}
