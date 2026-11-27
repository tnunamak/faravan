// CLI surface of the operation registry:
//   faravan <group> <verb> [ARGS] [--field value ...] [--input JSON|@file|-] [--yes] [--idempotency-key KEY] [--json]
//   faravan ops list|describe <id>|call <id>|openapi
// Commands that existed before the registry (faravan status, doctor, lending log, app, uninstall, job ..., circle ...)
// keep their own behaviour; a group verb is routed here only when it names an operation.
import { readFile } from 'node:fs/promises';
import { OPS, OPS_VERSION, opById, SURFACE_NAME, needsConfirmation, mayNeedConfirmation } from './registry.mjs';
import { createOpsClient, opError, problemOf, exitCodeFor, EXIT, appMayAuthorize } from './execute.mjs';
import { summary, describe, openApiDocument } from './http.mjs';
import { configHome } from '../../local-state.mjs';
import { validate } from './schema.mjs';
import { sendsJob, resolveJobRecipient } from '../job-recipient.mjs';
import { announceTelemetry } from '../telemetry/cli.mjs';

// Top-level commands that predate the registry. `faravan <legacy>` with no operation verb stays theirs.
const LEGACY = new Set(['app','circle','join','stop','lending','job','mcp','run','apply','uninstall','name','status','doctor','open-link','open-setup','update','host','help']);
const cliGroup = group => group.replaceAll('_', '-');
const GROUPS = new Map(OPS.map(op => op.id.split('.')[0]).map(group => [cliGroup(group), group]));
const kebab = name => name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replaceAll('_', '-').toLowerCase();

/** Where `faravan argv...` goes: null (an older command), the ops tool, a group listing, or one operation. */
export function opsRoute(argv) {
  const [first, verb] = argv;
  if (first === 'ops') return {kind:'ops'};
  const group = GROUPS.get(first);
  if (!group) return null;
  if (!verb || verb.startsWith('-')) return LEGACY.has(first) ? null : {kind:'group', group};
  if (first === 'lending' && verb === 'log') return null; // the original command prints the same entries
  for (let end = argv.length; end > 1; end--) {
    const name = argv.slice(1, end).map(part => part.replaceAll('-', '_')).join('.');
    const op = opById(group + '.' + name);
    if (op) return {kind:'op', op, rest:argv.slice(end)};
  }
  return LEGACY.has(first) ? null : {kind:'group', group, unknown:verb};
}

/** Positional arguments: the route's path parameters, else the operation's declared cli.args. */
export function positionals(op) {
  if (op.cli?.args) return op.cli.args;
  return op.rest ? [...op.rest.path.matchAll(/\{(\w+)\}/g)].map(m => m[1]) : [];
}
const typesOf = schema => schema?.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
function coerce(name, schema, raw) {
  const types = typesOf(schema);
  if (raw === 'null' && types.includes('null')) return null;
  if (types.includes('boolean') && !types.includes('string')) {
    if (raw === true || raw === 'true') return true;
    if (raw === false || raw === 'false') return false;
    throw usage('--' + kebab(name) + ' is true or false.');
  }
  if (raw === true || raw === false) throw usage('--' + kebab(name) + ' needs a value.');
  if ((types.includes('integer') || types.includes('number')) && !types.includes('string')) {
    const value = Number(raw);
    if (!Number.isFinite(value)) throw usage('--' + kebab(name) + ' must be a number.');
    return value;
  }
  if ((types.includes('object') || types.includes('array')) && !types.includes('string')) {
    try { return JSON.parse(raw); } catch { throw usage('--' + kebab(name) + ' must be JSON.'); }
  }
  return raw;
}
const usage = message => opError('invalid_request',400,message);

async function readInput(value, stdin) {
  if (value === '-') { let text = ''; for await (const chunk of stdin) text += chunk; return JSON.parse(text || '{}'); }
  if (value.startsWith('@')) return JSON.parse(await readFile(value.slice(1), 'utf8'));
  return JSON.parse(value);
}

