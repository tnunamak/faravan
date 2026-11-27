import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingProbe, createLendingReadings, sanitizeProbeFailure, admissionRefreshClass} from '../lib/v1/lending-probe.mjs';
import {dockerSignedOutError, dockerProblem} from '../lib/v1/docker-state.mjs';

const expected = {code:'docker_signed_out',message:'Sign in to Docker to lend.',
  action:{kind:'docker-signin',label:'Sign in to Docker',href:'#/setup',step:'docker-signin'}};
const snapshot = () => ({read_at:null,windows:[],state:'unknown'});

test('Docker refusal error has the shared fixed blocker and no raw command output', () => {
  const error = dockerSignedOutError();
  assert.deepEqual(dockerProblem(),expected);
  assert.equal(error.code,expected.code);
  assert.equal(error.message,expected.message);
  assert.equal(error.probe_failure,expected.code);
  assert.deepEqual(error.action,expected.action);
});

test('cold probe preserves a Docker sign-in blocker', async () => {
  const probe = createLendingProbe({runGuest:async()=>{throw dockerSignedOutError();},now:()=>1000});
  const result = await probe.probe('codex');
  assert.deepEqual(result,{ok:false,reason:'docker_signed_out',...expected});
  assert.equal(probe.latestAttempt('codex').reason,'docker_signed_out');
  assert.equal(admissionRefreshClass(probe.latestAttempt('codex')),'invalidating');
  await probe.close();
});

test('public reading retains the known-safe blocker fields through sanitization', async () => {
  const probe = createLendingProbe({runGuest:async()=>{throw dockerSignedOutError();},now:()=>1000});
  const readings = createLendingReadings({ledger:{snapshot,snapshotReadOnly:snapshot},probe,now:()=>1000});
  const result = await readings('codex',{forceRefresh:true});
  assert.equal(result.refresh_succeeded,false);
  assert.deepEqual(result.probe,{reason:'docker_signed_out',provider:'codex',failure_class:'docker_signed_out',...expected});
  await probe.close();
});

test('sanitizer regenerates Docker blocker fields, never untrusted messages or actions', () => {
  const result = sanitizeProbeFailure({reason:'docker_signed_out',message:'PRIVATE_STDERR',code:'private',action:{href:'https://evil.invalid'}},'claude');
  assert.deepEqual(result,{reason:'docker_signed_out',provider:'claude',failure_class:'docker_signed_out',...expected});
  assert.ok(!JSON.stringify(result).includes('PRIVATE_STDERR'));
});

test('missing profile text without a Docker error code is not a sign-out', async () => {
  const probe = createLendingProbe({runGuest:async()=>{throw new Error('no default account profile set: secret not found');},now:()=>1000});
  const result = await probe.probe('codex');
  assert.equal(result.reason,'guest_failed');
  assert.equal(result.code,undefined);
  await probe.close();
});

test('sleeping-host refresh failure is not reclassified as a signed-out store', () => {
  const result = sanitizeProbeFailure({reason:'probe_unavailable',cause_code:'docker_signin_refresh_unavailable'},'codex');
  assert.equal(result.reason,'probe_unavailable');
  assert.equal(result.code,undefined);
  assert.equal(result.action,undefined);
});
