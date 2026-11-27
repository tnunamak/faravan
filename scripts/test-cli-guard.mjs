// Test-only tripwire, not a sandbox for untrusted code. Keep developer CLIs out of tests.
// External scripts/native grandchildren and Workers that replace both execArgv and env
// can lose the preload; their process launches are outside this tripwire's coverage.
import cp from 'node:child_process';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

export const CLI_NAMES = ['claude', 'codex', 'sbx', 'docker', 'security'];
const preload = fileURLToPath(import.meta.url);
const tests = resolve(dirname(preload), '../tests');
const tempRoots = [...new Set([tmpdir(), '/tmp', '/var/tmp', '/dev/shm'])];
const inside = (file, dir) => {
  const rel = relative(dir, file);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
function canonical(path) { try { return realpathSync(path); } catch { return resolve(path); } }

function resolveExecutable(command, options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ? fileURLPath(options.cwd) : process.cwd();
  const candidates = command.includes('/') ? [resolve(cwd, command)]
    : (env.PATH ?? '/usr/bin:/bin').split(delimiter).map(dir => resolve(cwd, dir, command));
  const found = candidates.find(file => {
    try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
  });
  return found ? canonical(found) : null;
}

export function checkCommand(command, options = {}) {
  if (command instanceof URL) command = fileURLToPath(command);
  if (typeof command !== 'string') return;
  // Resolve even unprotected requested names: an alias can point to a protected CLI.
  const file = resolveExecutable(command, options);
  // A missing executable cannot reach a real CLI; preserve the OS's ENOENT.
  if (!file) return;
  const name = [basename(command), basename(file)].find(name => CLI_NAMES.includes(name));
  if (!name) return;
  const denied = process.env.TEST_CLI_GUARD_DENY_DIR;
  const allowed = [process.env.TEST_CLI_FAKE_DIR, tests, ...tempRoots].filter(Boolean);
  if ((denied && inside(file, canonical(denied))) || !allowed.some(dir => inside(file, canonical(dir)))) {
    throw new Error(`TEST_CLI_GUARD: blocked real CLI: ${name} (${file})`);
  }
}
function fileURLPath(value) { return value instanceof URL ? fileURLToPath(value) : value; }

// Inspect shell words, including quoted absolute paths and commands after pipes/semicolons.
// These are the shell forms used by the suite. This is deliberately conservative:
// a protected CLI mentioned as a shell argument is checked too.
export function checkShell(script, options = {}) {
  const words = String(script).match(/(?:[^\s;|&()<>"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const env = { ...(options.env ?? process.env) };
  for (const raw of words) {
    const word = raw.replace(/["']/g, '').replace(/\\(.)/g, '$1');
    const expand = value => value.replace(/\$\{([A-Za-z_][A-Za-z_0-9]*)\}|\$([A-Za-z_][A-Za-z_0-9]*)/g,
      (_, braced, plain) => env[braced ?? plain] ?? '').replace(/^~\//, `${env.HOME ?? ''}/`);
    const assignment = word.match(/^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/s);
    if (assignment) env[assignment[1]] = expand(assignment[2]);
    else {
      const expanded = expand(word);
      if (!CLI_NAMES.includes(basename(expanded))) {
        checkCommand(expanded, { ...options, env });
        continue;
      }
      // Do not interpret cd or shell scope. Only bare names found through an
      // absolute PATH prefix in the runner's fake directory are independent of cwd.
      const absolutePrefix = [];
      for (const dir of (env.PATH ?? '/usr/bin:/bin').split(delimiter)) {
        if (!isAbsolute(dir)) break;
        absolutePrefix.push(dir);
      }
      const file = !expanded.includes('/') && absolutePrefix.length
        ? resolveExecutable(expanded, { ...options, env: { ...env, PATH: absolutePrefix.join(delimiter) } }) : null;
      const fakeDir = env.TEST_CLI_FAKE_DIR ?? process.env.TEST_CLI_FAKE_DIR;
      const denied = process.env.TEST_CLI_GUARD_DENY_DIR;
      if (!file || !fakeDir || !inside(file, canonical(fakeDir)) || (denied && inside(file, canonical(denied)))) {
        throw new Error(`TEST_CLI_GUARD: blocked real CLI: ${basename(expanded)} (shell command: ${expanded})`);
      }
    }
  }
}

const originals = Object.fromEntries(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'].map(name => [name, cp[name]]));
for (const [name, original] of Object.entries(originals)) {
  const wrapped = function(command, ...rest) {
    const optionsIndex = rest.findIndex(value => value && typeof value === 'object' && !Array.isArray(value));
    const supplied = optionsIndex < 0 ? {} : rest[optionsIndex];
    const env = { ...(supplied.env ?? process.env) };
    if (env.PATH === undefined) env.PATH = `${process.env.TEST_CLI_FAKE_DIR ?? ''}:/usr/bin:/bin`;
    const options = { ...supplied, env };
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    if (name === 'exec' || name === 'execSync' || options.shell) checkShell([command, ...args].join(' '), options);
    else {
      checkCommand(command, options);
      if (name === 'fork') checkCommand(options.execPath ?? process.execPath, options);
      if (['sh', 'bash', 'dash', 'zsh'].includes(basename(String(command)))) {
        const index = args.findIndex(arg => /^-[^-]*c/.test(arg));
        if (index >= 0) checkShell(args[index + 1], options);
      }
    }
    // Carry the tripwire through Node children even when tests supply a clean env.
    const flag = `--import=${JSON.stringify(preload)}`;
    if (!(env.NODE_OPTIONS ?? '').includes(preload)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} ${flag}`.trim();
    for (const key of ['TEST_CLI_FAKE_DIR', 'TEST_CLI_GUARD_DENY_DIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const nextOptions = { ...options, env };
    if (optionsIndex >= 0) rest[optionsIndex] = nextOptions;
    else rest.splice(Array.isArray(rest[0]) ? 1 : 0, 0, nextOptions);
    return original.call(this, command, ...rest);
  };
  // Preserve promisify(exec/execFile)'s {stdout, stderr} result contract.
  const custom = Symbol.for('nodejs.util.promisify.custom');
  if (original[custom]) wrapped[custom] = (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = wrapped(...args, (error, stdout, stderr) => {
        if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
        else resolve({ stdout, stderr });
      });
    });
    promise.child = child;
    return promise;
  };
  cp[name] = wrapped;
}
syncBuiltinESMExports();
