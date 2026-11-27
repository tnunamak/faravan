import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry } from '../../lib/v1/providers/index.mjs';

// Conservative scope assumption: test the existing injected-adapter registry,
// not concrete API/pi factory configuration or runtime enablement.
// Runtime registration retains dependency fv-outcome-pi-authorization-1114.
const methods = ['beginSignIn', 'finishSignIn', 'cancelSignIn', 'refresh',
  'readUsage', 'authorizeRequest', 'makeRun', 'classifyReplay', 'parseJobUsage'];
function fixture(id, signInKind) {
  const calls = [];
  const adapter = {
    descriptor: {
      schemaVersion: 1, id, label: id, signInKind, refreshKind: 'none',
      usageKind: 'none', maxConcurrentJobs: null, nativeUnits: [], destinations: [],
      models: [
        { id: 'second', label: 'Second', enabled: true, rank: 2,
          efforts: [{ id: 'careful', label: 'Careful' }], defaultEffort: null, pareto: null },
        { id: 'first', label: 'First', enabled: false, rank: 1,
          efforts: [], defaultEffort: null, pareto: false },
      ],
    },
  };
  for (const method of methods) {
    adapter[method] = function(input) {
      const result = { ok: true, value: { method, providerId: id } };
      calls.push({ receiver: this, input, method, result });
      return result;
    };
  }
  return { adapter, calls };
}

test('conservative injected-registry contract: registered adapters preserve identity and delegate successful calls', () => {
  const a = fixture('synthetic-api', 'api_key');
  const b = fixture('synthetic-local', 'local_harness');
  const registry = createProviderRegistry([a.adapter, b.adapter]);
  for (const entry of [a, b]) {
    const resolved = registry.getProvider(entry.adapter.descriptor.id);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.value, entry.adapter);
    for (const method of methods) {
      const input = Object.freeze({ accountId: 'synthetic-account', effortId: 'explicit-unsupported' });
      const result = resolved.value[method](input);
      const call = entry.calls.at(-1);
      assert.equal(result, call.result);
      assert.equal(call.input, input);
      assert.equal(call.receiver, entry.adapter);
      assert.equal(call.method, method);
    }
    assert.equal(entry.calls.length, methods.length);
  }
});

test('conservative injected-registry contract: list preserves provider/model order and unknown/default metadata without exposing mutable descriptors', () => {
  const a = fixture('synthetic-z', 'local_harness');
  const b = fixture('synthetic-a', 'api_key');
  const registry = createProviderRegistry([a.adapter, b.adapter]);
  const expected = structuredClone([a.adapter.descriptor, b.adapter.descriptor]);
  assert.deepEqual(registry.listProviders(), expected);
  const listed = registry.listProviders();
  listed.reverse();
  listed[1].models[0].efforts[0].id = 'mutated';
  listed[1].models[0].defaultEffort = 'mutated';
  listed[1].models.reverse();
  assert.deepEqual(registry.listProviders(), expected);
  assert.deepEqual(a.adapter.descriptor, expected[0]);
  const unknown = registry.getProvider('not-registered');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, 'provider_not_found');
});

test('conservative injected-registry contract: duplicate identities and missing required methods cannot register', () => {
  const a = fixture('synthetic-provider', 'api_key').adapter;
  const duplicate = fixture('synthetic-provider', 'local_harness').adapter;
  assert.throws(() => createProviderRegistry([a, duplicate]), /invalid_provider_adapter/);
  for (const method of methods) {
    const incomplete = { ...a };
    delete incomplete[method];
    assert.throws(() => createProviderRegistry([incomplete]), /invalid_provider_adapter/);
  }
});
