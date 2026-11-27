import './helpers/no-browser.mjs';
// Precedence: the most restrictive switch wins (docs/design/TELEMETRY.md §4.4, §4.5, §6 "Precedence"). The expected `effective`
// level is computed here from the design alone and compared with what the consent module says, over a matrix of environment
// x stored level x region x notice x build. Request scope and the surfaces (MCP cannot widen) follow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTelemetry, settle, ENDPOINT } from './helpers/telemetry-harness.mjs';
import { clientHeaders, scopeOf, envSwitch } from '../lib/v1/telemetry/switch.mjs';
import { OPS, opById, SURFACE_NAME } from '../lib/v1/ops/registry.mjs';
import { selectTools, parseToolsets } from '../lib/v1/mcp.mjs';
import { openApiDocument } from '../lib/v1/ops/http.mjs';
import { opsRoute } from '../lib/v1/ops/cli.mjs';
import { telemetryApp } from './helpers/telemetry-app.mjs';
import { api } from './helpers/v1-app-fixture.mjs';

// ---- The design, restated (§4.4 region table, §4.5 precedence) -------------------------------------------------------
const regionDefault = () => 'on'; // Owner's launch policy: the notice activates the default, with no region question.
const ENV_ON = new Set(['FARAVAN_NO_TELEMETRY=1', 'DO_NOT_TRACK=1']);
const STREAMS = {off: [], on:['counts','quota','diagnostics']};

/** Most restrictive wins: env, then the stored choice or the region default, then the notice, then the build. */
function expectedEffective({env, level, region, noticeShown, uploadable}) {
  if (Object.entries(env).some(([name, value]) => ENV_ON.has(`${name}=${value}`))) return 'off';
  if (!uploadable) return 'off';
  const chosen = level ?? regionDefault(region);
  if (!noticeShown) return 'off';
  return chosen;
}

const ENVS = [
  ['no env', {}], ['FARAVAN_NO_TELEMETRY=1', {FARAVAN_NO_TELEMETRY: '1'}], ['DO_NOT_TRACK=1', {DO_NOT_TRACK: '1'}],
  ['DO_NOT_TRACK=0 is not a switch', {DO_NOT_TRACK: '0'}], ['FARAVAN_NO_TELEMETRY=0 is not a switch', {FARAVAN_NO_TELEMETRY: '0'}],
  ['both set', {FARAVAN_NO_TELEMETRY: '1', DO_NOT_TRACK: '1'}], ['one off, one not', {FARAVAN_NO_TELEMETRY: '0', DO_NOT_TRACK: '1'}],
];
const LEVELS = [null, 'off', 'on'];
const REGIONS = [null, 'US', 'FR', 'GB', 'CH', 'DE', 'JP'];
const BUILDS = [['release with telemetry enabled',true],['build OFF',false]];

function withPolicy(policy, run) {
  const dir = mkdtempSync(join(tmpdir(), 'tel-prec-'));
  try {
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({version: 2, level: null, region: null, noticeShownAt: null, decidedAt: null, generation: 3, ...policy}));
    return run(dir);
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('effective level over env x stored level x region x notice x build (588 combinations) equals the design', () => {
  let combinations = 0;
  const wrong = [];
  for (const [envName, env] of ENVS) for (const level of LEVELS) for (const region of REGIONS) for (const noticeShown of [true, false]) for (const [buildName, uploadable] of BUILDS) {
    combinations++;
    withPolicy({level, region, noticeShownAt: noticeShown ? 1 : null, decidedAt: level ? 1 : null}, dir => {
      const h = makeTelemetry({dir, level: null, env, enabled:uploadable});
      const status = h.tel.status();
      const expected = expectedEffective({env, level, region, noticeShown, uploadable});
      if (status.effective !== expected || JSON.stringify(status.streams) !== JSON.stringify(STREAMS[expected])) {
        wrong.push(`${envName} | level ${level} | region ${region} | notice ${noticeShown} | ${buildName}: expected ${expected}, got ${status.effective} [${status.streams}]`);
      }
      if (Object.entries(env).some(([n, v]) => ENV_ON.has(`${n}=${v}`))) assert.equal(status.reason.kind, 'env', `${envName}: the environment is named as the reason`);
    });
  }
  assert.equal(combinations, 7 * 3 * 7 * 2 * 2);
  assert.deepEqual(wrong, []);
});

test('the launch default is ON for every legacy region and for an unknown region', () => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const wrong = [];
  for (const a of letters) for (const b of letters) {
    const region = a + b;
    withPolicy({region, noticeShownAt: 1}, dir => {
      const effective = makeTelemetry({dir, level: null}).tel.status().effective;
      if (effective !== (regionDefault(region) ?? 'off')) wrong.push(`${region}: ${effective}`);
    });
  }
  assert.deepEqual(wrong, []);
  withPolicy({region: null, noticeShownAt: 1}, dir => assert.equal(makeTelemetry({dir, level: null}).tel.status().effective, 'on', 'unknown region'));
});

