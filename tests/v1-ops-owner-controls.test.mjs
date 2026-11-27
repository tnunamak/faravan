import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {OPS, opById, SURFACE_NAME, mayNeedConfirmation} from '../lib/v1/ops/registry.mjs';
import {openApiDocument} from '../lib/v1/ops/http.mjs';
import {opsRoute} from '../lib/v1/ops/cli.mjs';
import {selectTools} from '../lib/v1/mcp.mjs';
import {check} from '../lib/v1/ops/schema.mjs';

// The owner's controls for lending, behind the operations registry: the saved per-job limit, the one-job presence override and
// owner origin attestation. Each reaches the UI route, the CLI, HTTP and MCP from one declaration, with the same input contract.
const OWNER_CONTROLS = {
  'lending.owner_settings': {method: 'GET', path: '/api/lending/owner-settings', safety: 'read'},
  'lending.set_owner_settings': {method: 'POST', path: '/api/lending/owner-settings', safety: 'consequential'},
  'lending.presence': {method: 'GET', path: '/api/lending/presence', safety: 'read'},
  'lending.allow_once': {method: 'POST', path: '/api/lending/presence/allow-once', safety: 'consequential'},
  'lending.window_origins': {method: 'GET', path: '/api/lending/window-origins', safety: 'read'},
  'lending.attest_window': {method: 'POST', path: '/api/lending/window-origins/attest', safety: 'consequential'},
};
const toolsByName = new Map(selectTools().map((tool) => [tool.name, tool]));

test('each owner control is declared once, bound to its route, and read or changed as its safety says', () => {
  for (const [id, expected] of Object.entries(OWNER_CONTROLS)) {
    const op = opById(id);
    assert.ok(op, `${id} is an operation`);
    assert.equal(op.rest?.method, expected.method, id);
    assert.equal(op.rest?.path, expected.path, id);
    assert.equal(op.safety, expected.safety, id);
    assert.equal(mayNeedConfirmation(op), expected.safety === 'consequential', `${id}: confirmation follows safety`);
  }
});

test('each owner control reaches the CLI, the HTTP operation and an MCP tool, and nothing else is added to them', () => {
  const paths = openApiDocument().paths;
  for (const id of Object.keys(OWNER_CONTROLS)) {
    const op = opById(id);
    const route = opsRoute(SURFACE_NAME.cli(op).split(' ').slice(1));
    assert.equal(route?.kind, 'op', `${id}: the CLI reaches the operation`);
    assert.equal(route.op, op, id);
    assert.ok(paths['/api/ops/' + id]?.post, `${id}: POST /api/ops/${id} is documented`);
    assert.ok(toolsByName.has(SURFACE_NAME.mcp(op)), `${id}: MCP tool ${SURFACE_NAME.mcp(op)}`);
  }
  assert.equal(OPS.filter((op) => op.id.startsWith('lending.') && op.safety === 'human').length, 0);
});

test('the owner controls validate their input by the same schema on every surface, and refuse out-of-range values by name', () => {
  const schema = (id) => opById(id).input;
  assert.equal(check(schema('lending.set_owner_settings'), {maxJobUsd: 2, reason: 'owner decision'}), null);
  assert.ok(check(schema('lending.set_owner_settings'), {maxJobUsd: 0, reason: 'owner decision'}), 'a limit must be positive');
  assert.ok(check(schema('lending.set_owner_settings'), {maxJobUsd: 2}), 'a change needs a reason');
  const digest = 'sha256:' + 'a'.repeat(64);
  assert.equal(check(schema('lending.allow_once'), {digest, reason: 'run now', minutes: 15}), null);
  assert.ok(check(schema('lending.allow_once'), {digest, reason: 'run now', minutes: 31}), 'the lifetime is bounded at thirty minutes');
  assert.ok(check(schema('lending.allow_once'), {digest: 'job-1', reason: 'run now'}), 'a job is named by its full digest');
  assert.equal(check(schema('lending.attest_window'), {instance: 'five_hour@1792744800000', reason: 'I opened it'}), null);
  assert.ok(check(schema('lending.attest_window'), {instance: 'five_hour@1792744800000', reason: ''}), 'an attestation needs a reason');
  for (const id of Object.keys(OWNER_CONTROLS)) {
    const tool = toolsByName.get(SURFACE_NAME.mcp(opById(id)));
    const expected = [...Object.keys(opById(id).input.properties ?? {}), ...(mayNeedConfirmation(opById(id)) ? ['confirm'] : [])].sort();
    assert.deepEqual(Object.keys(tool.inputSchema.properties ?? {}).sort(), expected, `${id}: MCP fields match`);
  }
});
