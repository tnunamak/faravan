// The composer's folder picker (EXPERIENCE M7, `compose.local`): turns what a person typed into a folder path, and
// offers folders to choose from. It only reads, and the browser never leaves the person's home folder.
import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class FolderError extends Error {
  constructor(code, message, path) { super(message); this.name = 'FolderError'; this.code = code; this.path = path; }
}

/** A typed folder as an absolute normalized path: trimmed, no trailing slash, `~`/`$HOME` and relative paths from home. */
export function expandPath(input, home) {
  if (typeof input !== 'string' || input.includes('\0')) return null;
  let text = input.trim();
  if (!text) return null;
  const prefix = text.match(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/);
  if (prefix) text = home + text.slice(prefix[0].length);
  else if (text.startsWith('~')) return null; // ~other-user is not this person's home
  return resolve(isAbsolute(text) ? text : join(home, text));
}

const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const isDir = async path => (await stat(path).catch(() => null))?.isDirectory() === true;

/** The branch a git folder is on (from .git/HEAD, no process), '' when detached, or null when it is not a repository. */
export async function gitBranch(dir) {
  let gitDir = join(dir, '.git');
  const info = await lstat(gitDir).catch(() => null);
  if (!info) return null;
  if (info.isFile()) {
    const pointer = (await readFile(gitDir, 'utf8').catch(() => '')).match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return null;
    gitDir = resolve(dir, pointer);
  } else if (!info.isDirectory()) return null;
  const head = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => null);
  if (head === null) return null;
  return head.match(/^ref:\s*refs\/heads\/(.+)$/m)?.[1]?.trim() ?? '';
}

/** The last commit's time as ISO UTC, or null; the git process is killed after `timeoutMs`. */
const lastCommitAt = async (dir, timeoutMs) => {
  if (!(timeoutMs > 0)) return null;
  try {
    const out = (await exec('git', ['-C', dir, '-c', 'core.fsmonitor=false', 'log', '-1', '--format=%ct'],
      {encoding:'utf8', timeout:Math.ceil(timeoutMs), killSignal:'SIGKILL', env:{...process.env, GIT_TERMINAL_PROMPT:'0', LC_ALL:'C'}})).stdout.trim();
    return /^\d+$/.test(out) ? new Date(Number(out) * 1000).toISOString() : null;
  } catch { return null; }
};

const subdirs = async dir => (await readdir(dir, {withFileTypes:true}).catch(() => []))
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

