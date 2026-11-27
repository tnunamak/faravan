/** Package committed source or a local folder without protocol transport. */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { stat, readdir } from 'node:fs/promises';
import { readArchiveEntries } from './archive.mjs';
import { filterSourceArchive } from './source-filter.mjs';
import { withIsolatedGitRead } from './git-source-status.mjs';

const execFileAsync = promisify(execFile);
export class SubmitError extends Error {
  constructor(message) { super(message); this.name = 'SubmitError'; }
}
const fail = message => { throw new SubmitError(message); };
export const SOURCE_MEDIA_TYPE = 'application/x-tar';

function digestOf(buffer) {
  return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
}

// Inspect names before Git can interpret a source tree as repository metadata.
export async function rejectMetadataRoot(dir) {
  // Uploaded metadata must never become plain source: Git objects retain excluded
  // committed files. Inspect names only, before invoking Git or reading any config.
  const rootEntries = await readdir(dir, {withFileTypes:true});
  const file = name => rootEntries.some(entry => entry.name.toLowerCase() === name && entry.isFile());
  const directory = name => rootEntries.find(entry => entry.name.toLowerCase() === name && entry.isDirectory());
  if ((file('head') && (directory('objects') || directory('refs') || file('config') || file('commondir'))) ||
      (file('config') && directory('objects') && (await readdir(join(dir, directory('objects').name)))
        .some(name => /^(?:pack|info|[0-9a-f]{2})$/i.test(name)))) {
    throw Object.assign(new SubmitError('Git metadata cannot be sent as source. Select the working folder instead.'), {status:400});
  }
}

// Packages a local directory as the base_artifact tar. Prefers `git archive
// HEAD` when `dir` is a git repo — it naturally excludes .git/ and
// gitignored/untracked files. The shared archive filter then excludes credential
// files while preserving committed generated source. Falls back to a plain `tar` of the directory
// (excluding .git if present) when it isn't a git repo, when HEAD has no
// commits yet (a fresh repo), or when git tracks no file under `dir` (for
// example a temp directory that happens to sit inside an unrelated work
// tree: `git archive` would silently ship an empty source).
// `git archive` ships the last commit, not the working tree. The result's
// `uncommitted` lists the paths under `dir` that git status reports as
// modified or untracked (and not ignored), so callers can warn the user.
export async function packageSourceDirectory(dir, {allowGit=true} = {}) {
  const dirStat = await stat(dir).catch(() => null);
  if (!dirStat || !dirStat.isDirectory()) fail(`--source is not a directory: ${dir}`);

  await rejectMetadataRoot(dir);

  if (allowGit) {
    const packaged = await withIsolatedGitRead(dir, async read => {
      const metadata = await read.packaging();
      if (metadata.kind !== 'committed') return null;
      const archive = await read.archive();
      const filtered = filterSourceArchive(archive);
      const archived = new Set(readArchiveEntries(archive, {allowGit:true}).map(entry => entry.name));
      for (const entry of (await read.committedTree()).split('\0')) {
        const tab = entry.indexOf('\t');
        if (tab < 0 || entry.slice(0, tab).split(' ')[1] !== 'blob') continue;
        const path = entry.slice(tab + 1);
        if (!archived.has(path)) filtered.omitted.push({path, reason:'not_source'});
      }
      const fields = (await read.status({scope:['.']})).split('\0').filter(Boolean);
      const uncommitted = [];
      for (let i = 0; i < fields.length; i++) {
        uncommitted.push(fields[i].slice(3));
        if (/[RC]/.test(fields[i].slice(0, 2))) i++;
      }
      return { ...filtered, ...digestOf(filtered.buffer), media_type: SOURCE_MEDIA_TYPE, method: 'git-archive', uncommitted };
    });
    if (packaged) return packaged;
  }

  // GNU tar and bsdtar accept --no-xattrs; COPYFILE_DISABLE alone is insufficient on macOS.
  const { stdout } = await execFileAsync('tar', ['-cf', '-', '--no-xattrs', '--exclude=.git', '-C', dir, '.'], { maxBuffer: 1024 * 1024 * 1024, encoding: 'buffer' });
  const filtered = filterSourceArchive(stdout, {tracked:false});
  return { ...filtered, ...digestOf(filtered.buffer), media_type: SOURCE_MEDIA_TYPE, method: 'tar' };
}
