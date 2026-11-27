import './helpers/no-browser.mjs';
// Suggested filename: test/lender-requeue-consent.acceptance.test.mjs
// The lender is loaded as an ES module inside a fake-clock context, which needs node --experimental-vm-modules. Without the flag the
// file runs itself again with it, so a plain `node --test` still checks every case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import * as path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hasModules = typeof vm.SourceTextModule === 'function';
const vmTest = hasModules ? test : test.skip;
if (!hasModules) {
  test('every case passes when run with --experimental-vm-modules', () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--test', fileURLToPath(import.meta.url)], { encoding: 'utf8', env });
    assert.equal(run.status, 0, run.stdout.slice(-4000) + run.stderr.slice(-1000));
  });
}

const copy = value => structuredClone(value);
const START = Date.parse('2026-11-10T12:00:00Z');
const digest = text => 'sha256:' + createHash('sha256').update(text).digest('hex');
const fail = code => Object.assign(new Error(code), { code });
const forbidden = name => () => { throw fail('unexpected_' + name); };
const canon = value => JSON.stringify(value, function (key, item) {
  return item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item;
});

class Clock {
  time = START;
  nextId = 1;
  timers = new Map();
  now = () => this.time;
  monotonic = () => this.time - START;
  setTimeout = (fn, ms = 0) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  next() {
    const entries = [...this.timers.entries()].sort((a, b) =>
      a[1].at - b[1].at || a[0] - b[0]);
    if (!entries.length) return false;
    const [id, timer] = entries[0];
    this.timers.delete(id);
    this.time = Math.max(this.time, timer.at);
    timer.fn();
    return true;
  }
  advance(ms) { this.time += ms; }
  async flush() {
    // All fake I/O resolves through promises. No real timer or process is used.
    for (let i = 0; i < 400; i++) await Promise.resolve();
  }
}

function makeJob({ nonce = 'job-a', circle = 'circle-a',
  repo = 'https://example.invalid/repo-a.git', wall = 60 } = {}) {
  const payload = {
    schema_version: 1, circle, author: digest('borrower'),
    nonce, created_at: new Date(START).toISOString(),
    expires_at: new Date(START + 7 * 86400000).toISOString(),
    prompt: { digest: digest('Make a test change'), bytes: 18, media_type: 'text/plain' },
    source: { kind: 'git', url: repo, commit: 'a'.repeat(40) },
    requirements: {
      harness: ['codex', 'claude-code-subscription'],
      model: { any_of: ['model-a', 'model-b'] },
      capabilities: [], egress: [],
      limits: { wall_seconds: wall, cpu: 1, memory_bytes: 1048576,
        disk_bytes: 1048576, output_bytes: 1048576 }
    }
  };
  return { job_digest: digest(canon(payload)), state: 'queued',
    job: { payload }, current_attempt: null };
}

