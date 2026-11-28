import './helpers/no-browser.mjs';
// Parity: every operation is reachable on the CLI, over HTTP and over MCP with the same input contract, and every
// app route the docs describe or the web UI calls is an operation. A new route, UI call or operation that skips a
// surface fails here, by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { OPS, opById, SURFACE_NAME, mayNeedConfirmation, offeredOnMcp } from '../lib/v1/ops/registry.mjs';
import { openApiDocument } from '../lib/v1/ops/http.mjs';
import { restRequest } from '../lib/v1/ops/execute.mjs';
import { opsRoute, parseOpArgs, positionals } from '../lib/v1/ops/cli.mjs';
import { validate } from '../lib/v1/ops/schema.mjs';
import { statusLabel, statusMessage } from '../lib/v1/cli.mjs';
import { formatJobProjection } from '../ui/v1/src/job-projection-view.mjs';
import { selectTools, MCP_INSTRUCTIONS, instructionsForTools } from '../lib/v1/mcp.mjs';
import { REMOTE_READS, remoteSupported, localApprovalRequired } from '../lib/v1/chatgpt-policy.mjs';
import { generated } from '../scripts/gen-ops-docs.mjs';

const root = new URL('../', import.meta.url);
const stripLocal = value => JSON.parse(JSON.stringify(value, (key, v) => key === 'x-local-path' ? undefined : v));
const kebab = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-').toLowerCase();
const toolsByName = new Map(selectTools().map(tool => [tool.name, tool]));

test('every operation has a CLI command, an HTTP operation and an MCP tool; human-only ones only the CLI', () => {
  const paths = openApiDocument().paths, missing = [];
  for (const op of OPS) {
    const human = op.safety === 'human';
    const route = opsRoute(SURFACE_NAME.cli(op).split(' ').slice(1));
    if (human) {
      if (!op.cli?.legacy) missing.push(op.id + ': human-only operation without its CLI command');
      if (toolsByName.has(SURFACE_NAME.mcp(op))) missing.push(op.id + ': human-only operation offered over MCP');
      if (paths['/api/ops/' + op.id]) missing.push(op.id + ': human-only operation offered over HTTP');
      continue;
    }
    // `faravan lending log` predates the registry and prints the same entries: its own command is the exposure.
    const legacySame = route === null && op.cli?.legacy === SURFACE_NAME.cli(op);
    if (!legacySame && (route?.kind !== 'op' || route.op !== op)) missing.push(op.id + ': ' + SURFACE_NAME.cli(op) + ' does not reach it');
    if (!paths['/api/ops/' + op.id]?.post) missing.push(op.id + ': no POST /api/ops/' + op.id + ' in the OpenAPI document');
    if (offeredOnMcp(op)) {
      if (!toolsByName.has(SURFACE_NAME.mcp(op))) missing.push(op.id + ': no MCP tool ' + SURFACE_NAME.mcp(op));
    } else {
      // Excluded on purpose: the registry gives the reason (mcp.excluded), and the tool must not be offered.
      if (!op.mcp?.excluded?.trim()) missing.push(op.id + ': excluded from MCP without a reason');
      if (toolsByName.has(SURFACE_NAME.mcp(op))) missing.push(op.id + ': excluded from MCP but offered as a tool');
    }
  }
  assert.deepEqual(missing, []);
});

test('multi-segment operation commands route fully and lending log stays legacy', () => {
  const op = opById('lending.history.import');
  const route = opsRoute(['lending','history','import','--yes']);
  assert.equal(route?.kind, 'op');
  assert.equal(route?.op, op);
  assert.deepEqual(route?.rest, ['--yes']);
  assert.equal(opsRoute(['lending','log']), null);
});

