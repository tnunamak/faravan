// HTTP surface of the operation registry, served by the app beside its REST routes:
//   GET  /api/ops              the operations (id, title, safety, idempotency, CLI, MCP and REST names)
//   GET  /api/ops/<id>         one operation with its input and output JSON Schemas
//   POST /api/ops/<id>         run it: JSON body = input. Headers: Faravan-Confirm: yes (consequential operations),
//                              Idempotency-Key (writes; a repeat with the same key and input replays the first answer)
//   GET  /api/openapi.json     OpenAPI 3.1 for the operations and the REST routes they are bound to
// Operations bound to a REST route call that route on this same loopback server, so both paths run the same code.
import { OPS, OPS_VERSION, opById, SURFACE_NAME } from './registry.mjs';
import { runOp, appRequest, problemOf, discoverApp, opError } from './execute.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { OUTCOMES } from '../outcome.mjs';
import { forwardedHeaders } from '../telemetry/switch.mjs';
export {scopeOf,clientHeaders} from '../telemetry/switch.mjs';

const MAX_BODY = 28 * 1024 * 1024;
const KEY_TTL_MS = 24 * 3600 * 1000, MAX_KEYS = 500;

export function summary(op) {
  return {id:op.id, title:op.title, safety:op.safety, idempotency:op.idempotency, long:op.long === true,
    cli:op.safety === 'human' ? op.cli?.legacy ?? null : SURFACE_NAME.cli(op), mcp:op.safety === 'human' ? null : SURFACE_NAME.mcp(op),
    http:op.safety === 'human' ? null : SURFACE_NAME.http(op), rest:op.rest ? op.rest.method + ' ' + op.rest.path : null};
}
export function describe(op) {
  return {...summary(op), description:op.description, input:op.input, output:op.output, untrusted:op.untrusted === true,
    ...(op.cli?.legacy ? {legacy_cli:op.cli.legacy} : {}), ...(op.mcp?.legacy ? {legacy_mcp:op.mcp.legacy} : {}), ...(op.mcp?.resource ? {mcp_resource:op.mcp.resource} : {})};
}

async function readJson(req, maxBytes = MAX_BODY) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) throw opError('invalid_content_type', 415, 'Send a JSON body.');
  let length = 0; const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > maxBytes) throw opError('payload_too_large', 413); chunks.push(chunk); }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw opError('invalid_request', 400, 'The body is not JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw opError('invalid_request', 400, 'The body must be a JSON object (the operation input).');
  return value;
}

/**
 * createOpsHttp({home, token, origin, backendFactory}) → handle(req, res, parts): true when it answered.
 * `origin` is a function: the server's port is known only after listen.
 */
