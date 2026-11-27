// Read-only project inspection. inspectRepo describes Git facts; inspectProject adds
// filtered snapshot previews and supports plain folders. Neither writes to the project.
import { execFile } from 'node:child_process';
import { readFile, stat, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { sourceFileOmission } from './secret-files.mjs';
import { changedFiles } from '../git-source-status.mjs';
import { buildSourceManifest } from '../source-manifest.mjs';
import { workingTreeSource } from './run.mjs';
import { expandPath, innerRepos, nearSiblings } from './folders.mjs';
import { packageSourceDirectory } from '../source-package.mjs';

const exec = promisify(execFile);

export class RepoError extends Error {
  constructor(code, message, {path, suggestions} = {}) {
    super(message); this.name = 'RepoError'; this.code = code;
    if (path !== undefined) this.path = path;
    if (suggestions !== undefined) this.suggestions = suggestions;
  }
  /** What the app sends back about a refusal: the plain message, the normalized path, and folders to try instead. */
  details() { return {message:this.message, ...(this.path === undefined ? {} : {path:this.path}), ...(this.suggestions ? {suggestions:this.suggestions} : {})}; }
}
/** Each refusal is one composer state; the message is plain words, never a git error. */
export const REPO_STATES = {
  repo_missing: 'compose.repo-missing',
  not_git: 'compose.not-git',
  no_commits: 'compose.no-commits',
};
export const repoStateOf = code => REPO_STATES[code] ?? 'compose.repo-missing';

const git = async (cwd, args) => (await exec('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: {...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'},
})).stdout;

/** `home` expands `~`, `$HOME` and relative paths; it defaults to this user's home folder. */
export async function inspectRepo(input, {home = process.env.HOME || homedir()} = {}) {
  const path = expandPath(input, home);
  if (path === null) throw new RepoError('repo_missing', 'Give the path of the folder, for example ~/code/project.');
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new RepoError('repo_missing', 'No folder at ' + path, {path, suggestions:await nearSiblings(path)});
  let top;
  try { top = (await git(path, ['rev-parse', '--show-toplevel'])).trim(); }
  catch (error) {
    if (error.code === 'ENOENT') throw new RepoError('git_missing', 'git is not installed on this computer, so Faravan cannot send a project.', {path});
    throw new RepoError('not_git', 'Faravan sends a git repository so changes can come back as a branch. Run git init in this folder, or choose another folder.', {path, suggestions:await innerRepos(path)});
  }
  let head;
  try { head = (await git(top, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])).trim(); }
  catch { throw new RepoError('no_commits', 'This repository has no commits yet. Make a first commit, then send it.', {path:top}); }
  const branch = (await git(top, ['branch', '--show-current']).catch(() => '')).trim() || null;
  const committed = (await git(top, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'])).split('\0').filter(Boolean);
  const files = committed.length;
  const changed = await changedFiles(top);
  const tracked = new Set((await git(top, ['ls-files', '-z', '--cached'])).split('\0').filter(Boolean));
  const working = [...new Set((await git(top, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).split('\0').filter(Boolean))];
  const sourceOmissions = {
    head: (await packageSourceDirectory(top)).omitted,
    workingTree: [],
  };
  for (const file of working) {
    let omission = sourceFileOmission(file, {tracked:tracked.has(file)});
    // O_NOFOLLOW/nonblocking keep a replaced symlink or FIFO out of preview reads.
    if (!omission && await realpath(dirname(join(top,file))).catch(()=>null) === dirname(join(top,file))) {
      const handle=await open(join(top,file),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(()=>null);
      if(handle)try {
        if((await handle.stat()).isFile()) {
          const bytes=Buffer.alloc(32),{bytesRead}=await handle.read(bytes,0,32,0);
          omission=sourceFileOmission(file,{tracked:tracked.has(file),bytes:bytes.subarray(0,bytesRead)});
        }
      } finally {await handle.close();}
    }
    if (!omission) continue;
    try { if ((await lstat(join(top, file))).isFile()) sourceOmissions.workingTree.push(omission); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const excludedChanges=new Set(sourceOmissions.workingTree.map(file=>file.path));
  const excludedHead=new Set(sourceOmissions.head.map(file=>file.path));
  const sendableChanged=changed.filter(file=>!excludedChanges.has(file.path)&&
    !(file.code==='D'&&excludedHead.has(file.path))&&!sourceFileOmission(file.path,{tracked:tracked.has(file.path)}));
  const sendableChangedCount=sendableChanged.length;
  let testCommand = '';
  try {
    const file = join(top, 'package.json');
    if ((await stat(file)).size <= 1024 * 1024 && JSON.parse(await readFile(file, 'utf8'))?.scripts?.test?.trim())
      testCommand = 'npm test';
  } catch { /* A project without a readable package test leaves the check optional. */ }
  return {path: top, name: basename(top), branch, head, files, changed: sendableChanged.slice(0, 200), changed_count: changed.length, testCommand, sourceOmissions, sendableChangedCount};
}

/** Composer inspection also supports a plain folder; Git-specific callers retain inspectRepo. */
export async function inspectProject(input,options={}) {
  try{
    const repo=await inspectRepo(input,options);if(options.manifest===false)return {kind:'git',...repo};
    const head=await packageSourceDirectory(repo.path);
    const headManifest=buildSourceManifest(head.buffer,{omitted:head.omitted,includeOmittedPaths:true});
    const working=repo.changed_count?await workingTreeSource(repo.path):null;
    return {kind:'git',...repo,sourceManifests:{head:headManifest,workingTree:working?buildSourceManifest(working.sourceTar,{omitted:working.sourceOmissions,includeOmittedPaths:true}):headManifest}};
  }
  catch(error){
    if(!(error instanceof RepoError)||!['not_git','no_commits'].includes(error.code))throw error;
    const path=error.path;
    const {folderFiles,sourceFilesArchive}=await import('./source-ingest.mjs');
    if(options.manifest===false)return {kind:'folder',path,name:basename(path),branch:null,head:null,changed:[],changed_count:0,suggestions:error.suggestions||[]};
    const snapshot=await folderFiles(path);
    const tar=sourceFilesArchive(snapshot.files);
    const sourceManifest=buildSourceManifest(tar,{omitted:snapshot.omitted,includeOmittedPaths:true});
    return {kind:'folder',sourceManifest,path,name:basename(path),branch:null,head:null,files:snapshot.files.length,bytes:snapshot.bytes,
      changed:[],changed_count:0,sendableChangedCount:0,testCommand:'',sourceOmissions:{head:snapshot.omitted,workingTree:snapshot.omitted},suggestions:error.suggestions||[]};
  }
}
