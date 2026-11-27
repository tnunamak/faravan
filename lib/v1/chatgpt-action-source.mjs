import { createTar } from '../tar-writer.mjs';
import { withIsolatedGitRead } from '../git-source-status.mjs';
// Freeze what a remote ChatGPT caller wants to send, and describe it exactly, BEFORE the person approves.
//
//   const {input, details, cleanup} = await prepareChatgptSource(remoteInput, {home});
//
// `details` is what the local approval page shows (the exact files, the exact repository, where it goes);
// `input` is what the executor must run. Approval covers `input`, so `input` must not be able to change after
// the click. A local `repo.path` is therefore copied into a private one-commit snapshot repository under
// `<home>/v1/` and `input.repo.path` points at that copy. Moving HEAD, editing the worktree or swapping a file
// in the original afterwards changes nothing that is executed.
//
// Snapshot rules (every source is untrusted, including the person's own repository: another process or a
// cloned project may have planted its `.git/config`):
//   * the original repository is only read, never written, and no command named in its config runs: filter
//     drivers are absent, fsmonitor is off, and the shared fixed-capability read session uses a private
//     admin directory containing only selected data settings, with committed reads pinned to one object;
//   * nothing of the original `.git` enters the finished snapshot (no config, hooks, remotes, credentials);
//   * symlinks, submodules and special files are omitted and listed in `details.repo.omitted`, never followed;
//   * the bytes go through lib/archive.mjs (path, case, depth and size rules) and are committed into a fresh
//     repository with global and system config off, no hooks, no filters, fixed author and date, no signing;
//   * the finished commit is archived again and compared byte-for-byte and mode-for-mode with the preview.
// Limits: at most 1000 files and 20 MiB. Anything larger is refused, never truncated.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { ArchiveError, archiveFileCount, extractArchive } from '../archive.mjs';
import { REVIEW_HIDDEN_CHARS } from './chatgpt-policy.mjs';
import { isSecretFile, sourceFileOmission } from './secret-files.mjs';
import { filterSourceArchive } from '../source-filter.mjs';

const exec = promisify(execFile);

export const SOURCE_LIMITS = Object.freeze({
  maxFiles: 1000,
  maxBytes: 20 * 1024 * 1024,
  maxTextBytesPerFile: 1024 * 1024,
  maxTextBytesTotal: 8 * 1024 * 1024,
  maxListed: 200,
});
const ARCHIVE_POLICY = {maxEntries: 20000, maxTotalBytes: SOURCE_LIMITS.maxBytes, maxFileBytes: SOURCE_LIMITS.maxBytes};
const GIT_TIMEOUT_MS = 60_000;

