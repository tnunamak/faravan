import fs from 'node:fs';
import path from 'node:path';

export function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// The caller supplies an established durable base, unchanged across retries.
// Existing bindings below it may be retained from an interrupted mkdir/fsync,
// so sync them too. Never open unrelated ancestors above that boundary.
export function ensureDurableDirectory(directory, {base} = {}) {
  if (typeof base !== 'string' || !base) throw new TypeError('An established durable base directory is required');
  const root = path.resolve(base), relative = path.relative(root, path.resolve(directory));
  const outside = value => value === '..' || value.startsWith('..' + path.sep) || path.isAbsolute(value);
  if (outside(relative)) throw new Error(`Directory is outside its durable base: ${directory}`);
  if (!fs.statSync(root).isDirectory()) throw new Error(`Not a durable base directory: ${root}`);
  const physicalRoot = fs.realpathSync(root);
  let physical = physicalRoot;
  for (const name of relative.split(path.sep).filter(Boolean)) {
    const parent = physical, entry = path.join(parent, name);
    try { fs.mkdirSync(entry, {mode:0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.statSync(entry).isDirectory()) throw new Error(`Not a directory: ${entry}`);
    physical = fs.realpathSync(entry);
    if (outside(path.relative(physicalRoot, physical))) throw new Error(`Directory escapes its durable base: ${entry}`);
    syncDirectory(parent);
  }
  return physical;
}
