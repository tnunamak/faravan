import {syntheticReadiness} from './synthetic-readiness.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyProxyHarness } from './legacy-proxy-harness.mjs';
import { deferred } from './v1-lender-fixture.mjs';
import { guestExec, collectGuest } from './git-guest.mjs';
import { resultArchive } from './v1-journey.mjs';
import {JOB_DEFAULTS} from '../../lib/v1/job-defaults.mjs';

// Shared fakes for tests that run real lenders under the real pool: a backend that keeps one sandbox per job
// (so two agents can run at once), two lent accounts, and an in-memory counter store.
export const BOTH = ['claude-code-subscription', 'codex'];
export function sandboxes(t) {
  const live = new Map(), gone = new Set(), runs = [];
  let n = 0;
  const backend = {
    sandboxOwnership:()=>({owner_scope:'f'.repeat(64)}),
    ensureGuestRuntime:async()=>({node:process.execPath}),
    lenderCapabilities: () => ({ available: true, backend_id: 'fake', pinned_git: true, enforced_limits: ['wall_seconds', 'cpu', 'memory_bytes', 'disk_bytes', 'output_bytes'],
      max_limits: {...JOB_DEFAULTS.limits}, egress: ['internet', 'provider-only'], capabilities: ['patch-output'] }),
    admitJob: () => ({ ok: true, enforced_limits: ['cpu', 'memory', 'wall', 'output', 'storage'], unenforced: [] }),
    async probeCapabilities() { return {available:true,preflight:{ok:true,checks:['sbx_install','sbx_daemon','docker_login'].map(name=>({name,ok:true}))}}; },
    async protectionSummary(requirements,context={}){return syntheticReadiness(backend,requirements,context);},
    async prepare(spec) {
      const dir = await mkdtemp(join(tmpdir(), 'pool-sbx-'));
      const handle = { sandbox_id: 'sbx-' + (++n), job_id: spec.job_id, scratch_dir: dir, _entrypoint: spec.entrypoint,
        _execution: { egress_evidence: { 'api.example.test': 'allowed' }, enforced_limits: ['cpu', 'memory', 'wall', 'output', 'storage'], unenforced: [] } };
      live.set(handle.sandbox_id, { handle, run: null });
      return handle;
    },
    async cloneGitSource(handle, source) { handle._execution.verified_commit = source.commit; },
    async start(handle, opts = {}) {
      if(handle._sourcePreparation&&handle._entrypoint.includes('FARAVAN_GIT_SOURCE_OK')){handle._lastExecStdout='FARAVAN_GIT_SOURCE_OK\n';return;}
      if (await guestExec(handle, handle._entrypoint)) return;
      if (handle._entrypoint.startsWith('mkdir -p .wf-result') || /login status|auth status/.test(handle._entrypoint)) return;
      const run = deferred();
      live.get(handle.sandbox_id).run = run;
      runs.push({ sandbox: handle.sandbox_id, agent: /^cd .* && claude /.test(handle._entrypoint) || handle._entrypoint.includes('claude --print') || handle._entrypoint.includes("'claude'") ? 'claude' : 'codex' });
      await opts.onLaunchDurable?.();
      if(handle.cancelled)throw Object.assign(new Error('synthetic cancellation'),{name:'AbortError'});
      await opts.onExecutionStarted?.();
      await run.promise;
      if(handle.cancelled)throw Object.assign(new Error('synthetic cancellation'),{name:'AbortError'});
      handle._lastExecStdout = '{"type":"turn.completed","usage":{"input_tokens":13,"output_tokens":5}}\n';
      opts.onLog?.({ stream: 'stdout', chunk: Buffer.from(handle._lastExecStdout) });
    },
    async collectDeclaredOutputs(handle, manifest) { return await collectGuest(handle, manifest) ?? [{ path: '.wf-result/result.tar.gz', bytes_content: resultArchive() }]; },
    async cancel(handle) { handle.cancelled=true;live.get(handle.sandbox_id)?.run?.resolve();return {compute_stopped:true}; },
    async destroy(handle) { live.delete(handle.sandbox_id); gone.add(handle.sandbox_id); await rm(handle.scratch_dir, { recursive: true, force: true }); return {removed:true,scratch_removed:true,policy_removed:true,storage_removed:true}; },
  };
  t.after(async () => { for (const { handle, run } of live.values()) { run?.resolve(); await rm(handle.scratch_dir, { recursive: true, force: true }); } });
  return { backend, live, gone, runs };
}
export function adapters() {
  return BOTH.map((id) => ({ accountProviderId:id==='codex'?'codex':'claude',spec:legacyProxyHarness(id), installed: true, signedIn: true, harnessVersion: 'test-only', models: ['example-model'], capabilities: [] }));
}
export function memory(initial=null) { let disk = structuredClone(initial); return { get: async () => structuredClone(disk), set: async (value) => { disk = structuredClone(value); }, acquire: async () => () => {}, peek: () => disk }; }
