// Bounded registry tests only. These synthetic adapters are never production defaults.
// They do not qualify four production providers or a model/effort/Pareto catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRegistry, getProvider, listProviders } from '../../lib/v1/providers/index.mjs';
import { fault } from '../../lib/v1/accounts.mjs';

const methods = ['beginSignIn', 'finishSignIn', 'cancelSignIn', 'refresh', 'readUsage',
  'authorizeRequest', 'makeRun', 'classifyReplay', 'parseJobUsage'];
function fixture(id) {
  return {
    descriptor: { schemaVersion: 1, id, fixture: { note: 'synthetic registry-only fixture' } },
    ...Object.fromEntries(methods.map(name => [name, () => { throw new Error('unexpected effect: ' + name); }])),
  };
}
test('injected registry keeps caller ordering and does not enable production defaults', () => {
  const before = listProviders();
  const supplied = [fixture('registry-fixture-z'), fixture('registry-fixture-a')];
  const registry = createProviderRegistry(supplied);
  assert.deepEqual(registry.listProviders().map(d => d.id), supplied.map(a => a.descriptor.id));
  assert.deepEqual(listProviders(), before);
  assert.deepEqual(getProvider('registry-fixture-z'), fault('provider_not_found'));
  assert.deepEqual(registry.getProvider('unknown-fixture'), fault('provider_not_found'));
  assert.deepEqual(registry.listProviders().map(d => d.id), ['registry-fixture-z', 'registry-fixture-a']);
});
test('duplicate IDs, wrong schema and every absent adapter method are refused', () => {
  assert.throws(() => createProviderRegistry([fixture('same'), fixture('same')]), /invalid_provider_adapter/);
  const wrong = fixture('wrong'); wrong.descriptor.schemaVersion = 2;
  assert.throws(() => createProviderRegistry([wrong]), /invalid_provider_adapter/);
  const noId = fixture(''); assert.throws(() => createProviderRegistry([noId]), /invalid_provider_adapter/);
  for (const method of methods) {
    const invalid = fixture('missing-' + method); delete invalid[method];
    assert.throws(() => createProviderRegistry([invalid]), /invalid_provider_adapter/, method);
  }
});
test('editing a listed descriptor cannot rewrite the registered nested descriptor', () => {
  const adapter = fixture('copy-boundary'), registry = createProviderRegistry([adapter]);
  const first = registry.listProviders();
  first[0].fixture.note = 'changed'; first.push({ id: 'not-registered' });
  assert.equal(registry.listProviders().length, 1);
  assert.equal(registry.listProviders()[0].fixture.note, 'synthetic registry-only fixture');
  assert.equal(adapter.descriptor.fixture.note, 'synthetic registry-only fixture');
  assert.deepEqual(registry.getProvider('not-registered'), fault('provider_not_found'));
});
