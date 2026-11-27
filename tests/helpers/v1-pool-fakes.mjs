import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyProxyHarness } from './legacy-proxy-harness.mjs';
import { deferred } from './v1-lender-fixture.mjs';
import { guestExec, collectGuest } from './git-guest.mjs';
import { resultArchive } from './v1-journey.mjs';

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
      max_limits: { wall_seconds: 600, cpu: 2, memory_bytes: 2147483648, disk_bytes: 4294967296, output_bytes: 10485760 }, egress: ['internet', 'provider-only'], capabilities: ['patch-output'] }),
    admitJob: () => ({ ok: true, enforced_limits: ['cpu', 'memory', 'wall', 'output', 'storage'], unenforced: [] }),
    async probeCapabilities() { return { available: true }; },
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
      runs.push({ sandbox: handle.sandbox_id, agent: /^cd .* && claude /.test(handle._entrypoint) || handle._entrypoint.includes('claude --print') ? 'claude' : 'codex' });
      opts.onExecutionStarted?.();
      await run.promise;
      handle._lastExecStdout = '{"type":"turn.completed","usage":{"input_tokens":13,"output_tokens":5}}\n';
      opts.onLog?.({ stream: 'stdout', chunk: Buffer.from(handle._lastExecStdout) });
    },
    async collectDeclaredOutputs(handle, manifest) { return await collectGuest(handle, manifest) ?? [{ path: '.wf-result/result.tar.gz', bytes_content: resultArchive() }]; },
    async cancel(handle) { live.get(handle.sandbox_id)?.run?.reject(Object.assign(new Error('synthetic cancellation'), { name: 'AbortError' })); return { compute_stopped: true }; },
    async destroy(handle) { live.delete(handle.sandbox_id); gone.add(handle.sandbox_id); await rm(handle.scratch_dir, { recursive: true, force: true }); return { removed: true }; },
  };
  t.after(async () => { for (const { handle, run } of live.values()) { run?.resolve(); await rm(handle.scratch_dir, { recursive: true, force: true }); } });
  return { backend, live, gone, runs };
}
export function adapters() {
  return BOTH.map((id) => ({ spec:legacyProxyHarness(id), installed: true, signedIn: true, harnessVersion: 'test-only', models: ['example-model'], capabilities: [] }));
}
export function memory() { let disk = null; return { get: async () => structuredClone(disk), set: async (value) => { disk = structuredClone(value); }, acquire: async () => () => {}, peek: () => disk }; }