test('MCP tool input schemas are the registry input schemas (plus confirm where confirmation can be needed)', () => {
  for (const op of OPS.filter(offeredOnMcp)) {
    const tool = toolsByName.get(SURFACE_NAME.mcp(op)), expected = stripLocal(op.input);
    if (mayNeedConfirmation(op)) {
      assert.equal(tool.inputSchema.properties.confirm?.type, 'boolean', op.id);
      expected.properties = {...expected.properties, confirm:tool.inputSchema.properties.confirm};
    }
    assert.deepEqual(stripLocal(tool.inputSchema), expected, op.id + ': MCP input drifted from the registry');
    assert.equal(tool.annotations.readOnlyHint, op.safety === 'read', op.id);
    assert.equal(tool.annotations.destructiveHint, op.safety === 'consequential', op.id);
  }
});

test('HTTP operation input and output schemas match the registry for the full operation surface', () => {
  const paths = openApiDocument().paths;
  for (const op of OPS.filter(o => o.safety !== 'human')) {
    const operation = paths['/api/ops/' + op.id]?.post;
    assert.ok(operation, op.id + ': no operation HTTP endpoint');
    assert.deepEqual(stripLocal(operation.requestBody.content['application/json'].schema), stripLocal(op.input), op.id + ': HTTP input drifted');
    assert.deepEqual(stripLocal(operation.responses['200'].content['application/json'].schema), stripLocal(op.output), op.id + ': HTTP output drifted');
  }
});