export class ChatgptSourceError extends Error {
  constructor(code, message) { super(String(message).slice(0, 240)); this.name = 'ChatgptSourceError'; this.code = code; }
}
const fail = (code, message) => { throw new ChatgptSourceError(code, message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// ---- git ------------------------------------------------------------------------------------------------------

// Commands against our own snapshot repositories: no user, system or repository-supplied configuration at all.
const sealedEnv = home => ({PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
  GIT_AUTHOR_NAME: 'Faravan', GIT_AUTHOR_EMAIL: 'snapshot@faravan.invalid', GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Faravan', GIT_COMMITTER_EMAIL: 'snapshot@faravan.invalid', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z'});
const SEALED_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
  '-c', 'core.safecrlf=false', '-c', 'core.fileMode=true', '-c', 'core.attributesFile=/dev/null', '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false', '-c', 'protocol.allow=never', '-c', 'gc.auto=0'];

const aborted = () => new ChatgptSourceError('aborted', 'Preparing the project was cancelled.');
const checkAbort = signal => { if (signal?.aborted) throw aborted(); };

async function git(args, {cwd, env, maxBuffer = 64 * 1024 * 1024, signal} = {}) {
  checkAbort(signal);
  try {
    return (await exec('git', args, {cwd, env, maxBuffer, timeout: GIT_TIMEOUT_MS, encoding: 'buffer', signal})).stdout;
  } catch (error) {
    if (signal?.aborted || error.name === 'AbortError') throw aborted();
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail('too_large', 'The project is larger than ' + (SOURCE_LIMITS.maxBytes >> 20) + ' MiB.');
    if (error.code === 'ENOENT') fail('git_missing', 'git is not installed on this computer, so Faravan cannot send a project.');
    const detail = String(error.stderr ?? '').trim().split('\n')[0].slice(0, 160);
    fail('source_unreadable', 'git could not read the project' + (detail ? ': ' + detail : '.'));
  }
}

// ---- tar ------------------------------------------------------------------------------------------------------

const tarOf = entries => createTar(entries.map(({path,bytes,executable}) => ({
  name:path,data:bytes,mode:executable?0o755:0o644,type:'0',
})));

async function extractChecked(tar, destination) {
  try {
    const files = archiveFileCount(tar, ARCHIVE_POLICY);
    if (files > SOURCE_LIMITS.maxFiles) fail('too_large', 'The project has more than ' + SOURCE_LIMITS.maxFiles + ' files.');
    await extractArchive(tar, destination, {...ARCHIVE_POLICY, preserveExecutable: true, allowGit: false});
  } catch (error) {
    if (!(error instanceof ArchiveError)) throw error;
    fail(error.code === 'too_large' ? 'too_large' : 'invalid_source', 'The files cannot be sent safely: ' + error.message);
  }
}

// ---- preview --------------------------------------------------------------------------------------------------

/** Regular files under `dir` (skipping a top-level .git), with bytes. */
async function readTree(dir) {
  const files = [];
  const walk = async rel => {
    for (const entry of await readdir(join(dir, rel), {withFileTypes: true})) {
      const path = rel ? rel + '/' + entry.name : entry.name;
      if (!rel && entry.name === '.git') continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const full = join(dir, path);
        files.push({path, bytes: await readFile(full), executable: ((await lstat(full)).mode & 0o111) !== 0});
      } else fail('invalid_source', 'Unexpected non-regular file in snapshot: ' + path);
    }
  };
  await walk('');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const utf8 = new TextDecoder('utf-8', {fatal: true});
/** Per-file preview: exact text for UTF-8 files within budget, hash and size for the rest. */
function previewOf(files) {
  let textBudget = SOURCE_LIMITS.maxTextBytesTotal;
  return files.map(({path, bytes, executable}) => {
    const item = {path, sha256: sha256(bytes), bytes: bytes.length, executable: Boolean(executable), binary: false, text: null};
    let text = null;
    if (!bytes.includes(0)) { try { text = utf8.decode(bytes); } catch { /* not UTF-8 */ } }
    if (text === null) { item.binary = true; return item; }
    if (bytes.length > SOURCE_LIMITS.maxTextBytesPerFile || bytes.length > textBudget) { item.text_omitted = 'too_large'; return item; }
    textBudget -= bytes.length;
    item.text = text;
    if (REVIEW_HIDDEN_CHARS.test(text)) item.hidden_characters = true;
    return item;
  });
}
const sourceHash = files => sha256(files.map(f => `${f.executable ? 'x' : '-'}\t${f.sha256}\t${f.path}\n`).join(''));

// ---- sources --------------------------------------------------------------------------------------------------

async function prepareFiles(input, scratch) {
  if (!Array.isArray(input.files) || input.files.length > SOURCE_LIMITS.maxFiles) fail('too_large', 'More than ' + SOURCE_LIMITS.maxFiles + ' files.');
  const entries = []; let total = 0;
  for (const file of input.files) {
    if (!file || typeof file.path !== 'string' || typeof file.base64 !== 'string') fail('invalid_source', 'Each file needs a path and base64 content.');
    if (!file.path || file.path.length > 1024 || file.path.includes('\0')) fail('invalid_source', 'Unsafe file path.');
    if (file.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) fail('invalid_source', 'Content of ' + JSON.stringify(file.path.slice(0, 80)) + ' is not valid base64.');
    const bytes = Buffer.from(file.base64, 'base64');
    if ((total += bytes.length) > SOURCE_LIMITS.maxBytes) fail('too_large', 'The files are larger than ' + (SOURCE_LIMITS.maxBytes >> 20) + ' MiB.');
    entries.push({path: file.path, bytes, executable: false});
  }
  // lib/archive.mjs owns the path rules: absolute, "..", ".git", backslash, case and Unicode collisions, depth.
  const check = join(scratch, 'files-check');
  await extractChecked(tarOf(entries), check);
  await rm(check, {recursive: true, force: true});
  // The app never uploads credential files (lib/v1/secret-files.mjs). Preview and execution both drop them, explicitly.
  const excluded = entries.filter(e => sourceFileOmission(e.path,{bytes:e.bytes})).map(e => e.path);
  const kept = entries.filter(e => !sourceFileOmission(e.path,{bytes:e.bytes}));
  if (!kept.length) fail('empty_source', excluded.length ? 'Every file is a credential or build file, which Faravan never sends.' : 'There are no files to send.');
  return {excluded, keep: new Set(kept.map(e => e.path)), details: {type: 'files', files: previewOf(kept.sort((a, b) => (a.path < b.path ? -1 : 1))), excluded}};
}

function prepareGit(input) {
  const {url, commit, ...rest} = input.git ?? {};
  if (typeof url !== 'string' || Object.keys(rest).length) fail('invalid_source', 'A git source is {url, commit}.');
  if (typeof commit !== 'string' || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) fail('invalid_source', 'A git source must pin a full lowercase commit hash, not a branch or tag.');
  let parsed;
  try { parsed = new URL(url); } catch { fail('invalid_source', 'The git URL is not a valid URL.'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname || url.length > 2048) fail('invalid_source', 'The git URL must be https and carry no credentials.');
  return {details: {type: 'git', git: {url, commit}}};
}

// Files git would call part of the working tree: tracked plus untracked, minus ignored, read without following links.
async function workingTreeEntries(top, read, signal) {
  const listing = await read.worktreeFiles();
  const listed = listing.listed.split('\0').filter(Boolean);
  const unique = [...new Set(listed)];
  if (unique.length > SOURCE_LIMITS.maxFiles + 5000) fail('too_large', 'The project lists far more than ' + SOURCE_LIMITS.maxFiles + ' files. Add a .gitignore for generated files.');
  const tracked = new Set(listing.tracked.split('\0').filter(Boolean));
  const topReal = await realpath(top);
  const entries = [], omitted = [];
  let total = 0;
  for (const path of unique) {
    checkAbort(signal);
    const exclusion=sourceFileOmission(path,{tracked:tracked.has(path)});
    if (exclusion) { omitted.push({path, reason: exclusion.reason==='credentials'?'secret_file':'not_source'}); continue; }
    const full = join(topReal, path);
    let info;
    try { info = await lstat(full); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { omitted.push({path, reason: 'deleted'}); continue; } throw error; }
    if (info.isSymbolicLink()) { omitted.push({path, reason: 'symlink'}); continue; }
    if (!info.isFile()) { omitted.push({path, reason: info.isDirectory() ? 'submodule_or_directory' : 'not_a_regular_file'}); continue; }
    // A symlinked parent directory must not lead outside the repository (or anywhere else).
    if (await realpath(join(full, '..')).catch(() => null) !== join(topReal, posix.dirname(path) === '.' ? '' : posix.dirname(path))) { omitted.push({path, reason: 'symlink'}); continue; }
    if (entries.length >= SOURCE_LIMITS.maxFiles) fail('too_large', 'The project has more than ' + SOURCE_LIMITS.maxFiles + ' files.');
    if (info.size > SOURCE_LIMITS.maxBytes - total) fail('too_large', 'The project is larger than ' + (SOURCE_LIMITS.maxBytes >> 20) + ' MiB.');
    const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size > SOURCE_LIMITS.maxBytes - total) { omitted.push({path, reason: 'changed_while_reading'}); continue; }
      // Where the open file really is (Linux): a swap to a link elsewhere fails this check.
      const there = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => full);
      if (there !== full) { omitted.push({path, reason: 'symlink'}); continue; }
      const bytes = Buffer.alloc(opened.size);
      const {bytesRead} = await handle.read(bytes, 0, opened.size, 0);
      if (bytesRead !== opened.size) { omitted.push({path, reason: 'changed_while_reading'}); continue; }
      const history=sourceFileOmission(path,{tracked:tracked.has(path),bytes});
      if(history){omitted.push(history);continue;}
      total += bytes.length;
      entries.push({path, bytes, executable: (opened.mode & 0o111) !== 0});
    } finally { await handle.close(); }
  }
  return {entries, omitted};
}

