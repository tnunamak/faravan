import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readArchiveEntries} from '../lib/archive.mjs';
import {mkdtemp, mkdir, readFile, rm, writeFile, chmod, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateJobSpec} from '../lib/runtime.mjs';
import {resolveHarness, buildValidatedJobSpec, runJob, parseHarnessExecutionResult, parseProviderAccount, executionMetadata, capacityKindForHarness, buildTaskReceipt} from '../lib/executor.mjs';

test('ValidatedJobSpec construction passes validateJobSpec and uses the harness image/entrypoint', () => {
  const harness = resolveHarness('claude-code-subscription');
  assert.equal(harness.image, 'claude');
  const entrypointWithPrompt = `${harness.entrypoint} 'print WF_TASK_OK and exit'`;
  const spec = buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness, entrypointWithPrompt });
  assert.doesNotThrow(() => validateJobSpec(spec));
  assert.equal(spec.image, 'claude');
  assert.ok(spec.entrypoint.startsWith('claude --print --verbose --output-format stream-json --dangerously-skip-permissions'));
  assert.deepEqual(spec.output_manifest, ['.wf-result/result.tar.gz']);
});

test('credential-only GitHub tasks carry the capability into the sandbox job spec', () => {
  const harness = resolveHarness('claude-code-subscription');
  const spec = buildValidatedJobSpec({ taskDigest: 'b'.repeat(64), harness, entrypointWithPrompt: harness.entrypoint, githubAccessRequired: true });
  assert.equal(spec.github_access_required, true);
});

test('resolveHarness rejects an unknown harness name rather than silently defaulting', () => {
  assert.throws(() => resolveHarness('nonexistent-harness'), /unknown --harness/);
});

