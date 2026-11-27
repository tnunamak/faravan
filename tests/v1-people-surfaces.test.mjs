import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { HOST_CAPABILITIES } from '../lib/v1/versions.mjs';
import { appRequest, runOp } from '../lib/v1/ops/execute.mjs';
import { runOpsCommand } from '../lib/v1/ops/cli.mjs';
import { selectTools } from '../lib/v1/mcp.mjs';
import { SURFACE_NAME, opById } from '../lib/v1/ops/registry.mjs';

function capture() {
  let value = '';
  return {stream:new Writable({write(chunk, _encoding, done) { value += chunk; done(); }}), read:() => value};
}

function governance(people) {
  return people.map(({personId, role, blocked}) => ({personId, role, blocked}))
    .sort((a, b) => a.personId.localeCompare(b.personId));
}

test('people listing and governance actions agree across REST, ops HTTP, CLI, and MCP contracts', {timeout:120000}, async t => {
  const f = await appFixture(t);
  // Exercise the in-repo updated coordinator protocol and feature negotiation.
  f.hostCapabilities = {capabilities:[...HOST_CAPABILITIES, 'circle_people_v1']};
  const {owner, lender, circle} = await f.realConnect();
  const lenderId = lender.app.device.keyId;
  const base = '/api/circles/' + circle.id + '/people';

  // Same read through direct REST, operation HTTP, and the real CLI argument parser/client boundary.
  const direct = await api(owner.app, base);
  const viaHttp = await api(owner.app, '/api/ops/people.list', {method:'POST', body:{circle:circle.id}});
  const output = capture();
  const cliCode = await runOpsCommand(['people','list','--circle',circle.id,'--json'], {
    home:owner.home, stdout:output.stream, stderr:output.stream,
    client:{call:(id, input, options = {}) => runOp(id, input, {
      home:owner.home, confirmed:options.confirmed,
      rest:(method, path, request) => appRequest(owner.app, method, path, request),
    })},
  });
  assert.equal(cliCode, 0);
  const viaCli = JSON.parse(output.read());
  assert.deepEqual(viaHttp, direct);
  assert.deepEqual(viaCli, direct);
  assert.ok(direct.some(person => person.personId === lenderId));

  // MCP publishes the same operation names, schemas, and safety hints as the registry.
  const tools = new Map(selectTools().map(tool => [tool.name, tool]));
  for (const id of ['people.list','people.link_proof','people.link','people.set_role','people.set_block','people.remove']) {
    const op = opById(id), tool = tools.get(SURFACE_NAME.mcp(op));
    assert.ok(tool, id + ' is exposed as an MCP tool');
    const schema = structuredClone(tool.inputSchema), expected = structuredClone(op.input);
    if (op.safety === 'consequential') {
      const confirm = schema.properties.confirm;
      assert.equal(confirm?.type, 'boolean', id + ' exposes explicit consent');
      delete schema.properties.confirm;
    }
    assert.deepEqual(schema, expected, id + ' MCP schema matches the registry');
    assert.equal(tool.annotations.readOnlyHint, op.safety === 'read', id);
    assert.equal(tool.annotations.destructiveHint, op.safety === 'consequential', id);
  }

  // Owner changes pass through each action surface, and every resulting roster view agrees.
  const roleInput = {personId:lenderId, role:'borrow-only'};
  const blockInput = {personId:lenderId, blocked:true};
  await assert.rejects(runOp('people.set_role', {circle:circle.id, ...roleInput}, {
    home:owner.home, confirmed:false,
    rest:(method, path, request) => appRequest(owner.app, method, path, request),
  }), error => error.code === 'confirmation_required' && error.effect.includes('borrow-only') && error.effect.includes(lenderId) && error.effect.includes(circle.id));
  await assert.rejects(runOp('people.set_block', {circle:circle.id, personId:lenderId, blocked:true}, {
    home:owner.home, confirmed:false,
    rest:(method, path, request) => appRequest(owner.app, method, path, request),
  }), error => error.code === 'confirmation_required' && error.effect.startsWith('Block new requests and runs for ') && error.effect.includes(lenderId) && error.effect.includes(circle.id));
  const roleRest = await api(owner.app, base + '/role', {method:'POST', body:roleInput});
  assert.ok(roleRest.people.some(person => person.personId === lenderId && person.role === 'borrow-only'));

  const blockHttp = await api(owner.app, '/api/ops/people.set_block', {
    method:'POST', body:{circle:circle.id, ...blockInput}, headers:{'faravan-confirm':'yes'},
  });
  assert.ok(blockHttp.people.some(person => person.personId === lenderId && person.blocked === true));

  const cliOutput = capture();
  const cliBlock = await runOpsCommand(['people','set-block','--circle',circle.id,'--person-id',lenderId,'--blocked','false','--yes','--json'], {
    home:owner.home, stdout:cliOutput.stream, stderr:cliOutput.stream,
    client:{call:(id, input, options = {}) => runOp(id, input, {
      home:owner.home, confirmed:options.confirmed,
      rest:(method, path, request) => appRequest(owner.app, method, path, request),
    })},
  });
  assert.equal(cliBlock, 0);
  const cliResult = JSON.parse(cliOutput.read());
  assert.ok(cliResult.people.some(person => person.personId === lenderId && person.blocked === false));

  const after = await api(owner.app, base);
  assert.deepEqual(governance(after), governance(cliResult.people));

  // A member cannot change roles through either REST or confirmed ops HTTP.
  const deniedRest = await fetch(lender.app.origin + base + '/role', {
    method:'POST', headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json'},
    body:JSON.stringify({personId:lenderId,role:'member'}),
  });
  assert.equal(deniedRest.status, 409);
  assert.equal((await deniedRest.json()).code, 'not_owner');
  const deniedOps = await fetch(lender.app.origin + '/api/ops/people.set_role', {
    method:'POST', headers:{'x-faravan-session-token':lender.app.token,'content-type':'application/json','faravan-confirm':'yes'},
    body:JSON.stringify({circle:circle.id,personId:lenderId,role:'member'}),
  });
  assert.equal(deniedOps.status, 409);
  assert.equal((await deniedOps.json()).code, 'not_owner');
});
