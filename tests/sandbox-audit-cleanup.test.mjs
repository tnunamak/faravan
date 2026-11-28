import './helpers/no-browser.mjs';
import {sandboxOwnerScope} from '../lib/sandbox-name.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat, writeFile, chmod, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DockerSbxBackend, _internal } from '../lib/docker-backend.mjs';
import { createSbxPolicy, sbxRunner } from './helpers/sbx-policy-model.mjs';
import { createLender } from '../lib/v1/lender.mjs';
import { lenderFixture, until } from './helpers/v1-lender-fixture.mjs';
import { createCheckSandboxes } from '../lib/v1/check-sandboxes.mjs';

function backendFixture() {
  const runner = sbxRunner(createSbxPolicy(), args => ({ code: 0,
    stdout: args[0] === 'ls' ? '[]' : '', stderr: '' }));
  return () => new DockerSbxBackend({ runCommand: runner.run });
}
const spec = job_id => ({ job_id, image: 'claude', entrypoint: 'true',
  execution_scope: 'borrowed', auth_strategy: 'docker-native-oauth',
  resources: { cpu: 1, memory_mib: 512, storage_mib: 512, wall_seconds: 60, output_bytes: 4096, network_bytes: 1, max_processes: 1 },
  inputs: [], output_manifest: [], egress: 'internet', provider_hosts: ['**.anthropic.com'] });
const pending = jobId => ({owner_scope:sandboxOwnerScope(),sbx_home:_internal.sbxHome(), jobId, attemptId: 'test-attempt', attempt: { attempt_id: 'test-attempt' } });
// The first backend stands for a process that has exited: its cleanup leases end and its records stay.
const exited = (backend, ...handles) => { for (const handle of handles) backend.cleanupJournal.finish(handle, {}); };

test('R3: dead creator records reclaim existing VMs only after validated removal', async t => {
  const policy=createSbxPolicy(), released=[];
  const runner=sbxRunner(policy,args=>({code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''}));
  const backend=new DockerSbxBackend({runCommand:runner.run,storage:{release:async name=>released.push(name)}});
  const dead=await backend.prepare(spec('r3-existing-dead'));
  const live=await backend.prepare(spec('r3-existing-live'));
  const invalid=await backend.prepare(spec('r3-existing-invalid'));
  const invalidFile=join(_internal.sbxHome(),'scratch-journal',invalid.sandbox_id+'.json');
  const invalidRecord=JSON.parse(await readFile(invalidFile,'utf8'));
  t.after(async()=>{await writeFile(invalidFile,JSON.stringify(invalidRecord)); await backend.destroy(dead); await backend.destroy(live); await backend.destroy(invalid);});
  // Only the cleanup record removes compute, through its own create receipt. The scratch
  // journal's owner pid no longer authorizes a removal; a dead creator is a released lease.
  await writeFile(invalidFile,JSON.stringify({...invalidRecord,ownerPid:1073741824,scratch:live.scratch_dir}));
  await backend.reconcileOrphanedScratch();
  assert.equal(Object.hasOwn(policy.state.sandboxes,dead.sandbox_id),true,'orphan scratch recovery never removes compute');
  assert.deepEqual(runner.calls.filter(args=>args[0]==='rm'),[]);
  exited(backend,dead);
  await backend.reapCleanup();
  assert.equal(Object.hasOwn(policy.state.sandboxes,dead.sandbox_id),false);
  assert.equal(Object.hasOwn(policy.state.sandboxes,live.sandbox_id),true);
  assert.equal(Object.hasOwn(policy.state.sandboxes,invalid.sandbox_id),true);
  await assert.rejects(stat(dead.scratch_dir),{code:'ENOENT'});
  assert.ok((await stat(live.scratch_dir)).isDirectory());
  assert.deepEqual(released,[dead.sandbox_id]);
  const removal=runner.calls.findIndex(args=>args[0]==='rm' && args.at(-1)===dead.sandbox_id);
  assert.ok(removal>=0);
  assert.ok(runner.calls.slice(removal+1).some(args=>args[0]==='ls'));
});

test('R3: an orphan still present after remove keeps scratch and reservation', async t => {
  const policy=createSbxPolicy(), released=[];
  const runner=sbxRunner(policy,args=>({code:0,stdout:args[0]==='ls'?JSON.stringify(Object.keys(policy.state.sandboxes).map(name=>({name,status:'running'}))):'',stderr:''}));
  let denyRemoval=true;
  const backend=new DockerSbxBackend({runCommand:async(args,options)=>args[0]==='rm' && denyRemoval?{code:0,stdout:''}:runner.run(args,options),storage:{release:async name=>released.push(name)}});
  const dead=await backend.prepare(spec('r3-removal-unconfirmed'));
  t.after(async()=>{denyRemoval=false; await backend.destroy(dead);});
  const file=join(_internal.sbxHome(),'scratch-journal',dead.sandbox_id+'.json');
  const record=JSON.parse(await readFile(file,'utf8'));
  await writeFile(file,JSON.stringify({...record,ownerPid:1073741824}));
  await backend.reconcileOrphanedScratch();
  assert.ok((await stat(dead.scratch_dir)).isDirectory());
  assert.ok(Object.hasOwn(policy.state.sandboxes,dead.sandbox_id));
  assert.deepEqual(released,[]);
});