async function prepareRepo(input, root, signal) {
  const run = (args, options) => git(args, {...options, signal});
  const {path: requested, includeUncommitted = false, ...extra} = input.repo ?? {};
  if (typeof requested !== 'string' || !requested || requested.includes('\0') || !isAbsolute(requested) || Object.keys(extra).length || typeof includeUncommitted !== 'boolean') {
    fail('invalid_source', 'A repository source is {path, includeUncommitted?} with the full path of a folder.');
  }
  const info = await lstat(requested).catch(() => null);
  if (!info || !(info.isDirectory() || info.isSymbolicLink())) fail('repo_missing', "That folder isn't on this computer.");
  try {
  return await withIsolatedGitRead(requested, async read => {
  checkAbort(signal);
  const metadata = await read.packaging();
  if (metadata.kind === 'nonrepository') fail('not_git', 'Faravan sends a git repository, so the changes can come back as a branch.');
  if (!metadata.commit) fail('no_commits', 'This repository has no commits yet. Make a first commit, then send it.');
  const top = metadata.worktree, head = metadata.commit, branch = metadata.branch;
  const name = basename(top);
  const sealed = sealedEnv(root);
  const work = join(root, 'snapshot', name), verify = join(root, 'verify');
  let entries, omitted = [], uncommitted = [];

  if (includeUncommitted) {
    ({entries, omitted} = await workingTreeEntries(top, read, signal));
    await extractChecked(tarOf(entries), work);
  } else {
    // The shared fixed-capability session pins the commit and disables lazy transport.
    const tree = (await read.committedTree()).split('\0').filter(Boolean);
    const keep = []; let total = 0;
    for (const line of tree) {
      const m = /^(\d{6}) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(line);
      if (!m) fail('source_unreadable', 'Unreadable file list from git.');
      if (m[1] === '120000') omitted.push({path: m[4], reason: 'symlink'});
      else if (m[1] === '160000') omitted.push({path: m[4], reason: 'submodule_or_directory'});
      else if (isSecretFile(m[4])) omitted.push({path: m[4], reason: 'secret_file'});
      else {
        keep.push(m[4]);
        checkAbort(signal);
        const bytes = await read.blobBuffer(m[3], {maxBytes: Math.max(1, SOURCE_LIMITS.maxBytes - total)});
        if ((total += bytes.length) > SOURCE_LIMITS.maxBytes) fail('too_large', 'The project is larger than ' + (SOURCE_LIMITS.maxBytes >> 20) + ' MiB.');
        if (keep.length > SOURCE_LIMITS.maxFiles) fail('too_large', 'The project has more than ' + SOURCE_LIMITS.maxFiles + ' files.');
      }
    }
    const tar = keep.length
      ? await read.archive({paths: keep, maxBytes: SOURCE_LIMITS.maxBytes + 8 * 1024 * 1024})
      : null;
    if (tar) {
      const filtered = filterSourceArchive(tar);
      omitted.push(...filtered.omitted);
      await extractChecked(filtered.buffer, work);
    }
    const status = (await read.status()).split('\0').filter(Boolean);
    for (let i = 0; i < status.length; i++) { uncommitted.push(status[i].slice(3)); if (/[RC]/.test(status[i].slice(0, 2))) i++; }
  }

  await mkdir(work, {recursive: true});
  const files = await readTree(work);
  if (!files.length) fail('empty_source', 'There are no files to send in that project.');
  // A fresh repository that owns the approved bytes. info/attributes beats any .gitattributes in the tree.
  await run(['init', '-q', '-b', 'main', '--template=', work], {env: sealed});
  await mkdir(join(work, '.git/info'), {recursive: true});
  await writeFile(join(work, '.git/info/attributes'), '* -text -eol -ident -filter -export-ignore -export-subst\n');
  const inWork = (...args) => run([...SEALED_CONFIG, ...args], {cwd: work, env: sealed});
  await inWork('add', '--all', '--force');
  await inWork('commit', '-q', '--no-verify', '--no-gpg-sign', '--no-edit', '-m', 'Faravan snapshot of ' + head);
  const snapshotCommit = (await inWork('rev-parse', 'HEAD')).toString().trim();

  // The executor will `git archive HEAD` this repository. It must produce exactly what was previewed.
  await extractChecked(await inWork('archive', '--format=tar', 'HEAD'), verify);
  const packaged = await readTree(verify);
  const same = packaged.length === files.length && packaged.every((f, i) => f.path === files[i].path && f.executable === files[i].executable && f.bytes.equals(files[i].bytes));
  if (!same) fail('snapshot_mismatch', 'The repository attributes change what is packaged, so the approved files cannot be guaranteed. Remove export-ignore / export-subst rules or send the files directly.');
  await rm(verify, {recursive: true, force: true});

  const preview = previewOf(files);
  return {
    path: work,
    details: {
      type: 'repo', files: preview,
      repo: {
        original_path: top, requested_path: requested, name, branch, original_head: head,
        include_uncommitted: includeUncommitted, snapshot_commit: snapshotCommit, source_hash: sourceHash(preview),
        file_count: preview.length, total_bytes: files.reduce((n, f) => n + f.bytes.length, 0),
        omitted: omitted.slice(0, SOURCE_LIMITS.maxListed), omitted_count: omitted.length,
        uncommitted_not_sent: includeUncommitted ? [] : uncommitted.slice(0, SOURCE_LIMITS.maxListed),
        uncommitted_count: includeUncommitted ? 0 : uncommitted.length,
      },
    },
  };
  }, {signal, wholeRepository: true});
  } catch (error) {
    if (error instanceof ChatgptSourceError) throw error;
    if (signal?.aborted || error.name === 'AbortError') throw aborted();
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') fail('too_large', 'The project is larger than ' + (SOURCE_LIMITS.maxBytes >> 20) + ' MiB.');
    if (error.code === 'ENOENT') fail('git_missing', 'git is not installed on this computer, so Faravan cannot send a project.');
    throw error;
  }
}

