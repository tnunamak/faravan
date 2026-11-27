import {createProbeDiagnostics,probeDiagnosticFields,sanitizeProbeDiagnostics} from './v1/probe-diagnostics.mjs';
/** Sandbox job construction, execution, identity evidence and receipts. */
import { accountIdOfKey, isAccountKey } from './v1/lending-account-key.mjs';
import {validateWorkingDirectory,workingDirectoryCheck} from './working-directory.mjs';
import {gitSourceSnapshotScript} from './git-source-snapshot.mjs';
import { JOB_FRAMING_VERSION, shellQuote } from './harnesses/job-framing.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateJobSpec } from './runtime.mjs';
import { VERIFY_RESERVE_SECONDS, CHECK_SKIPPED, checkSummary, changedTestFiles } from './protocol/verification.mjs';
import { DockerSbxBackend, admitDockerJob, ensureSbxDaemon, testWorkspace, sbxChildEnv, workspaceFailure, hostSbxCallback } from './docker-backend.mjs';
import { HOST_DISK_STOPPED } from './host-disk.mjs';
import { baseScript, diffScript, parseBaseOutput, DIFF_OUTPUT, GIT_SCRIPT_MARKER } from './git-candidate.mjs';
import { adapterFor, resolveHarness as resolveAdapterHarness, DEFAULT_IDENTITY_PROBE_HARNESSES, identityProbeCommand, parseIdentityEvidence } from './harnesses/index.mjs';
import {currentProviderGeneration,readProviderSource} from './credential-generations.mjs';
import {parseCredentialListing,hasGlobalServiceCredential} from './sandbox-credentials.mjs';

export function resolveHarness(name) { return resolveAdapterHarness(name); }
export function parseHarnessExecutionResult(harnessId, stdout) { return adapterFor(harnessId).parseExecutionResult(stdout); }
export function parseProviderAccount(harnessId, stdout) { return adapterFor(harnessId).parseProviderAccount(stdout); }
export function statusProbeCommand(harnessId) { return adapterFor(harnessId).statusProbeCommand(); }
export function capacityKindForHarness(harness) { return adapterFor(harness.harness_id).capacityKind(harness); }

/** Bounded, read-only host probe. No sandbox, login, repair or model command. */
export async function probeSignIn(harnessId, { run = hostSbxCallback, timeoutMs = 3000, home = sbxChildEnv().HOME } = {}) {
  const adapter = adapterFor(harnessId), probe = adapter.spec?.signin_probe;
  const unknown = { signedIn: null, source: probe?.path ?? 'unavailable' };
  if(adapter.spec?.auth_strategy==='provider-file-generation') {
    try {
      const generation=await currentProviderGeneration(home,adapter.spec.install);
      if(generation) {
        const bytes=await readProviderSource(home,generation.source);
        const current=createHash('sha256').update(bytes).digest('hex')===generation.digest;
        return {signedIn:current ? true : null,source:'provider-generation'};
      }
    }catch{return {signedIn:null,source:'provider-generation'};}
    return {signedIn:false,source:'provider-generation'};
  }
  if (!probe || typeof adapter.parseSignIn !== 'function') return unknown;
  // Only the verified job-path store command is supported in this first slice.
  if (!(probe.command.length === 6 && JSON.stringify(probe.command.slice(0, 5)) === JSON.stringify(['sbx', 'secret', 'ls', '-g', '--service']) &&
      /^[a-z][a-z0-9-]{0,39}$/.test(probe.command[5]))) return unknown;
  if (run === hostSbxCallback) await ensureSbxDaemon();
  return new Promise(resolve => {
    let child, settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => { finish(unknown); try { child?.kill('SIGKILL'); } catch {} }, timeoutMs);
    try {
      child = run(process.env.FARAVAN_SBX_BIN || 'sbx', probe.command.slice(1),
        { env: sbxChildEnv(), timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16384, shell: false },
        (error, stdout, stderr) => {
          if (error) return finish(unknown); // Even sign-out-looking output from a failed command is unknown.
          if (String(stderr ?? '').trim()) return finish(unknown); // sbx reports an unreadable store on stderr, even with exit 0.
          let signedIn = null;
          try { signedIn = adapter.parseSignIn(stdout); } catch {}
          finish({ signedIn: typeof signedIn === 'boolean' ? signedIn : null, source: probe.path });
        });
    } catch { finish(unknown); }
  });
}

const listingEmpty = listing => listing.secrets.length === 0 && listing.custom_secrets.length === 0 && listing.shadowed_services.length === 0;
/**
 * Uses the same JSON secret listing as scope enforcement; presence selects a credential path, not identity evidence.
 * Only a readable, complete listing that lacks the row is negative evidence. A failed, denied or untrusted read is unknown
 * with reason `credential_store_unreadable`. An entirely empty listing is also unknown when the caller saw the row before
 * (`knownPresent`): an unreadable keychain can look exactly like an empty one.
 */
