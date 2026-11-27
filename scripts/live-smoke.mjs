#!/usr/bin/env node
// Live two-machine smoke test for Faravan. One command runs the whole loop:
// the borrower submits a tiny job to a circle, this computer (the lender)
// approves it and lends its agent, and the borrower applies the result and
// runs the repo's tests on it. See docs/testing/live-smoke.md.
//
//   node scripts/live-smoke.mjs [--preflight-only] [--update-borrower]
//
// Exit 0 on PASS, 1 on FAIL. Never prints the app token or an invite link.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CIRCLE = process.env.SMOKE_CIRCLE ?? 'Faravan test';
const BORROWER_SSH = process.env.SMOKE_BORROWER_SSH ?? 'root@192.0.2.60';
const BORROWER_USER = process.env.SMOKE_BORROWER_USER ?? 'borrower';
const BORROWER_CHECKOUT = '/home/borrower/faravan';
const BORROWER_BIN = '~/faravan/bin/faravan';
const AGENT = 'codex';
const APP_JSON = join(homedir(), '.waspflow/faravan/v1/app.json');
const LENDING_ERRORS = join(homedir(), '.waspflow/faravan/v1/lending-errors.jsonl');
const SCRATCH = join(homedir(), '.tmp/live-smoke');
const APPROVAL_TIMEOUT_MS = 180_000;
const RUN_TIMEOUT_MS = 300_000;
const PROMPT = 'Fix add() in add.mjs so that add.test.mjs passes. Change only add.mjs. Reply: done.';

const flags = new Set(process.argv.slice(2));
const KNOWN_FLAGS = new Set(['--preflight-only', '--update-borrower']);
for (const flag of flags) {
  if (!KNOWN_FLAGS.has(flag)) {
    console.error(`usage: node scripts/live-smoke.mjs [--preflight-only] [--update-borrower]`);
    process.exit(1);
  }
}
const UPDATE_BORROWER = flags.has('--update-borrower');
const PREFLIGHT_ONLY = flags.has('--preflight-only');

class SmokeFail extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}
const fail = (stage, message) => {
  throw new SmokeFail(stage, message);
};
const log = message => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${message}`);
const short = digest => String(digest ?? '').replace(/^sha256:/, '').slice(0, 8);
const sameDigest = (a, b) => String(a ?? '').replace(/^sha256:/, '') === String(b ?? '').replace(/^sha256:/, '');
const shq = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const seconds = ms => `${(ms / 1000).toFixed(1)}s`;
// Keep invite links and URLs out of anything we print from a remote command.
const redact = text => String(text ?? '').replace(/faravan:\/\/\S+|https?:\/\/\S+\/(?:join|i)\/\S*/g, '<link redacted>').trim().slice(0, 500);
const lastJson = text => {
  const line = String(text).trim().split('\n').findLast(l => l.trim().startsWith('{'));
  return line ? JSON.parse(line) : null;
};

// Runs a command and resolves to { code, stdout, stderr } instead of throwing.
async function sh(argv, { timeoutMs = 60_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0], argv.slice(1), { timeout: timeoutMs, maxBuffer: 16 << 20 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message) };
  }
}

const git = args => sh(['git', '-C', ROOT, ...args]);
const onBorrower = (command, timeoutMs) =>
  sh(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', BORROWER_SSH, `su - ${BORROWER_USER} -c ${shq(command)}`], { timeoutMs });

// Local app API. Re-reads app.json each call: the app rewrites it when it restarts.
async function appApi(path, body) {
  const app = JSON.parse(await readFile(APP_JSON, 'utf8'));
  const response = await fetch(`http://127.0.0.1:${app.port}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-faravan-session-token': app.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!response.ok) {
    const error = new Error(json?.message ?? `HTTP ${response.status}`);
    error.code = json?.code ?? String(response.status);
    throw error;
  }
  return json;
}