test('a stored choice beats the region default in both directions, and the environment beats a stored choice', () => {
  withPolicy({region: 'FR', level: 'on', noticeShownAt: 1}, dir => assert.equal(makeTelemetry({dir, level: null}).tel.status().effective, 'on', 'a person with ON and a legacy region'));
  withPolicy({region: 'US', level: 'off', noticeShownAt: 1}, dir => assert.equal(makeTelemetry({dir, level: null}).tel.status().effective, 'off', 'a US person who chose off'));
  withPolicy({region: 'US', level: 'on', noticeShownAt: 1}, dir => assert.equal(makeTelemetry({dir, level: null, env: {DO_NOT_TRACK: '1'}}).tel.status().effective, 'off'));
});

test('real choices through the API follow the same table (choose, restrict, notice, region change)', () => {
  const h = makeTelemetry({level: null});
  try {
    assert.equal(h.tel.status().effective, 'off', 'a fresh install');
    h.tel.view();
    assert.equal(h.tel.status().effective, 'off', 'region alone, notice not shown');
    h.tel.markNoticeShown();
    assert.equal(h.tel.status().effective, 'on', 'default for the region once the notice was shown');
    h.tel.view();
    assert.equal(h.tel.status().effective, 'on', 'legacy region changes do not change the launch default');
    h.tel.choose({level: 'on'});
    assert.equal(h.tel.status().effective, 'on');
    h.tel.restrict();
    assert.equal(h.tel.status().effective, 'off');
    h.tel.view();
    assert.equal(h.tel.status().effective, 'off', 'a stored off survives a region change');
    h.tel.choose({level: 'on'});
    assert.equal(h.tel.status().effective, 'on');
  } finally { h.cleanup(); }
});

test('environment switches apply per process: createTelemetry reads env once', () => {
  const env = {};
  const h = makeTelemetry({env});
  try {
    assert.equal(h.tel.status().effective, 'on');
    env.DO_NOT_TRACK = '1';
    assert.equal(h.tel.status().effective, 'on', 'a change after start does not apply to this process');
    const next = makeTelemetry({dir: h.dir, level: null, env: {...env}});
    assert.equal(next.tel.status().effective, 'off', 'the next process has it');
    delete env.DO_NOT_TRACK;
    const after = makeTelemetry({dir: h.dir, level: null, env: {...env}});
    assert.equal(after.tel.status().effective, 'on', 'and it needs no stored change to come back');
  } finally { h.cleanup(); }
});

test('what counts as an environment switch: 1 and any other non-empty value, but not 0, false or empty', () => {
  for (const value of ['1', 'true', 'yes', 'on']) assert.equal(envSwitch({DO_NOT_TRACK: value}), 'DO_NOT_TRACK', value);
  for (const value of ['0', 'false', 'FALSE', '', ' 0 ']) assert.equal(envSwitch({DO_NOT_TRACK: value}), null, JSON.stringify(value));
  assert.equal(envSwitch({}), null);
  assert.equal(envSwitch({FARAVAN_NO_TELEMETRY: '1'}), 'FARAVAN_NO_TELEMETRY');
  assert.equal(envSwitch({FARAVAN_NO_TELEMETRY: '0', DO_NOT_TRACK: '1'}), 'DO_NOT_TRACK', 'a zero on one name does not hide the other');
});

// ---- Request scope --------------------------------------------------------------------------------------------------

const names = h => h.transport.records().map(record => record.name);
const failureBody = {code: 'internal_error', message: 'x'};

test('a CLI switch header drops the request\'s own records (response, usage) but not other background work', async () => {
  for (const header of [{'faravan-telemetry': 'off'}, {'sec-gpc': '1'}]) {
    const h = makeTelemetry();
    try {
      h.tel.response({writer: 'ops', req: {url: '/api/ops/telemetry.status', headers: header}, status: 500, body: failureBody, opId: 'telemetry.status', durationMs: 20});
      h.tel.observe('lender-failure', {code: 'lender_failed', phase: 'run'}); // background work in the same hour
      await settle(h);
      assert.ok(names(h).includes('problem.count'), `${JSON.stringify(header)}: background work is governed by the stored level`);
      const problems = h.transport.records().filter(r => r.name === 'problem.count');
      assert.deepEqual(problems.map(r => r.attrs.component), ['lender'], `${JSON.stringify(header)}: only the lender failure, not the request's own failure`);
      assert.equal(names(h).includes('op.count'), false, 'the request\'s own usage is dropped too');
      assert.equal(names(h).includes('op.duration'), false);
    } finally { h.cleanup(); }
  }
});