export function createOpsHttp({home, coordinatorHome, token, origin, backendFactory, kappaForUsage, importLocalHistory,
  beforeSupportPreview, hostingLaunchApprovals, confirmationPolicy, strict = process.env.FARAVAN_OPS_STRICT === '1', onResponse = () => {}}) {
  const keys = new Map();
  const dispatches = new Map();
  const self = () => ({origin:origin(), token});
  // The inner REST call forwards the caller's surface and telemetry switch, so the occurrence it makes carries them.
  const restWith = (forward, principal) => async (method, path, request = {}) => {
    const dispatch = randomUUID();
    dispatches.set(dispatch, principal ?? {});
    try {return await appRequest(self(), method, path, {...request, headers:{...forward, ...request.headers,'faravan-operation-dispatch':'1','faravan-private-dispatch':dispatch}});}
    finally {dispatches.delete(dispatch);}
  };
  const rest = restWith({});
  const context = extra => ({home, coordinatorHome, rest, backendFactory, kappaForUsage, importLocalHistory, beforeSupportPreview, confirmationPolicy, strict, discover:() => discoverApp(home), startApp:async () => self(),
    call:(id, input, more = {}) => runOp(id, input, context({...extra, idempotencyKey:undefined, ...(more.signal ? {signal:more.signal} : {})})), ...extra});
  // Keep every answer for the promised 24 hours, and in-flight writes until they settle. At capacity refuse new
  // keys before starting work; evicting an unexpired answer could let a retry run a write twice.
  function remember(id, key, hash, promise) {
    const now = Date.now();
    for (const [k, v] of keys) if (now - v.at > KEY_TTL_MS && v.settled) keys.delete(k);
    if (keys.size >= MAX_KEYS) throw opError('idempotency_busy', 503, 'The idempotency cache is full. Existing keys can still be retried; new keys must wait for an answer to expire.');
    const entry = {hash, promise, at:now, settled:false};
    const cacheKey=id + '\0' + key;
    promise.then(outcome => {
      entry.settled = true; entry.at = Date.now();
      // Keep the input digest even when an unknown result can be retried, so the key
      // cannot be reused with a different job while the original outcome is unresolved.
      entry.retryableUnknown = outcome?.body?.outcome === 'unknown';
      entry.confirmationRequired = outcome?.status === 428 && outcome.body?.code === 'confirmation_required';
    });
    keys.set(cacheKey, entry);
  }
  const handle = async function(req, res, parts, principal = {}) {
    if (parts[0] !== 'api' || !(parts[1] === 'ops' || (parts[1] === 'openapi.json' && parts.length === 2))) return false;
    // Private native bootstrap: neither request ID nor reviewed facts reach the public operation observer.
    if (parts.length === 4 && parts[1] === 'ops' && parts[2] === 'hosting-launch' && parts[3] === 'consume') {
      const reply = (status, value) => {
        res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify(value));
        return true;
      };
      if (req.method !== 'POST' || principal.native !== true || principal.localBrowserOwner === true || !hostingLaunchApprovals)
        return reply(404,{code:'not_found'});
      try {
        const input = await readJson(req, 1024);
        if (Object.keys(input).length !== 1 || !Object.hasOwn(input, 'id')) return reply(400,{code:'invalid_request'});
        const tuple = hostingLaunchApprovals.consume(input.id);
        return tuple ? reply(200,tuple) : reply(404,{code:'not_found'});
      } catch (error) {
        return reply(statusOf(error),{code:problemOf(error).code});
      }
    }
    // The response observer for this writer. A failure rebuilt from the inner REST response (fromRest) was already
    // counted there; here it only counts as use of the operation.
    const began = Date.now();
    let fromRest = false, opId = null;
    const send = (value, status = 200, headers = {}) => {
      if (res.headersSent) return true;
      res.writeHead(status, {'Content-Type':'application/json', 'Faravan-Ops-Version':String(OPS_VERSION), ...headers});
      res.end(JSON.stringify(value));
      try{onResponse({req, status, body:value, opId:req.method==='POST'?opId:null, fromRest, durationMs:Date.now() - began});}catch{/* observation cannot change an operation */}
      return true;
    };
    const forward = forwardedHeaders(req.headers);
    try {
      if (parts[1] === 'openapi.json') return req.method === 'GET' ? send(openApiDocument()) : send({code:'not_found', message:'API endpoint not found.'}, 404);
      if (parts.length === 2) return req.method === 'GET' ? send({version:OPS_VERSION, ops:OPS.map(summary)}) : send({code:'not_found', message:'API endpoint not found.'}, 404);
      const op = parts.length === 3 ? opById(parts[2]) : null;
      opId = op?.id ?? null;
      if (!op) return send({code:'unknown_operation', message:'There is no such operation. GET /api/ops lists them.'}, 404);
      if (req.method === 'GET') return send(describe(op));
      if (req.method !== 'POST') return send({code:'not_found', message:'API endpoint not found.'}, 404);
      if (op.safety === 'human') throw opError('human_only', 403, op.description);
      const input = await readJson(req);
      const confirmed = /^(yes|true|1)$/i.test(req.headers['faravan-confirm'] ?? '');
      const key = req.headers['idempotency-key'];
      const runHere = async extra => {
        const ctx = context({confirmed, principal, rest:restWith(forward, {...principal, confirmed}), ...extra});
        if (op.id !== 'hosting.start' || !confirmed || principal.localBrowserOwner !== true || principal.native === true || !hostingLaunchApprovals)
          return runOp(op.id,input,ctx);
        // This is only on the top-level handler's context. ctx.call() rebuilds an
        // ordinary context, and no grant survives return from this handler.
        let running = true;
        const launch = (tuple, start) => {
          if (!running) throw opError('not_found',404);
          return hostingLaunchApprovals.withHostingLaunchApproval(tuple,start);
        };
        try { return await runOp(op.id,input,{...ctx,withHostingLaunchApproval:launch}); }
        finally { running = false; }
      };
      if (key !== undefined && (typeof key !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(key))) throw opError('invalid_request', 400, 'Idempotency-Key must be 1-255 visible characters.');
      if (!key || op.safety === 'read') {
        // An unkeyed call stops when its caller hangs up (a long wait, say); a keyed one runs on so a retry can replay it.
        const gone = new AbortController();
        res.once('close', () => { if (!res.writableFinished) gone.abort(); });
        return send(await runHere({signal:gone.signal}), 200, {'Faravan-Op':op.id});
      }
      const run = () => runHere({idempotencyKey:key});
      const hash = createHash('sha256').update(JSON.stringify(input) + (confirmed ? '\0confirmed' : '')).digest('hex');
      const prior = keys.get(op.id + '\0' + key);
      if (prior && (!prior.settled || Date.now() - prior.at <= KEY_TTL_MS)) {
        // A confirmation refusal did no work. Re-evaluate the same input after
        // confirmation or a saved permission change; changed input still cannot reuse the key.
        const consentRetry=prior.confirmationRequired&&(prior.hash===hash||prior.hash===createHash('sha256').update(JSON.stringify(input)).digest('hex'));
        if (prior.hash !== hash&&!consentRetry) throw opError('idempotency_key_reused', 409, 'This Idempotency-Key was used with a different input.');
        if (prior.retryableUnknown||consentRetry) keys.delete(op.id + '\0' + key);
        else {
          const outcome = await prior.promise;
          fromRest = outcome.fromRest === true;
          return send(outcome.body, outcome.status, {'Faravan-Op':op.id, 'Idempotent-Replayed':'true'});
        }
      }
      // Remember the outcome, success or failure, so a retry after a lost response never runs it twice.
      let start;
      const promise = new Promise(resolve => { start = resolve; }).then(run).then(body => ({status:200, body}), error => ({status:statusOf(error), body:problemOf(error), fromRest:error?.fromRest === true}));
      remember(op.id, key, hash, promise);
      start();
      const outcome = await promise;
      fromRest = outcome.fromRest === true;
      return send(outcome.body, outcome.status, {'Faravan-Op':op.id});
    } catch (error) {
      fromRest = error?.fromRest === true;
      return send(problemOf(error), statusOf(error));
    }
  };
  handle.principalFor = req => dispatches.get(req.headers['faravan-private-dispatch']) ?? null;
  return handle;
}
const statusOf = error => Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status :
  error?.code === 'invalid_request' ? 400 : error?.code === 'not_found' ? 404 : 500;