test('jobs.submit follow-up input has one contract across CLI, MCP, and operation HTTP', async () => {
  const op = opById('jobs.submit');
  const followup = {parentJob:'sha256:' + 'a'.repeat(64), parentResult:'sha256:' + 'b'.repeat(64)};
  const input = {circle:'Friends', prompt:'Continue this result', followup};
  validate(op.input, input);

  const cli = await parseOpArgs(op, ['--followup', JSON.stringify(followup)]);
  assert.deepEqual(cli.input.followup, followup);
  assert.deepEqual(toolsByName.get(SURFACE_NAME.mcp(op)).inputSchema.properties.followup, op.input.properties.followup);
  const http = openApiDocument().paths['/api/ops/jobs.submit'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(http.properties.followup, op.input.properties.followup);
  assert.deepEqual(restRequest(op, input), {method:'POST', path:'/api/jobs', body:input});
  const boundRoute = openApiDocument().paths['/api/jobs'].post.requestBody.content['application/json'].schema;
  assert.deepEqual(boundRoute.properties.followup, op.input.properties.followup);
});

test('running status matches the shared UI job projection', () => {
  const job = {state:'claimed', current_attempt:{state:'active', execution_started_at:'2026-10-23T15:52:00Z',execution_observed_at:'2026-10-23T15:52:09Z'}};
  const ui = formatJobProjection(job);
  assert.equal(ui.projection.phase, 'running');
  assert.equal(ui.key, 'working');
  assert.equal(statusLabel(job), 'Working');
  assert.equal(statusLabel({jobProjection:ui.projection}), 'Working');
});

test('a lender-requested stop has one Stopping label on the shared CLI and transport projection',()=>{
  const jobDigest='sha256:'+'a'.repeat(64),attemptId='attempt-1',generation=2;
  const job={job_digest:jobDigest,state:'claimed',current_attempt:{attempt_id:attemptId,generation,state:'active',execution_started_at:'2026-10-23T15:52:00Z',execution_observed_at:'2026-10-23T15:52:09Z'},
    stopRequest:{job_digest:jobDigest,attempt_id:attemptId,generation,requested_at:'2026-10-23T15:53:09Z'}};
  const ui=formatJobProjection(job);
  assert.equal(ui.projection.phase,'stopping');
  assert.equal(statusLabel(job),'Stopping');
  assert.equal(statusLabel({jobProjection:ui.projection}),'Stopping');
  assert.equal(statusMessage(job),'Stopping. The running computer has not confirmed it stopped. Check again shortly.');
});

test('MCP folder browsing permits the same plain parent folders as the folder API', () => {
  assert.equal(opById('folders.list').input.properties.path['x-local-path'], 'folder');
});

test('remote read tools are declared on their registry operations', () => {
  const ids = OPS.filter(op => op.remote?.access === 'read').map(op => op.id).sort();
  assert.deepEqual(ids, ['circles.check','circles.compose','circles.presence','circles.preview_join']);
  for (const id of ids) {
    assert.equal(opById(id).safety,'read',id);
    assert.equal(REMOTE_READS.has(id),true,id);
    assert.equal(remoteSupported(id),true,id);
    assert.equal(localApprovalRequired(id),false,id);
  }
});

test('MCP instructions are generated from each selected tool list', () => {
  for (const toolsets of [['all'], ['borrow'], ['lend'], ['meta'], ['jobs'], ['status']]) {
    const tools = selectTools({toolsets}), names = new Set(tools.map(tool => tool.name));
    const instructions = instructionsForTools(tools);
    for (const name of ['ops_describe', 'status_blockers', 'jobs_send_and_wait']) {
      assert.equal(instructions.includes(name), names.has(name), toolsets.join(',') + ': ' + name + ' instruction/list mismatch');
    }
  }
  assert.equal(MCP_INSTRUCTIONS, instructionsForTools(selectTools()));
  assert.equal(selectTools().some(tool => tool.name === 'ops_describe'), false,
    'the all preset keeps operation tools under the context budget; metadata tools use the explicit meta preset');
  assert.ok(selectTools({toolsets:['meta']}).some(tool => tool.name === 'ops_describe'),
    'the meta preset exposes the described metadata tool');
});

const sample = schema => {
  const types = schema.type === undefined ? ['string'] : [].concat(schema.type);
  if (schema.enum) return String(schema.enum.find(v => v !== null));
  if (types.includes('boolean') && !types.includes('string')) return 'true';
  if (types.includes('integer') || types.includes('number')) return String(schema.minimum ?? 1);
  if (types.includes('object')) return '{}';
  if (types.includes('array')) return '[]';
  return 'value';
};
test('every input field has a CLI flag (and path parameters are positional arguments)', async () => {
  for (const op of OPS.filter(o => o.safety !== 'human')) {
    for (const [name, schema] of Object.entries(op.input.properties ?? {})) {
      const {input} = await parseOpArgs(op, ['--' + kebab(name), sample(schema)]);
      assert.ok(Object.hasOwn(input, name), op.id + ': --' + kebab(name) + ' does not set ' + name);
    }
    for (const name of positionals(op)) assert.ok((op.input.required ?? []).includes(name), op.id + ': positional ' + name + ' is required input');
  }
});

// ---- Routes: the documented app API and the web UI

const normalize = path => path.replace(/[?].*$/, '').replace(/\/+$/, '').split('/').filter(Boolean)
  .map(segment => /^[:{]|\{\}/.test(segment) ? '{}' : segment).join('/');
const BOUND = [
  ...OPS.filter(op => op.rest).map(op => ({method:op.rest.method, path:normalize(op.rest.path.replace(/^\/api/, '')), op:op.id})),
  ...OPS.filter(op => op.safety !== 'human').map(op => ({method:'POST', path:'ops/' + op.id, op:op.id})),
];
const matches = (method, path) => BOUND.some(route => {
  if (route.method !== method) return false;
  const a = route.path.split('/'), b = path.split('/');
  return a.length === b.length && a.every((segment, i) => segment === b[i] || segment === '{}' || b[i] === '{}');
});
// Transport plumbing with no operation of its own, each with the operation an agent uses instead.
const PLUMBING = new Map([
  ['POST profile-migration', 'Dismiss the browser-only profile move notice'],
  ['GET home', 'status.get (same view)'], ['GET activity', 'events.list'], ['GET events', 'events.list (SSE stream for the web UI)'],
  ['GET jobs/{}/changed-files', 'jobs.result (changed-file ZIP download for the browser)'],
  ['GET jobs/{}/result', 'jobs.result (binary download for the browser)'],
  ['GET jobs/{}/message', 'jobs.changes (Markdown download for the browser)'],
  ['GET jobs/{}/file', 'jobs.result (individual output download for the browser)'],
  ['GET jobs/{}/image', 'jobs.changes (image preview for the browser)'],
  ['GET telemetry/bootstrap', 'telemetry.status (browser-only consent and install-ID hand-off for the in-page PostHog client)'],
  ['POST desktop/tray', 'tray-only report'], ['POST desktop/pin-prompt', 'Windows pin prompt, UI-only'],
]);

test('every route the app API documents is an operation or named plumbing', async () => {
  const text = await readFile(new URL('docs/protocol/app-api.md', root), 'utf8'), missing = [];
  for (const [, method, raw] of text.matchAll(/\b(GET|POST|DELETE) (\/api\/[^\s,;)`]+)/g)) {
    // Prose notation: a field (/api/status.update), alternatives (/api/lending/on|resume), a family (/api/desktop/*),
    // or a placeholder (<agent>).
    const base = raw.replace(/^\/api/, '').replace(/[.:]$/, '').replace(/^(\/[a-z-]+)\.[a-z_]+$/, '$1').replace(/<[^>]+>/g, ':x');
    const [head, ...alternatives] = base.split('|');
    for (const variant of [head, ...alternatives.map(alt => head.replace(/[^/]+$/, alt))]) {
      const path = normalize(variant);
      if (path.endsWith('*')) { if (!BOUND.some(r => r.method === method && r.path.startsWith(path.slice(0, -1))) && ![...PLUMBING.keys()].some(k => k.startsWith(method + ' ' + path.slice(0, -1)))) missing.push(method + ' /api/' + path); continue; }
      // A bare family name in prose ("POST /api/signin returns ...") is covered when an operation sits under it.
      if (!matches(method, path) && !PLUMBING.has(method + ' ' + path) && !BOUND.some(r => r.method === method && r.path.startsWith(path + '/'))) missing.push(method + ' /api/' + path);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'add an operation to lib/v1/ops/registry.mjs (or name it in PLUMBING)');
});

// A literal suffix selected by a condition is two concrete routes, not a wildcard route.
function routeAlternatives(expr) {
  const branch=expr.match(/\(\s*[^?:()]*\?\s*'([^'\n]*)'\s*:\s*'([^'\n]*)'\s*\)/);
  return branch ? [branch[1],branch[2]].flatMap(value=>routeAlternatives(expr.replace(branch[0],()=>"'"+value+"'"))) : [expr];
}

/** The API calls in the web UI source, as {method, path} with {} for computed segments. */
async function uiCalls() {
  const dir = new URL('ui/v1/src/', root), calls = [];
  for (const name of (await readdir(dir)).filter(n => /\.(mjs|jsx)$/.test(n) && !n.includes('.test.'))) {
    const source = await readFile(new URL(name, dir), 'utf8');
    const vars = new Map();
    for (const [, id, expr] of source.matchAll(/\b(base)\s*=\s*('[^'\n]*'(?:\s*\+[^,;\n]*)?)/g)) vars.set(id, expr);
    const pathOf = expr => expr.split('+').map(part => part.trim()).map(part => {
      if (/^'[^']*'$/.test(part)) return part.slice(1, -1);
      if (vars.has(part)) return pathOf(vars.get(part));
      return '{}';
    }).join('');
    const firstArg = rest => { let depth = 0, i = 0; for (; i < rest.length; i++) { const c = rest[i];
      if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) { if (!depth) break; depth--; } else if (c === ',' && !depth) break; } return rest.slice(0, i); };
    for (const match of source.matchAll(/\b(api\.get|api\.post|api\.download|api\.request|mutate|useResource\(api,)\s*\(?/g)) {
      const rest = source.slice(match.index + match[0].length), rawArg = firstArg(rest), arg = rawArg.trim();
      if (!arg.startsWith("'")) continue; // a pass-through wrapper (api.post(path, body)): its callers are scanned
      // request() forwards its explicit method; hosting.stop also needs its confirmation headers.
      const explicit = match[1] === 'api.request' && rest.slice(rawArg.length).match(/^\s*,\s*\{\s*method\s*:\s*['"](GET|POST|DELETE)['"]/);
      const method = explicit ? explicit[1] : ['api.post','mutate'].includes(match[1]) ? 'POST' : 'GET';
      for(const choice of routeAlternatives(arg)) {
        const path = normalize(pathOf(choice).replace(/([a-z])\{\}$/, '$1'));
        calls.push({method, path, where:name});
      }
    }
    const resources = source.match(/const resources = \[([^\]]*)\]/);
    if (resources) for (const [, path] of resources[1].matchAll(/'([^']+)'/g)) calls.push({method:'GET', path, where:name});
  }
  return calls;
}

test('every API call in the web UI is an operation or named plumbing (no UI-only capability)', async () => {
  assert.equal(matches('POST','ops/hosting.stop'),true);
  assert.equal(matches('GET','ops/hosting.stop'),false);
  assert.equal(matches('POST','ops/not.registered'),false);
  const calls = await uiCalls();
  for(const suffix of ['accept','decline'])assert.ok(calls.some(call=>call.where==='request.jsx'&&call.path==='approvals/{}/'+suffix),'approval '+suffix+' is checked independently');
  assert.ok(calls.length > 40, 'the UI scan found its calls (' + calls.length + ')');
  const missing = calls.filter(c => !matches(c.method, c.path) && !PLUMBING.has(c.method + ' ' + c.path) && !/^\{\}/.test(c.path));
  assert.deepEqual(missing.map(c => c.method + ' /api/' + c.path + ' (' + c.where + ')'), []);
});

test('the parity matrix in docs/design/AGENT-INTERFACES.md and docs/protocol/app-openapi.json are current', async () => {
  const next = await generated();
  assert.equal(await readFile(new URL('docs/design/AGENT-INTERFACES.md', root), 'utf8'), next.design, 'run npm run gen:ops');
  assert.equal(await readFile(new URL('docs/protocol/app-openapi.json', root), 'utf8'), next.openapi, 'run npm run gen:ops');
});

test('MCP tool lists stay within their size budget', () => {
  const size = options => Buffer.byteLength(JSON.stringify(selectTools(options).map(({_op, ...tool}) => tool)));
  // About 14.5k tokens; Claude Code defers MCP tools behind tool search, other clients load them all. The three
  // telemetry tools (status, off, preview) add 739 bytes to the list, which passes 64 KiB; the budget was 66.25 KiB, including lending readiness.
  // signin.start's method choice (device or browser) adds 55 bytes, and the shortest schema still needs 66.5 KiB; the same budget is in tests/v1-auto-run-surfaces.test.mjs.
  // Agent borrowing adds one permission operation and three scoped-consent descriptions.
  assert.ok(size({toolsets:['all']}) <= 68 * 1024, 'all: ' + size({toolsets:['all']}) + ' bytes');
  assert.ok(size({toolsets:['meta']}) <= 2 * 1024, 'meta: ' + size({toolsets:['meta']}) + ' bytes');
  assert.ok(size({toolsets:['lend']}) < size({toolsets:['all']}));
  assert.ok(selectTools({readOnly:true}).every(tool => tool.annotations.readOnlyHint === true));
  for (const op of OPS.filter(o => o.mcp?.resource)) assert.equal(op.safety, 'read', op.id + ' is a resource, so it must only read');
  assert.equal(opById('uninstall.run').safety, 'human');
});

// The strategies and the dial are discoverable on every surface: an agent on the CLI, over HTTP or over MCP reads the same choices.
test('lending.strategies is on the CLI, over HTTP and over MCP, and only reads', () => {
  const op = opById('lending.strategies');
  const route = opsRoute(SURFACE_NAME.cli(op).split(' ').slice(1));
  assert.equal(route?.kind, 'op');
  assert.equal(route.op, op);
  assert.ok(openApiDocument().paths['/api/ops/lending.strategies']?.post, 'an HTTP operation');
  const tool = toolsByName.get(SURFACE_NAME.mcp(op));
  assert.ok(tool, 'an MCP tool');
  assert.equal(tool.annotations.readOnlyHint, true);
});

test('local log learning read/set share REST and agent contracts without an import prompt', () => {
  const get=opById('lending.history.settings.get'), set=opById('lending.history.settings.set');
  assert.equal(get.rest.method,'GET');
  assert.equal(set.rest.method,'POST');
  assert.equal(get.rest.path,'/api/lending/history-learning');
  assert.equal(set.rest.path,get.rest.path);
  assert.deepEqual(set.input.required,['enabled']);
  assert.equal(set.input.properties.enabled.type,'boolean');
  assert.equal(mayNeedConfirmation(set),false);
  for(const op of [get,set]) {
    assert.equal(opsRoute(SURFACE_NAME.cli(op).split(' ').slice(1))?.op,op);
    assert.ok(toolsByName.has(SURFACE_NAME.mcp(op)));
    assert.ok(openApiDocument().paths['/api/ops/'+op.id]?.post);
  }
});

test('local learning controller fences Off and detects new completed meter periods', async () => {
  // Isolated lifecycle test: execute the exact controller block with explicit injected
  // adapters. It neither loads app dependencies nor reads any session directory.
  const {createContext,runInContext}=await import('node:vm');
  const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    let historyLearningEnabled='),source.indexOf('    const histories=new Map();'));
  assert.ok(block.includes('const checkCompletedHistory='));
  const events=[],consents=[],adapter={meterPeriods:[],deleteImportedHistory(){events.push('delete');}};
  let release,pending=false;
  const gate=new Promise(resolve=>{release=resolve;});
  const settings={limits:{lendingPolicy:{accountPlans:{}}}};
  const context={settings,options:{historyAdapter:()=>adapter},meterLedger:{},now:()=>1,closed:false,
    savedKappas:[],kappaUnknown:null,kappaFile:'/tmp/synthetic-controller-only/kappa.json',durableJsonAsync:async()=>{},
    home:'/tmp/synthetic-controller-only',certifiedKappa:()=>null,createLocalLendingHistoryAdapter:()=>adapter,
    directory:'/tmp/synthetic-controller-only',localLogRoots:()=>[],measurementFor:()=>null,
    lendingProbe:{funding:()=>null},identityPins:{peek:()=>null},
    createLentKappaStore:()=>({current:()=>null,record:()=>false,clear(){}}),join:(...parts)=>parts.join('/'),
    createLogAttributionStore:()=>({update:()=>({roots:[],providers:{}}),current:()=>null,clear:()=>events.push('forget')}),
    setImmediate:()=>{},saveThenApply:async patch=>{Object.assign(settings,patch);events.push('save');},
    importOwnerLendingHistory:async input=>{consents.push(input.consent);events.push('read');if(pending)await gate;
      if(input.shouldContinue())events.push('commit');return {};}};
  createContext(context);
  runInContext(block+'\nglobalThis.controller={importLocalHistory,setHistoryLearning,checkCompletedHistory};',context);
  const controller=context.controller;
  await controller.checkCompletedHistory();await controller.checkCompletedHistory();
  assert.deepEqual(events,['read','commit']);
  adapter.currentWindows=[{account:'claude',resource:'claude:weekly',account_week_id:20,observed_at:15,meter_points:2}];
  await controller.checkCompletedHistory();await controller.checkCompletedHistory();
  assert.deepEqual(events,['read','commit','read','commit']);
  adapter.meterPeriods=[{account:'claude',resource:'claude:weekly',account_week_id:10,meter_points:3}];
  await controller.checkCompletedHistory();
  assert.deepEqual(events,['read','commit','read','commit','read','commit']);
  pending=true;
  const importing=controller.importLocalHistory();await Promise.resolve();
  const stopping=controller.setHistoryLearning(false);release();await importing;await stopping;
  const afterOff=events.slice();await controller.importLocalHistory();await controller.checkCompletedHistory();
  assert.deepEqual(events,afterOff);
  assert.deepEqual(events.slice(-4),['read','save','delete','forget']);
  assert.equal(settings.learnFromLocalAgentLogs,false);
  // Property: the automatic triggers never prompt. Every read the controller makes carries consent.
  assert.equal(consents.length,events.filter(event=>event==='read').length);
  assert.deepEqual([...new Set(consents)],[true]);
});

test('an unreadable kappa estimates file is never replaced by an import', async () => {
  const {createContext,runInContext}=await import('node:vm');
  const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    let historyLearningEnabled='),source.indexOf('    const histories=new Map();'));
  const writes=[],adapter={meterPeriods:[],deleteImportedHistory(){}};
  class StateUnknownError extends Error{code='state_unknown';}
  const settings={limits:{lendingPolicy:{accountPlans:{}}}};
  const context={settings,options:{historyAdapter:()=>adapter},meterLedger:{},now:()=>1,closed:false,
    savedKappas:[],kappaUnknown:new Error('unreadable'),StateUnknownError,kappaFile:'/tmp/synthetic-controller-only/kappa.json',
    durableJsonAsync:async(file)=>{writes.push(file);},home:'/tmp/synthetic-controller-only',certifiedKappa:()=>null,
    createLocalLendingHistoryAdapter:()=>adapter,directory:'/tmp/synthetic-controller-only',localLogRoots:()=>[],
    measurementFor:()=>null,lendingProbe:{funding:()=>null},identityPins:{peek:()=>null},
    createLentKappaStore:()=>({current:()=>null,record:()=>false,clear(){}}),join:(...parts)=>parts.join('/'),
    createLogAttributionStore:()=>({update:()=>({roots:[],providers:{}}),current:()=>null,clear(){}}),
    setImmediate:()=>{},saveThenApply:async()=>{},importOwnerLendingHistory:async()=>({})};
  createContext(context);
  runInContext(block+'\nglobalThis.controller={importLocalHistory};',context);
  await assert.rejects(context.controller.importLocalHistory(),{code:'state_unknown'});
  assert.deepEqual(writes,[]);
});

test('Learning Off succeeds with an unreadable lending-history file: the bytes are moved aside and the clears run', async () => {
  // Real history adapter over a real corrupt file. Off is the owner's request to forget learned data, so it must not
  // refuse because the file cannot be read.
  const {createContext,runInContext}=await import('node:vm');
  const {mkdtemp,mkdir,writeFile,readdir,rm}=await import('node:fs/promises');
  const {existsSync,renameSync}=await import('node:fs');
  const {syncDirectory}=await import('../lib/durable-write.mjs');
  const {tmpdir}=await import('node:os');
  const {join,dirname}=await import('node:path');
  const {createLocalLendingHistoryAdapter}=await import('../lib/v1/lending-history-import.mjs');
  const source=await readFile(new URL('../lib/v1/app.mjs',import.meta.url),'utf8');
  const block=source.slice(source.indexOf('    let historyLearningEnabled='),source.indexOf('    const histories=new Map();'));
  const home=await mkdtemp(join(tmpdir(),'learning-off-'));
  await mkdir(join(home,'v1'));
  const historyFile=join(home,'v1','lending-history-claude.json');
  await writeFile(historyFile,'{broken');
  const kappaFile=join(home,'v1','lending-kappa-estimates.json');
  const events=[],writes=[];
  const settings={learnFromLocalAgentLogs:true,limits:{lendingPolicy:{accountPlans:{}}}};
  const context={settings,options:{},meterLedger:{entries:()=>[]},now:()=>1,closed:false,
    savedKappas:[],kappaUnknown:null,kappaFile,home,directory:home,
    durableJsonAsync:async(file,data)=>{writes.push([file,data]);},certifiedKappa:()=>null,
    createLocalLendingHistoryAdapter,localLogRoots:()=>[],measurementFor:()=>null,
    lendingProbe:{funding:()=>null},identityPins:{peek:()=>null},
    createLentKappaStore:()=>({current:()=>null,record:()=>false,clear(){}}),join:(...parts)=>join(...parts),dirname,existsSync,renameSync,syncDirectory,
    createLogAttributionStore:()=>({update:()=>({roots:[],providers:{}}),current:()=>null,clear:()=>events.push('forget')}),
    setImmediate:()=>{},saveThenApply:async patch=>{Object.assign(settings,patch);events.push('save');},
    importOwnerLendingHistory:async()=>({})};
  createContext(context);
  runInContext(block+'\nglobalThis.controller={setHistoryLearning};',context);
  try{
    await context.controller.setHistoryLearning(false);
    assert.equal(settings.learnFromLocalAgentLogs,false);
    // The unreadable bytes are kept beside the original, byte for byte, never erased.
    const kept=(await readdir(join(home,'v1'))).filter(name=>name.startsWith('lending-history-claude.json.unreadable-'));
    assert.equal(kept.length,1);
    assert.ok((await readFile(join(home,'v1',kept[0]))).equals(Buffer.from('{broken')));
    // The original path is rebuilt as an empty store (Off writes empty stores, as it does for an absent file).
    const rebuilt=JSON.parse(await readFile(historyFile,'utf8'));
    assert.deepEqual([rebuilt.bootstrap,rebuilt.usageSamples],[[],[]]);
    // The block runs in a vm realm, so compare the cleared list by length rather than deepEqual (prototype check).
    assert.equal(writes.length,1);assert.equal(writes[0][0],kappaFile);
    assert.ok(Array.isArray(writes[0][1]), 'cleared estimates remain an array across VM realms');
    assert.equal(writes[0][1].length,0);
    assert.deepEqual(events,['save','forget']);
  } finally {
    await rm(home,{recursive:true,force:true});
  }
});

test('limits.set retires preview presence without removing real presence or idle/stop controls', () => {
  const op = opById('limits.set');
  assert.ok(op);
  const paths = openApiDocument().paths;
  const schemas = [
    op.input,
    toolsByName.get(SURFACE_NAME.mcp(op)).inputSchema,
    paths['/api/ops/limits.set'].post.requestBody.content['application/json'].schema,
    paths['/api/lending/limits'].post.requestBody.content['application/json'].schema,
  ];
  for (const schema of schemas) {
    assert.equal(Object.hasOwn(schema.properties, 'presence'), false);
    assert.equal(schema.properties.idleOnly.type, 'boolean');
    assert.equal(schema.properties.lendingPolicy.properties.stopOnReturn.type, 'boolean');
  }
  assert.throws(() => validate(op.input, {presence:'legacy-preview'}));
  validate(op.input, {idleOnly:true, lendingPolicy:{stopOnReturn:true}});
  for (const id of ['circles.presence']) {
    const real = opById(id);
    assert.ok(real, id);
    assert.ok(paths['/api/ops/' + id]?.post, id);
    assert.ok(toolsByName.has(SURFACE_NAME.mcp(real)), id);
  }
});

test('the permission operation is disable-only while REST documents the local window toggle',async()=>{
  const {openApiDocument}=await import('../lib/v1/ops/http.mjs');
  const paths=openApiDocument().paths;
  const schema=path=>paths[path].post.requestBody.content['application/json'].schema;
  assert.deepEqual(schema('/api/ops/circles.set_agent_borrowing').properties.enabled.enum,[false]);
  assert.equal(schema('/api/ops/circles.set_agent_borrowing').properties.confirm,undefined);
  assert.equal(schema('/api/circles/{circle}/agent-borrowing').properties.enabled.enum,undefined);
  assert.match(paths['/api/circles/{circle}/agent-borrowing'].post.description,/local browser session/);
});
