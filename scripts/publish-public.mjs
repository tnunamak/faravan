#!/usr/bin/env node
// Default dry run verifies the destination and stages a private preview; only --push publishes.
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, isAbsolute, join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {EXCLUDED, exportPublicTree} from './public-tree.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {maxBuffer:256 * 1024 * 1024});
const gitText = (root, ...args) => git(root, ...args).toString().trim();

const historyEnv = {...process.env, GIT_NO_REPLACE_OBJECTS:'1'};
function gitInput(root, args, input, env = historyEnv) {
  return execFileSync('git', ['-C', root, ...args], {input, env, maxBuffer:256 * 1024 * 1024});
}
function tip(root) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', '--verify', '-q', 'HEAD^{commit}'],
    {env:historyEnv, encoding:'utf8'});
  if (result.status === 1) return null;
  if (result.error || result.status !== 0) throw new Error('could not read public clone HEAD', {cause:result.error});
  return result.stdout.trim();
}
// Public commits carry only a GitHub noreply identity: a real mailbox must never enter public history.
const NOREPLY = /^(?:\d+\+)?[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?@users\.noreply\.github\.com$/;
function approvedAuthor(author) {
  const match = /^([^<>\r\n]+?) <([^<>\s]+@[^<>\s]+)>$/.exec(author ?? '');
  if (!match || !match[1].trim()) throw new Error('author is required: Name <email>');
  if (!NOREPLY.test(match[2]))
    throw new Error('author email must be a GitHub noreply address (<id>+<login>@users.noreply.github.com)');
  return {name:match[1], email:match[2]};
}
// The deny file is private and local: one marker per line, # comments. A plain line is a literal,
// case-insensitive substring. A `word:<text>` line is a case-sensitive whole word: <text> must not touch an
// ASCII letter on either side, so `word:Ann` refuses "Ann" and "Ann's" but not "annual" or "Annex".
// Findings name the exported file, the line and the deny-file line number, never the marker itself.
const WORD_PREFIX = 'word:';
function loadDenyMarkers(denyFile, inside) {
  if (typeof denyFile !== 'string' || !isAbsolute(denyFile)) throw new Error('deny file must be an absolute path');
  const file = resolve(denyFile);
  if (inside.some(root => file === root || file.startsWith(root+'/')))
    throw new Error('deny file must stay outside the source repository, public clone and export: '+file);
  const markers = [];
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((raw, i) => {
    const marker = raw.trim();
    if (!marker || marker.startsWith('#')) return;
    const text = marker.startsWith(WORD_PREFIX) ? marker.slice(WORD_PREFIX.length) : null;
    if (text === '') throw new Error(`deny file line ${i+1}: a word: marker needs a word`);
    const latin1 = Buffer.from(text ?? marker, 'utf8').toString('latin1');
    if (text === null) markers.push({line:i+1, needle:latin1.toLowerCase()});
    else markers.push({line:i+1, word:new RegExp(`(?<![A-Za-z])${latin1.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}(?![A-Za-z])`)});
  });
  if (!markers.length) throw new Error('deny file has no markers: '+file);
  return {file, markers};
}
// One exemption: the copyright line of LICENSE.md. It is keyed on the exact path and the whole line, and it waives
// only word: entries. Any other line of that file, any other file (also one that holds this same line), any file name,
// any archive member and any plain entry is still scanned. The holder's first name is built from parts so this file
// does not carry the word into the public tree.
const LICENSE_EXEMPTION = {path:'LICENSE.md', line:`Copyright 2026 ${['T', 'i', 'm'].join('')} Nunamaker`};
const denyMatches = (marker, text, lower) => marker.word ? marker.word.test(text) : lower.includes(marker.needle);
function denyScan({output, files, deny}) {
  const hits = [];
  const view = bytes => bytes.toString('latin1');
  files.forEach(({path}, index) => {
    const absolute = join(output, path), stat = lstatSync(absolute);
    // A file name can itself carry a marker, so such a file is named by its manifest position, never by path.
    const name = view(Buffer.from(path)), lowerName = name.toLowerCase();
    const nameMarkers = deny.markers.filter(marker => denyMatches(marker, name, lowerName));
    const label = nameMarkers.length ? `export file #${index} (exported[${index}] in manifest.json)` : path;
    for (const {line} of nameMarkers) hits.push(`${label}: file name (deny-file line ${line})`);
    const scanText = (where, text, exemptRow = null) => {
      const lowerRows = text.toLowerCase().split('\n');
      text.split('\n').forEach((row, i) => {
        for (const marker of deny.markers) {
          if (!denyMatches(marker, row, lowerRows[i])) continue;
          if (marker.word && row === exemptRow) continue;
          hits.push(`${where}:${i+1} (deny-file line ${marker.line})`);
        }
      });
    };
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    scanText(label, view(bytes), path === LICENSE_EXEMPTION.path && !stat.isSymbolicLink() ? LICENSE_EXEMPTION.line : null);
    if (/\.(?:gz|tgz)$/.test(path)) {
      let inner; // Archive members are exported content too; refuse what cannot be read.
      try { inner = gunzipSync(bytes); } catch (cause) { throw new Error('cannot inspect archive for private markers: '+label, {cause}); }
      scanText(label+' [inside archive]', view(inner));
    }
  });
  if (hits.length) throw new Error(`export refused: private markers found (deny file ${deny.file}); ${hits.length} hit(s):\n`+
    hits.slice(0, 100).map(hit => '  '+hit).join('\n')+(hits.length > 100 ? `\n  … ${hits.length-100} more` : ''));
}
function verifyDestination(publicClone, dest) {
  if (typeof dest !== 'string' || !dest || dest.startsWith('-') || /[\r\n\0]/.test(dest))
    throw new Error('an explicit destination URL is required');
  if (!isAbsolute(dest) && !/^(https:\/\/|ssh:\/\/|git@github\.com:)/.test(dest))
    throw new Error('destination must be an explicit HTTPS or SSH URL or absolute local path');
  const config = git(publicClone, 'config', '--null', '--list').toString().split('\0');
  if (config.some(entry => /^url\..+\.(?:insteadof|pushinsteadof)\n/i.test(entry)))
    throw new Error('destination cannot be verified with Git URL rewriting enabled');
  const urls = [...gitText(publicClone, 'remote', 'get-url', '--all', 'origin').split('\n'),
    ...gitText(publicClone, 'remote', 'get-url', '--push', '--all', 'origin').split('\n')];
  if (urls.some(url => url !== dest)) throw new Error('origin fetch and push URLs must match the approved destination');
}
function requirePublicHistory(sourceRepo, publicClone, head) {
  if (!head) return;
  if (gitText(publicClone, 'rev-parse', '--is-shallow-repository') === 'true')
    throw new Error('public clone must have full history');
  const commits = gitInput(publicClone, ['rev-list', head]).toString().trim().split('\n');
  const objects = gitInput(sourceRepo, ['cat-file', '--batch-check'], commits.join('\n')+'\n').toString().trim().split('\n');
  if (objects.length !== commits.length || objects.some((row,i) => row !== commits[i]+' missing'))
    throw new Error('public clone contains source history or its ancestry could not be verified');
}
function destinationTip(publicClone, dest) {
  const refs = gitText(publicClone, 'ls-remote', '--refs', '--', dest);
  if (!refs) return null;
  const advertised = refs.split('\n').map(row => row.split('\t')).find(([,ref]) => ref === 'refs/heads/main')?.[0];
  if (!advertised) throw new Error('non-empty destination has no main branch');
  git(publicClone, 'fetch', '--no-tags', '--no-recurse-submodules', '--', dest, 'refs/heads/main');
  const fetched = gitText(publicClone, 'rev-parse', 'FETCH_HEAD^{commit}');
  if (fetched !== advertised) throw new Error('destination main changed during verification; retry with a fresh read');
  return fetched;
}
function scanTree({scanner, scratch, output, audit, push}) {
  const log = join(audit, 'secret-scan.log');
  const config = join(scratch, '.gitleaks.toml');
  const args = ['dir', '--no-banner', '--redact', '--exit-code', '1', '--max-archive-depth', '3', ...(existsSync(config) ? ['--config', config] : []), output];
  try {
    const result = typeof scanner === 'function'
      ? scanner({output, config:existsSync(config) ? config : null})
      : spawnSync(scanner ?? 'gitleaks', args, {cwd:scratch, encoding:'utf8', maxBuffer:8 * 1024 * 1024});
    if (result?.error?.code === 'ENOENT' && !scanner && !push) {
      writeFileSync(log, 'gitleaks unavailable; dry run not scanned\n', {mode:0o600});
      return false;
    }
    writeFileSync(log, (result?.stdout ?? '')+(result?.stderr ?? ''), {mode:0o600});
    if (result?.error || result?.status !== 0) throw new Error('secret scanner refused the exported tree');
    return true;
  } catch (cause) {
    if (!existsSync(log)) writeFileSync(log, 'secret scanner failed to complete\n', {mode:0o600});
    throw new Error('secret scan did not pass; see '+log, {cause});
  }
}
function stageExport(publicClone, output, audit, files, scan) {
  const gitDir = gitText(publicClone, 'rev-parse', '--absolute-git-dir');
  const env = {...historyEnv, GIT_INDEX_FILE:join(audit, 'export.index')};
  const staged = (...args) => gitInput(output, ['--git-dir', gitDir, '--work-tree', output, ...args], undefined, env);
  staged('read-tree', '--empty');
  staged('add', '-f', '-A', '--', '.');
  const expected = () => files.map(({path, mode}) => {
    const absolute = join(output,path), stat = lstatSync(absolute);
    if (!stat.isSymbolicLink() && !stat.isFile()) throw new Error('unexpected export file type: '+path);
    const actualMode = stat.isSymbolicLink() ? '120000' : (stat.mode & 0o100) ? '100755' : '100644';
    if (actualMode !== mode) throw new Error('exported mode differs from reviewed mode: '+path);
    const bytes = stat.isSymbolicLink() ? readlinkSync(absolute,{encoding:'buffer'}) : readFileSync(absolute);
    const blob = gitInput(publicClone, ['hash-object', '--stdin'], bytes).toString().trim();
    return mode+' '+blob+' 0\t'+path;
  }).sort();
  const entries = () => staged('ls-files','-s','-z').toString().split('\0').filter(Boolean).sort();
  const assertSame = (left,right) => {
    if (JSON.stringify(left)!==JSON.stringify(right)) throw new Error('staged tree differs from reviewed export');
  };
  const wanted = expected();
  assertSame(entries(), wanted);
  const scanned = scan();
  assertSame(expected(), wanted);
  staged('add', '-f', '-A', '--', '.');
  assertSame(entries(), wanted);
  const tree = staged('write-tree').toString().trim();
  const actualTree = gitInput(publicClone, ['ls-tree','-rz',tree]).toString().split('\0').filter(Boolean)
    .map(row => row.replace(/^(\d+) blob ([0-9a-f]+)\t/, '$1 $2 0\t')).sort();
  assertSame(actualTree, wanted);
  return {tree,scanned};
}

export function publishPublic({commit, publicClone, dest, author, scanner, denyFile, sourceRepo = ROOT, push = false,
  scratchRoot = join(homedir(), 'code/faravan/.worktrees')}) {
  if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('source must be a full trunk commit SHA');
  sourceRepo = resolve(sourceRepo); publicClone = resolve(publicClone);
  if (gitText(publicClone, 'rev-parse', '--show-toplevel') !== publicClone) throw new Error('public clone must be a repository root');
  const commonDir = root => resolve(root, gitText(root, 'rev-parse', '--git-common-dir'));
  if (commonDir(sourceRepo) === commonDir(publicClone)) throw new Error('public clone must have independent Git history');
  if (gitText(publicClone, 'symbolic-ref', '--short', 'HEAD') !== 'main') throw new Error('public clone must be on main');
  if (gitText(publicClone, 'status', '--porcelain', '--untracked-files=all') ||
      gitText(publicClone, 'ls-files', '--others', '--ignored', '--exclude-standard')) throw new Error('public clone must be clean, including ignored files');
  // Resolve and validate before any filesystem replacement. Never import source history into the clone.
  git(sourceRepo, 'cat-file', '-e', `${commit}^{commit}`);
  const {name,email} = approvedAuthor(author);
  if (push && !denyFile) throw new Error('--deny-file is required to push: the private-marker check cannot be skipped');
  const deny = denyFile ? loadDenyMarkers(denyFile, [sourceRepo, publicClone]) : null;
  if (!deny) process.stderr.write('WARNING: no --deny-file; private markers were NOT checked. A push requires one.\n');
  verifyDestination(publicClone,dest);
  const head = tip(publicClone);
  requirePublicHistory(sourceRepo,publicClone,head);
  const remote = destinationTip(publicClone,dest);
  if (!remote && head) throw new Error('bootstrap requires an unborn public main');
  if (remote && !head) throw new Error('reset the clone to the destination main tip');
  let retry = false;
  if (remote && head !== remote) {
    const parents = gitInput(publicClone,['rev-list','--parents','-n','1',head]).toString().trim().split(' ');
    const trailers = gitText(publicClone,'show','-s','--format=%(trailers:only,unfold=true)',head).split('\n');
    const heldTree = gitText(publicClone,'rev-parse',head+'^{tree}');
    const identity = gitText(publicClone,'show','-s','--format=%an <%ae>%n%cn <%ce>',head);
    retry = parents.length === 2 && parents[1] === remote && identity === author+'\n'+author &&
      trailers.filter(line=>line.startsWith('Public-Tree:')).join('') === 'Public-Tree: '+heldTree;
    if (!retry) throw new Error('reset the clone to the destination main tip');
  }
  const commitArgs = ['-c', `user.name=${name}`, '-c', `user.email=${email}`, '-c', 'commit.gpgsign=false',
    'commit', '--no-verify', '--allow-empty', `--author=${name} <${email}>`, '-m'];
  const makeCommit = (root, message) => execFileSync('git', ['-C', root, ...commitArgs, message], {
    env:{...process.env, GIT_AUTHOR_NAME:name, GIT_AUTHOR_EMAIL:email, GIT_COMMITTER_NAME:name, GIT_COMMITTER_EMAIL:email},
    maxBuffer:256 * 1024 * 1024,
  });
  mkdirSync(scratchRoot, {recursive:true});
  const scratch = mkdtempSync(join(scratchRoot, 'publish-public-'));
  const audit = mkdtempSync(join(dirname(publicClone), 'public-export-'));
  const output = join(audit, 'tree'), manifest = join(audit, 'manifest.json');
  let added = false;
  try {
    git(sourceRepo, 'worktree', 'add', '--detach', scratch, commit); added = true;
    // The codemod imports the project's parser and regenerates signed test fixtures.
    if (existsSync(join(scratch, 'package-lock.json'))) {
      const install = spawnSync('npm', ['ci'], {cwd:scratch, encoding:'utf8', maxBuffer:256 * 1024 * 1024});
      writeFileSync(join(audit, 'npm-ci.log'), `${install.stdout ?? ''}${install.stderr ?? ''}`);
      if (install.error || install.status !== 0) throw new Error(`source npm ci failed; see ${audit}/npm-ci.log`, {cause:install.error});
    }
    for (const flag of ['--apply', '--check']) {
      const result = spawnSync(process.execPath, ['scripts/rename/faravan-codemod.mjs', flag],
        {cwd:scratch, encoding:'utf8', maxBuffer:256 * 1024 * 1024});
      writeFileSync(join(audit, `rename-${flag.slice(2)}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
      if (result.error || result.status !== 0) throw new Error(`rename ${flag} failed; see ${audit}/rename-${flag.slice(2)}.log`, {cause:result.error});
    }
    git(scratch, 'add', '-A');
    makeCommit(scratch, `Rename source for public export ${commit.slice(0, 12)}`);
    const {commit:renamedCommit, rows, files} = exportPublicTree(scratch, output);
    const exported = new Set(files.map(row => row.path));
    writeFileSync(manifest, JSON.stringify({sourceCommit:commit, renamedCommit,
      excluded:rows.filter(row => !exported.has(row.path)).map(({path}) => ({path,
        reason:EXCLUDED.find(prefix => path.startsWith(prefix)) ?? 'not in ALLOWLIST'})),
      exported:files.map(({path}) => ({path,
        sha256:createHash('sha256').update(git(scratch, 'show', `HEAD:${path}`)).digest('hex')})),
    }, null, 2) + '\n');
    const {tree,scanned} = stageExport(publicClone,output,audit,files,()=>{
      if (deny) denyScan({output, files, deny});
      return scanTree({scanner,scratch,output,audit,push});
    });
    const headTree = head && gitText(publicClone,'rev-parse',head+'^{tree}');
    const unchanged = headTree === tree;
    if (retry && !unchanged) throw new Error('retry tree changed; reset the clone to the destination main tip');
    let publicCommit = unchanged ? head : null;
    if (push) {
      verifyDestination(publicClone,dest);
      if (gitText(publicClone,'status','--porcelain','--untracked-files=all') ||
          gitText(publicClone,'ls-files','--others','--ignored','--exclude-standard'))
        throw new Error('public clone changed during verification');
      if (destinationTip(publicClone,dest)!==remote || tip(publicClone)!==head)
        throw new Error('destination or local main moved during verification');
      if (!unchanged) {
        const message = 'Faravan public source\n\nPublic-Tree: '+tree;
        publicCommit = gitInput(publicClone,['-c','commit.gpgsign=false','commit-tree',tree,
          ...(head ? ['-p',head] : []),'-m',message],undefined,{...historyEnv,GIT_AUTHOR_NAME:name,
          GIT_AUTHOR_EMAIL:email,GIT_COMMITTER_NAME:name,GIT_COMMITTER_EMAIL:email}).toString().trim();
        git(publicClone,'update-ref','refs/heads/main',publicCommit,head ?? '0'.repeat(tree.length));
        git(publicClone,'reset','--hard',publicCommit);
      }
      if (!unchanged || retry) {
        if (tip(publicClone)!==publicCommit) throw new Error('public main moved before push');
        // Push the verified, scanned commit by SHA, never the mutable HEAD.
        git(publicClone,'push','--no-follow-tags','--recurse-submodules=no','--',dest,publicCommit+':refs/heads/main');
      }
    }
    return {publicCommit,sourceCommit:commit,renamedCommit,fileCount:files.length,output,manifest,audit,
      tree,scanned,denyChecked:Boolean(deny),unchanged,pushed:push && (!unchanged || retry)};
  } finally {
    if (added) git(sourceRepo, 'worktree', 'remove', '--force', scratch);
    else rmSync(scratch, {recursive:true, force:true});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), positional = [];
    let dest,author,denyFile,push=false;
    for (let i=0;i<args.length;i++) {
      if (args[i]==='--push') push=true;
      else if (args[i]==='--dest' && dest===undefined) dest=args[++i];
      else if (args[i]==='--author' && author===undefined) author=args[++i];
      else if (args[i]==='--deny-file' && denyFile===undefined) denyFile=args[++i];
      else if (args[i].startsWith('--')) throw new Error('unknown or repeated publish option: '+args[i]);
      else positional.push(args[i]);
    }
    if (positional.length!==2 || !dest || !author) throw new Error('usage: node scripts/publish-public.mjs <full trunk SHA> <public clone on main> --dest <url> --author "Name <noreply email>" [--deny-file <absolute path>; required with --push] [--push]');
    console.log(JSON.stringify(publishPublic({commit:positional[0], publicClone:positional[1], dest, author, denyFile:denyFile && resolve(denyFile), push}), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
