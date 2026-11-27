import {spawnSbxChild} from './docker-backend.mjs';
import {describeSbxRuntime,assertSbxRuntime,nonSbxCommand} from './sbx-runtime.mjs';
import { readdir, mkdir, open, rename, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock, writerIdentity, writerGroupGone } from './v1/lock.mjs';
import { GITHUB_SERVICE, generationId, isolatedSourceWriter, readGitHubGenerationValue } from './credential-generations.mjs';

const refused = (condition, credentialKind = null) => Object.assign(new Error('Sandbox credential authority could not be restricted to this job.'), { code: 'credential_scope_unenforceable', condition, credentialKind });
const unresolved = () => Object.assign(new Error('A previous sign-in may still be changing credentials.'), { code: 'credential_writer_unresolved' });
const lock = home => acquireProcessLock(join(home, 'credential-changes.lock'), { timeoutMs: 0 });
const writerDirectory = home => join(home, 'credential-writers');
const listingKeys = ['secrets','custom_secrets','shadowed_services','env_only_count'];
export function parseCredentialListing(result) {
  let value;
  try { value = JSON.parse(result?.stdout); } catch { throw refused('listing_json_invalid'); }
  if (result?.code !== 0) throw refused('listing_command_failed');
  if (!value || !Array.isArray(value.secrets) || !Array.isArray(value.custom_secrets) ||
      !Array.isArray(value.shadowed_services) || typeof value.env_only_count !== 'number' ||
      Object.keys(value).length !== listingKeys.length || listingKeys.some(key => !Object.hasOwn(value,key))) throw refused('listing_shape_unsupported');
  if (value.env_only_count !== 0) throw refused('environment_credential', 'environment');
  return value;
}
export function hasGlobalServiceCredential(listing, service) {
  return listing.secrets.some(row => row?.type === 'service' && row.name === service &&
    (row.scope === 'global' || row.scope === '(global)'));
}
async function syncDirectory(directory) { const fd=await open(directory,'r'); try { await fd.sync(); } finally { await fd.close(); } }
async function checkWriters(home, isolatedSources = false) {
  const directory=writerDirectory(home);
  let names;
  try {
    const info=await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw unresolved();
    names=await readdir(directory);
  } catch (error) { if(error.code==='ENOENT') return; throw unresolved(); }
  for (const name of names) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw unresolved();
    const file=join(directory,name);
    let info,record;
    try { info=await lstat(file); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.size>4096 || (process.getuid && info.uid!==process.getuid())) throw refused('writer_receipt_untrusted', 'writer'); record=JSON.parse(await readFile(file,'utf8')); }
    catch { throw unresolved(); }
    // These writers receive a unique provider config or a literal assignment
    // to a unique service name. They cannot target another publication. The
    // ordinary raw-store fence deliberately still treats their receipts as busy.
    if (isolatedSources && await isolatedSourceWriter(home,record.isolation)) continue;
    // Even a vanished process group cannot prove that a writer did not escape
    // it or delegate to a daemon. Keep the durable lease until an authoritative
    // reconciliation mechanism can prove the entire mutation has ended.
    if (!writerGroupGone(record)) throw unresolved();
    throw unresolved();
  }
}