async function preflight() {
  let home;
  try {
    home = await appApi('home');
  } catch (error) {
    fail('preflight', `the Faravan app is not answering on this computer (${error.code ?? error.message}). Start the app, then rerun.`);
  }
  const circle = home.circles?.find(c => c.name === CIRCLE);
  if (!circle) fail('preflight', `this computer has no circle named "${CIRCLE}".`);
  const lending = home.lending ?? {};
  if (!lending.enabled || lending.circle !== circle.id) fail('preflight', `lending is off for "${CIRCLE}". Turn it on in the app, then rerun.`);
  if (lending.paused) fail('preflight', 'lending is paused. Resume it, then rerun.');
  if (lending.mode !== 'ask') fail('preflight', `lending mode is "${lending.mode}". This test needs "ask" so it approves the job card itself.`);
  if (lending.status !== 'idle') fail('preflight', `the lender is busy (status "${lending.status}"). Wait for its current job to finish.`);

  const counters = lending.counters ?? {};
  const limits = lending.limits ?? {};
  const today = new Date().toISOString().slice(0, 10); // lender limits are kept in UTC
  if (counters.day === today && (counters.jobs >= limits.dailyJobs || counters.milliseconds >= limits.dailyMinutes * 60_000)) {
    fail('preflight', `today's lending limit is used up (${counters.jobs}/${limits.dailyJobs} jobs). Raise it or wait until tomorrow (UTC).`);
  }

  const cards = await appApi('approvals');
  if (cards.length) fail('preflight', `${cards.length} approval card(s) are already waiting. Resolve them first.`);

  const agent = (await appApi('agents')).find(a => a.id === AGENT);
  if (!agent?.installed || !agent.signedIn || !agent.useForLending || agent.stale) {
    fail('preflight', `no ready agent: "${AGENT}" must be installed, signed in and enabled for lending (state: ${agent?.signInState ?? 'missing'}).`);
  }
  log(`lender ready: "${CIRCLE}", ask mode, ${AGENT} (${agent.run?.model ?? 'default model'}, effort ${agent.run?.effort ?? 'default'})`);

  const reach = await onBorrower('true', 15_000);
  if (reach.code) fail('preflight', `borrower unreachable at ${BORROWER_SSH}: ${redact(reach.stderr)}`);

  const lenderHead = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const borrowerHead = (await onBorrower(`git -C ${BORROWER_CHECKOUT} rev-parse HEAD`, 20_000)).stdout.trim();
  const needsUpdate = borrowerHead !== lenderHead;
  if (needsUpdate) {
    if (!UPDATE_BORROWER) {
      fail('preflight', `borrower code is at ${short(borrowerHead)}, lender at ${short(lenderHead)}. Rerun with --update-borrower.`);
    }
    const dirty = await onBorrower(`git -C ${BORROWER_CHECKOUT} status --porcelain`, 20_000);
    if (dirty.stdout.trim()) fail('preflight', 'the borrower checkout has local changes, so it will not be reset.');
  }
  if ((await git(['status', '--porcelain', '--untracked-files=no'])).stdout.trim()) {
    log('note: the lender working tree has uncommitted changes; the borrower runs committed HEAD only');
  }
  return { circle, lenderHead, borrowerHead, needsUpdate };
}