// ---- entry point ----------------------------------------------------------------------------------------------

/**
 * @param {object} input  jobs.submit / jobs.send_and_wait input as the remote caller sent it (never mutated)
 * @param {{home: string}} options  Faravan home; private snapshots live in `<home>/v1/chatgpt-source-*`
 * @returns {Promise<{input: object, details: object, cleanup: () => Promise<void>}>}
 *   input    deep clone to execute; for `repo` it names the snapshot repository and drops includeUncommitted
 *   details  preview: {type: 'repo'|'git'|'files'|'none', files?: [{path, sha256, bytes, executable, binary, text,
 *            text_omitted?, hidden_characters?}], repo?: {...}, git?: {url, commit}}
 *   cleanup  idempotent; removes every private directory
 * Throws ChatgptSourceError (code: invalid_source | too_large | not_git | no_commits | repo_missing | git_missing |
 * source_unreadable | empty_source | snapshot_mismatch); private directories are already removed when it throws.
 */
export async function prepareChatgptSource(input, {home, signal} = {}) {
  checkAbort(signal);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_source', 'Input must be an object.');
  if (typeof home !== 'string' || !isAbsolute(home)) fail('invalid_source', 'A Faravan home is required.');
  const kinds = ['repo', 'git', 'files'].filter(k => input[k] !== undefined);
  if (kinds.length > 1) fail('invalid_source', 'Send exactly one of repo, git or files.');
  const execution = structuredClone(input);
  if (!kinds.length) return {input: execution, details: {type: 'none', files: []}, cleanup: async () => {}};

  const parent = join(home, 'v1');
  await mkdir(parent, {recursive: true, mode: 0o700});
  const root = await mkdtemp(join(parent, 'chatgpt-source-'));
  const cleanup = async () => { await rm(root, {recursive: true, force: true, maxRetries: 3, retryDelay: 20}); };
  try {
    if (kinds[0] === 'files') {
      const {keep, details} = await prepareFiles(input, root);
      execution.files = execution.files.filter(f => keep.has(f.path));
      checkAbort(signal);
      return {input: execution, details, cleanup};
    }
    if (kinds[0] === 'git') { await cleanup(); return {input: execution, ...prepareGit(input), cleanup: async () => {}}; }
    const {path, details} = await prepareRepo(input, root, signal);
    execution.repo = {path};
    checkAbort(signal);
    return {input: execution, details, cleanup};
  } catch (error) {
    // Cleanup must not replace the original preparation/abort error.
    await cleanup().catch(() => {});
    if (signal?.aborted) throw aborted();
    if (error instanceof ChatgptSourceError) throw error;
    throw new ChatgptSourceError('source_unreadable', 'The project could not be read: ' + String(error?.code ?? error?.message ?? error).slice(0, 120));
  }
}