test('the same request without the header is counted (the scope test is not vacuous)', async () => {
  const h = makeTelemetry();
  try {
    h.tel.response({writer: 'ops', req: {url: '/api/ops/telemetry.status', headers: {}}, status: 500, body: failureBody, opId: 'telemetry.status', durationMs: 20});
    h.tel.response({writer: 'ops', req: {url: '/api/ops/telemetry.status', headers: {'sec-gpc': '0'}}, status: 500, body: failureBody, opId: 'telemetry.status'});
    await settle(h);
    assert.ok(names(h).includes('op.count'));
    assert.equal(h.transport.records().find(r => r.name === 'problem.count').value, 2, 'Sec-GPC: 0 is not a request to be left alone');
  } finally { h.cleanup(); }
});

test('Sec-GPC on a UI or phone post drops those friction records; the same post without it is counted', async () => {
  const h = makeTelemetry();
  try {
    const post = {kind: 'dead_end', route: 'home'};
    h.tel.ui([post], {headers: {'sec-gpc': '1'}});
    h.tel.ui([post], {headers: {'faravan-telemetry': 'off'}});
    h.tel.ui([post], {headers: {}, origin: 'phone'});
    await settle(h);
    const friction = h.transport.records().filter(r => r.name === 'ui.friction');
    assert.equal(friction.length, 1);
    assert.equal(friction[0].value, 1, 'only the unrestricted post');
  } finally { h.cleanup(); }
});

test('a request scope only lowers: it never turns anything on', async () => {
  const off = makeTelemetry({level: 'off'});
  const counts = makeTelemetry({level: 'on'});
  try {
    off.tel.response({writer: 'app', req: {url: '/api/x', headers: {}}, status: 500, body: failureBody});
    await settle(off);
    assert.equal(off.transport.requests.length, 0);
    counts.tel.response({writer: 'app', req: {url: '/api/x', headers: {}}, status: 500, body: failureBody});
    await settle(counts);
    assert.ok(names(counts).includes('problem.observed.readiness'), 'ON includes diagnostics');
    assert.ok(names(counts).includes('problem.count'));
  } finally { off.cleanup(); counts.cleanup(); }
});

test('clients carry the person\'s environment switch as a request header; DO_NOT_TRACK=0 does not', () => {
  assert.deepEqual(clientHeaders({FARAVAN_NO_TELEMETRY: '1'}, 'cli'), {'faravan-surface': 'cli', 'faravan-telemetry': 'off'});
  assert.deepEqual(clientHeaders({DO_NOT_TRACK: '1'}, 'mcp'), {'faravan-surface': 'mcp', 'faravan-telemetry': 'off'});
  assert.deepEqual(clientHeaders({DO_NOT_TRACK: '0'}, 'cli'), {'faravan-surface': 'cli'});
  assert.deepEqual(clientHeaders({}, 'mcp'), {'faravan-surface': 'mcp'});
  assert.deepEqual(scopeOf({'faravan-telemetry': 'off'}), {off: true});
  assert.deepEqual(scopeOf({'sec-gpc': '1'}), {off: true});
  assert.deepEqual(scopeOf({'faravan-telemetry': 'on'}), {off: false});
  assert.deepEqual(scopeOf({'sec-gpc': '0'}), {off: false});
  assert.deepEqual(scopeOf(undefined), {off: false});
});

// ---- Surfaces: MCP can lower, never raise --------------------------------------------------------------------------

const groups = [...new Set(OPS.map(op => op.id.split('.')[0]))];
const mcpNames = () => new Set(['all', 'borrow', 'lend', 'meta', ...groups].flatMap(toolset => { try { return selectTools({toolsets: parseToolsets(toolset)}).map(t => t.name); } catch { return []; } }));

test('telemetry.set is human-only and appears on no MCP toolset and no HTTP operation', () => {
  const set = opById('telemetry.set');
  assert.equal(set.safety, 'human');
  assert.ok(!mcpNames().has(SURFACE_NAME.mcp(set)), 'not an MCP tool in any toolset');
  assert.ok(!selectTools({toolsets: ['all']}).some(tool => /telemetry_set|telemetry\.set/.test(tool.name)));
  assert.equal(openApiDocument().paths['/api/ops/telemetry.set'], undefined, 'not an HTTP operation');
  // The meta tool that reaches every operation does not list it either.
  assert.ok(!selectTools({toolsets: ['meta']}).some(tool => tool.name === 'telemetry_set'));
});