// Publish an unknown lease before spawning. The helper waits for the durable
// process identity before exec, so a parent crash cannot leave an unrecorded writer.
export async function spawnCredentialWriter(home, command, args, options = {}) {
  const {credentialIsolation,sbxRuntime,...spawnOptions}=options;
  if(!sbxRuntime)nonSbxCommand(command,spawnOptions.env);
  const isolated=await isolatedSourceWriter(home,credentialIsolation);
  if(process.platform==='win32' || (process.platform!=='linux' && !isolated))throw refused('writer_identity_unenforceable', 'writer');
  const directory=writerDirectory(home); await mkdir(directory,{recursive:true,mode:0o700});
  const directoryInfo=await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || (directoryInfo.mode & 0o077) ||
      (process.getuid && directoryInfo.uid !== process.getuid())) throw refused('writer_directory_untrusted', 'writer');
  await syncDirectory(home);
  const id=randomUUID(), file=join(directory,id+'.json');
  const pending=await open(file,'wx',0o600);
  try { await pending.writeFile('{}'); await pending.sync(); } finally { await pending.close(); }
  await syncDirectory(directory);
  if(process.platform!=='linux') {
    // Source isolation, unlike process completion, needs no /proc identity.
    // Persist that authority before launching on Unix platforms without /proc.
    const temporary=join(directory,id+'.pending');
    const fd=await open(temporary,'wx',0o600);
    try{await fd.writeFile(JSON.stringify({version:1,isolation:credentialIsolation}));await fd.sync();}finally{await fd.close();}
    await rename(temporary,file);await syncDirectory(directory);
    return sbxRuntime?spawnSbxChild(sbxRuntime,args,{...spawnOptions,mode:'spawn',detached:true,stdio:['pipe','pipe','pipe']}):spawn(command,args,{...spawnOptions,detached:true,stdio:['pipe','pipe','pipe']});
  }
  const child=spawn(process.execPath,[fileURLToPath(new URL('./credential-writer-launch.mjs',import.meta.url)),command,...args],
    {...spawnOptions,detached:true,stdio:['pipe','pipe','pipe','ipc']});
  try {
    const identity=writerIdentity(child.pid);
    if (isolated) identity.isolation=credentialIsolation;
    const temporary=join(directory,id+'.pending');
    const fd=await open(temporary,'wx',0o600);
    try { await fd.writeFile(JSON.stringify(identity)); await fd.sync(); } finally { await fd.close(); }
    await rename(temporary,file); await syncDirectory(directory);
    if(sbxRuntime)assertSbxRuntime(sbxRuntime,{signal:spawnOptions.signal,env:spawnOptions.env});
    child.send(sbxRuntime?{start:true,runtime:describeSbxRuntime(sbxRuntime)}:'start');
    return child;
  } catch (error) { try { child.kill('SIGKILL'); } catch {} throw refused('writer_identity_publication_failed', 'writer'); }
}

// Preparation publishes its durable scratch lease while holding the same lock
// that supported credential writers hold. Failed cleanup keeps the lease closed.
// A sign-in holds the lock while the person finishes the browser step, so
// wait for it (bounded) instead of failing the job at once.
// acquireCredentialPreparation returns the lock's release function, for a caller
// that must hold the lock across several steps (create, then set a scoped value).
// withCredentialPreparation holds it for one callback, as before.
export async function acquireCredentialPreparation(home, { isolatedSources = false, lockWaitMs = 360_000, lockPollMs = 500, signal } = {}) {
  const deadline = Date.now() + lockWaitMs;
  let release;
  for (;;) {
    try { release = await lock(home); break; } catch {
      if (Date.now() >= deadline || signal?.aborted) throw refused('preparation_lock_unavailable');
      await new Promise(resolve => setTimeout(resolve, Math.min(lockPollMs, Math.max(0, deadline - Date.now()))));
    }
  }
  try { await checkWriters(home,isolatedSources); return release; } catch(error) { await release(); throw error; }
}
export async function withCredentialPreparation(home, prepare, options = {}) {
  const release = await acquireCredentialPreparation(home, options);
  try { return await prepare(); } finally { await release(); }
}

// Source receipts and active sandbox leases are independent: concurrentSources
// controls whether this mutation can coexist with other prepared jobs.
// leaseWaitMs lets a caller wait for short-lived sandboxes (identity and safety
// checks) to finish preparing and end, instead of refusing at once. The lock
// is released between attempts so those sandboxes can clean up.
export async function acquireCredentialMutation(home, { sandboxId, isolatedSources = false, concurrentSources = false, leaseWaitMs = 0, leasePollMs = 500 } = {}) {
  const deadline = Date.now() + leaseWaitMs;
  const pause = () => new Promise(resolve => setTimeout(resolve, Math.min(leasePollMs, Math.max(0, deadline - Date.now()))));
  for (;;) {
    let release;
    try { release = await lock(home); } catch {
      if (Date.now() >= deadline) throw refused('mutation_lock_unavailable');
      await pause(); continue;
    }
    try {
      await checkWriters(home,isolatedSources);
      const entries = await readdir(join(home, 'scratch-journal')).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      if (concurrentSources || !entries.some(name => name !== sandboxId + '.json')) return release;
    } catch (error) { await release(); throw error; }
    await release();
    if (Date.now() >= deadline) throw refused('other_sandbox_lease', 'shared_store');
    await pause();
  }
}