test('receipt parsers capture only the fields emitted by Claude, Codex, and Gemini JSON output', () => {
  const claude = parseHarnessExecutionResult('claude-code-subscription', JSON.stringify({
    type: 'result', duration_ms: 3840,
    usage: { input_tokens: 15166, output_tokens: 63 },
    modelUsage: { 'claude-fable-5': { inputTokens: 15166, outputTokens: 63 } },
  }));
  assert.deepEqual(parseHarnessExecutionResult('claude-code-subscription', [
    JSON.stringify({ type: 'assistant', message: { content: 'working' } }),
    JSON.stringify({ type: 'result', model: 'claude-fable-5', usage: { input_tokens: 8, output_tokens: 3 } }),
  ].join('\n')), { model: 'claude-fable-5', usage: { input_tokens: 8, output_tokens: 3 } });
  assert.deepEqual(claude, { model: 'claude-fable-5', usage: { input_tokens: 15166, output_tokens: 63 } });
  assert.deepEqual(parseHarnessExecutionResult('claude-code-subscription', JSON.stringify({
    model: 'claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: { 'claude-haiku-4-5': {} },
  })), { model: 'claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 2 } });
  assert.deepEqual(parseHarnessExecutionResult('claude-code-subscription', JSON.stringify({
    usage: { input_tokens: 3, output_tokens: 2 }, modelUsage: { 'claude-haiku-4-5': {}, 'claude-sonnet-4-5': {} },
  })), { model: 'claude-haiku-4-5, claude-sonnet-4-5', usage: { input_tokens: 3, output_tokens: 2 } });

  const codex = parseHarnessExecutionResult('codex', [
    JSON.stringify({ type: 'thread.started', thread_id: 'abc' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 18795, cached_input_tokens: 10496, output_tokens: 6, reasoning_output_tokens: 0 } }),
  ].join('\n'));
  assert.deepEqual(codex, { model: null, usage: { input_tokens: 18795, output_tokens: 6 } });

  const gemini = parseHarnessExecutionResult('gemini', JSON.stringify({
    model: 'gemini-2.5-pro', stats: { inputTokens: 12, outputTokens: 7 },
  }));
  assert.deepEqual(gemini, { model: 'gemini-2.5-pro', usage: { input_tokens: 12, output_tokens: 7 } });
  assert.deepEqual(parseHarnessExecutionResult('codex', 'not json'), { model: null, usage: null });
});

test('receipt parser reads optional Claude account identity from sandbox status output and never requires it for result metadata', () => {
  const account = parseProviderAccount('claude-code-subscription', JSON.stringify({
    loggedIn: true, authMethod: 'claude.ai', email: 'rowan@example.test', subscriptionType: 'max',
  }));
  assert.deepEqual(account, { email: 'rowan@example.test', tier: 'max' });
  assert.equal(parseProviderAccount('claude-code-subscription', '{"loggedIn":false}'), null);
  assert.deepEqual(executionMetadata({ harness_id: 'claude-code-subscription', capacity_kind: 'subscription', model: 'claude-fable-5', usage: { input_tokens: 3, output_tokens: 2 }, duration_ms: 99 }), {
    harness_id: 'claude-code-subscription', capacity_kind: 'subscription', model: 'claude-fable-5', usage: { input_tokens: 3, output_tokens: 2 }, duration_ms: 99,
  });
});

test('capacity kind comes from the harness capacity source, not optional account tier data', () => {
  assert.equal(capacityKindForHarness(resolveHarness('claude-code-subscription')), 'subscription');
  assert.equal(capacityKindForHarness(resolveHarness('claude-code-api-key')), 'api_key');
  assert.equal(capacityKindForHarness(resolveHarness('gemini')), 'api_key');
  assert.equal(capacityKindForHarness(resolveHarness('gh-cli')), 'local');
});

test('task receipt joins measured sandbox facts, parsed output, and private identities', () => {
  const receipt = buildTaskReceipt({
    taskDigest: 'a'.repeat(64), harnessId: 'claude-code-subscription', dockerAccount: 'rowan',
    execution: {
      sandbox_id: 'wf-123', started_at: '2026-07-21T10:00:00.000Z', finished_at: '2026-07-21T10:00:01.200Z', duration_ms: 1200,
      stdout: JSON.stringify({ usage: { input_tokens: 12, output_tokens: 4 }, modelUsage: { 'claude-fable-5': {} } }),
      provider_status_stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'rowan@example.test', subscriptionType: 'max' }),
    },
  });
  assert.deepEqual(receipt, {
    schema_version: 1, task_digest: 'a'.repeat(64), harness_id: 'claude-code-subscription', capacity_kind: 'subscription', model: 'claude-fable-5',
    usage: { input_tokens: 12, output_tokens: 4 }, duration_ms: 1200,
    started_at: '2026-07-21T10:00:00.000Z', finished_at: '2026-07-21T10:00:01.200Z', sandbox_id: 'wf-123',
    identities: { docker_account: 'rowan', provider_account: { email: 'rowan@example.test', tier: 'max' } },
  });
});

async function writeStub(name, body) {
  const dir = await mkdtemp(join(tmpdir(), `wf-pull-sbx-stub-${name}-`));
  const scriptPath = join(dir, 'sbx');
  await writeFile(scriptPath, `#!/usr/bin/env bash\nset -euo pipefail\nif [ "$1 \${2:-}" = "daemon status" ]; then echo "Status: running"; exit 0; fi\n${body}\n`);
  await chmod(scriptPath, 0o755);
  return dir;
}

