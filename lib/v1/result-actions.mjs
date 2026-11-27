// What the borrower can do with a verified result besides Add as a branch: put some or all of its files into the
// working tree of their repository, and remove the branch Add as a branch made while nobody has touched it.
//
// The working-tree apply never writes before it knows the outcome. It replays the selected files on a scratch index
// (git apply --3way --cached from HEAD), refuses on any conflict, and only then copies the merged files from that tree
// into a private staging tree, then journals and replaces each file after checking again that HEAD and every touched path are as
// the preview showed them. It needs a clean working tree (untracked files elsewhere are fine), refuses paths that are in
// the way and never touches the index, other files or HEAD.
// Every git call goes through apply.mjs's `git` (no hooks, no fsmonitor, no shell, arguments as arrays).
import { mkdtemp, rm, stat, lstat, realpath, mkdir } from 'node:fs/promises';
import { constants, lstatSync, readlinkSync, openSync, closeSync, fstatSync, readFileSync, fsyncSync,
  mkdirSync, symlinkSync, writeFileSync, fchmodSync, linkSync, unlinkSync, renameSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { openDevice } from './device.mjs';
import { applyOwner, applyOwnerGone } from './apply-head-lock.mjs';
import { previewGuard } from './preview-lock.mjs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, dirname, basename } from 'node:path';
import { ApplyError, git, text, clean, findBase, verifiedPatch } from './apply.mjs';
import { unsafeSymlinkTarget, unsafePatchPath } from '../git-candidate.mjs';

const refuse = (code, message) => { throw new ApplyError(code, message); };
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Beyond this many files the per-file check is skipped and only the whole result can be applied. */
export const PER_FILE_LIMIT = 200;
const LITERAL = { GIT_LITERAL_PATHSPECS: '1' };
const firstLine = (result, fallback) => result.stderr.split('\n')[0] || fallback;

async function repositoryAt(repo) {
  if (typeof repo !== 'string' || !repo || repo.includes('\0') || !isAbsolute(repo)) refuse('repo_missing', 'Enter the full path of the folder, starting with / (or C:\\ on Windows).');
  const info = await stat(repo).catch(() => null);
  if (!info?.isDirectory()) refuse('repo_missing', `${clean(repo, 200)} is not a folder on this computer.`);
  const top = await git(['rev-parse', '--show-toplevel'], { cwd: repo });
  if (top.code !== 0) refuse('not_a_repository', `${clean(repo, 200)} is not a Git repository.`);
  return realpath(text(top));
}

/** The patch as one byte string per file, in parseUnifiedDiff order (it starts a file at each `diff --git ` line too). */
export function splitPatch(bytes) {
  const whole = Buffer.from(bytes), starts = [];
  for (let at = 0; at < whole.length;) {
    if (whole.subarray(at, at + 11).toString('latin1') === 'diff --git ') starts.push(at);
    const nl = whole.indexOf(10, at);
    at = nl < 0 ? whole.length : nl + 1;
  }
  return starts.map((start, i) => whole.subarray(start, starts[i + 1] ?? whole.length));
}

/**
 * `git status --porcelain=v1 -z`: every path with staged, unstaged or untracked changes (`dirty`), the tracked ones
 * among them (`tracked`: staged or unstaged, not untracked), and whether any is unmerged.
 */
function parseStatus(stdout) {
  const tokens = stdout.toString('utf8').split('\0'), dirty = new Set(), tracked = new Set();
  let unmerged = false;
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2), paths = [entry.slice(3)];
    if (xy.includes('U') || xy === 'AA' || xy === 'DD') unmerged = true;
    if (xy[0] === 'R' || xy[0] === 'C') paths.push(tokens[++i]);
    for (const path of paths) { dirty.add(path); if (xy !== '??') tracked.add(path); }
  }
  return { dirty, tracked, unmerged };
}

/** How many changed tracked files the preview names; the rest are counted. */
const CHANGED_SHOWN = 20;
const treeView = (tracked) => {
  const changed = [...tracked].sort();
  return { clean: !changed.length, changed: changed.slice(0, CHANGED_SHOWN), more: Math.max(0, changed.length - CHANGED_SHOWN) };
};