// Loads only the scoped production module. Synthetic dependencies supply the
// transport/executor contracts; no approval/retry function is replaced.
// This adapter is deliberately not a test of signatures, protocol validation,
// real offer-reader caching, sbx cleanup, or provider quota accounting.
async function loadLender(h) {
  let ids = 0;
  const uuid = () => '00000000-0000-4000-8000-' + String(++ids).padStart(12, '0');
  const passing = code => ['preparation_timeout', 'lending_busy', 'paused',
    'cleanup_pending', 'sandbox_not_ready'].includes(code);
  const limits = ['wall_seconds', 'cpu', 'memory_bytes', 'output_bytes'];
  const transcript = () => ({
    text: text => text ?? '', append: () => '', end: () => ''
  });
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [h.clock.now()])); }
    static now() { return h.clock.now(); }
  }
  const FakeAbortSignal = {
    any: signals => AbortSignal.any(signals),
    timeout(ms) {
      const controller = new AbortController();
      h.clock.setTimeout(() => controller.abort(fail('fake_timeout')), ms);
      return controller.signal;
    }
  };
  const deps = {
    'node:crypto': { createHash, randomUUID: uuid },
    'node:string_decoder': { StringDecoder },
    'node:fs/promises': {
      mkdir: forbidden('filesystem_write'), readFile: forbidden('filesystem_read'),
      open: forbidden('filesystem_open')
    },
    'node:path': { dirname: path.dirname, join: path.join, resolve: path.resolve },
    './lending-quota-timing.mjs': {
      PROVIDER_LIMIT_STOP_ANSWER_MS: 1000, PROVIDER_LIMIT_STOP_RETURN_MS: 1000
    },
    '../sandbox-remediation.mjs': { sandboxRemediationLines: () => [] },
    './isolation-check.mjs': {
      ISOLATION_CHECK_BUDGET_MS: 1000, checkJobIsolation: async () => ({ state: 'pass' })
    },
    './lending-run-model.mjs': {
      resolveLenderRunModel: adapter => adapter.run.model,
      configuredModelEfforts: () => [],
      matchingRun: () => null
    },
    './versions.mjs': {
      MODEL_EFFORT_PAIRS_CAPABILITY: 'model_effort_pairs_v1',
      AUTO_RUN_CAPABILITY: 'auto_run_v1',
      RUN_REQUEST_CAPABILITY: 'run_request_v1'
    },
    // No account is advertised in this fixture, so no signed run request can resolve.
    './run-request.mjs': {
      validateAccountAdvertisement: () => false, resolveSelection: () => ({ ok: false, code: 'adapter_unsupported' })
    },
    './auto-run-selection.mjs': {
      selectAutoRun: forbidden('automatic_selection'), listPriceSnapshot: () => ({})
    },
    './live-transcript.mjs': { createTranscriptPublisher: forbidden('live_transcript') },
    '../durable-write.mjs': { durableJsonAsync: forbidden('disk_storage') },
    '../harness-spec.mjs': { borrowedStrategyAllowed: strategy => strategy === 'fixture' },
    './lender-pace50.mjs': {
      DEFAULT_RUN_MODEL: { codex: 'model-a', claude: 'model-a' },
      isObjectiveReviewHold: () => false, lendableModelsFor: () => null
    },
    './continuation.mjs': {
      buildHandoff: forbidden('continuation'), lenderCredentialValues: async () => []
    },
    './workspace-transcript.mjs': { workspaceTranscript: transcript },
    './offers.mjs': {
      createOfferReader: ({ client }) => ({
        read: options => client.listJobs(options), forget: () => {}
      }),
      matchingRule: () => null,
      validateStandingRules: rules => {
        assert.equal(rules.length, 0, 'fixture has no automatic consent rules');
      }
    },
    './lock.mjs': { acquireProcessLock: forbidden('process_lock') },
    '../source-archive.mjs': {
      extractSourceArchive: forbidden('archive'), SOURCE_ARCHIVE_INPUT_BYTES: 1048576
    },
    '../protocol/index.mjs': {
      canonicalize: canon,
      limitRequirements: () => ({ required: limits }),
      canSatisfy: (requirements, advertisement) => ({
        ok: (!requirements.harness || requirements.harness.some(x =>
          advertisement.harnesses.includes(x))) &&
          (!requirements.model || requirements.model.any_of.some(x =>
            advertisement.models.includes(x))) &&
          limits.every(key => requirements.limits[key] <= advertisement.max_limits[key])
      })
    },
    '../executor.mjs': {
      buildValidatedJobSpec: input => ({ ...input, job_id: input.taskDigest }),
      buildTaskReceipt: forbidden('success_receipt'),
      async runJob({ backend, jobSpec, signal, onMeter }) {
        let handle;
        try {
          handle = await backend.prepare(jobSpec,{signal});
          await backend.start(handle, { signal });
          onMeter({ cost_usd: 0.01, tokens: 10, windows: [] });
          h.clock.advance(1000);
          throw fail('execution_failed');
        } catch (error) {
          if (handle) error.cleanupReceipt = await backend.destroy(handle);
          throw error;
        }
      }
    },
    './progress.mjs': { createProgressReporter: forbidden('progress_transport') },
    './failures.mjs': {
      newErrorRef: uuid, isPassingDecline: passing,
      isStartFailure: code => code === 'preparation_timeout'
    },
    './lending-state.mjs': { lendingHours: () => ({ inside: true }) },
    './blockers.mjs': { stoppedAgentCheck: () => null },
    './lending-wait.mjs': {
      agentDisplayName: name => name, waitLabel: name => name, SANDBOX_WAIT: 'waiting'
    },
    './state-projection.mjs': {
      observedExecutionTime: attempt => attempt?.execution_observed_at ?? null
    },
    '../harnesses/shared.mjs': { agentAuthFailure: () => false },
    './job-meta.mjs': { cleanTitle: text => text },
    './request-line.mjs': { requestLine: text => text.split('\n')[0] },
    '../git-candidate.mjs': {
      DIFF_OUTPUT: 'diff', diffstat: forbidden('diffstat'), isGitCandidateScript: () => false
    },
    '../harnesses/job-framing.mjs': {
      OUTPUT_DIR: 'faravan-output', LEGACY_OUTPUT_DIR: 'faravan-output'
    }
  };
  const context = vm.createContext({
    Buffer, structuredClone, AbortController, AbortSignal: FakeAbortSignal,
    Date: FakeDate, Intl, StringDecoder,
    performance: { now: h.clock.monotonic },
    setTimeout: h.clock.setTimeout, clearTimeout: h.clock.clearTimeout
  });
  const source = await readFile(path.resolve('lib/v1/lender.mjs'), 'utf8');
  const module = new vm.SourceTextModule(source, {
    context, identifier: 'file:///fixture/lib/v1/lender.mjs'
  });
  const linked = new Map();
  await module.link(specifier => {
    assert.ok(Object.hasOwn(deps, specifier), 'unmapped dependency: ' + specifier);
    if (!linked.has(specifier)) {
      const entries = Object.entries(deps[specifier]);
      linked.set(specifier, new vm.SyntheticModule(entries.map(([key]) => key),
        function () { for (const [key, value] of entries) this.setExport(key, value); },
        { context, identifier: specifier }));
    }
    return linked.get(specifier);
  });
  await module.evaluate();
  return module.namespace.createLender;
}