test('sandbox execution materializes source, records protection and preserves bytes before cleanup', async () => {
    const digest = 'a'.repeat(64);
    const harness = resolveHarness('claude-code-subscription');
    const entrypointWithPrompt = `${harness.entrypoint} 'print WF_TASK_OK and exit'`;
    const jobSpec = buildValidatedJobSpec({ taskDigest: digest, harness, entrypointWithPrompt });

    // --- run against a STUB sbx: proves the wiring, not sbx mechanics -------
    // (sbx mechanics are already proven in tests/docker-backend.test.mjs)
    const stubDir = await writeStub('pull-plumbing', `
      case "$1" in
        settings) if [ "$2 $3" = 'get ssh.agentForwardingEnabled' ]; then echo false; fi; exit 0 ;;
        secret) echo '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}'; exit 0 ;;
        --version) echo "sbx version 0.35.0-stub"; exit 0 ;;
        policy)
          # S5.5: the observed network log of this sandbox ($3), read after the agent runs
          if [ "\${2:-}" = log ]; then echo '{"allowed":[],"blocked":[{"sandbox_id":"'"$3"'","host":"10.0.0.1"}]}'; exit 0; fi
          if [ "\${2:-}" = check ]; then
            case "\${!#}" in
              10.0.0.1|192.168.1.1|169.254.169.254|example.com|mcp-gateway.docker.internal:80|mcp-gateway.docker.internal:443) echo '{"allowed":false}' ;;
              *) echo '{"allowed":true}' ;;
            esac
          fi
          exit 0 ;;
        run) exit 0 ;;
        exec)
          # \`sbx exec SANDBOX -- sh -c CMD\`: emulate producing the declared
          # output file wherever the CMD's tar step would have written it —
          # simplest correct stub is to just always succeed; collectDeclaredOutputs
          # below is separately stubbed to hand back a deterministic file.
          exit 0
          ;;
        cp) exit 0 ;;
        rm) exit 0 ;;
        ls) echo '[]'; exit 0 ;;
        *) exit 0 ;;
      esac
    `);
    const previousBin = process.env.FARAVAN_SBX_BIN;
    process.env.FARAVAN_SBX_BIN = join(stubDir, 'sbx');
    let collected;
    let cleanupReceipt;
    let materializeCalledWith;
    const fakeContent = 'fake-result';
    try {
      const { DockerSbxBackend } = await import('../lib/docker-backend.mjs');
      const backend = new DockerSbxBackend();
      // This plumbing test deliberately stubs sbx mechanics; the install
      // preflight itself is exhaustively exercised in
      // sbx-preflight.test.mjs. Do not make a fake binary appear
      // install-ready by accident while testing artifact flow.
      backend.probeCapabilities = async () => ({ available: true, backend_id: 'docker-sbx' });
      // collectDeclaredOutputs relies on `sbx cp` actually placing bytes at
      // outDir/declaredPath; the bare stub above no-ops that copy. Rather
      // than teach the bash stub to fabricate a tar file (duplicating
      // faravan-docker-backend's own already-tested cp mechanics), stub
      // collectDeclaredOutputs itself for this plumbing-only test.
      const fakeCollected = [{ path: '.wf-result/result.tar.gz', sha256: createHash('sha256').update(fakeContent).digest('hex'), bytes: fakeContent.length }];
      backend.collectDeclaredOutputs = async (handle, manifest) => {
        assert.deepEqual(manifest, jobSpec.output_manifest);
        const outDir = join(handle.scratch_dir, '.wf-outputs');
        const { mkdir } = await import('node:fs/promises');
        await mkdir(join(outDir, '.wf-result'), { recursive: true });
        await writeFile(join(outDir, '.wf-result', 'result.tar.gz'), fakeContent);
        return fakeCollected;
      };
      // Exercise the real materializeSource wiring: proves a file written
      // via the callback into the REAL (real prepare()-returned) scratch_dir
      // is what the guest's workspace mount would see — the exact gap
      // routed around in runJob's doc comment.
      const result = await runJob({
        jobSpec,
        backend,
        materializeSource: async (scratchDir) => {
          materializeCalledWith = scratchDir;
          await writeFile(join(scratchDir, 'materialized-source-marker.txt'), 'source was here');
        },
      });
      assert.deepEqual(result.execution.enforced_limits, ['cpu', 'memory', 'wall', 'output']);
      assert.deepEqual(result.execution.unenforced, ['storage', 'processes', 'network_bytes']);
      assert.equal(result.execution.egress_evidence['10.0.0.1'], 'denied');
      collected = result.collected;
      cleanupReceipt = result.cleanupReceipt;
    } finally {
      if (previousBin === undefined) delete process.env.FARAVAN_SBX_BIN;
      else process.env.FARAVAN_SBX_BIN = previousBin;
      await rm(stubDir, { recursive: true, force: true });
    }
    assert.ok(materializeCalledWith, 'materializeSource must be invoked with the real scratch_dir');
    assert.equal(collected.length, 1);
    assert.equal(collected[0].path, '.wf-result/result.tar.gz');
    // bytes_content must be readable from the returned collected[] entry
    // WITHOUT touching the filesystem again — destroy() already removed
    // scratch_dir by the time runJob returns.
    assert.equal(collected[0].bytes_content.toString('utf8'), fakeContent);

    assert.equal(cleanupReceipt.removed, true);
});

