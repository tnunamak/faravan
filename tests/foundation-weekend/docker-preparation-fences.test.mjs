import '../helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {BACKEND_ID, DockerSbxBackend} from '../../lib/docker-backend.mjs';
import {runJob} from '../../lib/executor.mjs';
import {createSbxPolicy, sbxRunner} from '../helpers/sbx-policy-model.mjs';
import {receiptBackend, receiptJob} from '../helpers/sandbox-receipt-fixture.mjs';

const unknown = {schemaVersion:1,state:'unknown',jobId:null,attemptId:null,sandboxId:null,observedAtMs:null};
const ok = (stdout = '') => ({code:0,stdout,stderr:''});
function deferred() {
  let resolve;
  const promise = new Promise(r => {resolve = r;});
  return {promise,resolve};
}

// No native command fallback: the runner models only create/readiness/inventory/removal.
// Real prepare, observer, deadline registration and journal ownership remain intact.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'preparation-fences-'));
  const scratch = join(root, 'scratch');
  await mkdir(scratch);
  const oldScratch = process.env.FARAVAN_SCRATCH_ROOT;
  process.env.FARAVAN_SCRATCH_ROOT = scratch;
  const model = createSbxPolicy();
  const creates = [];
  const inventory = new Set();
  let createHook = async () => ok();
  let readyHook = async () => ok();
  const unexpected = [];
  const runner = sbxRunner(model, async (args, options) => {
    if (args[0] === 'create' && args.includes('--name')) {
      const name = args[args.indexOf('--name') + 1];
      creates.push(name);
      inventory.add(name);
      return createHook(name, options);
    }
    if (args.join(' ') === 'ls --json') return ok(JSON.stringify([...inventory].map(name => ({name,status:'running'}))));
    if (args.join(' ') === 'template ls --json') return ok('[]');
    if (args.length === 4 && args[0] === 'exec' && args[2] === '--' && args[3] === 'true') {
      assert.ok(inventory.has(args[1]));
      return readyHook(args[1]);
    }
    if (args.length === 3 && args[0] === 'rm' && args[1] === '--force') {inventory.delete(args[2]); return ok();}
    if (args.length === 2 && args[0] === 'stop') return ok();
    unexpected.push(args);
    throw new Error('Unexpected synthetic sbx command: ' + JSON.stringify(args));
  }, {kitAllow:[]});
  const backend = receiptBackend(root, runner, {autoRepair:false,
    streamOutput: async () => {throw new Error('Unexpected agent stream dispatch');},
  });
  assert.ok(backend instanceof DockerSbxBackend);
  const owned = new Set();
  const inflight = new Set();
  const releases = new Set();
  t.after(async () => {
    for (const release of releases) release();
    await Promise.allSettled([...inflight]);
    let failure;
    for (const handle of owned) {
      try {
        const receipt = await backend.destroy(handle);
        assert.equal(receipt.removed, true);
        assert.equal(receipt.scratch_removed, true);
      } catch (error) {failure ??= error;}
    }
    if (oldScratch === undefined) delete process.env.FARAVAN_SCRATCH_ROOT;
    else process.env.FARAVAN_SCRATCH_ROOT = oldScratch;
    await rm(root, {recursive:true,force:true});
    assert.deepEqual(unexpected, [], 'no unmodelled/native command');
    assert.ok(!runner.calls.some(args => args[0] === 'run'), 'no agent run dispatch');
    if (failure) throw failure;
  });
  function prepare(job, options) {
    const promise = backend.prepare(job, options).then(handle => {owned.add(handle); return handle;});
    inflight.add(promise);
    promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
    return promise;
  }
  return {root,model,inventory,runner,backend,prepare,creates,owned,releases,
    setCreateHook(hook) {createHook = hook;},
    setReadyHook(hook) {readyHook = hook;},
    async destroy(handle) {
      const receipt = await backend.destroy(handle);
      assert.equal(receipt.removed, true);
      assert.equal(receipt.scratch_removed, true);
      owned.delete(handle);
      return receipt;
    }};
}
function context(job, generation = 1) {
  return {jobId:job.job_id,attemptId:'attempt-' + generation,generation};
}
function assertPrepared(backend, handle, binding) {
  const view = backend.getPreparationObservation(binding);
  assert.deepEqual(view, {schemaVersion:1,state:'prepared',jobId:binding.jobId,
    attemptId:binding.attemptId,sandboxId:handle.sandbox_id,observedAtMs:view.observedAtMs});
  assert.ok(Number.isFinite(view.observedAtMs) && view.observedAtMs >= 0);
  assert.equal(handle.job_id, binding.jobId);
  const authority = backend.cleanupJournal.admissionAuthority(handle);
  assert.equal(authority._cleanupId, handle._cleanupId);
  assert.equal(authority.sandbox_id, handle.sandbox_id);
  assert.equal(authority.compute_created, true);
  assert.equal(authority.create_settled, true);
  assert.deepEqual(backend.getPreparationObservation({...binding,generation:binding.generation + 1}), unknown);
}