/** Why the working tree at `path` must not be written, from the disk itself (ignored files and symlinked folders included). */
async function onDisk(cwd, path, inHead) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const info = await lstat(join(cwd, ...parts.slice(0, i))).catch(() => null);
    if (!info) break;
    if (info.isSymbolicLink() || !info.isDirectory()) return 'unsafe';
  }
  if (!inHead && await lstat(join(cwd, ...parts)).catch(() => null)) return 'exists';
  return null;
}

async function workingState(cwd, { base, head }) {
  const status = await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { cwd });
  if (status.code !== 0) refuse('not_a_repository', 'git could not read the working tree: ' + firstLine(status, 'unknown error'));
  const { dirty, tracked, unmerged } = parseStatus(status.stdout);
  if (unmerged) refuse('repo_busy', 'This repository has unresolved merge conflicts. Finish or abort that first.');
  const since = await git(['diff', '--name-only', '-z', '--no-renames', base, head], { cwd });
  const tree = await git(['ls-tree', '-r', '-z', '--name-only', head], { cwd });
  const split = (r) => new Set(r.stdout.toString('utf8').split('\0').filter(Boolean));
  return { dirty, tracked, changedSinceBase: split(since), inHead: split(tree) };
}

const filePaths = (file) => [...new Set([file.oldPath, file.path])];

/** Replays `patch` on a scratch index built from `head`. Returns the tree it makes, or null on any conflict or failure. */
async function trial(cwd, scratch, name, head, patch) {
  const env = { GIT_INDEX_FILE: join(scratch, name) };
  if ((await git(['read-tree', head], { cwd, env })).code !== 0) refuse('patch_conflict', 'git could not read HEAD.');
  const applied = await git(['apply', '--cached', '--3way', '--whitespace=nowarn', '-'], { cwd, env, input: patch });
  const unmerged = await git(['ls-files', '-u', '-z'], { cwd, env });
  if (applied.code !== 0 || unmerged.stdout.length) return null;
  return env;
}

async function linksAreSafe(cwd, env, paths) {
  const entries = (await git(['ls-files', '--stage', '-z'], { cwd, env })).stdout.toString('utf8').split('\0');
  for (const entry of entries) {
    const link = /^120000 ([0-9a-f]+) 0\t([\s\S]*)$/.exec(entry);
    if (!link || !paths.has(link[2])) continue;
    const target = (await git(['cat-file', 'blob', link[1]], { cwd })).stdout.toString('utf8');
    if (unsafeSymlinkTarget(target)) refuse('unsafe_patch', 'Refusing an unsafe patch: ' + clean(link[2], 200) + ': symbolic link points outside the repository.');
  }
}

/**
 * Each file of the result as it would land in this working tree now:
 * applies (cleanly) | merges (you changed it in a commit since; git merged both) | conflict | yours (uncommitted
 * changes in it) | exists (a file the result adds is already on disk, maybe ignored) | unsafe (a folder on the way is a link).
 */
// Git status intentionally hides some index entries. Working-tree mode refuses those entries,
// and refuses conversion attributes, so reading a result cannot execute checkout filters.
async function safeCheckoutInputs(cwd,paths) {
  const flags=await git(['ls-files','-v','-z'],{cwd});
  if(flags.code!==0)refuse('index_flags','Git could not check the index flags. Add the result as a branch instead.');
  if(flags.stdout.toString('utf8').split('\0').some(entry=>/^[a-zS] /.test(entry)))
    refuse('index_flags','Git is hiding changes in this folder with assume-unchanged or skip-worktree. Clear those flags, or add the result as a branch.');
  if(paths.some(path=>path.split('/').at(-1).toLowerCase()==='.gitattributes'))
    refuse('attributes','This result changes Git attributes. Add it as a branch so you can review those rules before using them.');
  const attrs=await git(['check-attr','--cached','-z','--stdin','filter','working-tree-encoding'],{cwd,env:LITERAL,input:paths.join('\0')+'\0'});
  if(attrs.code!==0)refuse('attributes','Git could not check file conversion rules. Add the result as a branch instead.');
  const parts=attrs.stdout.toString('utf8').split('\0');
  for(let index=0;index+2<parts.length;index+=3)if(!['unspecified','unset'].includes(parts[index+2]))
    refuse('attributes','These files use Git conversion filters or encoding rules. Add the result as a branch instead.');
}