/** Parse operation arguments into {input, flags}. Unknown flags are an error: no silent drop. */
export async function parseOpArgs(op, args, {stdin = process.stdin} = {}) {
  const props = op.input.properties ?? {}, byFlag = new Map();
  for (const name of Object.keys(props)) { byFlag.set(kebab(name), name); byFlag.set(name, name); }
  const flags = {json:false, yes:false, help:false, follow:false, idempotencyKey:undefined};
  let input = {};
  const fields = {}, positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { flags.json = true; continue; }
    if (arg === '--yes' || arg === '-y') { flags.yes = true; continue; }
    if (arg === '--help' || arg === '-h') { flags.help = true; continue; }
    if (arg === '--follow' && op.cli?.follow) { flags.follow = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    let [flag, inline] = arg.slice(2).split(/=(.*)/s);
    if (flag === 'input' || flag === 'idempotency-key') {
      const value = inline ?? args[++i];
      if (value === undefined) throw usage('--' + flag + ' needs a value.');
      if (flag === 'input') {
        try { input = await readInput(value, stdin); } catch { throw usage('--input must be JSON, @file or - (stdin).'); }
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw usage('--input must be a JSON object.');
      } else flags.idempotencyKey = value;
      continue;
    }
    let negated = false;
    // --no-x only for a true/false field: on a number it would silently mean 0.
    if (!byFlag.has(flag) && flag.startsWith('no-') && byFlag.has(flag.slice(3))) {
      const types = typesOf(props[byFlag.get(flag.slice(3))]);
      if (!types.includes('boolean') || types.includes('string')) throw usage('--' + flag + ' is not an option: --' + flag.slice(3) + ' is not true/false.');
      flag = flag.slice(3); negated = true;
    }
    const name = byFlag.get(flag);
    if (!name) throw usage('Unknown option --' + flag + '. Run ' + SURFACE_NAME.cli(op) + ' --help.');
    const isBool = typesOf(props[name]).includes('boolean') && !typesOf(props[name]).includes('string');
    let raw = negated ? false : inline;
    if (raw === undefined) raw = isBool && (args[i + 1] === undefined || args[i + 1].startsWith('--') || !['true','false'].includes(args[i + 1])) ? true : args[++i];
    if (raw === undefined) throw usage('--' + flag + ' needs a value.');
    fields[name] = coerce(name, props[name], raw);
  }
  const names = positionals(op);
  if (positional.length > names.length) throw usage('Too many arguments. Run ' + SURFACE_NAME.cli(op) + ' --help.');
  positional.forEach((value, index) => { fields[names[index]] = coerce(names[index], props[names[index]], value); });
  return {input:{...input, ...fields}, flags};
}

export function opHelp(op) {
  const props = op.input.properties ?? {}, required = new Set(op.input.required ?? []), names = positionals(op);
  const lines = [op.title + '. ' + op.description, '',
    'Usage: ' + SURFACE_NAME.cli(op) + names.map(n => ' ' + n.toUpperCase()).join('') + ' [options]', ''];
  const options = Object.entries(props).filter(([name]) => !names.includes(name)).map(([name, schema]) => {
    const types = typesOf(schema), bool = types.includes('boolean') && !types.includes('string');
    const kind = schema.enum ? schema.enum.filter(v => v !== null).join('|') : bool ? '' : types.includes('object') || types.includes('array') ? 'JSON' : types.includes('integer') || types.includes('number') ? 'N' : 'TEXT';
    return '  --' + kebab(name) + (kind ? ' ' + kind : '') + (required.has(name) ? '  (required)' : '') + (schema.description ? '  ' + schema.description : '');
  });
  if (options.length) lines.push('Options:', ...options);
  lines.push('  --input JSON|@file|-  The whole input as JSON (flags override its fields).',
    ...(mayNeedConfirmation(op) ? ['  --yes  Confirm' + (op.safety === 'consequential' ? '' : ' (needed for some inputs)') + ': ' + op.title] : []),
    ...(op.safety !== 'read' ? ['  --idempotency-key KEY  A retry with the same key and input returns the first answer.'] : []),
    ...(op.cli?.follow ? ['  --follow  Keep printing new events as JSON lines until interrupted.'] : []),
    '  --json  Print the result as one JSON value.', '',
    'Safety: ' + op.safety + '. Same operation: HTTP POST /api/ops/' + op.id + ', MCP tool ' + SURFACE_NAME.mcp(op) + '.',
    ...(op.cli?.legacy ? ['Also: ' + op.cli.legacy] : []),
    'Exit codes: 0 ok, 1 failed, 2 invalid input, 3 not found, 4 refused or conflict, 5 still running or timed out, 6 needs --yes, 7 app not running, 8 only a person can do this.');
  return lines.join('\n') + '\n';
}
function groupHelp(group) {
  const ops = OPS.filter(op => op.id.startsWith(group + '.'));
  return ops.map(op => '  ' + SURFACE_NAME.cli(op).padEnd(40) + op.title + (op.safety === 'consequential' ? ' (needs --yes)' : '')).join('\n') + '\n';
}