test('real prepare publishes only its trusted binding and current journal resource', {timeout:60000}, async t => {
  const f = await fixture(t), job = receiptJob(), binding = context(job);
  assert.deepEqual(f.backend.getPreparationObservation(), unknown);
  const handle = await f.prepare(job, {preparationContext:binding});
  assertPrepared(f.backend, handle, binding);
  const path = join(f.root, 'profile', 'v1', 'sandbox-cleanup', handle._cleanupId + '.json');
  const bytes = await readFile(path);
  try {
    await rm(path);
    assert.deepEqual(f.backend.getPreparationObservation(binding), unknown, 'removed retained row');
    await writeFile(path, JSON.stringify({...JSON.parse(bytes),_cleanupId:randomUUID()}));
    assert.deepEqual(f.backend.getPreparationObservation(binding), unknown, 'replacement retained row');
  } finally {await writeFile(path, bytes);}
  assertPrepared(f.backend, handle, binding);
  await f.destroy(handle);
  assert.deepEqual(f.backend.getPreparationObservation(binding), unknown, 'destroyed resource is not prepared');
});

test('legacy preparation and forged guest fields cannot publish trusted observations', {timeout:60000}, async t => {
  const f = await fixture(t);
  for (const forged of [false,true]) {
    const job = receiptJob({job_id:'legacy-' + forged});
    if (forged) {
      job.preparationContext = context(job);
      await assert.rejects(f.prepare(job), error => error.code === 'policy_unenforceable');
      assert.deepEqual(f.backend.getPreparationObservation(), unknown);
    } else {
      const handle = await f.prepare(job);
      assert.deepEqual(f.backend.getPreparationObservation(), unknown);
      await f.destroy(handle);
    }
  }
});

test('older held readiness completion cannot overwrite a newer preparation', {timeout:60000}, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.releases.add(release.resolve);
  let number = 0;
  f.setReadyHook(async () => {
    if (++number === 1) {entered.resolve(); await release.promise;}
    return ok();
  });
  const oldJob = receiptJob({job_id:'older'}), newJob = receiptJob({job_id:'newer'});
  const oldBinding = context(oldJob, 1), newBinding = context(newJob, 2);
  const oldResult = f.prepare(oldJob, {preparationContext:oldBinding});
  await entered.promise;
  assert.equal(f.backend.getPreparationObservation(oldBinding).state, 'pending');
  const newer = await f.prepare(newJob, {preparationContext:newBinding});
  assertPrepared(f.backend, newer, newBinding);
  release.resolve();
  const older = await oldResult;
  assertPrepared(f.backend, newer, newBinding);
  assert.deepEqual(f.backend.getPreparationObservation(oldBinding), unknown);
  await f.destroy(older);
  assertPrepared(f.backend, newer, newBinding);
  await f.destroy(newer);
});

test('cancelled held create is unknown, rejects after late completion and cleans its actual resource', {timeout:60000}, async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
  f.releases.add(release.resolve);
  f.setCreateHook(async () => {entered.resolve(); await release.promise; return ok();});
  const job = receiptJob({job_id:'cancelled-late'}), binding = context(job);
  const result = f.prepare(job, {preparationContext:binding,signal:controller.signal});
  const rejected = assert.rejects(result, error => {
    assert.equal(error.cleanup_receipt?.removed, true);
    assert.equal(error.cleanup_receipt?.scratch_removed, true);
    return true;
  });
  await entered.promise;
  assert.equal(f.backend.getPreparationObservation(binding).state, 'pending');
  controller.abort(new Error('test-owned cancellation'));
  assert.deepEqual(f.backend.getPreparationObservation(binding), unknown);
  release.resolve();
  await rejected;
  assert.deepEqual(f.backend.getPreparationObservation(binding), unknown);
  for (const name of f.creates) assert.ok(!f.inventory.has(name));
});