// Docker's proxy adds a service credential only to requests for that service's hosts. A restricted job whose
// sandbox denies every one of them cannot use the credential, so another lent agent's sign-in does not block it.
// The caller must prove each returned service's hosts are denied before the job runs (verifyInertServices).
export const INERT_SERVICE_HOSTS = Object.freeze({
  openai: Object.freeze(['api.openai.com', 'auth.openai.com', 'chatgpt.com', 'chat.openai.com', 'ab.chatgpt.com']),
  anthropic: Object.freeze(['api.anthropic.com', 'auth.anthropic.com', 'console.anthropic.com', 'claude.ai', 'platform.claude.com']),
  github: Object.freeze(['github.com', 'api.github.com', 'uploads.github.com', 'codeload.github.com', 'raw.githubusercontent.com']),
});
// Per-sandbox deny rules that make a service unreachable from a job open to the internet. Each covers the
// service's hosts above; the backend still proves every host is denied before the job runs.
export const INERT_SERVICE_DENY = Object.freeze({
  openai: Object.freeze(['openai.com', '**.openai.com', 'chatgpt.com', '**.chatgpt.com']),
  anthropic: Object.freeze(['anthropic.com', '**.anthropic.com', 'claude.ai', '**.claude.ai', 'claude.com', '**.claude.com']),
});
// Guest variables that would carry or announce the service's credential. GitHub is absent: every sandbox gets
// Faravan's GH_TOKEN sentinel by design, and the real token stays in the proxy.
export const INERT_SERVICE_ENV = Object.freeze({
  openai: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY', 'SBX_CRED_OPENAI_MODE']),
  anthropic: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'SBX_CRED_ANTHROPIC_MODE']),
  github: Object.freeze([]),
});

// Returned by restrictCredentialScope for a job open to the internet, without a GitHub grant, when the store holds a
// generated GitHub secret. It is not a service: its hosts cannot be denied, so the backend runs a guest probe instead.
export const GITHUB_BINDING_GUEST_PROBE = 'github-binding-guest-probe';
// A guest request to this URL shows the limit that applies to it: 60 without a token, more with one.
export const GITHUB_PROBE_URL = 'https://api.github.com/rate_limit';
/** Reads the probe's output. `authenticated` is true on any sign that the request carried a credential. */
export function classifyGitHubProbe(result) {
  if (result?.code !== 0) return { authenticated: false, reason: 'github_unreachable' };
  let body;
  try { body = JSON.parse(result.stdout); } catch { return { authenticated: false, reason: 'github_response_unreadable' }; }
  if (typeof body?.message === 'string' && /bad credentials/i.test(body.message)) return { authenticated: true, reason: 'credential_rejected_by_github' };
  const limits = [body?.resources?.core?.limit, body?.rate?.limit].filter(value => value !== undefined);
  if (!limits.length) return { authenticated: false, reason: 'github_response_unrecognized' };
  if (limits.every(value => value === 60)) return { authenticated: false, reason: 'unauthenticated' };
  return { authenticated: true, reason: 'authenticated_rate_limit' };
}

/**
 * Returns the global services it tolerated as inert; the caller must verify their hosts are denied.
 * `providerAccess: false` (a provider-free check) keeps the image's own provider sign-in bound and returns it as inert: the
 * caller denies and verifies its hosts and variables. The caller also restricts such a check's egress.
 */
