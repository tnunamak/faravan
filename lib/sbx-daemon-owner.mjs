// A random owner belongs to one installation in one data profile, never to a shared sbx HOME.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { configHome } from './local-state.mjs';

export const installRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
export function sbxOwnerFile(home = configHome(), root = installRoot) {
  return path.join(home, `sbx-daemon-owner-${createHash('sha256').update(root).digest('hex')}.json`);
}
export function readSbxOwner(home, root) {
  try {
    const owner = JSON.parse(fs.readFileSync(sbxOwnerFile(home, root), 'utf8'));
    return /^[0-9a-f]{64}$/.test(owner.id) && path.isAbsolute(owner.executable) ? owner : null;
  } catch { return null; }
}
export function resolveSbxExecutable(binary, env) {
  const candidates = binary.includes('/') ? [path.resolve(binary)] : String(env.PATH || '').split(path.delimiter).filter(path.isAbsolute).map(dir => path.join(dir, binary));
  const executable = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return fs.statSync(candidate).isFile(); } catch { return false; } });
  if (!executable) throw new Error('The sandbox executable could not be resolved.');
  return fs.realpathSync(executable);
}

function writeOwner(owner, { create = false } = {}) {
  const file = sbxOwnerFile();
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary = file + '.' + randomBytes(16).toString('hex') + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({id:owner.id, executable:owner.executable}) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // First publication must not overwrite the identity another process just created.
    if (create) {
      try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } else fs.renameSync(temporary, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { fs.rmSync(temporary, {force:true}); }
}

export function ensureSbxOwner(binary, env, { refreshExecutable = false } = {}) {
  if (!fs.existsSync(sbxOwnerFile())) {
    writeOwner({id:randomBytes(32).toString('hex'), executable:resolveSbxExecutable(binary, env)}, {create:true});
  }
  let owner = readSbxOwner();
  if (!owner) throw new Error('The sandbox service ownership record is unreadable.');
  if (refreshExecutable) {
    const executable = resolveSbxExecutable(binary, env);
    if (owner.executable !== executable) {
      owner = {id:owner.id, executable};
      writeOwner(owner);
    }
  }
  return owner;
}

export function sbxUnitBelongsToOwner(unit, owner) {
  return Boolean(owner && new RegExp('^faravan-sbxd-[0-9a-f]{12}-' + owner.id + '[.]service$').test(unit));
}

// The package hook uses the same home selection and JSON parser as the runtime,
// even when the app is down. Optional paths let fixtures exercise that boundary.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--id') {
  const owner = readSbxOwner(process.argv[3] || undefined, process.argv[4]);
  if (owner) process.stdout.write(owner.id + '\n');
  else process.exitCode = 1;
}

export function restoreSbxOwner(owner) {
  if (!/^[0-9a-f]{64}$/.test(owner.id) || !path.isAbsolute(owner.executable)) throw new Error('Invalid sandbox ownership evidence.');
  writeOwner(owner);
  return readSbxOwner();
}

// The caller must first prove that no live unit can still own this record.
export function quarantineUnreadableSbxOwner() {
  if (readSbxOwner() || !fs.existsSync(sbxOwnerFile())) return;
  fs.renameSync(sbxOwnerFile(), sbxOwnerFile() + '.bad-' + Date.now() + '-' + randomBytes(8).toString('hex'));
}