async function analyse({ digest, circle, repo, device, signal }) {
  if (!DIGEST.test(digest ?? '')) refuse('invalid_job', 'That is not a job ID.');
  const cwd = await repositoryAt(repo);
  const { bytes, parsed, receipt, job, circle: selectedCircle } = await verifiedPatch({ digest, circle, cwd, device, signal });
  const chunks = splitPatch(bytes);
  if (chunks.length !== parsed.files.length) refuse('patch_invalid', 'The patch could not be split into files.');
  const { base } = await findBase({ cwd, job, receipt });
  const head = text(await git(['rev-parse', 'HEAD'], { cwd }));
  const current = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd });
  await safeCheckoutInputs(cwd,parsed.files.flatMap(filePaths));
  const state = await workingState(cwd, { base, head });
  const files = [];
  for (const [i, file] of parsed.files.entries()) {
    let blocked = null;
    for (const path of filePaths(file)) {
      blocked ??= state.dirty.has(path) ? 'yours' : await onDisk(cwd, path, state.inHead.has(path));
    }
    files.push({ path: file.path, old_path: file.oldPath !== file.path ? file.oldPath : null, status: file.status,
      insertions: file.insertions, deletions: file.deletions, binary: file.binary, chunk: chunks[i], paths: filePaths(file), state: blocked });
  }
  const scratch = await mkdtemp(join(tmpdir(), 'faravan-worktree-'));
  try {
    const open = files.filter((f) => !f.state);
    const together = open.length ? await trial(cwd, scratch, 'all', head, Buffer.concat(open.map((f) => f.chunk))) : null;
    for (const [i, f] of open.entries()) {
      const fine = together || (files.length <= PER_FILE_LIMIT && await trial(cwd, scratch, 'f' + i, head, f.chunk));
      f.state = !fine ? 'conflict' : f.paths.some((p) => state.changedSinceBase.has(p)) ? 'merges' : 'applies';
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
  return { cwd, base, head, circle: selectedCircle, current_branch: current.code === 0 ? text(current) : null, files, tracked: state.tracked };
}

const publicView = (a) => ({ repo: a.cwd, base: a.base, head: a.head, current_branch: a.current_branch, working_tree: treeView(a.tracked),
  files: a.files.map(({ chunk, paths, ...f }) => f), per_file: a.files.length <= PER_FILE_LIMIT });

const BLOCKED = {
  yours: ['dirty', 'has uncommitted changes. Commit or stash them first.'],
  exists: ['path_exists', 'is already on disk (it may be ignored by Git). Move it away first.'],
  unsafe: ['unsafe_path', 'is inside a folder that is a link or a file on this computer.'],
  conflict: ['patch_conflict', 'conflicts with your version.'],
};

const worktreeHash = bytes => createHash('sha256').update(bytes).digest('hex');
const worktreeKey = record => 'worktree-apply:' + record.id;
const conflict = path => refuse('worktree_conflict', clean(path, 200) + ' changed while applying. Writing stopped; review this file and any saved recovery data before trying again.');

function fileImage(path) {
  let info;
  try { info = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return {kind:'absent'}; throw error; }
  let bytes, kind;
  if (info.isSymbolicLink()) { kind='link'; bytes=Buffer.from(readlinkSync(path)); }
  else if (info.isFile()) {
    kind='file';
    const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    try {
      const opened=fstatSync(fd);
      if(opened.dev!==info.dev||opened.ino!==info.ino)conflict(path);
      bytes=readFileSync(fd);
      const after=fstatSync(fd);
      if(after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)conflict(path);
    } finally {closeSync(fd);}
  } else refuse('unsafe_path',clean(path,200)+' is not a regular file or symbolic link.');
  return {kind,mode:info.mode&0o777,bytes:bytes.toString('base64'),hash:worktreeHash(bytes),dev:info.dev,ino:info.ino};
}
const sameImage=(a,b)=>a.kind===b.kind&&(a.kind==='absent'||(a.mode===b.mode&&a.hash===b.hash&&a.bytes===b.bytes));
const sameFile=(a,b)=>sameImage(a,b)&&(a.kind==='absent'||(a.dev===b.dev&&a.ino===b.ino));
function syncDirectory(path) {
  const fd=openSync(path,'r'); try {fsyncSync(fd);} finally {closeSync(fd);}
}
function safeParents(cwd,path) {
  if(unsafePatchPath(path))refuse('unsafe_path','The recovery path is not safe.');
  const parts=path.split('/');
  for(let i=1;i<parts.length;i++){
    const parent=join(cwd,...parts.slice(0,i));
    let info;try{info=lstatSync(parent);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!info.isDirectory()||info.isSymbolicLink())conflict(path);
  }
}
function checkFile(cwd,entry,expected,identity=false) {
  safeParents(cwd,entry.path);
  const current=fileImage(join(cwd,entry.path));
  if(!(identity?sameFile(current,expected):sameImage(current,expected)))conflict(entry.path);
}
function makeParents(cwd,path) {
  const parts=path.split('/');
  for(let i=1;i<parts.length;i++){
    const parent=join(cwd,...parts.slice(0,i));
    try {mkdirSync(parent,{mode:0o755});syncDirectory(dirname(parent));}
    catch(error){if(error.code!=='EEXIST')throw error;}
    if(!lstatSync(parent).isDirectory()||lstatSync(parent).isSymbolicLink())conflict(path);
  }
}
function stageImage(path,image) {
  let created=false;
  try {
    if(image.kind==='link'){symlinkSync(Buffer.from(image.bytes,'base64').toString(),path);created=true;}
    else {
      const fd=openSync(path,'wx',image.mode);created=true;
      try {writeFileSync(fd,Buffer.from(image.bytes,'base64'));fchmodSync(fd,image.mode);fsyncSync(fd);}
      finally {closeSync(fd);}
    }
    syncDirectory(dirname(path));
  } catch(error) {
    if(created){try{unlinkSync(path);}catch{}}
    throw error;
  }
}
function replaceFile(cwd,entry,expected,root,index) {
  makeParents(cwd,entry.path);
  const path=join(cwd,entry.path),backup=join(root,index+'.before.'+randomUUID()),prepared=join(dirname(path),'.faravan-'+randomUUID());
  let linked=false,preparedOwned=false;
  try {
    // A hard link retains the original inode, not just copied bytes. Re-reading
    // it after replacement detects in-place writes to that inode in the gap.
    if(expected.kind!=='absent'){
      linkSync(path,backup);linked=true;syncDirectory(root);
      if(!sameFile(fileImage(backup),expected))conflict(entry.path);
    }
    if(entry.target.kind!=='absent'){stageImage(prepared,entry.target);preparedOwned=true;}
    // Portable Node has no conditional rename. This synchronous comparison and
    // rename have no await between them, but an uncooperative editor (including
    // one replacing the inode or a parent directory) can still race the OS calls.
    // The retained inode detects in-place edits, NOT every atomic editor rename.
    checkFile(cwd,entry,expected,true);
    if(entry.target.kind==='absent'){if(expected.kind!=='absent')unlinkSync(path);}
    else {renameSync(prepared,path);preparedOwned=false;}
    if(linked&&!sameImage(fileImage(backup),expected))conflict(entry.path);
    syncDirectory(dirname(path));
    checkFile(cwd,entry,entry.target);
  } finally {
    // Backups belong to the durable record and stay on every error.
    if(preparedOwned){try{unlinkSync(prepared);}catch(error){if(error.code!=='ENOENT')throw error;}}
  }
}
function validImage(image,checkLink=false) {
  if(image?.kind==='absent')return true;
  if(!['file','link'].includes(image?.kind)||!Number.isInteger(image.mode)||image.mode<0||image.mode>0o777||
    typeof image.bytes!=='string'||typeof image.hash!=='string')return false;
  const bytes=Buffer.from(image.bytes,'base64');
  return bytes.toString('base64')===image.bytes&&worktreeHash(bytes)===image.hash&&
    (!checkLink||image.kind!=='link'||!unsafeSymlinkTarget(bytes.toString()));
}
async function worktreeLocation(cwd) {
  const common=await git(['rev-parse','--git-common-dir'],{cwd});
  const local=await git(['rev-parse','--absolute-git-dir'],{cwd});
  if(common.code!==0||local.code!==0)refuse('not_a_repository','Git could not locate the repository data.');
  return {common:resolve(cwd,text(common)),local:resolve(cwd,text(local))};
}

/** Replay only complete old/new images; unknown bytes always stop before writing. */
export async function reconcileWorktrees(device) {
  for(const circle of await device.listCircles()){
    const intents=device.intentStore(circle.id);
    for(const record of await intents.list()){
      if(record?.kind!=='worktree-apply'||record.circle!==circle.id||!applyOwnerGone(record.owner))continue;
      let release;
      try {
        if(record.version!==1||typeof record.id!=='string'||!/^[0-9a-f-]{36}$/.test(record.id)||
          typeof record.repo!=='string'||!isAbsolute(record.repo)||!Array.isArray(record.files)||!record.files.length)continue;
        const cwd=await realpath(record.repo);
        if(cwd!==record.repo||await repositoryAt(cwd)!==cwd)continue;
        const location=await worktreeLocation(cwd);
        if(dirname(record.root)!==location.local||!basename(record.root).startsWith('faravan-worktree-'))continue;
        const rootInfo=lstatSync(record.root);
        if(!rootInfo.isDirectory()||rootInfo.isSymbolicLink())continue;
        if(record.files.some(entry=>typeof entry.path!=='string'||unsafePatchPath(entry.path)||!validImage(entry.before)||!validImage(entry.target,true)))continue;
        if(new Set(record.files.map(entry=>entry.path)).size!==record.files.length)continue;
        release=await previewGuard(location.common,{timeoutMs:30000});
        const head=text(await git(['rev-parse','HEAD'],{cwd}));
        const branch=await git(['symbolic-ref','--short','-q','HEAD'],{cwd});
        if(head!==record.head||(branch.code===0?text(branch):null)!==record.branch)continue;
        // Preflight the whole group before replay; don't partly recover around a
        // later user edit. A conflict during replay also retains every image.
        for(const [index,entry] of record.files.entries()){
          for(const name of readdirSync(record.root).filter(name=>name.startsWith(index+'.before.'))){
            if(!sameImage(fileImage(join(record.root,name)),entry.before))conflict(entry.path);
          }
          safeParents(cwd,entry.path);
          const current=fileImage(join(cwd,entry.path));
          if(!sameImage(current,entry.before)&&!sameImage(current,entry.target))conflict(entry.path);
        }
        try{
          for(const [index,entry] of record.files.entries()){
            const current=fileImage(join(cwd,entry.path));
            if(sameImage(current,entry.target))continue;
            if(!sameImage(current,entry.before))conflict(entry.path);
            replaceFile(cwd,entry,current,record.root,index);
          }
          for(const entry of record.files)checkFile(cwd,entry,entry.target);
          await intents.delete(worktreeKey(record));
          await rm(record.root,{recursive:true,force:true});
        }catch(error){
          // Keep displaced inode copies as well as the durable byte images.
          console.warn('Faravan: worktree recovery needs review: '+clean(error.message,400));
        }
      }catch(error){
        console.warn('Faravan: worktree recovery needs review: '+clean(error.message,400));
      }finally{if(release)release();}
    }
  }
}

/**
 * The web app's Apply to working tree. `dryRun` returns each file's state. A real run takes the files to apply
 * (`files`: paths from the preview; null = all) and `expect` = {head, current_branch} from the preview: if the repository
 * moved it writes nothing and returns the new state with status 'changed'. Every selected file must apply or merge
 * cleanly; otherwise nothing is written.
 */
export async function workingTreeForApp({ digest, circle, repo, files = null, dryRun = true, expect = null, device, signal } = {}) {
  const now = await analyse({ digest, circle, repo, device, signal });
  if (dryRun) return { ...publicView(now), status: 'dry_run' };
  if (!expect || expect.head !== now.head || (expect.current_branch ?? null) !== now.current_branch) return { ...publicView(now), status: 'changed' };
  const byPath = new Map(now.files.map((f) => [f.path, f]));
  const picked = files === null ? now.files : files.map((path) => byPath.get(path) ?? refuse('unknown_file', `${clean(path, 200)} is not a file in this result.`));
  if (!picked.length) refuse('nothing_selected', 'Choose at least one file.');
  if (files !== null && now.files.length > PER_FILE_LIMIT && picked.length !== now.files.length) refuse('too_many_files', `This result changes more than ${PER_FILE_LIMIT} files; apply all of it or add it as a branch.`);
  // A clean tree (no staged or unstaged change to any tracked file) keeps the apply undoable: afterwards every change
  // in the tree is this result's, so the `undo` lists below are exact. Untracked files elsewhere are not touched.
  if (now.tracked.size) refuse('dirty', `${clean([...now.tracked].sort()[0], 200)}${now.tracked.size > 1 ? ` and ${now.tracked.size - 1} more files have` : ' has'} uncommitted changes. Commit or stash them first. Nothing was written.`);
  for (const f of picked) {
    const blocked = BLOCKED[f.state];
    if (blocked) refuse(blocked[0], `${clean(f.path, 200)} ${blocked[1]} Nothing was written.`);
  }
  const paths = new Set(picked.flatMap((f) => f.paths));
  const d=await (device??openDevice());
  const selected=await d.selectCircle(now.circle),intents=d.intentStore(selected.id);
  const location=await worktreeLocation(now.cwd);
  const release=await previewGuard(location.common,{timeoutMs:30000});
  let scratch,root,journaled=false;
  try {
    // A pending update from any circle owns this worktree until reconciled.
    for(const item of await d.listCircles()){
      if((await d.intentStore(item.id).list()).some(record=>record?.kind==='worktree-apply'&&record.repo===now.cwd))
        refuse('worktree_conflict','This folder has an unfinished file update. Review its recovery data before applying another result.');
    }
    const before=new Map([...paths].map(path=>{safeParents(now.cwd,path);return [path,fileImage(join(now.cwd,path))];}));
    scratch=await mkdtemp(join(tmpdir(),'faravan-worktree-'));
    const env = await trial(now.cwd, scratch, 'pick', now.head, Buffer.concat(picked.map((f) => f.chunk)));
    if (!env) refuse('patch_conflict', 'These files do not apply together. Nothing was written.');
    await linksAreSafe(now.cwd, env, paths);
    const tree = await git(['write-tree'], { cwd: now.cwd, env });
    if (tree.code !== 0) refuse('patch_conflict', 'git could not build the result: ' + firstLine(tree, 'unknown error'));
    // Look again right before writing: a commit, a branch switch or an edit since the analysis stops the write.
    const head = text(await git(['rev-parse', 'HEAD'], { cwd: now.cwd }));
    const current = await git(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: now.cwd });
    if (head !== now.head || (current.code === 0 ? text(current) : null) !== now.current_branch) return { ...publicView(await analyse({ digest, circle, repo, device, signal })), status: 'changed' };
    const again = await workingState(now.cwd, { base: now.base, head });
    if (again.tracked.size) refuse('dirty', 'Files changed while applying. Nothing was written.');
    for (const path of paths) {
      if (again.dirty.has(path) || await onDisk(now.cwd, path, again.inHead.has(path))) refuse('dirty', `${clean(path, 200)} changed while applying. Nothing was written.`);
    }
    await safeCheckoutInputs(now.cwd,[...paths]);
    // Let Git perform checkout conversions only in a private worktree.
    const checkout=join(scratch,'checkout');await mkdir(checkout);
    const checkoutEnv={...LITERAL,GIT_WORK_TREE:checkout,GIT_INDEX_FILE:join(scratch,'checkout-index')};
    if((await git(['read-tree',now.head],{cwd:now.cwd,env:checkoutEnv})).code!==0)
      refuse('write_failed','Git could not prepare the file update.');
    const wrote = await git(['--attr-source='+now.head,'restore', '--source=' + text(tree), '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
      { cwd: now.cwd, env: checkoutEnv, input: [...paths].join('\0') });
    if (wrote.code !== 0) refuse('write_failed', 'Git could not prepare the files: ' + firstLine(wrote, 'unknown error'));
    const entries=[...paths].map(path=>({path,before:before.get(path),target:fileImage(join(checkout,path))}));
    for(const entry of entries)checkFile(now.cwd,entry,entry.before,true);
    // Original inode evidence needs hard links. A separate-filesystem Git
    // directory is unsupported: stop before journaling or replacing any file.
    const storage=await stat(location.local);
    if(entries.some(entry=>entry.before.kind!=='absent'&&entry.before.dev!==storage.dev))
      refuse('worktree_filesystem','This folder and its Git data are on different filesystems. Add the result as a branch instead. Nothing was written.');
    root=await mkdtemp(join(location.local,'faravan-worktree-'));
    syncDirectory(location.local);
    const record={kind:'worktree-apply',version:1,id:randomUUID(),circle:selected.id,repo:now.cwd,
      head:now.head,branch:now.current_branch,owner:applyOwner(),root,files:entries};
    // The device intent store fsyncs both bytes and directory before resolving.
    // Every path has immutable old/target bytes, type, mode and SHA-256.
    journaled=true;
    await intents.set(worktreeKey(record),record);
    // Staging and durable persistence can take arbitrarily long. Recheck the
    // preview AFTER both, not only before those asynchronous operations.
    const finalHead=text(await git(['rev-parse','HEAD'],{cwd:now.cwd}));
    const finalBranch=await git(['symbolic-ref','--short','-q','HEAD'],{cwd:now.cwd});
    if(finalHead!==now.head||(finalBranch.code===0?text(finalBranch):null)!==now.current_branch){
      await intents.delete(worktreeKey(record));journaled=false;
      return {...publicView(await analyse({digest,circle:selected.id,repo,device:d,signal})),status:'changed'};
    }
    for(const [index,entry] of entries.entries())replaceFile(now.cwd,entry,entry.before,root,index);
    for(const entry of entries)checkFile(now.cwd,entry,entry.target);
    await intents.delete(worktreeKey(record));journaled=false;
    const added = [...paths].filter((p) => !again.inHead.has(p)), tracked = [...paths].filter((p) => again.inHead.has(p));
    return { ...publicView(now), status: 'applied', applied: picked.map((f) => f.path), undo: { restore: tracked, remove: added } };
  } finally {
    try {
      if(scratch)await rm(scratch,{recursive:true,force:true});
      if(root&&!journaled)await rm(root,{recursive:true,force:true});
    } finally {release();}
  }
}

/**
 * Remove this branch (the undo of Add as a branch), only while untouched: `applied` is the app's own record
 * {branch, repo, commit}. The branch must still point at that exact commit, the commit must name this job, and no
 * worktree may have it checked out. The delete is a compare-and-delete (`update-ref -d REF OLD`), never a force.
 * A branch already gone returns status 'gone'.
 */
export async function removeBranchForApp({ digest, applied, dryRun = false } = {}) {
  if (!DIGEST.test(digest ?? '')) refuse('invalid_job', 'That is not a job ID.');
  const { branch, repo, commit } = applied ?? {};
  if (typeof branch !== 'string' || !branch || !COMMIT.test(commit ?? '')) refuse('not_applied', 'This result was not added as a branch here.');
  if (branch.startsWith('-') || (await git(['check-ref-format', 'refs/heads/' + branch])).code !== 0) refuse('not_applied', 'The saved branch name is not valid.');
  const cwd = await repositoryAt(repo);
  if (cwd !== repo) refuse('repo_missing', `${clean(repo, 200)} is no longer the top of the repository.`);
  const ref = 'refs/heads/' + branch;
  const now = await git(['rev-parse', '-q', '--verify', ref], { cwd });
  if (now.code !== 0) return { status: 'gone', branch, repo, commit };
  if (text(now) !== commit) refuse('branch_moved', `${clean(branch, 200)} has commits that Faravan did not make. It was left alone.`);
  const message = await git(['log', '-1', '--format=%B', commit], { cwd });
  if (!message.stdout.toString('utf8').split('\n').some(line => line === 'Faravan-Job: ' + digest || line === 'Faravan-Job: ' + digest)) refuse('not_our_commit', `${clean(branch, 200)} does not hold this result. It was left alone.`);
  const worktrees = await git(['worktree', 'list', '--porcelain', '-z'], { cwd });
  if (worktrees.stdout.toString('utf8').split('\0').includes('branch ' + ref)) refuse('branch_checked_out', `${clean(branch, 200)} is checked out. Switch to another branch first.`);
  if (dryRun) return { status: 'removable', branch, repo, commit };
  const removed = await git(['update-ref', '-m', 'faravan remove-branch', '-d', ref, commit], { cwd });
  if (removed.code !== 0) refuse('branch_moved', `${clean(branch, 200)} changed while removing it. It was left alone.`);
  return { status: 'removed', branch, repo, commit };
}