async function fixture(t, { mode = 'offers', failure = 'launched' } = {}) {
  const h = {
    clock: new Clock(), mode, failure, row: null, offer: null, open: false,
    cards: [], claims: [], preparations: [], launches: [], requeues: [],
    settlements: [], events: [], diagnostics: [], loopError: null,
    agent: 'codex', account: 'codex', model: 'model-a'
  };
  const attempts = new Map(), claimKeys = new Map();
  const storage = {
    acquire: async () => () => {},
    get: async () => copy(h.row),
    set: async row => { h.row = copy(row); }
  };
  const candidate = {
    registry: { bind() {}, unbind() {} },
    gate: async () => null,
    reserve: async input => ({ ok: true,
      reservation: { provider: input.provider, model: input.model,
        ...(input.accountKey ? { accountKey: input.accountKey } : {}) } }),
    admitStart: async () => ({ ok: true }),
    started: async () => ({ applied: true }),
    recordCleanup: async () => {},
    recheck: async () => {},
    settle: async (id, record) => {
      h.settlements.push({ id, record: copy(record) });
      return { applied: true };
    }
  };
  const backend = {
    lenderCapabilities: async () => ({
      available: true, backend_id: 'fixture', pinned_git: true, egress: [],
      capabilities: [], enforced_limits: ['wall_seconds', 'cpu', 'memory_bytes', 'output_bytes'],
      max_limits: { wall_seconds: 3600, cpu: 8, memory_bytes: 16 * 1048576,
        disk_bytes: 16 * 1048576, output_bytes: 16 * 1048576 }
    }),
    admitJob: async () => ({ ok: true }),
    async prepare(spec,{signal}={}) {
      h.preparations.push({ attemptId: h.activeAttempt.attempt_id,
        digest: h.activeAttempt.job_digest, agent: h.agent,
        account: h.account, model: h.model, spec: copy(spec) });
      if(h.failure==='prepare-abort')return new Promise((_,reject)=>{
        const abort=()=>reject(Object.assign(signal.reason,{cleanupReceipt:{removed:true,scratch_removed:true}}));
        signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
      });
      if (h.failure === 'prepare') {
        throw Object.assign(fail('preparation_timeout'),
          { cleanupReceipt: { removed: true, scratch_removed: true } });
      }
      return { sandbox_id: 'fake-' + h.activeAttempt.attempt_id,
        scratch_dir: '/fixture/never-created', _entrypoint: 'fixture-agent' };
    },
    async start(handle, options) {
      await options.onLaunchDurable?.({ at: new Date(h.clock.now()).toISOString() });
      options.onExecutionStarted?.();
      h.launches.push({ attemptId: h.activeAttempt.attempt_id,
        digest: h.activeAttempt.job_digest, account: h.account, model: h.model });
    },
    destroy: async () => ({ removed: true, scratch_removed: true }),
    requestStop: async () => ({ removed: true })
  };
  const view = () => copy(h.offer);
  const active = attempt => copy(attempts.get(attempt.attempt_id));
  const requeue = (attempt, reason) => {
    const stored = attempts.get(attempt.attempt_id);
    stored.state = 'failed';
    h.open = false; // Test controls when the coordinator reoffers completed failure.
    h.offer.state = 'queued';
    h.offer.current_attempt = copy(stored);
    h.requeues.push({ attempt: copy(stored), reason });
    return { applied: true };
  };
  const client = {
    capabilities: async () => ({ capabilities: [] }),
    fetchArtifact: async () => Buffer.from('Make a test change'),
    getJob: async jobDigest => {
      if (jobDigest !== h.offer?.job_digest) throw Object.assign(fail('not_found'), { status: 404 });
      return view();
    },
    async claimJob(jobDigest, advertisement, options) {
      if (claimKeys.has(options.idempotencyKey)) return copy(claimKeys.get(options.idempotencyKey));
      if (!h.open || jobDigest !== h.offer?.job_digest || h.offer.state !== 'queued') {
        throw Object.assign(fail('conflict'), { status: 409 });
      }
      const n = h.claims.length + 1;
      const attempt = { attempt_id: 'attempt-' + n, job_digest: jobDigest,
        generation: n, state: 'active',
        lease_expires_at: new Date(h.clock.now() + 120000).toISOString() };
      attempts.set(attempt.attempt_id, attempt);
      h.activeAttempt = attempt;
      h.offer.state = 'active';
      h.offer.current_attempt = copy(attempt);
      const result = { job_digest: jobDigest, job: copy(h.offer.job), attempt: copy(attempt) };
      claimKeys.set(options.idempotencyKey, copy(result));
      h.claims.push({ ...copy(result), idempotencyKey: options.idempotencyKey });
      return result;
    },
    async claimNext(advertisement, options) {
      if (!h.open || h.offer?.state !== 'queued' ||
          options.exclude?.includes(h.offer.job_digest)) return null;
      return this.claimJob(h.offer.job_digest, advertisement, options);
    },
    async renew(attempt) {
      const stored = attempts.get(attempt.attempt_id);
      stored.lease_expires_at = new Date(h.clock.now() + 120000).toISOString();
      return active(attempt);
    },
    async startAttempt(attempt) {
      attempts.get(attempt.attempt_id).execution_started_at =
        new Date(h.clock.now()).toISOString();
      return active(attempt);
    },
    async observeExecutionStart(attempt) {
      attempts.get(attempt.attempt_id).execution_observed_at =
        new Date(h.clock.now()).toISOString();
      return active(attempt);
    },
    release: async (attempt, reason,options) => {
      h.releaseCalls??=[];h.releaseCalls.push(copy({attempt,reason,idempotencyKey:options?.idempotencyKey}));
      if(h.releaseUnknown)throw Object.assign(fail('network_error'),{retryable:true,outcome:'unknown'});
      return requeue(attempt,reason);
    },
    fail: async (attempt, reason) => requeue(attempt, reason),
    stopped: async () => ({ applied: true })
  };
  if (mode === 'offers') client.listJobs = async () => ({
    legacy: false, items: h.open && h.offer?.state === 'queued' ? [view()] : []
  });
  const policy = {
    enabled: true, mode: 'ask', storage, standingRules: [],
    timeZone: 'UTC', pollMs: 1000, preparationTimeoutMs: 180000,
    checkJobIsolation: async () => ({ state: 'pass' }),
    hold: () => h.open ? null : 'lending_busy',
    lendingRuntime: { candidate }
  };
  const createLender = await loadLender(h);
  h.drive = async (predicate, label, maxSteps = 4000) => {
    for (let step = 0; step < maxSteps; step++) {
      await h.clock.flush();
      if (h.loopError) throw h.loopError;
      if (predicate()) return;
      if (!h.clock.next()) throw new Error('fixture stalled: ' + label);
    }
    throw new Error('bounded virtual-time timeout: ' + label + '\n' +
      JSON.stringify({ state: h.worker?.getState(), diagnostics: h.diagnostics }));
  };
  h.boot = () => {
    h.outer = new AbortController();
    h.ended = false;
    h.worker = createLender({
      client, backend, policy, clock: h.clock, accountKey: h.account,
      credentialValues: async () => [],
      adapters: async () => [{
        installed: true, signedIn: true, enabled: true,
        spec: { harness_id: h.agent, auth_strategy: 'fixture',
          credential_in_guest: false, entrypoint: 'fixture-agent' },
        models: ['model-a', 'model-b'], run: { model: h.model, effort: 'high' }
      }],
      approve: card => new Promise(resolve => {
        const recorded = { jobDigest: card.jobDigest, job: copy(card.job),
          harness: card.harness, account: h.account, answer: resolve, settled: false };
        h.cards.push(recorded);
        const aborted = () => { if (!recorded.settled) {
          recorded.settled = true; resolve({ withdrawn: true, code: 'cancelled' });
        } };
        card.signal.addEventListener('abort', aborted, { once: true });
        if (card.signal.aborted) aborted();
      }),
      onEvent: event => h.events.push(copy(event)),
      onDiagnostic: event => h.diagnostics.push(copy(event))
    });
    h.loop = h.worker.start(h.outer.signal).catch(error => { h.loopError = error; })
      .finally(() => { h.ended = true; });
  };
  h.close = async () => {
    if (h.ended) return;
    h.outer.abort(fail('fixture_shutdown'));
    await h.drive(() => h.ended, 'shutdown');
    await h.loop;
  };
  h.restart = async () => { await h.close(); h.boot(); };
  h.publish = job => {
    h.offer = copy(job); h.offer.state = 'queued'; h.open = true;
    h.worker.reconfigure();
  };
  h.answer = (index, answer) => {
    const card = h.cards[index];
    assert.ok(card && !card.settled, 'a live approval card is required');
    card.settled = true; card.answer(answer);
  };
  h.quiet = () => !h.worker.getState().current &&
    !h.row?.pending && !h.row?.declinePending && !h.row?.stoppedPending;
  h.finishFailure = async count => h.drive(
    () => h.requeues.length >= count && h.quiet(), 'failure fully settled');
  h.firstApprovedFailure = async job => {
    h.publish(job);
    await h.drive(() => h.cards.length === 1, 'first approval card');
    assert.equal(h.preparations.length, 0, 'no sandbox preparation before consent');
    h.answer(0, true);
    await h.finishFailure(1);
    assert.equal(h.claims.length, 1);
    assert.equal(h.preparations.length, 1, 'the first failure reached executor preparation');
    assert.equal(h.launches.length, h.failure.startsWith('prepare') ? 0 : 1);
  };
  h.retryWithoutAsk = async job => {
    const cards = h.cards.length, preparations = h.preparations.length;
    const claims = h.claims.length, requeues = h.requeues.length;
    h.publish(job);
    await h.drive(() => h.cards.length > cards ||
      h.preparations.length > preparations, 'same-scope retry or unwanted second card');
    assert.equal(h.cards.length, cards, 'same job and approved scope must not ask again');
    assert.equal(h.preparations.length, preparations + 1, 'retry must actually attempt to run');
    await h.finishFailure(requeues + 1);
    assert.equal(h.claims.length, claims + 1, 'a rerun needs a fresh attempt');
    assert.notEqual(h.claims.at(-1).attempt.attempt_id, h.claims.at(-2).attempt.attempt_id);
    assert.notEqual(h.claims.at(-1).idempotencyKey, h.claims.at(-2).idempotencyKey);
  };
  h.requireFreshAsk = async job => {
    const cards = h.cards.length, preparations = h.preparations.length;
    h.publish(job);
    await h.drive(() => h.cards.length > cards ||
      h.preparations.length > preparations, 'new scope must ask before preparing');
    assert.equal(h.preparations.length, preparations, 'old consent must not start changed scope');
    assert.equal(h.cards.length, cards + 1);
    assert.equal(h.cards.at(-1).jobDigest, job.job_digest);
    return cards;
  };
  h.boot();
  t.after(() => h.close());
  return h;
}