// Bundles the lender's committed HEAD and resets the borrower checkout to it.
async function updateBorrower(lenderHead) {
  await mkdir(SCRATCH, { recursive: true });
  const dir = await mkdtemp(join(SCRATCH, 'bundle-'));
  const bundle = join(dir, 'lender.bundle');
  // The copy is made as root, so root also makes it readable and removes it.
  const remote = `/tmp/live-smoke-${randomBytes(4).toString('hex')}.bundle`;
  const rootSsh = command => sh(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', BORROWER_SSH, command], { timeoutMs: 60_000 });
  try {
    const created = await git(['bundle', 'create', bundle, 'HEAD']);
    if (created.code) fail('update', `could not bundle the lender commit: ${redact(created.stderr)}`);
    const copied = await sh(['scp', '-q', '-o', 'BatchMode=yes', bundle, `${BORROWER_SSH}:${remote}`], { timeoutMs: 120_000 });
    if (copied.code) fail('update', `could not copy the bundle to the borrower: ${redact(copied.stderr)}`);
    await rootSsh(`chmod 644 ${remote}`);
    const reset = await onBorrower(`cd ${BORROWER_CHECKOUT} && git fetch -q ${remote} HEAD && git reset -q --hard FETCH_HEAD`, 120_000);
    if (reset.code) fail('update', `borrower reset failed: ${redact(reset.stderr || reset.stdout)}`);
    const head = (await onBorrower(`git -C ${BORROWER_CHECKOUT} rev-parse HEAD`, 20_000)).stdout.trim();
    if (head !== lenderHead) fail('update', `borrower is at ${short(head)} after the update, expected ${short(lenderHead)}.`);
    log(`borrower updated to ${short(head)}`);
  } finally {
    await rootSsh(`rm -f ${remote}`);
    await rm(dir, { recursive: true, force: true });
  }
}

// Creates a tiny repo with one failing node test and submits the job. Returns the full job digest.
async function submitJob(stamp) {
  const files = {
    'package.json': JSON.stringify({ name: `smoke-${stamp}`, private: true, type: 'module' }, null, 2) + '\n',
    'add.mjs': 'export function add(a, b) {\n  return a - b;\n}\n',
    'add.test.mjs':
      "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { add } from './add.mjs';\n\ntest('add sums two numbers', () => {\n  assert.equal(add(2, 3), 5);\n});\n",
  };
  const writes = Object.entries(files).map(([name, text]) => `printf %s ${Buffer.from(text).toString('base64')} | base64 -d > ${name}`);
  const command = [
    `mkdir -p "$HOME/smoke/${stamp}/repo" && cd "$HOME/smoke/${stamp}/repo"`,
    'git init -q -b main',
    ...writes,
    'git add -A && git -c user.name=smoke -c user.email=smoke@localhost commit -q -m "smoke: failing test"',
    'if node --test add.test.mjs >/dev/null 2>&1; then echo SEED_TEST_PASSES; exit 1; fi',
    `${BORROWER_BIN} run ${shq(PROMPT)} --circle ${shq(CIRCLE)} --detach --json`,
  ].join(' && ');
  const result = await onBorrower(command, 120_000);
  if (result.code) fail('submit', `faravan run failed: ${redact(result.stderr || result.stdout)}`);
  const submitted = lastJson(result.stdout);
  if (!submitted?.job_digest) fail('submit', 'faravan run did not return a job digest.');
  return { digest: submitted.job_digest, submittedAt: Date.now() };
}

// Follows the lender until its job finishes. Approves the matching card once it appears.
async function serveJob(digest, cursorStart) {
  let cursor = cursorStart;
  let lastStatus = 'idle';
  let claimedAt = null;
  let approvedAt = null;
  let startedAt = null;
  let finishedAt = null;
  const approvalDeadline = Date.now() + APPROVAL_TIMEOUT_MS;
  for (;;) {
    for (const event of await appApi(`activity?after=${cursor}`)) {
      cursor = event.id;
      // Transcript chunks are not lifecycle changes; they would only add noise to the log.
      if (event.type !== 'lending' || !event.data?.status || event.data.status === lastStatus || event.data.status === 'transcript') continue;
      lastStatus = event.data.status;
      const at = Date.parse(event.at);
      if (lastStatus === 'awaiting-approval') claimedAt ??= at;
      if (lastStatus === 'running') startedAt ??= at;
      if (lastStatus === 'finished') finishedAt ??= at;
      log(`lender: ${lastStatus}${event.data.label ? ` (${event.data.label})` : ''}`);
      if (['failed', 'stopped', 'declined'].includes(lastStatus)) fail('lender', `the lender ended the job as "${lastStatus}".`);
    }

    if (approvedAt === null) {
      const card = (await appApi('approvals')).find(c => sameDigest(c.jobDigest, digest));
      if (card) {
        claimedAt ??= Date.now();
        log(`approving job ${short(digest)} (card ${String(card.id).slice(0, 8)})`);
        try {
          await appApi(`approvals/${card.id}/accept`, {});
        } catch (error) {
          fail('approve', `accepting the card failed (${error.code}): ${error.message}`);
        }
        approvedAt = Date.now();
      } else if (Date.now() > approvalDeadline) {
        fail('approve', `no approval card for job ${short(digest)} within ${APPROVAL_TIMEOUT_MS / 1000}s (lender status: ${lastStatus}).`);
      }
    } else if (Date.now() > approvedAt + RUN_TIMEOUT_MS) {
      fail('lender', `the job did not finish within ${RUN_TIMEOUT_MS / 1000}s of approval (lender status: ${lastStatus}).`);
    }

    if (approvedAt !== null && finishedAt !== null) return { claimedAt, approvedAt, startedAt, finishedAt };
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Reads the codex usage from the lender's transcript (the last turn.completed event).
async function usageLine(digest, circleId) {
  try {
    const transcript = await appApi(`jobs/${digest}/transcript?circle=${circleId}`);
    let usage = null;
    for (const line of String(transcript.text ?? '').split('\n')) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'turn.completed' && event.usage) usage = event.usage;
      } catch {}
    }
    if (!usage) return 'usage unavailable (no turn.completed in transcript)';
    return `input=${usage.input_tokens} output=${usage.output_tokens} reasoning=${usage.reasoning_output_tokens ?? 'n/a'}`;
  } catch (error) {
    return `usage unavailable (${error.code ?? error.message})`;
  }
}