export async function probeLendingSignIn(harnessId, { run = hostSbxCallback, timeoutMs = 30_000, signal, knownPresent = false } = {}) {
  const adapter = adapterFor(harnessId), spec = adapter.lendingSpec;
  const unknown = {signedIn:null, secretPresent:null, source:'sandbox-store'};
  const unreadable = {...unknown, reason:'credential_store_unreadable'};
  if (!spec?.signin_probe || signal?.aborted) return unknown;
  const command = spec.signin_probe.command;
  if (!(command.length === 6 && JSON.stringify(command.slice(0, 5)) === JSON.stringify(['sbx', 'secret', 'ls', '-g', '--service']) &&
      command[5] === spec.provider_service_id && /^[a-z][a-z0-9-]{0,39}$/.test(command[5]))) return unknown;
  if (run === hostSbxCallback) await ensureSbxDaemon();
  return new Promise(resolve => {
    let child, settled = false;
    const finish = value => { if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort',abort); resolve(value); } };
    const abort = () => { try { child?.kill('SIGKILL'); } catch {} };
    const timer = setTimeout(() => { finish(unreadable); try { child?.kill('SIGKILL'); } catch {} }, timeoutMs);
    try {
      child = run(process.env.FARAVAN_SBX_BIN || 'sbx', ['secret','ls','--json'],
        {env:sbxChildEnv(), timeout:timeoutMs, killSignal:'SIGKILL', maxBuffer:16 * 1024 * 1024, shell:false, ...(signal?{signal}:{})},
        (error, stdout, stderr) => {
          if (error) return finish(signal?.aborted ? unknown : unreadable);
          // sbx warns on stderr when it cannot read the keychain, and may still exit 0 with a listing it could not read.
          if (String(stderr ?? '').trim()) return finish(unreadable);
          try {
            const listing=parseCredentialListing({code:0,stdout:String(stdout??'')});
            const secretPresent=hasGlobalServiceCredential(listing,spec.provider_service_id);
            if (secretPresent) return finish({signedIn:null,secretPresent:true,source:'sandbox-store'});
            if (knownPresent && listingEmpty(listing)) return finish({...unreadable,secretPresent:null});
            finish({signedIn:false,secretPresent:false,source:'sandbox-store'});
          } catch { finish(unreadable); }
        });
      if(!settled)signal?.addEventListener('abort',abort,{once:true});
      if(!settled&&signal?.aborted)abort();
    } catch { finish(unknown); }
  });
}

export function executionMetadata(receipt) {
  return {
    harness_id: receipt.harness_id,
    capacity_kind: receipt.capacity_kind,
    model: receipt.model,
    usage: receipt.usage,
    duration_ms: receipt.duration_ms,
    ...(receipt.egress_evidence ? { egress_evidence: receipt.egress_evidence } : {}),
    ...(receipt.enforced_limits ? { enforced_limits: receipt.enforced_limits } : {}),
    ...(receipt.unenforced ? { unenforced: receipt.unenforced } : {}),
    ...(receipt.verified_commit ? { verified_commit: receipt.verified_commit } : {}),
  };
}

/** Builds the private receipt from execution-edge facts and parsed CLI output. */
export function buildTaskReceipt({ taskDigest, harnessId, execution, dockerAccount = null, probeDiagnostics = execution?.probe_diagnostics }) {
  const harness = resolveHarness(harnessId);
  const parsedExecution = parseHarnessExecutionResult(harnessId, execution.stdout);
  return {
    schema_version: 1,
    task_digest: taskDigest,
    ...(probeDiagnostics?.job_digest===taskDigest?probeDiagnosticFields(probeDiagnostics):{}),
    harness_id: harnessId,
    capacity_kind: capacityKindForHarness(harness),
    model: execution.account_observation?.jobId===taskDigest
      ?(parsedExecution.model&&parsedExecution.model!==execution.account_observation.model?null:execution.account_observation.model)
      :parsedExecution.model,
    usage: parsedExecution.usage,
    duration_ms: execution.duration_ms,
    started_at: execution.started_at,
    finished_at: execution.finished_at,
    sandbox_id: execution.sandbox_id,
    ...(execution.egress_evidence ? { egress_evidence: execution.egress_evidence } : {}),
    ...(execution.enforced_limits ? { enforced_limits: execution.enforced_limits } : {}),
    ...(execution.unenforced ? { unenforced: execution.unenforced } : {}),
    ...(execution.verified_commit ? { verified_commit: execution.verified_commit } : {}),
    ...(execution.job_framing_version ? { job_framing_version: execution.job_framing_version, workspace_path: execution.workspace_path } : {}),
    ...(execution.network_scope ? { network_scope: execution.network_scope } : {}),
    ...(execution.network_kit ? { network_kit: execution.network_kit } : {}),
    identities: {
      docker_account: dockerAccount,
      provider_account: parseProviderAccount(harnessId, execution.provider_status_stdout),
    },
  };
}

/**
 * Explicit observational refresh: creates/destroys disposable sandboxes and
 * runs status-only adapter commands, never sign-in, repair or model execution.
 * The capability gate is read-only; failures stay unknown. App GETs never call it.
 */
export async function probeFaravanIdentity(options = {}) {
  const diagnostics=options.probeContext??createProbeDiagnostics({purpose:'native_identity',provider:options.provider,
    onEvent:options.onProbeEvent,onReceipt:options.onProbeReceipt});
  if (options.harnessNames?.length === 1 && options.harnessNames[0] === 'pi') {
    options.signal?.throwIfAborted();
    const harness = options.harnessSpecs?.pi ?? resolveHarness('pi');
    const evidence = probeDiagnosticFields(diagnostics.finish());
    return {docker_account:null, providers:[{
      harness_id:'pi', service:harness.provider_service_id, capacity_kind:capacityKindForHarness(harness),
      installed:null, signedIn:null, authed:null, ...evidence,
    }], ...evidence};
  }
  const backend = (options.backendFactory ?? (() => new DockerSbxBackend()))();
  const queue=diagnostics.start('queue');
  const work = () => {diagnostics.end(queue);return probeFaravanIdentityInTurn({ ...options, probeContext:diagnostics, backendFactory: () => backend });};
  try {const result=await (backend.withSandboxCheck ? backend.withSandboxCheck(work) : work());
    return {...result,...probeDiagnosticFields(diagnostics.finish())};}
  catch(error){const receipt=diagnostics.finish(options.signal?.aborted?'cancelled':error?.code==='wall_timeout'?'timed_out':'failed');
    try{Object.assign(error,probeDiagnosticFields(receipt));}catch{}throw error;}
}

async function probeFaravanIdentityInTurn({ harnessNames = DEFAULT_IDENTITY_PROBE_HARNESSES,
  backendFactory = () => new DockerSbxBackend(), readDockerAccount: accountReader, signal,
  harnessSpecs = {}, network = 'disabled', probeContext } = {}) {
  const diagnostics=probeContext;
  let active=diagnostics.start('preflight');
  if(!accountReader)accountReader=(await import('./docker-backend.mjs')).readDockerAccount;
  const docker_account = await accountReader().catch(() => null);
  signal?.throwIfAborted?.();
  const providers = [];
  // Gate the shared test workspace behind the read-only capability check, so an
  // unsupported or too-old sbx never boots a sandbox. An image failure is
  // specific to the image tested and must not hide the other agents' checks.
  let workspace = { ok: true };
  // One agent: its own sandbox is the test workspace, so a failure there names the cause. (Several agents share one.)
  const gateBackend = backendFactory();
  const capabilities = await gateBackend.lenderCapabilities?.({signal}).catch(() => null);
  signal?.throwIfAborted?.();
  // A fresh machine has no guest disk evidence yet. On a supported runtime its trusted
  // setup probe establishes that evidence, so later jobs get bounded guest disks.
  const qualifyStorage = capabilities?.available === true && capabilities.guest_block_device_capacity === false &&
    await gateBackend.storage?.supported?.(capabilities.preflight?.version);
  diagnostics.end(active,capabilities?.available===true?'ok':'failed');
  active=diagnostics.start('storage_qualification',{subject:'qualification'});
  if (qualifyStorage || harnessNames.length > 1 && capabilities?.available === true) {
    workspace = await testWorkspace({ backend: gateBackend, version: capabilities?.preflight?.version, harnessName: harnessNames[0] });
    diagnostics.end(active,workspace.ok?'ok':workspace.cause==='timeout'?'timed_out':'failed');
  } else diagnostics.end(active,'skipped');
  const sharedCount=diagnostics.snapshot().phases.length;
  const workspaceBlocksAll = !workspace.ok && workspace.cause !== 'image_unavailable';
  for (const name of harnessNames) {
    const harness = harnessSpecs[name] ?? resolveHarness(name),command=identityProbeCommand(name);
    const providerStart=diagnostics.snapshot().phases.length;
    const providerDiagnostics=()=>{const receipt=diagnostics.snapshot();return sanitizeProbeDiagnostics({...receipt,first_failure:null,
      phases:[...receipt.phases.slice(0,sharedCount),...receipt.phases.slice(providerStart)].map((phase,i)=>({...phase,sequence:i+1}))});};
    if (workspaceBlocksAll) {
      providers.push({
        harness_id: name, service: harness.provider_service_id,
        capacity_kind: harness.provider_service_id === 'github' ? 'n/a' : capacityKindForHarness(harness),
        installed: null, signedIn: null, authed: null,
        workspace_cause: workspace.cause,...probeDiagnosticFields(providerDiagnostics()),
      });
      continue;
    }
    const backend = backendFactory();
    let handle = null;
    let evidence={installed:null,signedIn:null,account:null},failure=null;
    active=diagnostics.start('preflight');
    try {
      if(signal?.aborted)throw Object.assign(new Error('timeout'),{code:'wall_timeout'});
      if(!command)throw new Error('status probe unavailable');
      // probeCapabilities may repair identity. Never call it from account detection.
      const capabilities = await backend.lenderCapabilities?.({signal});
      signal?.throwIfAborted?.();
      if (capabilities?.available!==true) throw new Error('sandbox backend unavailable');
      const jobSpec = buildValidatedJobSpec({
        taskDigest: '0'.repeat(64), harness, entrypointWithPrompt:command,
        network,
        // Boot and policy verification can be slow on a loaded lender. Keep
        // this probe's wall aligned with the backend's 180-second readiness cap.
        resources:{...DEFAULT_RESOURCES,wall_seconds:180,output_bytes:16384},
      });
      diagnostics.end(active);active=diagnostics.start('create_ready');
      handle = await backend.prepare(jobSpec,{signal,identityProbe:true});
      if(signal?.aborted)throw Object.assign(new Error('timeout'),{code:'wall_timeout'});
      diagnostics.end(active);
      const statusController=new AbortController();
      const statusSignal=signal?AbortSignal.any([signal,statusController.signal]):statusController.signal;
      let watchdog,abort;
      try {
        const stopped=new Promise((_,reject)=>{
          abort=()=>reject(statusSignal.reason);
          statusSignal.addEventListener('abort',abort,{once:true});
        });
        active=diagnostics.start('identity',{budgetMs:30_000,deadlineSource:'command'});
        watchdog=setTimeout(()=>statusController.abort(Object.assign(new Error('Identity status deadline exceeded.'),{code:'wall_timeout'})),30_000);
        statusSignal.throwIfAborted();
        await Promise.race([backend.start(handle,{signal:statusSignal}),stopped]);
        // An abort can settle start with partial output. Only a completed status is evidence.
        statusSignal.throwIfAborted();
      } finally {
        clearTimeout(watchdog);
        statusSignal.removeEventListener('abort',abort);
      }
      evidence=parseIdentityEvidence(name,handle._lastExecStdout,{subscription:harness.auth_strategy==='docker-native-oauth'});
      diagnostics.end(active,evidence.signedIn==null?'failed':'ok');
    } catch (error) {
      diagnostics.end(active,signal?.aborted?'cancelled':error?.code==='wall_timeout'?'timed_out':'failed');
      // Unavailable sandbox/template, timeout or unknown output is not evidence of logout.
      if(harnessNames.length===1&&command)failure=workspaceFailure(error);
    } finally {
      if (handle) {
        const teardown=diagnostics.start('teardown');
        try {if((await backend.destroy(handle))?.removed!==true){evidence={installed:null,signedIn:null,account:null};diagnostics.end(teardown,'failed');}
          else diagnostics.end(teardown);}
        catch {evidence={installed:null,signedIn:null,account:null};diagnostics.end(teardown,'failed');}
      }
    }
    // A probe without an answer (timeout, failed start or destroy, unknown output) proves nothing about the policy.
    if(evidence.signedIn==null)backend.forgetIdentityPolicy?.();
    const account=evidence.account;
    providers.push({
      harness_id:name,service:harness.provider_service_id,
      capacity_kind:harness.provider_service_id==='github'?'n/a':capacityKindForHarness(harness),
      installed:evidence.installed,signedIn:evidence.signedIn,authed:evidence.signedIn,...probeDiagnosticFields(providerDiagnostics()),
      ...(evidence.installed===null&&failure?{workspace_cause:failure.cause}:{}),
      ...(account?.email ? {account_email:account.email} : {}),
      ...(account?.tier ? {tier:account.tier} : {}),
    });
  }
  return {docker_account,providers};
}

// --- ValidatedJobSpec construction ------------------------------------------

const DEFAULT_RESOURCES = Object.freeze({
  cpu: 2,
  memory_mib: 4096,
  storage_mib: 4096,
  wall_seconds: 1800,
  output_bytes: 50 * 1024 * 1024,
  network_bytes: 100 * 1024 * 1024,
  max_processes: 256,
});

/**
 * @param {object} params
 * @param {string} params.taskDigest              bare-hex task digest, used to derive job_id
 * @param {object} params.harness                 adapter spec or resolved harness; the image is `.image`, else the adapter's `.install`
 * @param {string} params.entrypointWithPrompt     harness entrypoint + shell-quoted task prompt, already assembled
 * @returns {object} a validated ValidatedJobSpec (validateJobSpec has already run)
 */
export function buildValidatedJobSpec({ taskDigest, harness, entrypointWithPrompt, executionScope = 'owner', githubAccessRequired = false, network = 'enabled', registries, requiredLimits = ['cpu', 'memory', 'wall', 'output'], resources = DEFAULT_RESOURCES, verify }) {
  const spec = {
    job_id: `wf-pull-${taskDigest.slice(0, 16)}-${randomUUID().slice(0, 8)}`,
    image: harness.image ?? harness.install,
    execution_scope: executionScope,
    ...(harness.auth_strategy ? { auth_strategy: harness.auth_strategy } : {}),
    entrypoint: entrypointWithPrompt,
    resources: { ...resources },
    ...(verify !== undefined ? { verify: { ...verify } } : {}),
    inputs: [],
    // A fallback tree candidate is collected as one guest-produced archive.
    output_manifest: ['.wf-result/result.tar.gz'],
    egress: network === 'enabled' ? 'internet' : network === 'disabled' ? 'provider-only' : network,
    // A broker-only harness (pi) names no provider hosts; its inert placeholder keeps the spec valid and opens no route.
    provider_hosts: [...(harness.egress_provider_hosts || harness.provider_domains || [])],
    ...(registries !== undefined ? { registries: [...registries] } : {}),
    required_limits: [...requiredLimits],
    ...(githubAccessRequired ? { github_access_required: true } : {}),
  };
  return validateJobSpec(spec);
}

// --- run orchestration -------------------------------------------------------

/**
 * Run an admitted job, materialize source after prepare establishes the workspace,
 * and read output bytes before destroying it. Cancellation and failures also
 * destroy the sandbox. Commands for Git candidates and archive output run in the guest.
 * verify_v1 checks run afterwards in a new sandbox that holds only the returned source.
 */
export async function runJob({ jobSpec, frameJob, workingDirectory, materializeSource, cloneGitSource, gitDiff = false, outputDir, authorize, statusProbe, onLog, onStage, lendingBudget, onMeter, onExecutionStarted, onCollected, accountKey = null, preparationContext, signal, durationNow, wallRemainingMs, now = () => new Date(), backend = new DockerSbxBackend() }) {
  const active = () => { if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('cancelled'), { code: 'cancelled' }); };
  // A step whose failure the job can survive still ends the job on a disk stop, with that reason.
  const keepDiskStop = error => { if (['host_disk_low', 'host_disk_unreadable'].includes(error?.code)) throw error; };
  active();
  // Message/files jobs return one workspace folder as the tree; they never diff.
  const outputDirs = outputDir === undefined ? [] : Array.isArray(outputDir) ? outputDir : [outputDir];
  if (outputDir !== undefined && (gitDiff || !outputDirs.length || !outputDirs.every(dir => /^[a-z0-9-]+$/.test(dir))))
    throw Object.assign(new Error('An output folder excludes a diff candidate'), { code: 'invalid_job_spec' });
  if(workingDirectory!==undefined)validateWorkingDirectory(workingDirectory);
  // Only a spec that asks for checks is validated here; admission still declines everything else with its own codes.
  if (jobSpec.verify !== undefined) validateJobSpec(jobSpec);
  const verification = jobSpec.verify ? Object.freeze({ ...jobSpec.verify }) : null;
  if (verification && lendingBudget && backend.checkWithoutProvider !== true)
    throw Object.assign(new Error("this lender cannot run checks without the agent's sign-in"), {code:'policy_unenforceable'});
  if (verification && ['verify', 'verificationFiles', 'prepareCheck'].some(name => typeof backend[name] !== 'function'))
    throw Object.assign(new Error('Backend does not implement verify_v1'), {code:'policy_unenforceable'});
  // The source exception is derived from the validated HTTPS source, never from
  // an arbitrary registry or task-supplied policy fragment. Keep the caller's spec intact.
  if (cloneGitSource && jobSpec.egress !== 'internet') {
    let source;
    try { source = new URL(cloneGitSource.url); } catch {}
    if (source?.protocol === 'https:' && source.hostname === 'github.com' && !source.username && !source.password) {
      jobSpec = { ...jobSpec, source_hosts: ['github.com', 'codeload.github.com'] };
    } else if (!jobSpec.provider_hosts?.some(host => host === '**.github.com' || host === 'github.com')) {
      throw Object.assign(new Error('Restricted policy cannot permit this Git source.'), { code: 'policy_unenforceable' });
    }
  }
  const admission = typeof backend.admitJob === 'function' ? await backend.admitJob(jobSpec) : admitDockerJob(jobSpec);
  if (!admission.ok) throw Object.assign(new Error(admission.reason), { code: admission.code, admission });
  const capabilities = await backend.probeCapabilities();
  if (!capabilities.available) {
    throw Object.assign(new Error(`sandbox backend unavailable: ${(capabilities.missing_prerequisites || []).join('; ')} (${capabilities.install_hint || ''})`), { code: 'sandbox_backend_unavailable' });
  }

  active();
  // The account comes from the lender's own reservation; a default-account job (no key, or a bare provider key) is
  // prepared exactly as before. Any other key must name an added account, or the job does not start.
  const defaultAccount = accountKey == null || (isAccountKey(accountKey) && accountIdOfKey(accountKey) === null);
  if (!defaultAccount && accountIdOfKey(accountKey) === null)
    throw Object.assign(new Error('The selected account is invalid.'), { code: 'claude_account_unavailable' });
  // Trusted caller metadata is not part of the guest spec and is never taken from it.
  const prepareOptions={signal,wallRemainingMs,separatePreparationClock:true,...(defaultAccount?{}:{accountKey}),
    ...(preparationContext===undefined?{}:{preparationContext})};
  const handle = await backend.prepare(jobSpec, prepareOptions);
  // One removal per sandbox, shared by the normal path, cancellation and failure.
  const handles = [handle], removals = new Map();
  const prepareCleanups = []; // a check sandbox that failed in prepare was removed there
  let sourceWrites = Promise.resolve(), outputHandoff = null;
  const materialize = materializeSource && (scratch => {
    sourceWrites = Promise.resolve().then(async () => {
      active(); await materializeSource(scratch); active();
      const target = handles.find(item => item.scratch_dir === scratch);
      if (target) await backend.syncWorkspace?.(target);
    });
    return sourceWrites;
  });
  const release = (target, cancel = false) => {
    if (!removals.has(target)) removals.set(target, (async () => {
      if (cancel) await backend.cancel(target).catch(() => {});
      // A cancelled extractor must stop writing before scratch is removed.
      await sourceWrites.catch(() => {});
      // Cancellation stops compute above, but collected output belongs to the
      // handoff until its independent writer confirms a durable copy.
      if (outputHandoff && !await outputHandoff) return {removed:false};
      return backend.destroy(target);
    })());
    return removals.get(target);
  };
  const stop = () => { for (const target of handles) release(target, true).catch(() => {}); };
  signal?.addEventListener('abort', stop, {once:true});
  if (signal?.aborted) stop();
  try {
    active();
    if (authorize) await authorize(handle);
    if (materialize) await materialize(handle.scratch_dir);
    if (cloneGitSource) {
      if (typeof backend.cloneGitSource !== 'function') throw Object.assign(new Error('sandbox backend does not support Git repository task sources'), { code: 'git_source_unsupported' });
      await backend.cloneGitSource(handle, cloneGitSource);
      if(cloneGitSource.commit){
        const snapshot=await execViaBackend(backend,handle,gitSourceSnapshotScript(await backend.ensureGuestRuntime(handle)),{sourcePreparation:true,signal});
        if(snapshot._lastExecStdout?.trim()!=='FARAVAN_GIT_SOURCE_OK')
          throw Object.assign(new Error('Pinned source did not pass source checks.'),{code:'invalid_source'});
      }
    }
    active();
    let providerStatus = null;
    if (statusProbe) {
      try {
        providerStatus = await execViaBackend(backend, handle, statusProbe, {signal});
      } catch (error) {
        keepDiskStop(error);
        // An unauthenticated status command is observability evidence, not a
        // reason to discard a task that the harness may still be able to run.
        providerStatus = { _lastExecStdout: '', _lastExecStderr: String(error.message || error) };
      }
    }
    // Diff candidates need a base commit fixed BEFORE the agent runs. Both
    // steps run inside the guest (never host git on lender-side workspace
    // bytes); any failure leaves the tree candidate as the fallback.
    const workdir = cloneGitSource ? 'repo' : '.';
    const agentWorkdir=workingDirectory===undefined?workdir:workdir+'/'+workingDirectory;
    if(workingDirectory!==undefined){
      try{const checked=await execViaBackend(backend,handle,workingDirectoryCheck(workdir,workingDirectory),{sourcePreparation:true,signal});
        if(checked._lastExecStdout?.trim()!=='FARAVAN_WORKDIR_OK')throw Object.assign(new Error('Working directory was not verified.'),{code:'invalid_working_directory'});
      }catch(error){keepDiskStop(error);active();throw Object.assign(new Error('The selected working directory is missing or contains a symbolic link.'),{code:'invalid_working_directory'});}
    }
    let framingMetadata;
    if (frameJob) {
      const workspace = join(handle.scratch_dir, workdir);
      handle._entrypoint = 'cd ' + shellQuote(join(handle.scratch_dir,agentWorkdir)) + ' && ' + adapterFor(frameJob.harnessId).jobCommand({ ...frameJob, workspace });
      if (frameJob.harnessId !== 'gh-cli') framingMetadata = { job_framing_version: JOB_FRAMING_VERSION, workspace_path: workspace };
    }
    let gitBase = null, diffUnavailable = null;
    if (gitDiff) {
      try {
        const parsed = parseBaseOutput((await execViaBackend(backend, handle, baseScript(workdir), {signal}))._lastExecStdout);
        if (parsed.base) gitBase = parsed; else diffUnavailable = parsed.unavailable;
      } catch (error) { keepDiskStop(error); active(); diffUnavailable = 'git_failed'; }
    }
    const before = verification ? await backend.verificationFiles(handle, workdir) : null;
    await backend.assertActive?.(handle);
    const startedAt = now();
    const durationStart = durationNow?.();
    active();
    const agentRun = await backend.start(handle, { onLog, signal, lendingBudget, onMeter, onExecutionStarted, ...(verification ? {reserveSeconds:VERIFY_RESERVE_SECONDS} : {}) });
    // The receipt's execution timing is the agent's run only; checks carry their own duration.
    const finishedAt = now();
    const durationEnd = durationNow?.();
    active();

    let manifest = jobSpec.output_manifest;
    if (gitBase) {
      try {
        await execViaBackend(backend, handle, diffScript(workdir, gitBase.base), {signal});
        manifest = [DIFF_OUTPUT];
      } catch (error) { active(); gitBase = null; diffUnavailable = 'git_failed'; }
    }
    if (outputDir !== undefined) {
      // Only the requested output folder comes back, never the source tree. An agent that
      // wrote nothing still yields a (nearly) empty, valid archive.
      const outputPaths = outputDirs.map(dir => shellQuote(workdir + '/' + dir)).join(' ');
      const tarRoots = outputDirs.map(shellQuote).join(' ');
      const tarCommand = 'mkdir -p .wf-result ' + outputPaths +
        ' && tar czf .wf-result/result.tar.gz -C ' + shellQuote(workdir) + ' ' + tarRoots;
      await execViaBackend(backend, handle, tarCommand, {signal});
    } else if (!gitBase) {
      // Fallback candidate: tar the whole post-run workspace inside the guest
      // so a single declared output captures "the resulting tree".
      const sourceRoot=cloneGitSource?.commit?'repo':'.';
      const tarCommand = 'mkdir -p .wf-result && tar czf .wf-result/result.tar.gz --exclude=.wf-result -C '+sourceRoot+' .';
      await execViaBackend(backend, handle, tarCommand, {signal});
    }

    active();
    const collected = await backend.collectDeclaredOutputs(handle, manifest);
    // Read collected output bytes back BEFORE destroy() — destroy() removes
    // handle.scratch_dir (which is where collectDeclaredOutputs just wrote
    // .wf-outputs/<declaredPath>), so any caller reading the file path
    // AFTER runJob returns would find it already gone.
    const collectedWithBytes = await Promise.all(collected.map(async (file) => ({
      ...file,
      bytes_content: file.bytes_content ?? await readFile(join(handle.scratch_dir, '.wf-outputs', file.path)),
    })));
    await backend.assertActive?.(handle);
    active();
    const collectedResult = {
      collected: collectedWithBytes,
      candidate: gitBase
        ? { format: 'diff', base_commit: gitBase.base, base_tree: gitBase.tree }
        : { format: 'tree', ...(gitDiff ? { diff_unavailable: diffUnavailable ?? 'git_failed' } : {}) },
      execution: {
        ...framingMetadata,
        sandbox_id: handle.sandbox_id,
        ...(agentRun?.accountObservation?{account_observation:agentRun.accountObservation}:{}),
        ...(lendingBudget?{stop_reason:agentRun?.stop?.stop_reason??'done',lending_meter:agentRun?.meter??null,lending_readings:handle._lending?.readings??[]}:{}),
        started_at: startedAt.toISOString(),
        finished_at: finishedAt.toISOString(),
        duration_ms: Math.max(0, Math.round(durationNow ? durationEnd-durationStart : finishedAt.getTime() - startedAt.getTime())),
        stdout: handle._lastExecStdout || '',
        provider_status_stdout: providerStatus?._lastExecStdout || '',
        ...(handle._execution || {}),
      },
    };
    // The only output copy must survive before either sandbox can be removed.
    // Interrupted verification is reported as skipped, never as a successful check.
    if(verification)collectedResult.checks=[{cmd:verification.cmd,exit:null,timed_out:false,parser:null,
      summary:'',skipped:CHECK_SKIPPED.workspace,changed_test_files:[],observed_by:'sandbox'}];
    let finishHandoff;
    outputHandoff = new Promise(resolve => {finishHandoff=resolve;});
    handle._outputHandoff=outputHandoff;
    try {
      await onCollected?.(collectedResult);
      finishHandoff(true);
      delete handle._outputHandoff;
    } catch(error) {
      finishHandoff(false);
      error.outputSaveFailed=true;throw error;
    }
    let cleanupReceipt = await release(handle);
    active();
    let checks;
    if (verification) {
      // Nothing the agent left running, or changed outside the returned source, may reach the check.
      if (cleanupReceipt?.removed !== true) throw Object.assign(new Error('The agent sandbox was not verifiably removed, so checks did not run.'), { code: 'cessation_unverified' });
      onStage?.('checks');
      // A failure before the command starts keeps the agent's work and says, in fixed words, why no check ran.
      // Cancellation always wins; the raw error never reaches the result.
      const skip = (reason, error) => { active(); return error?.code === 'wall_timeout' ? CHECK_SKIPPED.time : ['host_disk_low', 'host_disk_unreadable'].includes(error?.code) ? CHECK_SKIPPED.workspace : CHECK_SKIPPED[reason]; };
      let check = null, skipped = null, changed = [];
      // GitHub opens only for a check that clones the source again, and the clone closes it before the command.
      // The caller's own wall deadline (wallRemainingMs, ms left on its clock) can be earlier than the sandbox's.
      const remainingMs = wallRemainingMs?.();
      try { check = await backend.prepareCheck(handle, { cloneSource: Boolean((gitBase || outputDir !== undefined) && cloneGitSource), ...(lendingBudget ? {providerAccess:false} : {}), ...(Number.isFinite(remainingMs) ? { remainingMs } : {}) }); }
      catch (error) { const receipt = error?.cleanup_receipt ?? error?.cleanupReceipt; if (receipt) prepareCleanups.push(receipt); skipped = skip('workspace', error); }
      if (check) {
        handles.push(check);
        if (signal?.aborted) stop();
        active();
        try {
          await checkWorkspace({ backend, check, workdir, gitBase, outputDir, collected: collectedWithBytes, materializeSource: materialize, cloneGitSource, active, signal });
          if(workingDirectory!==undefined) {
            const checked=await execViaBackend(backend,check,workingDirectoryCheck(workdir,workingDirectory),{sourcePreparation:true,signal});
            if(checked._lastExecStdout?.trim()!=='FARAVAN_WORKDIR_OK')throw Object.assign(new Error('Returned working directory was not verified.'),{code:'check_workspace_failed'});
          }
          changed = changedTestFiles(before, await backend.verificationFiles(check, workdir));
        } catch (error) { changed = []; skipped = skip('source', error); }
      }
      let observed = null, checkStart, checkEnd;
      if (!skipped) {
        active();
        checkStart = durationNow?.();
        observed = await backend.verify(check, { ...verification, workdir:agentWorkdir });
        checkEnd = durationNow?.();
        active();
        // The check's time limit is the backend's own watchdog, so the result stands even if the deadline is near.
        if (observed.skipped === 'time') skipped = CHECK_SKIPPED.time;
        // Older peers accept only the known messages, so a check sandbox halted for low disk reads as one that could not run.
        if (observed.skipped === 'disk') skipped = CHECK_SKIPPED.workspace;
      }
      checks = [skipped
        ? {cmd:verification.cmd,exit:null,timed_out:false,parser:null,summary:'',skipped,changed_test_files:changed,observed_by:'sandbox'}
        : {cmd:verification.cmd,exit:observed.exit,timed_out:observed.timed_out,
          ...(Number.isFinite(checkStart) && Number.isFinite(checkEnd) && checkEnd >= checkStart && Number.isSafeInteger(Math.round(checkEnd - checkStart)) ? { duration_ms: Math.round(checkEnd - checkStart) } : {}),
          ...(Number.isSafeInteger(observed.timeout_ms) && observed.timeout_ms >= 0 ? { timeout_ms: observed.timeout_ms } : {}),
          ...checkSummary(verification.cmd,observed.stdout),changed_test_files:changed,observed_by:'sandbox'}];
      cleanupReceipt = combinedCleanup([cleanupReceipt, ...(check ? [await release(check)] : []), ...prepareCleanups]);
      active();
    }
    const completedResult={...collectedResult,cleanupReceipt,...(checks?{checks}:{})};
    await onCollected?.(completedResult);
    return completedResult;
  } catch (error) {
    if(error.outputSaveFailed)throw error;
    const receipts = await Promise.all(handles.map(target => release(target).catch(() => null)));
    receipts.push(...prepareCleanups);
    const cleanupReceipt = combinedCleanup(receipts);
    error.cleanupReceipt = cleanupReceipt;
    error.computeStopped = cleanupReceipt?.removed === true;
    throw error;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

/** Receipt of the agent sandbox; `removed` holds only when every sandbox of the run was removed. */
function combinedCleanup([agent, ...checks]) {
  if (!checks.length) return agent;
  return { ...agent, removed: [agent, ...checks].every(receipt => receipt?.removed === true),
    scratch_removed: [agent, ...checks].every(receipt => receipt?.scratch_removed === true), check_cleanup: checks[0] ?? null };
}

// Same command-line overrides as the candidate scripts: no hooks, fsmonitor or user config from the workspace.
const CHECK_GIT = "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git -c 'safe.directory=*' -c core.hooksPath=/dev/null -c core.fsmonitor=false";

/**
 * Build the check sandbox's workspace from the returned source only. A diff is applied to a fresh copy of the job
 * source whose tree must equal the base the agent started from; a tree candidate is the whole returned workspace.
 * Candidate bytes go into a new directory this process creates, and are removed before the check runs.
 */
async function checkWorkspace({ backend, check, workdir, gitBase, outputDir, collected, materializeSource, cloneGitSource, active, signal }) {
  const bytes = path => collected.find(file => file.path === path)?.bytes_content;
  const failed = message => Object.assign(new Error(message), { code: 'check_workspace_failed' });
  const stage = async (name, content) => {
    const dir = join(check.scratch_dir, '.wf-check-' + randomUUID());
    await mkdir(dir); // never recursive: an existing path, link or not, is refused
    await writeFile(join(dir, name), content, { flag: 'wx' });
    await backend.syncWorkspace?.(check);
    return dir;
  };
  const guest = async command => {
    try { return await execViaBackend(backend, check, command, {signal}); }
    catch (error) { active(); throw ['entrypoint_start_failed','agent_exit_nonzero','agent_group_not_ceased','agent_run_failed'].includes(error.code) ? failed('The check workspace could not be built from the returned source.') : error; }
  };
  if (gitBase) {
    const diff = bytes(DIFF_OUTPUT);
    if (!diff) throw failed('The returned diff is missing.');
    if (materializeSource) await materializeSource(check.scratch_dir);
    if (cloneGitSource) await backend.cloneGitSource(check, cloneGitSource);
    if (cloneGitSource?.commit) {
      const snapshot=await execViaBackend(backend,check,gitSourceSnapshotScript(await backend.ensureGuestRuntime(check)),{sourcePreparation:true,signal});
      if(snapshot._lastExecStdout?.trim()!=='FARAVAN_GIT_SOURCE_OK')throw failed('Pinned check source did not pass source checks.');
    }
    active();
    const base = parseBaseOutput((await guest(baseScript(workdir)))._lastExecStdout);
    if (base.tree !== gitBase.tree) throw Object.assign(new Error('The check workspace did not match the source the agent started from.'), { code: 'check_workspace_mismatch' });
    if (!diff.length) return;
    const dir = await stage('changes.diff', diff);
    await guest(`${GIT_SCRIPT_MARKER}check-apply; cd ${shellQuote(workdir)} && ${CHECK_GIT} apply --binary --whitespace=nowarn -- ${shellQuote(join(dir, 'changes.diff'))} && rm -rf -- ${shellQuote(dir)}`);
    return;
  }
  const tree = bytes('.wf-result/result.tar.gz');
  if (!tree) throw failed('The returned workspace is missing.');
  // Typed results return only the requested output folder; rebuild the source the checker expects beside it.
  if (outputDir !== undefined) {
    if (materializeSource) await materializeSource(check.scratch_dir);
    if (cloneGitSource) await backend.cloneGitSource(check, cloneGitSource);
    if (cloneGitSource?.commit) {
      const snapshot=await execViaBackend(backend,check,gitSourceSnapshotScript(await backend.ensureGuestRuntime(check)),{sourcePreparation:true,signal});
      if(snapshot._lastExecStdout?.trim()!=='FARAVAN_GIT_SOURCE_OK')throw failed('Pinned check source did not pass source checks.');
    }
    active();
  }
  const dir = await stage('result.tar.gz', tree);
  // Pinned Git trees contain the project root, without the original repo/ wrapper.
  const target = outputDir === undefined && !cloneGitSource?.commit ? '.' : workdir;
  await guest(`${GIT_SCRIPT_MARKER}check-tree; mkdir -p ${shellQuote(target)} && tar xzf ${shellQuote(join(dir, 'result.tar.gz'))} -C ${shellQuote(target)} && rm -rf -- ${shellQuote(dir)}`);
}

// DockerSbxBackend has no public "run an arbitrary extra command" method —
// start() is the only driver, and it's already been used for the harness
// entrypoint. Re-invoke the same `sbx exec SANDBOX -- sh -c CMD` shape
// start() uses, via the backend's own handle fields, rather than adding a
// new public backend method for a single internal need. If a second caller
// ever needs this, promote it to a real SandboxBackend method instead of
// duplicating the shape a third time.
async function execViaBackend(backend, handle, shellCommand, {sourcePreparation=false,signal}={}) {
  // These host-owned commands prepare or collect a job; they never authorize another agent launch.
  const fields = ['_entrypoint','_bookkeeping','_sourcePreparation','_lastExecStdout','_lastExecStderr'];
  const saved = fields.map(name => [name, Object.hasOwn(handle, name), handle[name]]);
  const active = () => { if(signal?.aborted)throw signal.reason ?? Object.assign(new Error('cancelled'),{code:'cancelled'}); };
  try {
    handle._entrypoint = shellCommand;
    handle._bookkeeping = true;
    if (sourcePreparation) handle._sourcePreparation = true;
    active();
    const started = await backend.start(handle, {signal});
    active();
    if (started?.host_disk_low === true) throw Object.assign(new Error(started.host_disk_detail ?? HOST_DISK_STOPPED), {code:started.host_disk_reason ?? 'host_disk_low'});
    return {_lastExecStdout:handle._lastExecStdout, _lastExecStderr:handle._lastExecStderr};
  } catch (error) {
    active();
    throw error;
  } finally {
    for (const [name, present, value] of saved) { if (present) handle[name] = value; else delete handle[name]; }
  }
}
