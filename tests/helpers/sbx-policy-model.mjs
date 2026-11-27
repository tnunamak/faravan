// A stateful model of sbx 0.48's network policy commands, written from live observation (2026-10-19), not from
// Faravan's own matcher: a sandbox sees the GLOBAL allow rules plus its own rules; a deny that matches beats an
// allow that matches; a rule with no port covers every port and `check` assumes 443; `**.x` matches any subdomain
// of x but not x; `*.x` one label; a deny that is the same resource as an allow in the same sandbox is refused
// ("conflicts with existing allow rule"); `check` exits 1 when it denies. Stubs that ignore installed rules cannot
// catch a job that inherits an allowance, so every sandbox-path test should run against this.
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';

const REAL_GLOBAL = JSON.parse(readFileSync(new URL('../fixtures/sbx-0.48-global-policy.json', import.meta.url), 'utf8')).rules;
export const SBX_GLOBAL_RULES = REAL_GLOBAL;

const splitPort = resource => {
  const at = resource.lastIndexOf(':');
  return resource.includes('/') || (resource.match(/:/g) || []).length > 1 || at < 0 || !/^\d+$/.test(resource.slice(at + 1))
    ? [resource.toLowerCase(), null] : [resource.slice(0, at).toLowerCase(), resource.slice(at + 1)];
};
const ipv4 = text => /^\d+\.\d+\.\d+\.\d+$/.test(text) ? text.split('.').reduce((n, part) => n * 256 + Number(part), 0) : null;
function matches(resource, host, port) {
  const [pattern, resourcePort] = splitPort(resource);
  if (resourcePort !== null && resourcePort !== String(port)) return false;
  if (pattern.includes('/') && !pattern.includes(':')) {
    const [base, bits] = pattern.split('/'), a = ipv4(base), b = ipv4(host);
    if (a === null || b === null) return false;
    const size = 2 ** (32 - Number(bits));
    return Math.floor(a / size) === Math.floor(b / size);
  }
  if (pattern.startsWith('**.')) return host.endsWith(pattern.slice(2)) && host.length > pattern.length - 2;
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && !host.slice(0, -(pattern.length - 1)).includes('.') && host.length > pattern.length - 1;
  if (pattern.includes('*')) return new RegExp('^' + pattern.replaceAll('.', '\\.').replaceAll('*', '[^.]*') + '$').test(host);
  return pattern === host;
}