test('N1: restart reclaims the exact job and helper scratch but leaves a sibling alone', async t => {
  const open = backendFixture(), backend = open();
  const job = await backend.prepare(spec('audit-cleanup'));
  const helper = await backend.prepare(spec('audit-cleanup-check'));
  const sibling = await backend.prepare(spec('audit-cleanup-sibling'));
  t.after(async () => { await backend.destroy(job); await backend.destroy(helper); await backend.destroy(sibling); });
  exited(backend, job, helper, sibling);
  const recovered = await open().reconcilePending(pending('audit-cleanup'));
  assert.equal(recovered.removed, true);
  await assert.rejects(stat(job.scratch_dir), { code: 'ENOENT' });
  await assert.rejects(stat(helper.scratch_dir), { code: 'ENOENT' });
  assert.ok((await stat(sibling.scratch_dir)).isDirectory());
});

test('N1: failed scratch deletion remains retryable after sandbox removal and restart', async t => {
  const open = backendFixture(), backend = open();
  const handle = await backend.prepare(spec('audit-cleanup-denied'));
  await writeFile(join(handle.scratch_dir, 'owned'), 'test');
  await chmod(handle.scratch_dir, 0o500);
  t.after(async () => { await chmod(handle.scratch_dir, 0o700).catch(() => {}); await backend.destroy(handle); });
  const receipt = await backend.destroy(handle);
  assert.equal(receipt.removed, true);
  assert.equal(receipt.scratch_removed, false);
  await chmod(handle.scratch_dir, 0o700);
  const recovered = await open().reconcilePending(pending('audit-cleanup-denied'));
  await assert.rejects(stat(handle.scratch_dir), { code: 'ENOENT' });
  assert.equal(recovered.scratch_removed, true);
});

test('N1: result delivery retains a separate scratch retry record after compute has ceased', async t => {
  const f = await lenderFixture(t);
  f.backend.destroy = async () => { f.calls.push(['destroy']); return { removed: true, scratch_removed: false }; };
  const controller = new AbortController();
  const lender = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [], onEvent: event => f.events.push(event) });
  const running = lender.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.result && f.saved()?.pending === null, 'result delivery and cessation settlement');
  assert.equal(f.saved().scratchPending?.length, 1);
  assert.equal(f.saved().scratchPending[0].attemptId, f.attempt().attempt_id);
  assert.equal(f.saved().scratchPending[0].scratchDir, f.root);
  controller.abort(); await running;
  let retries = 0, removable = false;
  f.backend.reconcilePending = async record => { retries++; return { removed: true, scratch_removed: removable, attemptId: record.attemptId }; };
  const restartController = new AbortController();
  const restarted = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [] });
  const recovery = restarted.start(restartController.signal);
  t.after(async () => { restartController.abort(); await recovery; });
  await until(() => retries > 0, 'scratch recovery after restart');
  assert.equal(f.saved().scratchPending.length, 1, 'failed deletion survives restart');
  removable = true;
  f.clock.advance(1000);
  // Cleanup isolation rule: scratch debt follows the ordinary idle poll and does not close admission.
  await until(() => {f.clock.advance(1000);return f.saved().scratchPending.length === 0;}, 'verified scratch removal');
});

test('N1: recovery refuses a journal pointing at a sibling and a scratch symlink', async t => {
  const open = backendFixture(), backend = open();
  const handle = await backend.prepare(spec('audit-cleanup-path'));
  const sibling = await backend.prepare(spec('audit-cleanup-path-sibling'));
  const recordPath = join(_internal.sbxHome(), 'scratch-journal', handle.sandbox_id + '.json');
  const original = await readFile(recordPath, 'utf8');
  t.after(async () => { await writeFile(recordPath, original); await backend.destroy(handle); await backend.destroy(sibling); });
  exited(backend, handle, sibling);
  await writeFile(recordPath, JSON.stringify({ ...JSON.parse(original), scratch: sibling.scratch_dir }));
  assert.equal((await open().reconcilePending(pending('audit-cleanup-path'))).scratch_removed, false);
  assert.ok((await stat(sibling.scratch_dir)).isDirectory());
  // The refused recovery left the cleanup record open. Swap its scratch for a symlink to the
  // sibling before the scratch journal is repaired: removal must not follow it.
  await rm(handle.scratch_dir, { recursive: true, force: true });
  await symlink(sibling.scratch_dir, handle.scratch_dir);
  await writeFile(recordPath, original);
  // A symlinked scratch is refused outright: no removal is reported and the sibling stays.
  const refused = await open().reconcilePending(pending('audit-cleanup-path'));
  assert.equal(refused.removed, false);
  assert.equal(refused.code, 'cessation_unverified');
  assert.ok((await stat(sibling.scratch_dir)).isDirectory());
});