test('identity probe network disabled maps to provider-only without opaque policy or token', () => {
  const harness = resolveHarness('codex');
  const spec = buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness, entrypointWithPrompt: 'true', network: 'disabled' });
  assert.equal(spec.egress, 'provider-only');
  assert.deepEqual(spec.provider_hosts, ['**.openai.com', '**.chatgpt.com', 'chatgpt.com']);
  assert.equal(Object.hasOwn(spec, 'egress_policy_id'), false);
  assert.equal(Object.hasOwn(spec, 'capability_token'), false);
});

test('runJob declines unsupported policy and limits before probing or preparing', async () => {
  const harness = resolveHarness('codex');
  const jobSpec = buildValidatedJobSpec({ taskDigest: 'a'.repeat(64), harness, entrypointWithPrompt: 'true', requiredLimits: ['storage'] });
  const backend = { probeCapabilities() { assert.fail('must decline before side effects'); }, prepare() { assert.fail('must decline before running'); } };
  await assert.rejects(runJob({ jobSpec, backend }), { code: 'storage_unenforceable' });
  jobSpec.required_limits = ['cpu'];
  jobSpec.egress = 'unsupported';
  await assert.rejects(runJob({ jobSpec, backend }), { code: 'policy_unenforceable' });
});

test('policy evidence survives private receipt and public execution metadata', () => {
  const evidence = { 'api.openai.com': 'allowed', '10.0.0.1': 'denied' };
  const receipt = buildTaskReceipt({
    taskDigest: 'a'.repeat(64), harnessId: 'codex',
    execution: { stdout: '', duration_ms: 1, egress_evidence: evidence, enforced_limits: ['cpu', 'memory', 'wall', 'output'], unenforced: ['storage', 'processes', 'network_bytes'] },
  });
  const metadata = executionMetadata(receipt);
  assert.deepEqual(metadata.egress_evidence, evidence);
  assert.deepEqual(metadata.enforced_limits, ['cpu', 'memory', 'wall', 'output']);
});

test('framed Git jobs execute inside the repository named by the framing', async t => {
  const {execFileSync}=await import('node:child_process');
  const scratch=await mkdtemp(join(tmpdir(),'faravan-framed-cwd-'));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const backend={ensureGuestRuntime:async()=>({node:process.execPath,sha256:createHash('sha256').update(await readFile(process.execPath)).digest('hex')}),
    admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),
    prepare:async spec=>({scratch_dir:scratch,sandbox_id:'framing-test',_entrypoint:spec.entrypoint}),
    cloneGitSource:async()=>{
      await mkdir(join(scratch,'repo'));
      const git=(...args)=>execFileSync('git',['-C',join(scratch,'repo'),...args]);
      git('init','-q');git('config','user.email','fixture@example.test');git('config','user.name','Fixture');
      await writeFile(join(scratch,'repo','.env'),'dummy-fixture-secret');
      await writeFile(join(scratch,'repo','.env.example'),'EXAMPLE=value');
      await writeFile(join(scratch,'repo','main.js'),'source');
      git('add','.');git('commit','-qm','fixture');
    },
    start:async handle=>{
      if(handle._sourcePreparation)handle._lastExecStdout=execFileSync('sh',['-c',handle._entrypoint],{cwd:scratch,encoding:'utf8'});
      if(handle._entrypoint.startsWith('mkdir -p .wf-result'))execFileSync('sh',['-c',handle._entrypoint],{cwd:scratch});
      if(handle._entrypoint.includes('codex exec')) {
        await assert.rejects(stat(join(scratch,'repo','.env')),{code:'ENOENT'});
        await assert.rejects(stat(join(scratch,'repo','.git')),{code:'ENOENT'});
        assert.equal(await readFile(join(scratch,'repo','.env.example'),'utf8'),'EXAMPLE=value');
        handle._lastExecStdout=execFileSync('sh',['-c','codex() { pwd; }; '+handle._entrypoint],{cwd:scratch,encoding:'utf8'});
      }
    },
    collectDeclaredOutputs:async()=>[{path:'.wf-result/result.tar.gz',bytes_content:await readFile(join(scratch,'.wf-result/result.tar.gz'))}],
    destroy:async()=>({removed:true}),
  };
  const jobSpec=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('codex'),entrypointWithPrompt:'unused'});
  const result=await runJob({jobSpec,backend,cloneGitSource:{url:'https://github.com/example/repo',commit:'a'.repeat(40)},frameJob:{harnessId:'codex',prompt:'create an image'}});
  assert.equal(result.execution.stdout.trim(),join(scratch,'repo'));
  assert.equal(result.execution.workspace_path,join(scratch,'repo'));
  assert.equal(result.execution.job_framing_version,1);
  const names=readArchiveEntries(result.collected[0].bytes_content).map(entry=>entry.name);
  assert.ok(names.includes('main.js'),'a follow-up receives the project root, without an extra repo/ wrapper');
  assert.ok(!names.some(name=>name.startsWith('repo/')||name.includes('.git')));
});