// kitManaged: sbx 0.50 and later refuse `policy rm` on a kit rule; it is recreated at sandbox create. A deny of the
// same resource as a kit allow is accepted and wins (observed live on sbx 0.50.0, 2026-10-29).
export function createSbxPolicy({ globalRules = SBX_GLOBAL_RULES, statePath = null, kitManaged = false } = {}) {
  let state = { globalRules: structuredClone(globalRules), sandboxes: {}, seq: 0 };
  const log = [];
  const load = () => { if (statePath && existsSync(statePath)) state = JSON.parse(readFileSync(statePath, 'utf8')); };
  const save = () => { if (!statePath) return; writeFileSync(statePath + '.tmp' + process.pid, JSON.stringify(state)); renameSync(statePath + '.tmp' + process.pid, statePath); };
  const rulesOf = name => state.sandboxes[name] ?? (state.sandboxes[name] = []);
  const ok = stdout => ({ code: 0, stdout, stderr: '' });
  const fail = stderr => ({ code: 1, stdout: '', stderr });

  function decide(sandbox, target) {
    const [host, explicit] = splitPort(target.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
    const port = explicit ?? (/^https:/.test(target) ? 443 : 443);
    const all = [...state.globalRules, ...rulesOf(sandbox).map(rule => ({ ...rule, applies_to: 'sandbox:' + sandbox }))];
    const hit = decision => all.some(rule => rule.status === 'active' && rule.decision === decision && rule.resources.some(item => matches(item, host, port)));
    return !hit('deny') && hit('allow');
  }
  function add(decision, sandbox, resources) {
    if (!state.sandboxes[sandbox] && !sandbox) return fail('sandbox required');
    const clash = resources.find(item => rulesOf(sandbox).some(rule => rule.decision !== decision && rule.resources.includes(item)
      && !(kitManaged && rule.id.startsWith('kit-'))));
    if (clash) return fail(`error: ${decision} network rule: ${JSON.stringify(clash)} conflicts with existing rule`);
    rulesOf(sandbox).push({ id: 'rule-' + (++state.seq), scope: 'sandbox:' + sandbox, applies_to: 'sandbox:' + sandbox, resource_type: 'network',
      decision, resources, status: 'active', origin: 'local', layer: 'local' });
    return ok('');
  }
  const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };

  return {
    log, get state() { load(); return state; },
    /** A sandbox exists: its kit's own allowances are scoped rules, as `sbx run` creates them. */
    createSandbox(name, { kitAllow = [], denyNetwork = [] } = {}) {
      load();
      const rules = rulesOf(name);
      if (kitAllow.length) rules.push({ id: 'kit-' + (++state.seq), scope: 'sandbox:' + name, applies_to: 'sandbox:' + name, resource_type: 'network',
        decision: 'allow', resources: [...kitAllow], status: 'active', origin: 'local', layer: 'local' });
      for (const resource of denyNetwork) add('deny', name, [resource]);
      save();
    },
    removeSandbox(name) { load(); delete state.sandboxes[name]; save(); },
    /** The effective answer, for assertions that do not go through the CLI. */
    allowed(sandbox, target) { load(); return decide(sandbox, target); },
    /** Handle one sbx invocation: a result for `policy ...`, null for anything else. */
    run(args) {
      if (args[0] !== 'policy') return null;
      load();
      log.push([...args]);
      const sandbox = flag(args, '--sandbox');
      let result;
      if ((args[1] === 'deny' || args[1] === 'allow') && args[2] === 'network') {
        const resources = args.at(-1).split(',');
        result = sandbox ? add(args[1], sandbox, resources) : fail('global rules are not modelled');
      } else if (args[1] === 'rm' && args[2] === 'network') {
        const rules = rulesOf(sandbox), id = flag(args, '--id'), resource = flag(args, '--resource');
        const managed = kitManaged && rules.find(rule => rule.id === id && rule.id.startsWith('kit-'));
        if (managed) return fail(`error: remove network rule: rule ${id} is managed by a kit and is recreated at sandbox create; it cannot be removed with "policy rm"`);
        const before = rules.length;
        state.sandboxes[sandbox] = rules.filter(rule => !(id ? rule.id === id : resource.split(',').some(item => rule.resources.includes(item))));
        result = state.sandboxes[sandbox].length < before ? ok('') : fail('error: no such rule');
      } else if (args[1] === 'ls') {
        const name = args[2] && !args[2].startsWith('-') ? args[2] : null;
        result = ok(JSON.stringify({ rules: [...state.globalRules, ...(name ? rulesOf(name) : [])] }));
      } else if (args[1] === 'check' && args[2] === 'network') {
        const allowed = decide(sandbox, args.at(-1));
        result = { code: allowed ? 0 : 1, stdout: JSON.stringify({ allowed, target: args.at(-1) }), stderr: '' };
      } else result = ok('');
      // Only writes touch the state file: stubs run as parallel processes, and a read must never see a half-written file.
      if (args[1] === 'deny' || args[1] === 'allow' || args[1] === 'rm') save();
      return result;
    },
  };
}

/** A runCommand for DockerSbxBackend: policy commands go to the model, everything else to `other`. */
export function sbxRunner(model, other = () => ({ code: 0, stdout: '', stderr: '' }), { kitAllow = ['api.anthropic.com:443'],
  secretResult = { code: 0, stdout: '{"secrets":[],"custom_secrets":[],"shadowed_services":[],"env_only_count":0}', stderr: '' } } = {}) {
  const calls = [];
  const run = async (args, options) => {
    calls.push([...args]);
    if (args.join(' ') === 'secret ls --json') return secretResult;
    if (args[0] === 'settings') return { code: 0, stdout: args.join(' ') === 'settings get ssh.agentForwardingEnabled' ? 'false' : '', stderr: '' };
    if (args[0] === 'run' || args[0] === 'create') {
      const denyNetwork = args.flatMap((arg, i) => arg === '--deny-network' ? [args[i + 1]] : []);
      model.createSandbox(args[args.indexOf('--name') + 1], { kitAllow, denyNetwork });
    }
    if (args[0] === 'rm') model.removeSandbox(args.at(-1));
    const response=model.run(args) ?? await other(args, options);
    if(args[0]==='ls'&&response.code===0&&response.stdout==='')return {...response,stdout:JSON.stringify(Object.keys(model.state.sandboxes).map(name=>({name,status:'running'})))};
    return response;
  };
  return { run, calls };
}

/** What `sbx run codex` scopes to its sandbox (sbx 0.48, read live 2026-10-19). */
export const CODEX_KIT_ALLOW = ['api.openai.com:443', 'openai.com:443', 'auth.openai.com:443', 'chatgpt.com:443', 'files.openai.com:443',
  'registry.npmjs.org:443', 'releases.openai.com:443', 'api.github.com:443', 'github.com:443', 'release-assets.githubusercontent.com:443',
  'codeload.github.com:443', 'archive.ubuntu.com:80', 'security.ubuntu.com:80', 'ports.ubuntu.com:80', 'download.docker.com:443'];
export const CLAUDE_KIT_ALLOW = ['api.anthropic.com:443', 'platform.claude.com:443', 'downloads.claude.ai:443', 'claude.com:443',
  'code.claude.com:443', 'mcp-proxy.anthropic.com:443', 'bridge.claudeusercontent.com:443'];