// ---- OpenAPI ----------------------------------------------------------------------------------------------

const PROBLEM = {$ref:'#/components/schemas/Problem'};
const errors = {default:{description:'A problem: {code, message}. code is stable; message is for people.', content:{'application/json':{schema:PROBLEM}}}};
/** Strip registry-only keywords so the document is plain JSON Schema 2020-12. */
function clean(schema) {
  if (Array.isArray(schema)) return schema.map(clean);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'x-local-path').map(([key, value]) => [key, clean(value)]));
}
const ext = op => ({'x-faravan-safety':op.safety, 'x-faravan-idempotency':op.idempotency, ...(op.long ? {'x-faravan-long-running':true} : {}),
  ...(op.untrusted ? {'x-faravan-untrusted-output':true} : {}), 'x-faravan-cli':SURFACE_NAME.cli(op), 'x-faravan-mcp':SURFACE_NAME.mcp(op)});

export function openApiDocument() {
  const paths = {
    '/api/ops':{get:{operationId:'ops.list', summary:'List operations', tags:['ops'], responses:{200:{description:'Operations', content:{'application/json':{schema:{type:'object'}}}}, ...errors}}},
    '/api/openapi.json':{get:{operationId:'ops.openapi', summary:'This document', tags:['ops'], responses:{200:{description:'OpenAPI 3.1', content:{'application/json':{schema:{type:'object'}}}}}}},
  };
  for (const op of OPS) {
    if (op.safety === 'human') continue;
    const group = op.id.split('.')[0];
    paths['/api/ops/' + op.id] = {post:{operationId:op.id, summary:op.title, description:op.description, tags:[group], ...ext(op),
      parameters:[
        {name:'Faravan-Confirm', in:'header', required:op.safety === 'consequential', schema:{type:'string', enum:['yes']},
          description:op.safety === 'consequential' ? 'Required: the person confirmed this. Without it the answer is 428 confirmation_required with the effect.' :
            op.consequentialIf ? 'Required for some inputs (see the description); without it those answer 428 confirmation_required.' : 'Not needed for this operation.'},
        ...(op.safety === 'read' ? [] : [{name:'Idempotency-Key', in:'header', required:false, schema:{type:'string', maxLength:255},
          description:'A repeat with the same key and input within 24 hours returns the first answer (Idempotent-Replayed: true).'}])],
      requestBody:{required:true, content:{'application/json':{schema:clean(op.input)}}},
      responses:{200:{description:'The result', content:{'application/json':{schema:clean(op.output)}}}, ...errors}}};
    if (!op.rest) continue;
    // The REST route the operation is bound to (used by the web UI); same input fields, same result.
    const route = op.rest.path, method = op.rest.method.toLowerCase();
    const inPath = [...op.rest.path.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
    const props = op.input.properties ?? {}, required = op.input.required ?? [];
    const others = Object.keys(props).filter(key => !inPath.includes(key));
    const fixed = Object.keys(op.rest.fixed ?? {});
    const entry = {operationId:op.id + '.rest', summary:op.title + ' (REST route)', description:'Bound to operation ' + op.id + '. ' + op.description, tags:[group], ...ext(op),
      parameters:[...inPath.map(name => ({name, in:'path', required:true, schema:clean(props[name])})),
        ...(method === 'get' || method === 'delete' ? others.map(name => ({name, in:'query', required:required.includes(name), schema:clean(props[name])})) : [])],
      ...(method === 'post' ? {requestBody:{required:true, content:{'application/json':{schema:clean({...op.input,
        properties:{...Object.fromEntries(others.map(key => [key, props[key]])), ...Object.fromEntries(fixed.map(key => [key, {const:op.rest.fixed[key]}]))},
        required:[...required.filter(key => others.includes(key)), ...fixed]})}}}} : {}),
      responses:{200:{description:'The result', content:{'application/json':{schema:clean(op.output)}}}, ...errors}};
    // The operation only revokes; the local window uses this REST route to set either value.
    if(op.id==='circles.set_agent_borrowing'){
      entry.summary='Set the saved agent permission';
      entry.description='Enable from the local browser session, or disable from any authenticated caller. This records owner intent for agents that follow the rules; it does not protect against programs running as the same OS user.';
      entry.requestBody.content['application/json'].schema.properties.enabled={type:'boolean'};
    }
    paths[route] ??= {};
    // Two operations may share a route (jobs.apply_preview and jobs.apply differ in a fixed field): list both.
    if (paths[route][method]) (paths[route][method]['x-faravan-also'] ??= []).push(op.id);
    else paths[route][method] = entry;
  }
  return {openapi:'3.1.0', jsonSchemaDialect:'https://json-schema.org/draft/2020-12/schema',
    info:{title:'Faravan local app API', version:String(OPS_VERSION),
      description:'Generated from lib/v1/ops/registry.mjs; do not edit by hand (npm run gen:ops). The app listens on 127.0.0.1 only. ' +
        'Authenticate with the session token from <FARAVAN_HOME>/v1/app.json in x-faravan-session-token (legacy clients may use x-faravan-session-token). See docs/agents.md.'},
    servers:[{url:'http://127.0.0.1:{port}', variables:{port:{default:'0', description:'The port in <FARAVAN_HOME>/v1/app.json.'}}}],
    security:[{session:[]}],
    components:{securitySchemes:{session:{type:'apiKey', in:'header', name:'x-faravan-session-token'}},
      schemas:{Problem:{type:'object', required:['code','message'], properties:{code:{type:'string'}, message:{type:'string'}, effect:{type:'string'}, field:{type:['string','null']},
        outcome:{type:'string',enum:[...OUTCOMES]},operationKey:{type:'string',maxLength:128},
        jobDigest:{type:'string',description:'With outcome unknown on a job send: the saved job. Follow it; do not send again.'}}, additionalProperties:true}}},
    paths};
}