test('message jobs start in an empty workspace and return only faravan-output/ as a tree', async t => {
  const {execFileSync}=await import('node:child_process');
  const scratch=await mkdtemp(join(tmpdir(),'faravan-message-out-'));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  let framed='';
  const backend={
    admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),
    prepare:async spec=>({scratch_dir:scratch,sandbox_id:'message-test',_entrypoint:spec.entrypoint}),
    start:async handle=>{
      const agent=handle._entrypoint.includes('--append-system-prompt');
      if(agent) framed=handle._entrypoint;
      const fn=agent?'claude() { ls -A; mkdir -p faravan-output && echo a,b > faravan-output/data.csv && echo stray > notes.txt; }; ':'';
      handle._lastExecStdout=execFileSync('sh',['-c',fn+handle._entrypoint],{cwd:scratch,encoding:'utf8'});
    },
    collectDeclaredOutputs:async(handle,manifest)=>manifest.map(path=>({path,bytes_content:execFileSync('tar',['tzf',join(scratch,path)])})),
    destroy:async()=>({removed:true}),
  };
  const jobSpec=buildValidatedJobSpec({taskDigest:'b'.repeat(64),harness:resolveHarness('claude-code-subscription'),entrypointWithPrompt:'unused'});
  const result=await runJob({jobSpec,backend,outputDir:'faravan-output',frameJob:{harnessId:'claude-code-subscription',prompt:'answer X',result:'message'}});
  assert.match(framed,/final message is what they read/);
  assert.deepEqual(result.candidate,{format:'tree'},'a requested tree is not a failed diff');
  const names=result.collected[0].bytes_content.toString().trim().split('\n').map(n=>n.replace(/\/$/,'')).sort();
  assert.deepEqual(names,['faravan-output','faravan-output/data.csv']);
});

for (const step of ['status probe','working directory check','diff base']) {
  test('a disk stop during the '+step+' ends the job as host_disk_low before the agent runs', async t => {
    const scratch=await mkdtemp(join(tmpdir(),'faravan-disk-prestep-'));
    t.after(()=>rm(scratch,{recursive:true,force:true}));
    let agentRan=false, destroyed=false;
    const backend={
      admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),
      prepare:async spec=>({scratch_dir:scratch,sandbox_id:'disk-prestep',_entrypoint:spec.entrypoint}),
      // start() reports a disk stop of its own run as a result, not an error.
      start:async handle=>{
        const pre=step==='status probe'?handle._entrypoint==='status-probe':step==='diff base'?handle._entrypoint.includes('rev-parse'):handle._sourcePreparation;
        if(pre)return {host_disk_low:true};
        if(handle._entrypoint==='status-probe'||handle._entrypoint.includes('rev-parse')||handle._sourcePreparation){handle._lastExecStdout='';return;}
        agentRan=true;
      },
      collectDeclaredOutputs:async()=>[],
      destroy:async()=>{destroyed=true;return {removed:true};},
    };
    const jobSpec=buildValidatedJobSpec({taskDigest:'d'.repeat(64),harness:resolveHarness('codex'),entrypointWithPrompt:'agent-run'});
    await assert.rejects(runJob({jobSpec,backend,statusProbe:'status-probe',gitDiff:step==='diff base',
      ...(step==='working directory check'?{workingDirectory:'sub'}:{})}),{code:'host_disk_low'});
    assert.equal(agentRan,false,'the agent never starts on a halted sandbox');
    assert.equal(destroyed,true,'the sandbox is still removed');
  });
}