export async function restrictCredentialScope(run, job, sandboxId, generation = null, providerGeneration = null, { providerAccess = true, scopedService = null } = {}) {
  const value = parseCredentialListing(await run(['secret', 'ls', '--json']));
  // A sandbox-scoped value wins over a global one, and removing it restores the global one. A global value under
  // the kit's GitHub service would reach every sandbox that has no scoped value. Faravan never writes one.
  if (value.secrets.some(row => row?.name === GITHUB_SERVICE && ['global', '(global)'].includes(row.scope)))
    throw refused('github_service_global', 'service');
  // A per-account sign-in is a value scoped to this one sandbox under its own service name. A global value under that name would
  // reach every sandbox, so it is refused, as for the GitHub service above.
  if (scopedService && hasGlobalServiceCredential(value, scopedService)) throw refused('scoped_service_global', 'service');
  const services = new Set([{ claude: 'anthropic', codex: 'openai', gemini: 'google', 'wf-gh-cli': 'github' }[job.image]]);
  if (job.github_access_required) services.add('github');
  if (scopedService) services.add(scopedService);
  const githubGranted = services.has('github');
  if(generation && services.delete('github'))services.add(generation.service);
  // A native file generation must not compete with a proxy's old global value.
  if(providerGeneration)services.delete({codex:'openai',claude:'anthropic'}[job.image]);
  const effective = row => {
    if (!row || typeof row.scope !== 'string' || !row.scope) throw refused('credential_scope_missing');
    return row.scope === 'global' || row.scope === '(global)' || row.scope === sandboxId;
  };
  // Older releases stored each GitHub generation as a global secret with a binding for github.com and api.github.com. A job that was not
  // granted GitHub gets no kit that requests it, but nothing proves sbx applies the binding only to that kit, so
  // such a job must not be able to reach those hosts (the same rule as the built-in github service). Old
  // generations stay in the store and keep their bindings, so every one of them counts.
  const inactiveGeneration = row => row?.type==='service' && typeof row.name==='string' &&
    row.name.startsWith('faravan-github-') && generationId(row.name.slice('faravan-github-'.length)) && !services.has(row.name);
  // A GitHub-granted job may use the lender's GitHub account by design, whichever generation holds the token.
  const ignored = row => githubGranted && inactiveGeneration(row);
  const restricted = typeof job.egress === 'string' && job.egress !== 'internet';
  // A job open to the internet may need GitHub for its source, so a GitHub sign-in cannot be made inert by a deny rule.
  // The job's own provider is never inert: denying its hosts would block the job, so its leftover proxy value refuses.
  const own = { codex: 'openai', claude: 'anthropic' }[job.image];
  // A restricted job is proven unable to reach GitHub by the denial. An open job may need GitHub for its source, so
  // it cannot be denied; the backend probes from the guest whether the binding reaches it instead.
  const inertGeneration = row => inactiveGeneration(row) && (!restricted || ['global', '(global)'].includes(row.scope));
  const inertService = row => (restricted || Object.hasOwn(INERT_SERVICE_DENY, row?.name)) && row?.name !== own && row?.type === 'service' && ['global', '(global)'].includes(row.scope) &&
    Object.hasOwn(INERT_SERVICE_HOSTS, row.name) && !services.has(row.name);
  const inert = row => inertGeneration(row) || inertService(row);
  const unrelated = value.secrets.filter(row => effective(row) && !ignored(row) && (row.type !== 'service' || !services.has(row.name)));
  if (unrelated.some(row => !inert(row))) throw refused('unrelated_service_credential', 'service');
  if (value.custom_secrets.some(effective)) throw refused('custom_credential', 'custom');
  if (value.shadowed_services.length) throw refused('shadowed_service', 'service');
  // A provider-free check keeps the image's own provider sign-in bound and returns it as inert, so the caller denies and
  // verifies its hosts and variables, as for another agent's sign-in. The caller restricts such a check's egress, so no
  // host outside the provider list and the registries is reachable.
  const provider = { claude: 'anthropic', codex: 'openai', gemini: 'google' }[job.image];
  const providerRow = !providerAccess && Boolean(provider) && value.secrets.some(row => effective(row) && row.type === 'service' && row.name === provider);
  // Stripping SSH_AUTH_SOCK does not override a persistent daemon socket.
  const disabled = await run(['settings', 'set', 'ssh.agentForwardingEnabled', 'false']);
  const cleared = await run(['settings', 'set', 'ssh.agentSocketPath', '']);
  const forwarding = await run(['settings', 'get', 'ssh.agentForwardingEnabled']);
  const socket = await run(['settings', 'get', 'ssh.agentSocketPath']);
  if (disabled.code !== 0) throw refused('ssh_disable_failed', 'ssh_agent');
  if (cleared.code !== 0) throw refused('ssh_socket_clear_failed', 'ssh_agent');
  if (forwarding.code !== 0) throw refused('ssh_forwarding_query_failed', 'ssh_agent');
  if (socket.code !== 0) throw refused('ssh_socket_query_failed', 'ssh_agent');
  if (forwarding.stdout.trim() !== 'false') throw refused('ssh_forwarding_enabled', 'ssh_agent');
  if (!['', '""'].includes(socket.stdout.trim())) throw refused('ssh_socket_present', 'ssh_agent');
  // For a restricted job the caller proves the GitHub hosts are denied, as for the built-in service.
  return [...new Set([...unrelated.map(row => !inactiveGeneration(row) ? row.name : restricted ? 'github' : GITHUB_BINDING_GUEST_PROBE), ...(providerRow ? [provider] : [])])];
}

const githubRows = (listing, sandboxId) => listing.secrets.filter(row => row?.name === GITHUB_SERVICE && row.scope === sandboxId);

/**
 * Copies the pinned GitHub generation into a secret scoped to this sandbox only. The caller holds the preparation
 * lock and has made the sandbox's cleanup record durable first, so a crash after this write is still cleaned up.
 * The value goes to sbx on stdin: never argv, environment, a kit file or a log.
 */
