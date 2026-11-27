import { readArchiveEntries } from './archive.mjs';
import { createTar } from './tar-writer.mjs';
import { sourceFileOmission } from './v1/secret-files.mjs';

// Validate the actual bytes, then rebuild from allowed entries. Checking a filesystem list alone
// misses PAX paths and cannot bind a preview to the bytes that will leave the computer.
export function filterSourceArchive(buffer, {tracked = true} = {}) {
  const omitted = [], kept = [];
  const entries = readArchiveEntries(buffer, {preserveExecutable:true, allowGit:true});
  for (const entry of entries) {
    const exclusion = sourceFileOmission(entry.name, {tracked: typeof tracked === 'function' ? tracked(entry.name) : tracked, bytes:entry.data});
    if (exclusion) {
      if (entry.type === '0') omitted.push(exclusion);
    } else kept.push(entry);
  }
  rejectGitMetadata(kept);
  return {buffer:createTar(kept), omitted};
}


// All local paths meet here, including working-tree and caller-supplied tars.
// Infer directories too: file-only tars need not contain directory entries.
function rejectGitMetadata(entries) {
  const folders = new Map();
  const folder = path => {
    if (!folders.has(path)) folders.set(path, {files:new Set(), directories:new Set()});
    return folders.get(path);
  };
  const refuse = () => { throw Object.assign(new Error('Git metadata cannot be sent as source. Select the working folder instead.'), {code:'git_metadata_rejected',status:400}); };
  for (const entry of entries) {
    const parts = entry.name.toLowerCase().split('/').filter(part => part && part !== '.');
    const name = parts.pop(), parent = parts.join('/');
    if (!name) continue;
    if (entry.type === '0') {
      folder(parent).files.add(name);
      // Loose objects and pack files disclose blobs even without repository refs.
      if ((/^[0-9a-f]{38}(?:[0-9a-f]{24})?$/.test(name) && /^[0-9a-f]{2}$/.test(parts.at(-1) ?? '')) ||
          /^pack-[0-9a-f]{40}(?:[0-9a-f]{24})?\.(?:pack|idx)$/.test(name)) refuse();
    } else if (entry.type === '5') folder(parent).directories.add(name);
    while (parts.length) {
      const child = parts.pop();
      folder(parts.join('/')).directories.add(child);
    }
  }
  for (const {files,directories} of folders.values()) {
    if (files.has('head') && (directories.has('objects') || directories.has('refs') || files.has('config') || files.has('commondir'))) refuse();
  }
}