test('an agent that writes nothing still returns an empty faravan-output/ tree', async t => {
  const {execFileSync}=await import('node:child_process');
  const scratch=await mkdtemp(join(tmpdir(),'faravan-output-empty-'));
  t.after(()=>rm(scratch,{recursive:true,force:true}));
  const backend={
    admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),
    prepare:async spec=>({scratch_dir:scratch,sandbox_id:'output-empty',_entrypoint:spec.entrypoint}),
    start:async handle=>{ if(!handle._entrypoint.includes('claude')) execFileSync('sh',['-c',handle._entrypoint],{cwd:scratch}); },
    collectDeclaredOutputs:async(handle,manifest)=>manifest.map(path=>({path,bytes_content:execFileSync('tar',['tzf',join(scratch,path)])})),
    destroy:async()=>({removed:true}),
  };
  const jobSpec=buildValidatedJobSpec({taskDigest:'c'.repeat(64),harness:resolveHarness('claude-code-subscription'),entrypointWithPrompt:'unused'});
  const result=await runJob({jobSpec,backend,outputDir:'faravan-output',frameJob:{harnessId:'claude-code-subscription',prompt:'x',result:'files'}});
  assert.deepEqual(result.collected[0].bytes_content.toString().trim().split('\n').map(n=>n.replace(/\/$/,'')),['faravan-output']);
});

test('working-directory jobs run agent and checks in subdirectory while framing and output stay rooted',async t=>{
 const {execFileSync}=await import('node:child_process');
 const scratch=await mkdtemp(join(tmpdir(),'faravan-selected-cwd-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
 await mkdir(join(scratch,'packages','app'),{recursive:true});let checkDirectory,outputCommand;
 const backend={
  admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),
  prepare:async spec=>({scratch_dir:scratch,sandbox_id:'workdir-test',_entrypoint:spec.entrypoint}),
  start:async handle=>{if(handle._entrypoint.includes('codex exec'))handle._lastExecStdout=execFileSync('sh',['-c','codex() { pwd; }; '+handle._entrypoint],{cwd:scratch,encoding:'utf8'});
   else if(handle._sourcePreparation)handle._lastExecStdout=execFileSync('sh',['-c',handle._entrypoint],{cwd:scratch,encoding:'utf8'});else if(handle._entrypoint.startsWith('mkdir -p .wf-result'))outputCommand=handle._entrypoint;},
  prepareCheck:async()=>({scratch_dir:scratch,sandbox_id:'check-test'}),
  verificationFiles:async()=>[],verify:async(handle,input)=>{assert.equal(handle.sandbox_id,'check-test');checkDirectory=input.workdir;return {exit:0,stdout:'',timed_out:false};},
  collectDeclaredOutputs:async()=>[{path:'.wf-result/result.tar.gz',bytes_content:Buffer.from('result')}],destroy:async()=>({removed:true})};
 const jobSpec=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('codex'),entrypointWithPrompt:'unused',verify:{cmd:'pwd'}});
 const result=await runJob({jobSpec,backend,workingDirectory:'packages/app',frameJob:{harnessId:'codex',prompt:'create a report'}});
 assert.equal(result.execution.stdout.trim(),join(scratch,'packages','app'));assert.equal(result.execution.workspace_path,scratch);
 assert.equal(checkDirectory,'./packages/app');assert.match(outputCommand,/-C \. \./);
 await assert.rejects(runJob({jobSpec,backend,workingDirectory:'missing',frameJob:{harnessId:'codex',prompt:'x'}}),{code:'invalid_working_directory'});
});