for (const mode of ['offers', 'legacy']) {
  for(const failure of ['prepare','prepare-abort'])vmTest(mode + ': confirmed '+failure+' release asks again before another attempt', async t => {
    const h=await fixture(t,{mode,failure}),job=makeJob();
    await h.firstApprovedFailure(job);
    assert.equal(h.row.jobConsents.length,0);
    assert.equal(h.row.hiddenOffers?.length??0,0);
    await h.restart();
    const card=await h.requireFreshAsk(job),count=h.requeues.length;
    h.answer(card,true);await h.finishFailure(count+1);
    assert.equal(h.cards.length,2);
    assert.equal(h.launches.length,0);
  });
  vmTest(mode + ': unchanged retry after a launched failure retains its legacy approval',async t=>{
    const h=await fixture(t,{mode,failure:'launched'}),job=makeJob();
    await h.firstApprovedFailure(job);await h.retryWithoutAsk(job);assert.equal(h.cards.length,1);
  });
}

vmTest('approval survives lender recreation after a fully settled failed run', async t => {
  const h = await fixture(t), job = makeJob();
  await h.firstApprovedFailure(job);
  await h.restart(); // Storage is retained; every in-memory lender variable is fresh.
  await h.retryWithoutAsk(job);
  assert.equal(h.cards.length, 1);
});