test('failed create never publishes prepared even if the fake daemon materialized it', {timeout:60000}, async t => {
  const f = await fixture(t);
  f.setCreateHook(async () => ({code:1,stdout:'',stderr:'synthetic create failed'}));
  const job = receiptJob({job_id:'failed-create'}), binding = context(job);
  await assert.rejects(f.prepare(job, {preparationContext:binding}), error => {
    assert.equal(error.cleanup_receipt?.removed, true);
    return true;
  });
  assert.deepEqual(f.backend.getPreparationObservation(binding), unknown);
  for (const name of f.creates) assert.ok(!f.inventory.has(name));
});

// This is the explicitly authorized external preflight seam, not daemon evidence.
// prepare/observer/admission/destruction remain the actual backend implementation.
function syntheticPreflight(backend, available) {
  let calls = 0;
  backend.probeCapabilities = async () => {
    calls++;
    return {available,backend_id:BACKEND_ID,version:'synthetic-fixture-only',
      missing_prerequisites:available ? [] : ['synthetic-unavailable']};
  };
  return () => calls;
}

test('real runJob observes exact prepared handle at authorize and destroys it before start', {timeout:60000}, async t => {
  const f = await fixture(t), job = receiptJob({job_id:'executor-prepared'});
  const binding = Object.freeze(context(job, 17));
  const probes = syntheticPreflight(f.backend, true);
  const sentinel = new Error('test-owned authorize stop');
  let retained, authorized = 0;
  await assert.rejects(runJob({
    jobSpec:job,backend:f.backend,preparationContext:binding,
    authorize:handle => {
      retained = handle;
      f.owned.add(handle);
      authorized++;
      assert.equal(handle.backend_id, BACKEND_ID);
      assertPrepared(f.backend, handle, binding);
      assert.deepEqual(handle._resources, job.resources);
      assert.ok(f.inventory.has(handle.sandbox_id));
      assert.equal(f.creates.filter(name => name === handle.sandbox_id).length, 1);
      throw sentinel;
    },
  }), error => {
    assert.equal(error, sentinel);
    assert.equal(error.cleanupReceipt?.removed, true);
    assert.equal(error.cleanupReceipt?.scratch_removed, true);
    assert.equal(error.cleanupReceipt?.sandbox_id, retained?.sandbox_id);
    assert.equal(error.computeStopped, true);
    return true;
  });
  assert.equal(probes(), 1);
  assert.equal(authorized, 1);
  assert.ok(retained);
  assert.ok(!f.inventory.has(retained.sandbox_id));
  await assert.rejects(stat(retained.scratch_dir), {code:'ENOENT'});
  assert.deepEqual(f.backend.getPreparationObservation(binding), unknown);
  assert.equal(f.runner.calls.filter(args => args[0] === 'rm' && args.at(-1) === retained.sandbox_id).length, 1);
  f.owned.delete(retained); // Actual runJob removal above already completed.
});

test('unavailable synthetic preflight refuses before prepare, authorize and start', {timeout:60000}, async t => {
  const f = await fixture(t), previousJob = receiptJob({job_id:'previous-prepared'});
  const previousBinding = context(previousJob, 21);
  const previous = await f.prepare(previousJob, {preparationContext:previousBinding});
  const before = f.backend.getPreparationObservation(previousBinding);
  assertPrepared(f.backend, previous, previousBinding);
  const createsBefore = [...f.creates];
  const probes = syntheticPreflight(f.backend, false);
  const job = receiptJob({job_id:'executor-unavailable'}), binding = context(job, 22);
  let authorized = false;
  await assert.rejects(runJob({
    jobSpec:job,backend:f.backend,preparationContext:binding,
    authorize:() => {authorized = true; throw new Error('Unexpected authorize');},
  }), {code:'sandbox_backend_unavailable'});
  assert.equal(probes(), 1);
  assert.equal(authorized, false);
  // prepare always clears/replaces the single observation on entry. This
  // retained original proves refusal happened before that actual method.
  assert.deepEqual(f.backend.getPreparationObservation(previousBinding), before);
  assert.deepEqual(f.backend.getPreparationObservation(binding), unknown);
  assert.deepEqual(f.creates, createsBefore);
  assert.ok(f.inventory.has(previous.sandbox_id));
  await f.destroy(previous);
});
