import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { covers, planNetworkDeny, probeTarget, resourceHost, resourcePort, sampleForChecks, parsePolicyListing } from '../lib/network-policy.mjs';
import { SBX_GLOBAL_RULES } from './helpers/sbx-policy-model.mjs';
import { GEMINI_HARNESS } from '../lib/harnesses/gemini.adapter.mjs';

test('Gemini provider-only permits its model/auth endpoints and denies unrelated Google products', () => {
  const agent = GEMINI_HARNESS.egress_provider_hosts;
  const required = ['generativelanguage.googleapis.com', 'oauth2.googleapis.com'];
  const unrelated = ['storage.googleapis.com', 'bigquery.googleapis.com', 'compute.googleapis.com'];
  const plan = planNetworkDeny({ inherited: [...required, ...unrelated], agent });
  assert.deepEqual(plan.refused, []);
  for (const host of required) {
    assert.ok(agent.some(pattern => covers(pattern, host)), host);
    assert.ok(!plan.deny.includes(host), host);
  }
  for (const host of unrelated) {
    assert.ok(!agent.some(pattern => covers(pattern, host)), host);
    assert.ok(plan.deny.includes(host), host);
  }
  const wide = planNetworkDeny({ inherited: ['**.googleapis.com'], agent });
  assert.deepEqual(wide.refused, ['**.googleapis.com'], 'broad inherited access must fail closed');
});

test('resources split into host and port, and addresses stay whole', () => {
  assert.deepEqual([resourceHost('API.Example.com:443'), resourcePort('api.example.com:443')], ['api.example.com', '443']);
  assert.deepEqual([resourceHost('**.x.com'), resourcePort('**.x.com')], ['**.x.com', null]);
  assert.deepEqual([resourceHost('10.0.0.0/8'), resourcePort('10.0.0.0/8')], ['10.0.0.0/8', null]);
  assert.deepEqual([resourceHost('::1/128'), resourcePort('fc00::/7')], ['::1/128', null]);
});

test('covers is conservative: it says yes only when every destination of the resource is inside the pattern', () => {
  const yes = [['**.x.com', 'a.x.com'], ['**.x.com', 'a.b.x.com'], ['**.x.com', '*.x.com'], ['**.x.com', '**.y.x.com:443'], ['*.x.com', 'a.x.com'],
    ['x.com', 'x.com:443'], ['x.com', 'x.com'], ['**.x.com:443', 'a.x.com:443'], ['10.0.0.0/8', '10.0.0.0/8']];
  const no = [['**.x.com', 'x.com'], ['*.x.com', 'a.b.x.com'], ['*.x.com', '**.x.com'], ['x.com:443', 'x.com'], ['x.com:443', 'x.com:80'],
    ['**.x.com', 'evilx.com'], ['**.x.com', 'a.y.com'], ['crl*.d.com', 'crl1.d.com'], ['10.0.0.0/8', '10.1.0.0/16'], ['a.x.com', '**.x.com']];
  for (const [pattern, resource] of yes) assert.equal(covers(pattern, resource), true, pattern + ' covers ' + resource);
  for (const [pattern, resource] of no) assert.equal(covers(pattern, resource), false, pattern + ' must not cover ' + resource);
});

test('a probe target is something the resource matches, on the port the rule names', () => {
  assert.equal(probeTarget('**.amazonaws.com:443'), 'faravan-probe.amazonaws.com:443');
  assert.equal(probeTarget('crl*.digicert.com:80'), 'crlfaravan-probe.digicert.com:80');
  assert.equal(probeTarget('github.com:443'), 'github.com:443');
  assert.equal(probeTarget('10.0.0.0/8'), '10.0.0.0');
});

const inherited = SBX_GLOBAL_RULES.flatMap(rule => rule.resources);

test('against the real sbx 0.48 default, a provider-only plan denies nearly everything and keeps the provider', () => {
  const plan = planNetworkDeny({ inherited, agent: ['**.anthropic.com', '**.claude.ai', 'api.anthropic.com:443'] });
  assert.equal(plan.refused.length, 0);
  assert.ok(plan.deny.includes('**.amazonaws.com:443') && plan.deny.includes('github.com:443') && plan.deny.includes('registry.npmjs.org:443'));
  assert.equal(plan.deny.includes('api.anthropic.com:443'), false, 'the provider stays allowed');
  assert.equal(plan.deny.length + 1 <= inherited.length, true);
  assert.equal(plan.window, null);
  assert.equal(plan.scope, null);
});