// The allowance boundary below is the approved wall-time allowance. Repository
// and duration changes produce a new immutable digest; never forge same-digest
// changed content just to make a scope test look like a coordinator retry.
const scopeChanges = {
  agent: (h, job) => { h.agent = 'claude-code-subscription'; h.account = 'claude'; return job; },
  account: (h, job) => { h.account = 'codex:second-account'; return job; },
  model: (h, job) => { h.model = 'model-b'; return job; },
  repository: (h, job) => makeJob({
    nonce: job.job.payload.nonce, circle: job.job.payload.circle,
    repo: 'https://example.invalid/repo-b.git'
  }),
  allowance: (h, job) => makeJob({
    nonce: job.job.payload.nonce, circle: job.job.payload.circle, wall: 120
  })
};
for (const [name, change] of Object.entries(scopeChanges)) {
  vmTest(name + ' change requires one new ask, then its unchanged retry does not', async t => {
    const h = await fixture(t), job = makeJob();
    await h.firstApprovedFailure(job);
    await h.retryWithoutAsk(job); // Positive retention control, red on the baseline.
    const changed = change(h, job);
    await h.restart();
    const index = await h.requireFreshAsk(changed), failures = h.requeues.length;
    h.answer(index, true);
    await h.finishFailure(failures + 1);
    await h.retryWithoutAsk(changed);
    assert.equal(h.cards.length, 2);
  });
}