async function lenderErrorMessage() {
  try {
    const last = (await readFile(LENDING_ERRORS, 'utf8')).split('\n').filter(Boolean).at(-1);
    if (!last) return 'none recorded';
    return redact(JSON.parse(last).message ?? last);
  } catch {
    return 'none recorded';
  }
}

// Filled in as the run goes, so a failure can still report the job and its timings.
const ctx = { digest: null, submitToClaim: null, approveToStart: null, run: null, resultToApplied: null, usage: 'n/a' };

async function main() {
  const pre = await preflight();
  if (PREFLIGHT_ONLY) {
    log(pre.needsUpdate ? 'preflight passed; a full run would first update the borrower' : 'preflight passed');
    return { pass: true };
  }
  if (pre.needsUpdate) await updateBorrower(pre.lenderHead);

  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;
  // Only this job's events count: start after the newest event that exists now.
  const cursorStart = (await appApi('activity?after=0')).at(-1)?.id ?? 0;
  log(`borrower: submitting job to "${CIRCLE}" from ~/smoke/${stamp}`);
  const job = await submitJob(stamp);
  ctx.digest = job.digest;
  log(`job ${short(job.digest)} submitted`);

  const lender = await serveJob(job.digest, cursorStart);
  ctx.submitToClaim = lender.claimedAt - job.submittedAt;
  ctx.approveToStart = lender.startedAt - lender.approvedAt;
  ctx.run = lender.finishedAt - lender.startedAt;

  const waited = await onBorrower(`${BORROWER_BIN} job wait ${job.digest} --timeout ${RUN_TIMEOUT_MS / 1000} --json`, RUN_TIMEOUT_MS + 60_000);
  if (waited.code) fail('borrower', `the borrower job did not finish: ${redact(waited.stdout || waited.stderr)}`);
  const borrowerDoneAt = Date.now();
  log('borrower: job finished, applying');

  const branch = `smoke-${stamp}`;
  const repo = `"$HOME/smoke/${stamp}/repo"`;
  const applied = await onBorrower(`cd ${repo} && ${BORROWER_BIN} apply ${job.digest} --branch ${branch} --json`, 120_000);
  if (applied.code) fail('apply', `faravan apply failed: ${redact(applied.stderr || applied.stdout)}`);
  ctx.resultToApplied = Date.now() - borrowerDoneAt;
  log(`borrower: applied to branch ${branch}`);

  const tests = await onBorrower(`cd ${repo} && git checkout -q ${branch} && node --test add.test.mjs`, 120_000);
  if (tests.code) fail('tests', `tests failed on ${branch}: ${redact(tests.stdout || tests.stderr)}`);
  log(`borrower: tests pass on ${branch}`);
  ctx.usage = await usageLine(job.digest, pre.circle.id);
  return { pass: true };
}

function summary(result) {
  const { ctx = {} } = result;
  const timing = [
    `submit->claim=${ctx.submitToClaim == null ? 'n/a' : seconds(ctx.submitToClaim)}`,
    `approve->start=${ctx.approveToStart == null ? 'n/a' : seconds(ctx.approveToStart)}`,
    `run=${ctx.run == null ? 'n/a' : seconds(ctx.run)}`,
    `result->applied=${ctx.resultToApplied == null ? 'n/a' : seconds(ctx.resultToApplied)}`,
  ];
  const job = ctx.digest ? `job=${short(ctx.digest)}` : 'job=none';
  const head = result.pass ? 'PASS' : `FAIL(${result.stage})`;
  return `RESULT ${head} ${job} ${timing.join(' ')} usage: ${ctx.usage ?? 'n/a'}`;
}

let outcome;
try {
  outcome = await main();
} catch (error) {
  outcome = { pass: false, stage: error.stage ?? 'internal', message: error.message };
}
outcome.ctx = ctx;

if (outcome.pass) {
  console.log(PREFLIGHT_ONLY ? 'PREFLIGHT OK' : summary(outcome));
  process.exit(0);
}

console.error(`FAIL [${outcome.stage}]: ${redact(outcome.message)}`);
const lenderError = await lenderErrorMessage();
console.error(`lender last error: ${lenderError}`);
if (outcome.ctx?.digest) {
  const status = await onBorrower(`${BORROWER_BIN} job status ${outcome.ctx.digest} --json`, 30_000);
  console.error(`borrower job status: ${redact(status.stdout || status.stderr)}`);
}
console.log(summary(outcome));
process.exit(1);
