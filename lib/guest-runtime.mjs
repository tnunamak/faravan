import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, mkdir, copyFile, chmod, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from './harnesses/job-framing.mjs';

import { RUNTIME_HELP } from './v1/lending-status-copy.mjs';
export { RUNTIME_HELP };
export const runtimeError = () => Object.assign(new Error(RUNTIME_HELP), { code: 'guard_runtime_unavailable' });
const verified = new Map();
export async function verifyRuntime(file, expected) {
  try {
    if (!/^[a-f0-9]{64}$/.test(expected)) throw runtimeError();
    const info = await stat(file);
    if (!info.isFile()) throw runtimeError();
    const key = `${file}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    let hash = verified.get(key);
    if (!hash) {
      hash = createHash('sha256').update(await readFile(file)).digest('hex');
      verified.set(key, hash);
    }
    if (hash !== expected) throw runtimeError();
    return hash;
  } catch { throw runtimeError(); }
}

export async function stageGuestRuntime({ root = fileURLToPath(new URL('../', import.meta.url)), arch = process.arch, home } = {}) {
  try {
    if (!['x64', 'arm64'].includes(arch)) throw runtimeError();
    const manifest = JSON.parse(await readFile(path.join(root, 'guest-runtime/manifest.json'), 'utf8'));
    const entry = manifest[`linux-${arch}`];
    const relative = `guest-runtime/linux-${arch}/node`;
    const source = path.join(root, relative);
    await verifyRuntime(source, entry?.sha256);
    const dir = path.join(home, 'guest-runtime', entry.sha256);
    const node = path.join(dir, 'node');
    // `created` is true only when this call made the directory: mkdir either makes it or finds it. A
    // directory that was already there is used when its runtime verifies, but this call did not make it.
    await mkdir(path.dirname(dir), { recursive: true, mode: 0o755 });
    let created = false;
    try { await mkdir(dir, { mode: 0o755 }); created = true; } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    try { await verifyRuntime(node, entry.sha256); } catch {
      const partial = node + '.' + process.pid + '.' + randomUUID();
      try {
        await copyFile(source, partial);
        await chmod(partial, 0o555);
        await verifyRuntime(partial, entry.sha256);
        await rename(partial, node);
      } finally { await rm(partial, { force: true }); }
    }
    if (((await stat(node)).mode & 0o777) !== 0o555) await chmod(node, 0o555);
    await verifyRuntime(node, entry.sha256);
    return { dir, node, sha256: entry.sha256, created };
  } catch { throw runtimeError(); }
}

// The directory stageGuestRuntime will use, known from the manifest before anything is staged or
// reused, so it can be protected first. null when the manifest cannot be read.
export async function intendedRuntimeDir({ root = fileURLToPath(new URL('../', import.meta.url)), arch = process.arch, home } = {}) {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'guest-runtime/manifest.json'), 'utf8'));
    const sha256 = manifest[`linux-${arch}`]?.sha256;
    return /^[0-9a-f]{64}$/.test(sha256 ?? '') ? path.join(home, 'guest-runtime', sha256) : null;
  } catch { return null; }
}

export function runtimeWorkspaceArgs(runtime, { mountless }) {
  // Without a primary workspace sbx would treat this directory as the workspace.
  if (!runtime || mountless || !path.isAbsolute(runtime.dir) || /[\s:]/.test(runtime.dir)) return [];
  return [`${runtime.dir}:ro`];
}
export async function guardRuntimeReadiness(options, stage = stageGuestRuntime) {
  try { return { ok: true, runtime: await stage(options) }; }
  catch { return { ok: false, code: 'guard_runtime_unavailable', detail: RUNTIME_HELP }; }
}
export function guestHashCommand(expected, nodePath) {
  // Python is available even in agent images that have no Node on PATH.
  const script = `import hashlib, sys; sys.exit(hashlib.sha256(open(${JSON.stringify(nodePath)}, "rb").read()).hexdigest() != ${JSON.stringify(expected)})`;
  return `python3 -c ${shellQuote(script)} && ${shellQuote(nodePath)} --version`;
}
const HASH_FAILURE = 'FARAVAN_GUEST_RUNTIME_UNAVAILABLE';
export const guestRuntimeCheckFailed = result => result.code === 125 && (result.stderr ?? '').includes(HASH_FAILURE);
export function guestRuntimeCommand(runtime, command) {
  return `(${guestHashCommand(runtime.sha256, runtime.node)}) >/dev/null || { printf '%s\\n' '${HASH_FAILURE}' >&2; exit 125; }; ${command}`;
}
export const runtimeStartFailed = result => guestRuntimeCheckFailed(result) || result.code === 127 && /(?:node.*(?:not found|No such file)|(?:not found|No such file).*node)/i.test(result.stderr ?? '');

export async function installGuestRuntime({ runtime, mounted, run, sandboxId }) {
  if (!runtime) throw runtimeError();
  const exec = command => run(['exec', sandboxId, '--', 'sh', '-c', command]);
  if (mounted) {
    const mount = `awk -v target=${shellQuote(runtime.dir)} '$5 == target {found=1; if ($6 !~ /(^|,)ro(,|$)/) writable=1} END {exit writable ? 2 : (found ? 0 : 1)}' /proc/self/mountinfo`;
    const result = await exec(mount);
    if (result.code === 0) {
      if ((await exec(guestHashCommand(runtime.sha256, runtime.node))).code !== 0) throw runtimeError();
      return { method: 'mount', dir: runtime.dir, node: runtime.node, sha256: runtime.sha256 };
    }
    if (result.code !== 1) throw runtimeError();
  }
  const dir = '/tmp/faravan-runtime-' + runtime.sha256;
  const node = dir + '/node';
  if ((await exec('mkdir -p ' + shellQuote(dir))).code !== 0 ||
      (await run(['cp', runtime.node, `${sandboxId}:${node}`])).code !== 0 ||
      (await exec('chmod 0555 ' + shellQuote(node) + ' && ' + guestHashCommand(runtime.sha256, node))).code !== 0) throw runtimeError();
  return { method: 'copy', node, sha256: runtime.sha256 };
}