const editDistance = (a, b) => {
  let row = Array.from({length:b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
};

const entryOf = async path => {
  const branch = await gitBranch(path);
  return branch === null ? {path, name:basename(path)} : {path, name:basename(path), branch};
};

/** Up to `limit` folders next to a missing one whose names look like what was typed. */
export async function nearSiblings(path, limit = 3) {
  const parent = dirname(path), wanted = basename(path).toLowerCase();
  if (parent === path || !wanted || !await isDir(parent)) return [];
  const scored = (await subdirs(parent)).map(entry => {
    const name = entry.name.toLowerCase();
    const score = name.startsWith(wanted) || wanted.startsWith(name) ? 0 : editDistance(name, wanted);
    return {name:entry.name, score};
  }).filter(item => item.score <= Math.max(2, Math.floor(wanted.length / 3)))
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, limit);
  return Promise.all(scored.map(item => entryOf(join(parent, item.name))));
}

/** Up to `limit` git repositories directly inside a plain folder. */
export async function innerRepos(path, limit = 8) {
  const found = [];
  for (const entry of (await subdirs(path)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (found.length >= limit) break;
    const child = join(path, entry.name), branch = await gitBranch(child);
    if (branch !== null) found.push({path:child, name:entry.name, branch});
  }
  return found;
}

const SKIP = new Set(['node_modules', 'vendor', 'snap']);
const SKIP_PATHS = [['.cache'], ['go', 'pkg']];

/** Git repositories under home, breadth first, at most `maxDepth` folders down; never follows a symlink. */
export async function scanRepos(home, {maxDepth = 3, maxDirs = 2000, budgetMs = 1500, now = Date.now} = {}) {
  const started = now(), repos = [];
  let queue = [{dir:home, depth:0, rel:[]}], visited = 0, truncated = false;
  while (queue.length) {
    const next = [];
    for (const {dir, depth, rel} of queue) {
      if (visited >= maxDirs || now() - started >= budgetMs) { truncated = true; break; }
      visited++;
      if (await gitBranch(dir) !== null) repos.push(dir);
      if (depth >= maxDepth) continue;
      for (const entry of await subdirs(dir)) { // Dirent.isDirectory() is false for symlinks
        const path = [...rel, entry.name];
        if (SKIP.has(entry.name) || SKIP_PATHS.some(skip => skip.every((part, i) => path[i] === part) && skip.length === path.length)) continue;
        next.push({dir:join(dir, entry.name), depth:depth + 1, rel:path});
      }
    }
    if (truncated) break;
    queue = next;
  }
  return {repos, truncated};
}

const confined = async (path, home) => {
  const realHome = await realpath(home).catch(() => home);
  if (!inside(path, home) && !inside(path, realHome)) throw new FolderError('outside_home', 'Faravan only shows folders inside your home folder (' + home + ').', path);
  const real = await realpath(path).catch(() => null);
  if (real === null) throw new FolderError('folder_missing', 'No folder at ' + path, path);
  if (!inside(real, realHome)) throw new FolderError('outside_home', path + ' leads outside your home folder (' + home + '), so Faravan does not show it.', path);
  if (!await isDir(real)) throw new FolderError('folder_missing', 'No folder at ' + path, path);
  return {real, realHome};
};

/** The immediate visible subfolders of a folder inside home: git repositories first, then by name; at most 500. */
export async function listFolders(input, {home, limit = 500}) {
  const path = input === undefined || input === '' ? resolve(home) : expandPath(input, home);
  if (path === null) throw new FolderError('folder_missing', 'Give a folder path, for example ~/code.', String(input ?? ''));
  const {realHome} = await confined(path, home);
  const folders = [];
  for (const entry of await readdir(path, {withFileTypes:true}).catch(() => [])) {
    if (entry.name.startsWith('.')) continue;
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      const real = await realpath(child).catch(() => null);
      if (!real || !inside(real, realHome) || !await isDir(real)) continue;
    } else if (!entry.isDirectory()) continue;
    const branch = await gitBranch(child);
    folders.push(branch === null ? {name:entry.name, path:child, is_git:false} : {name:entry.name, path:child, is_git:true, branch});
  }
  folders.sort((a, b) => Number(b.is_git) - Number(a.is_git) || a.name.localeCompare(b.name));
  return {path, home:resolve(home), folders:folders.slice(0, limit)};
}

/**
 * Folders to offer in the composer: the last eight checked or sent (persisted by `recent`), and repositories found
 * under home. Both lists are newest commit first. One `budgetMs` deadline covers the walk and the git reads for commit
 * times; whatever it cuts short comes back with `truncated: true`. The found list is reused for `cacheMs`.
 */
export function createFolderService({home, recent, now = Date.now, scan = scanRepos, cacheMs = 60000, budgetMs = 1500, gitTimeoutMs = 1000}) {
  let cached = null, scanning = null, writes = Promise.resolve();
  const newest = (a, b) => (b.last_commit_at ?? '').localeCompare(a.last_commit_at ?? '') || a.path.localeCompare(b.path);
  /** Describes paths eight at a time; past the deadline the commit time is unknown (null) and `cut` is set. */
  const describeAll = async (paths, deadline) => {
    const out = [];let cut = false;
    for (let i = 0; i < paths.length; i += 8) {
      out.push(...await Promise.all(paths.slice(i, i + 8).map(async path => {
        const left = Math.min(gitTimeoutMs, deadline - now());
        if (left <= 0) cut = true;
        const exists=await isDir(path);
        return {path, name:basename(path), ...(!exists?{stale:true}:{}), branch:exists ? await gitBranch(path) || null : null, last_commit_at:exists ? await lastCommitAt(path, left) : null};
      })));
    }
    return {list:out.sort(newest), cut};
  };
  const found = async deadline => {
    const walk = await scan(home, {budgetMs:Math.max(0, deadline - now()), now});
    const {list, cut} = await describeAll(walk.repos, deadline);
    cached = {at:now(), repos:list, truncated:walk.truncated || cut};
    return cached;
  };
  return {
    /** Serialized, so concurrent sends of A, B, A always leave A newest. */
    remember(path) {
      writes = writes.catch(() => {}).then(() => recent.set([path, ...recent.get().filter(item => item !== path)].slice(0, 8)));
      return writes;
    },
    async suggest() {
      const deadline = now() + budgetMs;
      const kept = [];
      for (const path of recent.get()) if (!kept.includes(path)) kept.push(path);
      const recentView = await describeAll(kept, deadline);
      if (!cached || now() - cached.at >= cacheMs) scanning ??= found(deadline).finally(() => { scanning = null; });
      const repos = scanning ? await scanning : cached;
      return {recent:recentView.list, repos:repos.repos, truncated:repos.truncated};
    },
  };
}