vmTest('declining changed scope revokes the earlier approval even if old scope returns', async t => {
  const h = await fixture(t), job = makeJob();
  await h.firstApprovedFailure(job);
  await h.retryWithoutAsk(job);
  h.model = 'model-b';
  await h.restart();
  const index = await h.requireFreshAsk(job), before = h.preparations.length;
  h.answer(index, { declined: true });
  await h.clock.flush();
  h.open = false;
  await h.restart();
  h.model = 'model-a'; // The prior approval must not resurrect after the decline.
  h.publish(job);
  const until = h.clock.now() + 31 * 60000;
  await h.drive(() => h.preparations.length > before ||
    h.cards.length > index + 1 || h.clock.now() >= until, 'decline remains authoritative');
  assert.equal(h.preparations.length, before,
    'declined job cannot run; suppression or a new unanswered card is safe');
  // If reoffered as a card, deliberately do not answer it. No implicit true.
});

vmTest('another job with identical prompt and repository cannot inherit approval', async t => {
  const h = await fixture(t), first = makeJob();
  await h.firstApprovedFailure(first);
  await h.retryWithoutAsk(first);
  const second = makeJob({ nonce: 'job-b' });
  assert.equal(first.job.payload.prompt.digest, second.job.payload.prompt.digest);
  assert.deepEqual(first.job.payload.source, second.job.payload.source);
  assert.notEqual(first.job_digest, second.job_digest);
  const index = await h.requireFreshAsk(second), failures = h.requeues.length;
  h.answer(index, true);
  await h.finishFailure(failures + 1);
  await h.retryWithoutAsk(second);
  assert.equal(h.cards.length, 2);
});