test('telemetry.off exists on HTTP, the CLI and MCP', () => {
  const off = opById('telemetry.off');
  assert.ok(off, 'registered');
  assert.notEqual(off.safety, 'human');
  assert.ok(openApiDocument().paths['/api/ops/telemetry.off']?.post, 'HTTP');
  const route = opsRoute(SURFACE_NAME.cli(off).split(' ').slice(1));
  assert.equal(route?.kind, 'op', 'CLI');
  assert.equal(route.op, off);
  assert.ok(selectTools().some(tool => tool.name === SURFACE_NAME.mcp(off)), 'MCP');
  assert.ok(selectTools({toolsets: ['all']}).some(tool => tool.name === 'telemetry_off'));
});

test('DEFECT: over MCP, telemetry can only be read, shown and turned off (design §2.2 "MCP gets status, off and preview")', () => {
  const telemetryTools = selectTools().map(tool => tool.name).filter(name => name.startsWith('telemetry_')).sort();
  // notice_shown and reset_id are write operations on every surface today. Marking the notice shown is the step that turns a
  // region default on for someone who has not seen the notice, so an MCP client must not be able to take it.
  assert.deepEqual(telemetryTools, ['telemetry_off', 'telemetry_preview', 'telemetry_status']);
});

test('DEFECT: a call from the MCP surface to telemetry.notice_shown must not turn on the region default for someone who has not seen the notice', async t => {
  const x = await telemetryApp(t, {level: null});
  assert.equal(x.tel.status().effective, 'off');
  assert.equal(x.tel.status().reason.kind, 'notice_pending');
  const response = await fetch(x.app.origin + '/api/ops/telemetry.notice_shown', {method: 'POST', body: '{}',
    headers: {'x-faravan-session-token': x.app.token, 'content-type': 'application/json', 'faravan-surface': 'mcp'}});
  assert.equal(x.tel.status().effective, 'off', `an MCP-surface call (HTTP ${response.status}) raised the level to ${x.tel.status().effective}: widening needs a local UI or CLI action, never MCP`);
});

test('direct MCP telemetry routes allow only status, preview and off', async t => {
  const x = await telemetryApp(t, {level: 'on'});
  const headers = {'faravan-surface': 'mcp'};
  const before = x.tel.status().generation;
  for (const path of ['notice', 'choose', 'reset-id', 'ui']) {
    const body = path === 'ui' ? {records: []} : path === 'choose' ? {level: 'on'} : {};
    const denied = await api(x.app, '/api/telemetry/' + path, {method: 'POST', body, headers, status: 403});
    assert.equal(denied.code, 'human_only', path);
  }
  assert.equal(x.tel.status().generation, before);
  assert.equal((await api(x.app, '/api/telemetry', {headers})).effective, 'on');
  assert.ok((await api(x.app, '/api/telemetry/preview', {headers})).items);
  assert.equal((await api(x.app, '/api/telemetry/off', {method: 'POST', body: {}, headers})).effective, 'off');
});

// ---- The same, end to end on a running app --------------------------------------------------------------------------

test('on a running app: telemetry.set is refused over HTTP ops, telemetry.off works and lowers the level for every later request', async t => {
  const x = await telemetryApp(t, {level: 'on', region: 'US'});
  const post = (path, body = {}, headers = {}) => fetch(x.app.origin + path, {method: 'POST', headers: {'x-faravan-session-token': x.app.token, 'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
  assert.equal(x.tel.status().effective, 'on');
  const set = await post('/api/ops/telemetry.set', {level: 'on'}, {'faravan-surface': 'mcp'});
  assert.ok([403, 404].includes(set.status), `telemetry.set over ops answered ${set.status}`);
  const off = await post('/api/ops/telemetry.off', {}, {'faravan-surface': 'mcp'});
  assert.equal(off.status, 200);
  assert.equal(x.tel.status().effective, 'off');
  assert.equal((await api(x.app, '/api/telemetry')).effective, 'off');
  const again = await post('/api/ops/telemetry.status', {}, {'faravan-surface': 'cli', 'faravan-telemetry': 'off'});
  assert.equal(again.status, 200);
  assert.equal(x.tel.status().effective, 'off', 'a request header cannot turn anything back on');
});