async function confirmAtTerminal(op, input, {stdin, stderr}) {
  if (!stdin.isTTY) return false;
  stderr.write((op.confirm?.(input) ?? op.title) + '\nGo ahead? [y/N] ');
  const {createInterface} = await import('node:readline');
  const rl = createInterface({input:stdin, terminal:false});
  const answer = await new Promise(done => { rl.once('line', done); rl.once('close', () => done('')); });
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Run `faravan ...` for a route from opsRoute(). Returns the exit code. */
export async function runOpsCommand(argv, options = {}) {
  const stdout = options.stdout ?? process.stdout, stderr = options.stderr ?? process.stderr, stdin = options.stdin ?? process.stdin;
  const route = options.route ?? opsRoute(argv);
  const json = argv.includes('--json');
  const client = options.client ?? createOpsClient({home:options.home ?? configHome(), env:options.env, surface:'cli'});
  const fail = error => {
    const problem = problemOf(error);
    if (route.op?.id === 'lending.on' && problem.code === 'timeout')
      problem.message = 'Lending has not confirmed yet. Run faravan lending get to check it.';
    if (json) stdout.write(JSON.stringify(problem) + '\n');
    else stderr.write('faravan: ' + problem.message + (problem.effect && problem.code === 'confirmation_required' ? '\nRun again with --yes to go ahead.' : '') + (problem.detail ? '\nReason: ' + problem.detail : '') + '\n');
    return exitCodeFor(error);
  };
  try {
    if (route.kind === 'group') {
      if (route.unknown) { stderr.write('faravan: ' + cliGroup(route.group) + ' has no command ' + JSON.stringify(route.unknown) + '. Commands:\n' + groupHelp(route.group)); return EXIT.invalid; }
      stdout.write(groupHelp(route.group)); return EXIT.ok;
    }
    if (route.kind === 'ops') return await runOpsTool(argv.slice(1), {stdout, stderr, stdin, client, json, fail});
    const code = await runOne(route.op, route.rest, {stdout, stderr, stdin, client, fail});
    // The first-run notice goes to people, not to the telemetry command that answers it.
    // Neither reading offline startup status nor quitting may restart the app
    // through an incidental notice request while its discovery record changes.
    if (!route.op.id.startsWith('telemetry.') && !['status.get','app.quit'].includes(route.op.id))
      await announceTelemetry({client, home:options.home ?? configHome(), env:options.env ?? process.env, stderr});
    return code;
  } catch (error) { return fail(error); }
}

async function runOne(op, args, {stdout, stderr, stdin, client, fail}) {
  const {input:parsed, flags} = await parseOpArgs(op, args, {stdin});
  let input=parsed, consentOp=op;
  if (flags.help) { stdout.write(opHelp(op)); return EXIT.ok; }
  validate(op.input, input);
  if (sendsJob(op.id)) {
    const prepared=resolveJobRecipient(input,await client.call('circles.list',{}));
    input=prepared.input; consentOp={...op,confirm:() => op.confirm({...input,circle:prepared.circle.name??prepared.circle.id})};
  }
  if (op.safety === 'human') {
    stderr.write('faravan: ' + op.description + '\n');
    return EXIT.human_only;
  }
  let confirmed = flags.yes;
  const progress = flags.json ? undefined : message => stderr.write('faravan: ' + message + '\n');
  if (appMayAuthorize(op.id) && !confirmed) {
    try {
      const result=await client.call(op.id,input,{confirmed:false,idempotencyKey:flags.idempotencyKey,progress});
      stdout.write(JSON.stringify(result,null,flags.json?undefined:2)+'\n');
      return op.long&&result?.done===false?EXIT.timeout:EXIT.ok;
    } catch(error) {
      if(error.code!=='confirmation_required')throw error;
      if(error.confirmation_input)input={...input,...error.confirmation_input};
      if(error.effect)consentOp={...op,confirm:()=>error.effect};
    }
  }
  if (needsConfirmation(op, input) && !confirmed) confirmed = await confirmAtTerminal(consentOp, input, {stdin, stderr});
  if (needsConfirmation(op, input) && !confirmed)
    return fail(opError('confirmation_required',428,(consentOp.confirm?.(input) ?? op.title) + ' Run again with --yes to go ahead.', {effect:consentOp.confirm?.(input) ?? op.title,
      ...(sendsJob(op.id)?{confirmation_input:{circle:input.circle,expected_circle_id:input.expected_circle_id,...(input.expected_default_circle?{expected_default_circle:input.expected_default_circle}:{})}}:{})}));
  if (input.expected_circle_id) resolveJobRecipient(input,await client.call('circles.list',{}));
  if (flags.follow) return follow(op, input, {stdout, client});
  const result = await client.call(op.id, input, {confirmed, idempotencyKey:flags.idempotencyKey, progress});
  stdout.write(flags.json ? JSON.stringify(result) + '\n' : JSON.stringify(result, null, 2) + '\n');
  return op.long && result && result.done === false ? EXIT.timeout : EXIT.ok;
}

// `faravan events list --follow`: one JSON line per event, as they happen (NDJSON).
async function follow(op, input, {stdout, client}) {
  let after = input.after ?? 0;
  for (;;) {
    const page = await client.call(op.id, {...input, after, wait_seconds:30});
    for (const event of page.events) stdout.write(JSON.stringify(event) + '\n');
    after = page.next_after;
  }
}

async function runOpsTool(args, {stdout, stderr, stdin, client, json, fail}) {
  const [verb, id, ...rest] = args;
  if (verb === 'list' || verb === undefined) {
    const group = args.includes('--group') ? args[args.indexOf('--group') + 1] : null;
    const ops = OPS.filter(op => !group || op.id.startsWith(group + '.')).map(summary);
    if (json) stdout.write(JSON.stringify({version:OPS_VERSION, ops}) + '\n');
    else stdout.write(ops.map(o => o.id.padEnd(28) + o.safety.padEnd(14) + o.title).join('\n') + '\n');
    return EXIT.ok;
  }
  if (verb === 'openapi') { stdout.write(JSON.stringify(openApiDocument(), null, 2) + '\n'); return EXIT.ok; }
  if (verb === 'describe' || verb === 'call') {
    const op = opById(id ?? '');
    if (!op) return fail(opError('unknown_operation',404,'There is no operation ' + JSON.stringify(id ?? '') + '. Run faravan ops list.'));
    if (verb === 'describe') {
      stdout.write(json ? JSON.stringify(describe(op)) + '\n' : opHelp(op));
      return EXIT.ok;
    }
    return runOne(op, rest, {stdout, stderr, stdin, client, fail});
  }
  stderr.write('Usage: faravan ops list [--group GROUP] | describe ID | call ID [--input JSON|@file|-] [--yes] [--json] | openapi\n');
  return EXIT.invalid;
}