vmTest('another circle with identical job content cannot inherit approval', async t => {
  const h = await fixture(t), first = makeJob();
  await h.firstApprovedFailure(first);
  await h.retryWithoutAsk(first);
  const second = makeJob({ circle: 'circle-b' });
  assert.equal(first.job.payload.prompt.digest, second.job.payload.prompt.digest);
  assert.deepEqual(first.job.payload.source, second.job.payload.source);
  assert.notEqual(first.job.payload.circle, second.job.payload.circle);
  assert.notEqual(first.job_digest, second.job_digest);
  const index = await h.requireFreshAsk(second), failures = h.requeues.length;
  h.answer(index, true);
  await h.finishFailure(failures + 1);
  await h.retryWithoutAsk(second);
  assert.equal(h.cards.length, 2);
});

vmTest('ambiguous preparation release survives restart with the same intent and no second launch',async t=>{
  const h=await fixture(t,{failure:'prepare'}),job=makeJob();h.releaseUnknown=true;
  h.publish(job);await h.drive(()=>h.cards.length===1,'approval');h.answer(0,true);
  await h.drive(()=>h.row?.declinePending&&h.releaseCalls?.length,'release intent');
  const key=h.row.declinePending.idempotencyKey;
  await h.restart();
  await h.drive(()=>h.releaseCalls.length>=2,'same release replayed');
  assert.equal(h.row.declinePending.idempotencyKey,key);
  assert.ok(h.releaseCalls.every(call=>call.idempotencyKey===key));
  assert.equal(h.claims.length,1);assert.equal(h.launches.length,0);
  h.releaseUnknown=false;
  await h.drive(()=>h.quiet()&&h.requeues.length===1,'release confirmed');
  assert.equal(h.row.jobConsents.length,0);
  await h.requireFreshAsk(job);
});