test('a graceful imposed stop is collected as one result and remains explicit in execution facts',async()=>{
  let handle;
  const backend={admitJob:()=>({ok:true}),probeCapabilities:async()=>({available:true}),
    prepare:async()=>handle={sandbox_id:'synthetic',scratch_dir:'/synthetic',_entrypoint:'agent'},
    start:async(h,opts)=>{if(h===handle&&!h._bookkeeping){assert.equal(opts.lendingBudget.agent,'claude');h._lastExecStdout='partial work';return {stop:{stop_reason:'budget'},meter:{used_units:1}};}},
    collectDeclaredOutputs:async()=>[{path:'.wf-result/result.tar.gz',bytes_content:Buffer.from('partial')}],destroy:async()=>({removed:true})};
  const jobSpec=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('claude-code-subscription'),entrypointWithPrompt:'true'});
  const result=await runJob({jobSpec,backend,lendingBudget:{agent:'claude',budget:{unit:'claude_usd',limit:1}}});
  assert.equal(result.execution.stop_reason,'budget');assert.equal(result.collected[0].bytes_content.toString(),'partial');
});

test('a late collection failure preserves the cancellation that removed the sandbox', {timeout:5000}, async()=>{
  const controller=new AbortController(),reason=Object.assign(new Error('The job was stopped'),{code:'provider_limit'});
  let handle,entered,rejectCollection,cancels=0,destroys=0;
  const collecting=new Promise(resolve=>{entered=resolve;});
  const backend={admitJob:()=>({ok:true}),probeCapabilities:async()=>({available:true}),
    prepare:async()=>handle={sandbox_id:'synthetic',scratch_dir:'/synthetic',_entrypoint:'agent'},
    start:async h=>{
      if(h===handle&&!h._bookkeeping)return {stop:{stop_reason:'provider_limit'},meter:{used_units:0}};
      entered();
      return new Promise((resolve,reject)=>{rejectCollection=reject;});
    },
    collectDeclaredOutputs:async()=>assert.fail('cancelled collection must not publish output'),
    cancel:async()=>{cancels++;},
    destroy:async()=>{destroys++;rejectCollection?.(Object.assign(new Error('Sandbox was removed during collection'),{code:'guard_install_failed'}));return {removed:true};}};
  const jobSpec=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('claude-code-subscription'),entrypointWithPrompt:'true'});
  const running=runJob({jobSpec,backend,signal:controller.signal});
  await collecting;
  controller.abort(reason);
  await assert.rejects(running,error=>error===reason,'the secondary mkdir/guard error must not replace the initiating stop');
  assert.equal(cancels,1);assert.equal(destroys,1);
});

test('cancellation stops compute while destructive cleanup waits for collected output retention',async()=>{
  const controller=new AbortController(),reason=Object.assign(new Error('cancelled'),{code:'cancelled'});
  let collected,retain,cancels=0,destroys=0;
  const handoff=new Promise(resolve=>{retain=resolve;});
  const entered=new Promise(resolve=>{collected=resolve;});
  const backend={admitJob:()=>({ok:true}),probeCapabilities:async()=>({available:true}),
    prepare:async()=>({sandbox_id:'synthetic',scratch_dir:'/synthetic',_entrypoint:'agent'}),
    start:async()=>{},
    collectDeclaredOutputs:async()=>[{path:'.wf-result/result.tar.gz',bytes_content:Buffer.from('completed work')}],
    cancel:async()=>{cancels++;},destroy:async()=>{destroys++;return {removed:true};}};
  const jobSpec=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('claude-code-subscription'),entrypointWithPrompt:'true'});
  const running=runJob({jobSpec,backend,signal:controller.signal,onCollected:async result=>{
    assert.equal(result.collected[0].bytes_content.toString(),'completed work');collected();await handoff;
  }});
  await entered;
  try {
    controller.abort(reason);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(cancels,1,'compute stops without waiting for the writer');
    assert.equal(destroys,0,'the only output source remains until retention succeeds');
  } finally {retain();}
  await assert.rejects(running,error=>error===reason);
  assert.equal(destroys,1);
});