export async function assignSandboxGitHub(run, home, generation, sandboxId) {
  const token = await readGitHubGenerationValue(home, generation);
  const set = await run(['secret', 'set', GITHUB_SERVICE, '--sandbox', sandboxId, '--force'], { input: token });
  try {
    if (set.code !== 0) throw refused('sandbox_secret_set_failed', 'service');
    const listing = parseCredentialListing(await run(['secret', 'ls', '--json']));
    if (githubRows(listing, sandboxId).length !== 1) throw refused('sandbox_secret_unverified', 'service');
    if (listing.secrets.some(row => row?.name === GITHUB_SERVICE && ['global', '(global)'].includes(row.scope))) throw refused('github_service_global', 'service');
  } catch (error) {
    await removeSandboxGitHub(run, sandboxId).catch(() => false);
    throw error;
  }
}

/**
 * True once an independent listing shows no GitHub value scoped to this sandbox. The removal always runs: a value
 * that the listing does not show (or shows in another form) must still be removed.
 */
export async function removeSandboxGitHub(run, sandboxId) {
  if (!/^wf-[a-f0-9]{16}$/.test(sandboxId)) return false;
  // Its exit code is not evidence either way ("not found" fails too); the listing below decides.
  await run(['secret', 'rm', GITHUB_SERVICE, '--sandbox', sandboxId, '--force']).catch(() => {});
  return githubRows(parseCredentialListing(await run(['secret', 'ls', '--json'])), sandboxId).length === 0;
}

const legacyGitHubRow = row => row?.type === 'service' && typeof row.name === 'string' && row.name.startsWith('faravan-github-') &&
  generationId(row.name.slice('faravan-github-'.length)) && ['global', '(global)'].includes(row.scope);

/**
 * Earlier releases stored each GitHub generation as a global secret bound to github.com. With one present, sbx has two
 * values for the same hosts and which one a sandbox receives is not specified. The value is Faravan's own copy (the
 * generation file keeps the token), and restart recovery removes every earlier sandbox before new work starts, so no
 * running sandbox uses it. Called under the preparation lock before a GitHub job's scoped value is written.
 */
export async function removeLegacyGitHubSecrets(run) {
  const legacy = parseCredentialListing(await run(['secret', 'ls', '--json'])).secrets.filter(legacyGitHubRow);
  if (!legacy.length) return;
  for (const name of new Set(legacy.map(row => row.name))) await run(['secret', 'rm', name, '--force']).catch(() => {});
  if (parseCredentialListing(await run(['secret', 'ls', '--json'])).secrets.some(legacyGitHubRow))
    throw Object.assign(refused('legacy_github_secret_global', 'service'), {
      message: 'A GitHub secret from an earlier Faravan release could not be removed, so this job could receive it instead of its own GitHub access.' });
}

const NATIVE_PROVIDER = { codex: 'openai', claude: 'anthropic' };

/**
 * A job that generates its provider sign-in natively must not meet a proxy value left under the same service by an
 * earlier release: restrictCredentialScope refuses it. This removes that one global value, for the job's own provider
 * only, under the preparation lock, and only in Faravan's private sbx store (`privateHome`, proven by the caller). In
 * any other store, or for any other value, it does nothing and the existing refusal stands. One diagnostic event names
 * the provider (never the value) for each removal.
 */
export async function removeNativeProviderGlobalSecret(run, job, { privateHome = false, onDiagnostic = () => {}, now = Date.now } = {}) {
  const own = NATIVE_PROVIDER[job?.image];
  if (!own || privateHome !== true) return false;
  const globalRow = row => row?.type === 'service' && row.name === own && ['global', '(global)'].includes(row.scope);
  if (!(await listing(run)).secrets.some(globalRow)) return false;
  // The exit code is not evidence ("not found" fails too); the listing below decides.
  await run(['secret', 'rm', own, '--force']).catch(() => {});
  if ((await listing(run)).secrets.some(globalRow))
    throw Object.assign(refused('legacy_provider_secret_global', 'service'), {
      message: 'An earlier Faravan release left a sign-in for this agent that could not be removed, so this job could receive it instead of its own sign-in.' });
  try { Promise.resolve(onDiagnostic({ at: new Date(now()).toISOString(), code: 'legacy_provider_secret_removed', phase: 'prepare', provider: own })).catch(() => {}); } catch {}
  return true;
}
const listing = async run => parseCredentialListing(await run(['secret', 'ls', '--json']));
