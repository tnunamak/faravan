// Partial operation-boundary regression, not account enrollment/removal qualification.
// Assumption: retain the existing agent/sign-in ports until accepted account ports are supplied.
// All effects below are injected synthetic functions. No app, browser, native store or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {runOp, problemOf} from '../../lib/v1/ops/execute.mjs';

function boundary() {
  const calls = [];
  const response = Object.freeze({synthetic: true});
  const ctx = {
    confirmed: false,
    rest: async (...args) => { calls.push(args); return response; },
    call: async () => { throw new Error('unexpected secondary operation'); },
  };
  return {calls, response, ctx};
}

test('assuming existing agent ports, lending selection needs confirmation before effects', async () => {
  const {calls, response, ctx} = boundary();
  const input = {id: 'synthetic-agent', useForLending: true};
  await assert.rejects(runOp('agents.select', input, ctx),
    error => error.code === 'confirmation_required');
  assert.equal(calls.length, 0);
  assert.equal(await runOp('agents.select', input, {...ctx, confirmed: true}), response);
  assert.deepEqual(calls, [['POST', '/api/agents/synthetic-agent', {
    query: undefined, body: {useForLending: true}, signal: undefined,
    headers: {'faravan-confirm': 'yes'},
  }]]);
  // Confirmation is not authentication; the real app must still authorize this route.
});

test('assuming existing ports, invalid identifiers and unsupported effort have no effects', async () => {
  const {calls, ctx} = boundary();
  for (const [id, input] of [
    ['agents.set_run', {id: 17, model: 'synthetic-model', effort: 'high'}],
    ['agents.set_run', {id: 'synthetic-agent', model: 'synthetic-model', effort: 'ultra'}],
    ['signin.cancel', {flowId: 17}],
  ]) {
    await assert.rejects(runOp(id, input, ctx), error => error.code === 'invalid_request');
  }
  assert.equal(calls.length, 0);
});

test('assuming existing sign-in port, an already cancelled request does not dispatch', async () => {
  const {calls, ctx} = boundary();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runOp('signin.cancel', {flowId: 'synthetic-flow'}, {...ctx, signal: controller.signal}),
    error => error.code === 'cancelled',
  );
  assert.equal(calls.length, 0);
});

test('assuming existing agent run port, explicit model and effort are forwarded without downgrade', async () => {
  const {calls, response, ctx} = boundary();
  const input = {
    id: 'synthetic-agent',
    model: 'synthetic/model-v2',
    effort: 'high',
    model_efforts: [{model: 'synthetic/model-v2', effort: 'high'}],
  };
  const before = structuredClone(input);
  assert.equal(await runOp('agents.set_run', input, ctx), response);
  assert.deepEqual(calls, [['POST', '/api/agents/synthetic-agent/run', {
    query: undefined,
    body: {model: input.model, effort: 'high', model_efforts: input.model_efforts},
    signal: undefined,
  }]]);
  assert.deepEqual(input, before);
});

test('assuming the existing route owns refusal, dispatch does not retry or fall back', async () => {
  let attempts = 0;
  let secondaryCalls = 0;
  const refusal = Object.assign(new Error('synthetic private provider diagnostic'), {
    code: 'account_signed_out',
  });
  await assert.rejects(runOp('agents.set_run', {
    id: 'synthetic-agent', model: 'synthetic-model', effort: 'high',
  }, {
    confirmed: false,
    rest: async () => { attempts++; throw refusal; },
    call: async () => { secondaryCalls++; throw new Error('unexpected fallback'); },
  }), error => error === refusal);
  assert.equal(attempts, 1);
  assert.equal(secondaryCalls, 0);
});

test('assuming an untrusted provider error, public problem omits diagnostic and secret-like extras', () => {
  const error = Object.assign(new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'), {
    code: 'account_signed_out',
    token: 'SYNTHETIC_NOT_A_CREDENTIAL',
    loginUrl: 'https://invalid.example/synthetic',
    invite: 'SYNTHETIC_INVITE',
    action: {url: 'https://invalid.example/private'},
  });
  assert.deepEqual(problemOf(error), {
    code: 'account_signed_out', message: 'account signed out',
  });
});