test('backend deadline deletion shares the collected output handoff',{timeout:5000},async t=>{
  const {DockerSbxBackend}=await import('../lib/docker-backend.mjs');
  const controller=new AbortController(),reason=Object.assign(new Error('deadline'),{code:'wall_timeout'});
  let handle,collected,retain,removals=0,deadlineCleanup;
  const handoff=new Promise(resolve=>{retain=resolve;});
  const entered=new Promise(resolve=>{collected=resolve;});
  const backend=Object.assign(Object.create(DockerSbxBackend.prototype),{
    admitJob:()=>({ok:true}),probeCapabilities:async()=>({available:true}),
    prepare:async()=>handle={sandbox_id:'synthetic',scratch_dir:'/synthetic',_entrypoint:'agent'},
    start:async()=>{},assertActive:async()=>{},cancel:async()=>{},deadlineTimers:{clearTimeout(){}},_closeDiskSentry(){},
    collectDeclaredOutputs:async()=>[{path:'.wf-result/result.tar.gz',bytes_content:Buffer.from('completed work')}],
    _resolveCompute:async()=>{removals++;return {removed:true};},_finishDestroy:async()=>({removed:true,scratch_removed:true})});
  const jobSpec=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('claude-code-subscription'),entrypointWithPrompt:'true'});
  const running=runJob({jobSpec,backend,signal:controller.signal,onCollected:async()=>{collected();await handoff;}});
  running.catch(()=>{});
  t.after(async()=>{retain();await Promise.allSettled([running,deadlineCleanup]);});
  await entered;controller.abort(reason);
  // The backend watchdog invokes destroy itself, outside the executor's release helper.
  await backend.cancel(handle);deadlineCleanup=backend.destroy(handle);
  try {
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(removals,0,'the backend cannot delete output while the collected-byte writer owns it');
  } finally {retain();}
  await assert.rejects(running,error=>error===reason);
  assert.equal((await deadlineCleanup).removed,true);
  assert.ok(removals>0);
});

test('executor bookkeeping preserves the launched handle through diff and tar output',async t=>{
  const scratch=await mkdtemp(join(tmpdir(),'executor-handle-authority-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
  const handle={sandbox_id:'wf-receipt',scratch_dir:scratch,_entrypoint:'agent-run',_mountless:true,_workspaceReady:true,_credentialEnv:['CODEX_HOME=/guest']};
  const commands=[];
  const backend={admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),prepare:async()=>handle,
    start:async current=>{assert.equal(current,handle,'bookkeeping uses the launched object');commands.push(current._entrypoint);current._lastExecStdout='agent result';},
    collectDeclaredOutputs:async()=>[{path:'.wf-result/result.tar.gz',bytes_content:Buffer.from('collected output')}],destroy:async()=>({removed:true})};
  const jobSpec=buildValidatedJobSpec({taskDigest:'f'.repeat(64),harness:resolveHarness('codex'),entrypointWithPrompt:'agent-run'});
  const result=await runJob({jobSpec,backend,gitDiff:true});
  assert.equal(result.collected[0].bytes_content.toString(),'collected output');
  assert.ok(commands.some(command=>/git diff|tar czf/.test(command)));
  assert.equal(handle._bookkeeping,undefined);assert.equal(handle._entrypoint,'agent-run');
});

test('prepare receives the cancel signal and the remaining wall time for the default and for an added account', async () => {
  const jobSpec=buildValidatedJobSpec({taskDigest:'a'.repeat(64),harness:resolveHarness('codex'),entrypointWithPrompt:'unused'});
  const wallRemainingMs=()=>60_000, controller=new AbortController();
  for(const accountKey of [undefined,'claude','claude:11111111-1111-4111-8111-111111111111']){
    const seen=[];
    const backend={admitJob:async()=>({ok:true}),probeCapabilities:async()=>({available:true}),
      prepare:async(_spec,options)=>{seen.push(options);throw Object.assign(new Error('stop here'),{code:'stop_here'});}};
    await assert.rejects(runJob({jobSpec,backend,accountKey,signal:controller.signal,wallRemainingMs}),{code:'stop_here'});
    assert.equal(seen.length,1);
    assert.equal(seen[0].signal,controller.signal,'cancellation reaches prepare for '+String(accountKey));
    assert.equal(seen[0].wallRemainingMs,wallRemainingMs,'the remaining wall time reaches prepare for '+String(accountKey));
    assert.equal(seen[0].accountKey,accountKey?.includes(':')?accountKey:undefined);
  }
});
