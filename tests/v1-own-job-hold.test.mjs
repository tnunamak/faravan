import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext as runVM} from 'node:vm';
import {clientFailure} from '../lib/v1/client.mjs';
function runInNewContext(source,context) {
  context.clientFailure=clientFailure;
  context.resumeRetryAt??=0;context.resumeRetryDelay??=0;
  return runVM(source,context);
}

import {ownJobHold} from '../lib/v1/approval-hold.mjs';
import {statusMessage} from '../lib/v1/cli.mjs';

// A job this computer sent to itself waits for review when its identity check fails before it can run.
const heldView = {job_digest: 'sha256:' + 'd'.repeat(64), state: 'claimed', approval: 'pending', current_attempt: null,
  approvalHold: ownJobHold('identity_changed')};

test('an identity change on the own job gives one reason and one clearing action', () => {
  const hold = ownJobHold('identity_changed');
  assert.equal(hold.code, 'identity_changed');
  assert.equal(hold.reason, 'This computer’s details changed after the job was sent, so it is on hold.');
  assert.equal(hold.action, 'Review the job again in Approvals before it runs.');
  assert.equal(ownJobHold('daily_limit'), null, 'other refusals are not own-job holds');
});

test('the CLI send result names the reason and the action for a held own job', () => {
  const line = statusMessage(heldView, {});
  assert.equal(line, 'This computer’s details changed after the job was sent, so it is on hold. ' +
    'Review the job again in Approvals before it runs. Check again shortly.');
});

test('the CLI send result without a hold keeps the ordinary approval line', () => {
  const plain = {...heldView, approvalHold: null};
  assert.equal(statusMessage(plain, {}), 'Waiting for an answer. A lender needs to approve your job. Check again shortly.');
});

// Exercise the actual approval handler with deterministic dependencies, without starting a lender.
const appSource = await readFile(new URL('../lib/v1/app.mjs', import.meta.url), 'utf8');
const handlerStart = '  async function applyApproval(id,verb,pending,actor) {';
const handlerEnd = '  // Who holds a job this computer lost:';
assert.equal(appSource.split(handlerStart).length, 2, 'one approval handler');
assert.equal(appSource.split(handlerEnd).length, 2, 'one handler boundary');
const handlerSource = appSource.slice(appSource.indexOf(handlerStart), appSource.indexOf(handlerEnd));

for (const accepted of [false, true]) test('own-job hold survives pending acceptance and clears only on success: '+accepted, async () => {
  const jobDigest = heldView.job_digest, id = 'review-card';
  const ownJobHolds = new Map([[jobDigest, 'identity_changed']]);
  let resolveClaim, finished;
  const claimResult = new Promise(resolve => { resolveClaim = resolve; });
  const reachedClaim = new Promise(resolve => { finished = resolve; });
  const pending = {card:{id, jobDigest, identity:{}, offer:true}, claimResult,
    finish() { approvals.delete(id); finished(); }};
  const approvals = new Map([[id, pending]]);
  const applyApproval = runInNewContext('('+handlerSource.trim()+')', {
    approvals, ownJobHolds,
    checkApprovalAcceptance:async () => ({code:null}),
    recordJobDecision:async () => ({}),
    emit() {},
    fail(code,status) { throw Object.assign(new Error(code), {code,status}); },
  });
  const decision = applyApproval(id, 'accept', pending);
  const checked = accepted ? decision : assert.rejects(decision, {code:'protection_not_ready',status:409});
  await reachedClaim;
  const held = () => ownJobHold(ownJobHolds.get(jobDigest));
  // Resolve before asserting so a regression cannot leave the decision suspended.
  const during = held();
  resolveClaim(accepted ? {accepted:true} : {accepted:false,code:'protection_not_ready'});
  await checked;
  assert.deepEqual(during, heldView.approvalHold, 'the hold and reason remain until acceptance succeeds');
  if (accepted) assert.equal(ownJobHolds.has(jobDigest), false);
  else assert.deepEqual(held(), heldView.approvalHold, 'a failed accept keeps the hold and reason');
});

// The automatic own-job route also waits for the host's acquisition result.
const autoStart = '  async function approval(input) {';
const autoEnd = '  // Automatic resume:';
assert.equal(appSource.split(autoStart).length, 2, 'one automatic approval handler');
assert.equal(appSource.split(autoEnd).length, 2, 'one automatic handler boundary');
const autoSource = appSource.slice(appSource.indexOf(autoStart), appSource.indexOf(autoEnd));

for (const accepted of [false, true]) test('automatic own-job acceptance clears a hold only after success: '+accepted, async () => {
  const jobDigest = heldView.job_digest, ownJobHolds = new Map([[jobDigest, 'identity_changed']]);
  let resolveClaim;
  const claimResult = new Promise(resolve => { resolveClaim = resolve; });
  const approval = runInNewContext('('+autoSource.trim()+')', {
    safetyEpoch:0, closed:false, settings:{enabled:true,intent:'on',activeCircle:'circle'},
    device:{keyId:'self'}, ownJobHolds, now:()=>1000, randomUUID:()=> 'card',
    jobReadiness:async () => ({protection:{}}), adapterEntries:async () => [],
    jobSafetyFacts:()=> ({}), weekView:async () => ({}), credentialProxyFlag:()=>false,
    approvalIdentity:async () => ({}), checkApprovalAcceptance:async () => ({code:null}),
    recordJobDecision:async () => ({}), rememberPromptAfterClaim() {}, emit() {},
  });
  const input = {jobDigest, claimResult, offer:true, expiresAt:2000,
    job:{author:'self',circle:'circle',requirements:{limits:{wall_seconds:600}}}};
  assert.equal(await approval(input), true, 'approval permits the host acquisition to proceed');
  const during = ownJobHold(ownJobHolds.get(jobDigest));
  resolveClaim({accepted});
  await claimResult;
  assert.deepEqual(during, heldView.approvalHold, 'automatic approval alone does not clear the hold');
  if (accepted) assert.equal(ownJobHolds.has(jobDigest), false);
  else assert.deepEqual(ownJobHold(ownJobHolds.get(jobDigest)), heldView.approvalHold);
});