test('R2: failed check preparation survives result delivery and retries after restart', async t => {
  const f = await lenderFixture(t, { mutateJob: job => {
    job.verify = { cmd: 'true' }; job.requirements.capabilities.push('verify_v1'); job.requirements.limits.wall_seconds = 240;
  } });
  const capabilities = f.backend.lenderCapabilities;
  f.backend.lenderCapabilities = () => ({ ...capabilities(), capabilities: ['verify_v1'] });
  f.backend.verificationFiles = async () => '';
  f.backend.verify = async () => { throw new Error('check must not run'); };
  f.backend.prepareCheck = async () => { throw Object.assign(new Error('check preparation failed'),
    { cleanup_receipt: { removed: true, scratch_removed: false } }); };
  const controller = new AbortController();
  const lender = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [] });
  const running = lender.start(controller.signal);
  t.after(async () => { controller.abort(); await running; });
  await until(() => f.result && f.saved()?.pending === null, 'skipped check result');
  assert.match(f.result.payload.checks[0].skipped, /workspace could not start/);
  assert.equal(f.saved().scratchPending?.length, 1);
  controller.abort(); await running;
  let recovered;
  f.backend.reconcilePending = async record => { recovered = record;
    return { removed: true, scratch_removed: true, attemptId: record.attemptId }; };
  const restart = new AbortController();
  const recovery = createLender({...f.runOptions, client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy,
    clock: f.clock, approve: async () => true, credentialValues: async () => [] }).start(restart.signal);
  t.after(async () => { restart.abort(); await recovery; });
  await until(() => recovered && f.saved().scratchPending.length === 0, 'check cleanup retry');
  assert.equal(recovered.attemptId, f.attempt().attempt_id);
});

test('R2: setup reaper recovers scratch when a crash loses the prepare handle', async t => {
  const backend = backendFixture()(), prepare = backend.prepare.bind(backend);
  let leaked;
  backend.prepare = async job => { leaked = await prepare(job); throw new Error('crash before handle persisted'); };
  const file = join(_internal.sbxHome(), 'setup-crash-test.json');
  const checks = createCheckSandboxes({ backend, file, now: () => 1000, timeoutMs: 0 });
  t.after(async () => { if (leaked) await backend.destroy(leaked); await rm(file, { force: true }); });
  await assert.rejects(checks.backend.prepare(spec('wf-pull-0000000000000000-1234abcd')));
  assert.equal(JSON.parse(await readFile(file, 'utf8'))[0].scratch_dir, null);
  await checks.reap();
  // The check journal only forgets the lease; the cleanup record that reserved the name owns the scratch.
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
  exited(backend, leaked);
  await backend.reapCleanup();
  await assert.rejects(stat(leaked.scratch_dir), { code: 'ENOENT' });
});

test('R2: recovered setup handles release their durable storage reservation', async t => {
  // A handle carrying its recorded home releases through the storage pool of that home, so the pool is injected.
  const released=[], runner=sbxRunner(createSbxPolicy(), args => ({ code: 0, stdout: args[0] === 'ls' ? '[]' : '', stderr: '' }));
  const backend=new DockerSbxBackend({ runCommand: runner.run, storage: { release: async id=>released.push(id) } });
  const handle=await backend.prepare(spec('recovered-storage'));
  t.after(()=>backend.destroy(handle));
  await backend.destroy({job_id:handle.job_id,sandbox_id:handle.sandbox_id,scratch_dir:handle.scratch_dir,sbx_runtime:handle.sbx_runtime,...backend.sandboxOwnership()});
  assert.deepEqual(released,[handle.sandbox_id]);
});

test('R2: startup sweeps a dead setup journal without an attempt row, preserving live preparation', async t => {
  const backend=backendFixture()(), dead=await backend.prepare(spec('orphan-dead')), live=await backend.prepare(spec('orphan-live'));
  t.after(async()=>{await backend.destroy(dead);await backend.destroy(live);});
  const journal=join(_internal.sbxHome(),'scratch-journal',dead.sandbox_id+'.json');
  const value=JSON.parse(await readFile(journal,'utf8'));
  await writeFile(journal,JSON.stringify({...value,ownerPid:1073741824}));
  const checks=createCheckSandboxes({backend,file:join(_internal.sbxHome(),'empty-setup-journal.json')});
  await checks.reap();
  assert.ok((await stat(dead.scratch_dir)).isDirectory(),'the check journal does not remove scratch');
  exited(backend,dead);
  await backend.reapCleanup();
  await assert.rejects(stat(dead.scratch_dir),{code:'ENOENT'});
  assert.ok((await stat(live.scratch_dir)).isDirectory());
});