test('a Git source opens GitHub for the clone only, and the plan records how to close it', () => {
  const plan = planNetworkDeny({ inherited, agent: ['**.openai.com'], source: ['github.com', 'codeload.github.com'] });
  assert.equal(plan.refused.length, 0);
  assert.deepEqual(plan.sourceOnly, ['github.com', 'codeload.github.com']);
  assert.equal(plan.deny.includes('**.github.com:443'), false, 'wider than codeload.github.com, so it cannot be denied up front');
  assert.ok(plan.window.deny.includes('**.github.com:443') && plan.window.deny.includes('github.com:443') && plan.window.deny.includes('codeload.github.com'));
  assert.equal(plan.scope, 'clone_only');
  const github = planNetworkDeny({ inherited, agent: ['**.github.com'], source: ['github.com', 'codeload.github.com'] });
  assert.deepEqual(github.sourceOnly, ['github.com']);
  assert.equal(github.scope, 'whole_run', 'a provider on GitHub keeps GitHub reachable');
});

test('an inherited allowance wider than what the agent needs is refused, not ignored', () => {
  assert.deepEqual(planNetworkDeny({ inherited: ['**.com:443', 'x.org:443'], agent: ['**.anthropic.com'] }).refused, ['**.com:443']);
});

test('checks cover every pattern and a spread of exact hosts', () => {
  const sample = sampleForChecks(planNetworkDeny({ inherited, agent: ['**.anthropic.com'] }).deny);
  for (const pattern of inherited.filter(resource => /[*]/.test(resource) && !resource.startsWith('**.anthropic')))
    if (!covers('**.anthropic.com', pattern)) assert.ok(sample.includes(pattern), pattern);
  assert.ok(sample.length < 70 && sample.length > 30, String(sample.length));
});

test('the policy listing is read per sandbox: inherited, own allows with their ids, own denies', () => {
  const stdout = JSON.stringify({ rules: [
    { id: 'g', applies_to: 'all', decision: 'allow', resource_type: 'network', status: 'active', resources: ['a.com:443'] },
    { id: 'k', applies_to: 'sandbox:s1', decision: 'allow', resource_type: 'network', status: 'active', resources: ['kit.com:443'] },
    { id: 'd', applies_to: 'sandbox:s1', decision: 'deny', resource_type: 'network', status: 'active', resources: ['10.0.0.0/8'] },
    { id: 'other', applies_to: 'sandbox:s2', decision: 'allow', resource_type: 'network', status: 'active', resources: ['evil.com'] },
    { id: 'off', applies_to: 'all', decision: 'allow', resource_type: 'network', status: 'inactive', resources: ['gone.com'] },
    { id: 'fs', applies_to: 'all', decision: 'allow', resource_type: 'filesystem:read', status: 'active', resources: ['**'] }] });
  assert.deepEqual(parsePolicyListing(stdout, 's1'), { inheritedAllow: ['a.com:443'], ownAllow: [{ id: 'k', resources: ['kit.com:443'] }], ownDeny: ['10.0.0.0/8'] });
  for (const bad of ['', 'not json', '{}', '{"rules":"x"}']) assert.equal(parsePolicyListing(bad, 's1'), null);
});

test('kit hosts are denied on all their inherited and own ports', () => {
  const plan = planNetworkDeny({ inherited, agent: ['**.openai.com'], kit: ['archive.ubuntu.com:80', 'api.github.com:443', 'download.docker.com:443'] });
  assert.ok(plan.deny.includes('archive.ubuntu.com:443'));
  assert.ok(plan.deny.includes('archive.ubuntu.com:80'));
  assert.ok(plan.deny.includes('**.github.com:443') && plan.deny.includes('**.docker.com:443'));
  assert.deepEqual(plan.kitWider, []);
  assert.equal(plan.refused.length, 0);
});

test('an inherited wildcard over a whole top-level domain is refused even for a kit host', () => {
  const plan = planNetworkDeny({ inherited: ['**.com:443'], agent: ['**.openai.com'], kit: ['github.com:443'] });
  assert.deepEqual(plan.refused, ['**.com:443']);
  assert.deepEqual(plan.kitWider, []);
});
