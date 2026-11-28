import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './helpers/git-guest.mjs';
import { appFixture, api, browserApi } from './helpers/v1-app-fixture.mjs';
import { inspectRepo, inspectProject, RepoError } from '../lib/v1/repo-source.mjs';
import { expandPath, listFolders, scanRepos, createFolderService, FolderError } from '../lib/v1/folders.mjs';
import { OPS } from '../lib/v1/ops/registry.mjs';

// The composer's folder picker: typed paths are forgiving, refusals carry where the person probably meant, and the
// browser only ever walks inside the person's home folder.
const tempHome = async t => { const dir = await realpath(await mkdtemp(join(tmpdir(), 'faravan-home-'))); t.after(() => rm(dir, {recursive:true, force:true})); return dir; };
const repo = async (dir, {commit = true, branch = 'main', date = '2026-01-01T00:00:00Z'} = {}) => {
  await mkdir(dir, {recursive:true}); git(dir, 'init', '-q', '-b', branch);
  if (commit) { git(dir, 'config', 'user.name', 'T'); git(dir, 'config', 'user.email', 't@example.test');
    await writeFile(join(dir, 'a.txt'), 'a\n'); git(dir, 'add', '.');
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'one'], {cwd:dir, env:{...process.env, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', GIT_COMMITTER_DATE:date, GIT_AUTHOR_DATE:date}}); }
  return dir;
};
const refusal = async run => { try { await run(); } catch (error) { assert.ok(error instanceof RepoError, String(error)); return error; } assert.fail('expected a refusal'); };

test('expandPath trims, drops trailing slashes, expands ~ and $HOME, and resolves relative paths against home', () => {
  const home = '/home/pat';
  assert.equal(expandPath('  /srv/code/app/  ', home), '/srv/code/app');
  assert.equal(expandPath('~', home), home);
  assert.equal(expandPath('~/', home), home);
  assert.equal(expandPath('~/code/app/', home), '/home/pat/code/app');
  assert.equal(expandPath('$HOME/code', home), '/home/pat/code');
  assert.equal(expandPath('${HOME}/code', home), '/home/pat/code');
  assert.equal(expandPath('code/app', home), '/home/pat/code/app');
  assert.equal(expandPath('/', home), '/');
  assert.equal(expandPath('/srv//x/../y', home), '/srv/y');
  for (const bad of ['', '   ', undefined, 7, 'a\0b', '~other/x']) assert.equal(expandPath(bad, home), null, String(bad));
});

test('inspectRepo answers with normalized paths, near siblings for a missing folder, inner repos for a plain folder', async t => {
  const home = await tempHome(t);
  await repo(join(home, 'code', 'faravan'), {branch:'dev'});
  await repo(join(home, 'code', 'sparkle'));
  await mkdir(join(home, 'code', 'spare-parts'));
  await mkdir(join(home, 'code', 'unrelated-zzz'));
  const ok = await inspectRepo('~/code/faravan/', {home});
  assert.deepEqual([ok.path, ok.branch], [join(home, 'code', 'faravan'), 'dev']);
  assert.equal((await inspectRepo('code/faravan', {home})).path, join(home, 'code', 'faravan'), 'relative to home');

  const missing = await refusal(() => inspectRepo('~/code/faravn/', {home}));
  assert.equal(missing.code, 'repo_missing');
  assert.equal(missing.path, join(home, 'code', 'faravn'));
  assert.equal(missing.message, 'No folder at ' + join(home, 'code', 'faravn'));
  assert.ok(missing.suggestions.length >= 1 && missing.suggestions.length <= 3);
  assert.deepEqual(missing.suggestions[0], {path:join(home, 'code', 'faravan'), name:'faravan', branch:'dev'});
  assert.ok(!missing.suggestions.some(s => s.name === 'unrelated-zzz'));

  const plain = join(home, 'code');
  for (let i = 0; i < 10; i++) await repo(join(plain, 'many', 'r' + i), {commit:false});
  const notGit = await refusal(() => inspectRepo('~/code', {home}));
  assert.equal(notGit.code, 'not_git');
  assert.equal(notGit.message, 'Faravan sends a git repository so changes can come back as a branch. Run git init in this folder, or choose another folder.');
  assert.equal(notGit.path, plain);
  assert.deepEqual(notGit.suggestions.map(s => s.name).sort(), ['faravan', 'sparkle']);
  assert.ok(notGit.suggestions.every(s => typeof s.branch === 'string'));
  const many = await refusal(() => inspectRepo(join(plain, 'many'), {home}));
  assert.equal(many.suggestions.length, 8, 'at most eight inner repositories');

  await repo(join(home, 'empty'), {commit:false});
  const empty = await refusal(() => inspectRepo('~/empty', {home}));
  assert.deepEqual([empty.code, empty.path], ['no_commits', join(home, 'empty')]);
});

test('inspectProject keeps inner-repository suggestions on send-as-files folders', async t => {
  const home = await tempHome(t), outer = join(home, 'workspace');
  const inner = await repo(join(outer, 'app'));
  const plain = await inspectProject(outer, {home});
  assert.equal(plain.kind, 'folder');
  assert.deepEqual(plain.suggestions.map(({path, name, branch}) => ({path, name, branch})), [{path:inner, name:'app', branch:'main'}]);
  const lightweight = await inspectProject(outer, {home, manifest:false});
  assert.equal(lightweight.kind, 'folder');
  assert.deepEqual(lightweight.suggestions, plain.suggestions);
});

test('listFolders: immediate subfolders, git first then by name, hidden skipped, confined to home', async t => {
  const home = await tempHome(t);
  await mkdir(join(home, 'b-plain')); await mkdir(join(home, 'a-plain')); await mkdir(join(home, '.hidden'));
  await repo(join(home, 'z-repo'), {branch:'trunk'});
  await writeFile(join(home, 'file.txt'), 'x');
  const outside = await tempHome(t);
  await symlink(outside, join(home, 'escape'));
  await symlink(join(home, 'a-plain'), join(home, 'inner-link'));
  const view = await listFolders(undefined, {home});
  assert.equal(view.path, home); assert.equal(view.home, home);
  assert.deepEqual(view.folders.map(f => f.name), ['z-repo', 'a-plain', 'b-plain', 'inner-link']);
  assert.deepEqual(view.folders[0], {name:'z-repo', path:join(home, 'z-repo'), is_git:true, branch:'trunk'});
  assert.deepEqual(view.folders[1], {name:'a-plain', path:join(home, 'a-plain'), is_git:false});
  assert.equal((await listFolders('~/a-plain/', {home})).path, join(home, 'a-plain'));
  const code = async run => { try { await run(); } catch (error) { assert.ok(error instanceof FolderError, String(error)); return [error.code, error.path, error.message]; } assert.fail('expected refusal'); };
  const [c1, p1, m1] = await code(() => listFolders(outside, {home}));
  assert.deepEqual([c1, p1], ['outside_home', outside]); assert.match(m1, /home folder/);
  const [c2, p2] = await code(() => listFolders('~/escape', {home}));
  assert.deepEqual([c2, p2], ['outside_home', join(home, 'escape')]);
  const [c3, p3, m3] = await code(() => listFolders('~/nope', {home}));
  assert.deepEqual([c3, p3, m3], ['folder_missing', join(home, 'nope'), 'No folder at ' + join(home, 'nope')]);
  assert.deepEqual((await code(() => listFolders('~/../..', {home})))[0], 'outside_home');
  // a symlink in the middle of the path that leaves home is refused, not only a final one
  await mkdir(join(outside, 'deeper'));
  assert.deepEqual((await code(() => listFolders('~/escape/deeper', {home})))[0], 'outside_home');
  // a sibling whose name starts with home's name is not inside home
  const sibling = home + '-other'; await mkdir(sibling); t.after(() => rm(sibling, {recursive:true, force:true}));
  assert.deepEqual((await code(() => listFolders(sibling, {home})))[0], 'outside_home');
  assert.deepEqual((await code(() => listFolders(home + '-other/', {home})))[1], sibling);
});

test('scanRepos: depth 3, skips hidden/vendor dirs and symlinks, stops at the directory and time caps', async t => {
  const home = await tempHome(t);
  await repo(join(home, 'code', 'a'));
  await repo(join(home, 'code', 'deep', 'b'));
  await repo(join(home, 'one', 'two', 'three', 'four'));
  await repo(join(home, 'node_modules', 'x')); await repo(join(home, '.cache', 'y')); await repo(join(home, 'go', 'pkg', 'z'));
  await repo(join(home, 'snap', 's')); await repo(join(home, 'vendor', 'v')); await repo(join(home, '.hidden', 'h'));
  const outside = await tempHome(t); await repo(join(outside, 'leak'));
  await symlink(outside, join(home, 'linked'));
  const found = await scanRepos(home);
  assert.deepEqual(found.repos.sort(), [join(home, 'code', 'a'), join(home, 'code', 'deep', 'b')]);
  assert.equal(found.truncated, false);
  const capped = await scanRepos(home, {maxDirs:2});
  assert.equal(capped.truncated, true);
  let tick = 0;
  const timed = await scanRepos(home, {now:() => (tick += 1000)});
  assert.equal(timed.truncated, true, 'the time budget stops the walk');
  let calls = 0;
  const atBoundary = await scanRepos(home, {now:() => (calls++ === 0 ? 0 : 1500)});
  assert.deepEqual([atBoundary.truncated, atBoundary.repos], [true, []], 'exactly 1500 ms is over budget');
  let early = 0;
  assert.equal((await scanRepos(home, {now:() => (early++ === 0 ? 0 : 1499)})).truncated, false, '1499 ms is within budget');
});

test('folder suggestions: newest commit first, deduped, stale rows retained, scan cached 60s', async t => {
  const home = await tempHome(t);
  const a = await repo(join(home, 'code', 'a'), {date:'2026-01-01T00:00:00Z'}), b = await repo(join(home, 'code', 'b'), {date:'2026-03-01T00:00:00Z'});
  let stored = [], clock = 1_000_000, scans = 0;
  const service = createFolderService({home, now:() => clock, recent:{get:() => stored, set:async list => { stored = list; }},
    scan:async (...args) => { scans++; return scanRepos(...args); }});
  for (let i = 0; i < 9; i++) await service.remember(join(home, 'gone' + i));
  await service.remember(a); await service.remember(b); await service.remember(a);
  assert.equal(stored.length, 8, 'last eight kept');
  assert.deepEqual(stored.slice(0, 2), [a, b], 'deduped, most recently used first');
  const view = await service.suggest();
  assert.deepEqual(view.recent.filter(r=>!r.stale).map(r=>r.path),[b,a], 'available folders newest commit first');
  assert.equal(view.recent.filter(r=>r.stale).length,6,'missing sources stay labelled instead of being substituted');
  assert.deepEqual(view.recent[0], {path:b, name:'b', branch:'main', last_commit_at:'2026-03-01T00:00:00.000Z'});
  assert.deepEqual(view.repos.map(r => r.path), [b, a], 'found repositories newest commit first');
  assert.equal(view.truncated, false);
  await service.suggest(); assert.equal(scans, 1, 'cached');
  clock += 61_000; await service.suggest(); assert.equal(scans, 2, 'cache expires after 60s');
});

test('folder suggestions: concurrent remembers keep the last order (A, B, A leaves A newest)', async t => {
  let stored = [];
  const slowSet = async list => { await new Promise(r => setTimeout(r, 5)); stored = list; };
  const service = createFolderService({home:'/nowhere', recent:{get:() => stored, set:slowSet}});
  await Promise.all([service.remember('/r/a'), service.remember('/r/b'), service.remember('/r/a')]);
  assert.deepEqual(stored, ['/r/a', '/r/b']);
});

test('folder suggestions: one deadline covers the walk and the commit-time reads', async t => {
  const home = await tempHome(t);
  const a = await repo(join(home, 'a'));
  let clock = 0;
  // the walk itself uses the whole budget; no git process may run after it
  const service = createFolderService({home, now:() => clock, recent:{get:() => [], set:async () => {}},
    scan:async () => { clock += 1500; return {repos:[a], truncated:false}; }});
  const view = await service.suggest();
  assert.deepEqual(view.repos, [{path:a, name:'a', branch:'main', last_commit_at:null}]);
  assert.equal(view.truncated, true, 'the cut-short commit times are reported');
});

test('app API: folders.suggest and folders.list are registered read ops; refusals keep path and suggestions', {timeout:120000}, async t => {
  for (const id of ['folders.suggest', 'folders.list']) {
    const op = OPS.find(o => o.id === id); assert.ok(op, id); assert.equal(op.safety, 'read'); assert.equal(op.rest.method, 'GET');
  }
  const f = await appFixture(t), {owner, circle} = await f.connect();
  const ui=await browserApi(owner.app);
  const home = await tempHome(t);
  const {app, home:configHome} = await f.start('folders', {userHome:home});
  const r = await repo(join(home, 'code', 'proj'));
  await api(app, '/api/folders?path=' + encodeURIComponent('~/code'), {token:null, status:401});
  const listed = await api(app, '/api/folders?path=' + encodeURIComponent('~/code/'));
  assert.deepEqual(listed, {path:join(home, 'code'), home, folders:[{name:'proj', path:r, is_git:true, branch:'main'}]});
  const outside = await api(app, '/api/folders?path=/', {status:403});
  assert.deepEqual([outside.code, outside.path], ['outside_home', '/']);
  await mkdir(join(r, 'sub'));
  const inspected = await api(app, '/api/repo/inspect', {method:'POST', body:{path:'~/code/proj/sub/'}});
  assert.equal(inspected.path, r);
  const persisted = async dir => JSON.parse(await readFile(join(dir, 'v1', 'app-settings.json'), 'utf8')).recentRepos;
  assert.deepEqual(await persisted(configHome), [r], 'a checked folder is saved as its normalized repository root');
  const suggest = await api(app, '/api/folders/suggest');
  assert.deepEqual(suggest.recent.map(x => x.path), [r], 'a successful inspection is remembered');
  assert.deepEqual(suggest.repos.map(x => x.path), [r]);
  const refused = await api(app, '/api/repo/inspect', {method:'POST', body:{path:'~/code/prj'}});
  assert.deepEqual(refused.refusal, {code:'repo_missing', state:'compose.repo-missing', message:'No folder at ' + join(home, 'code', 'prj'),
    path:join(home, 'code', 'prj'), suggestions:[{path:r, name:'proj', branch:'main'}]});
  // the send refusal carries the same fields
  const sent = await ui('/api/jobs', {method:'POST', body:{circle:circle.id, prompt:'x', harness:'codex', repo:{path:join(home, 'missing')}}, status:409});
  assert.deepEqual([sent.code,sent.repo_code,sent.path],['repo_refused','repo_missing',join(home,'missing')]);
  const plain = await api(owner.app, '/api/repo/inspect', {method:'POST',body:{path:join(home,'code')}});
  assert.equal(plain.kind,'folder','plain folders retain the send-as-files path');
  // a successful send is remembered as its repository root too
  await ui('/api/jobs', {method:'POST', body:{circle:circle.id, prompt:'x', harness:'codex', repo:{path:r + '/sub/'}, draft_id:'draft-folders-0001'}});
  assert.deepEqual(await persisted(owner.home), [r,join(home,'code')]);
});

test('default scan stops at 2,000 directories and browsing returns at most 500 rows', async t => {
  const home = await tempHome(t);
  for (let start = 0; start < 2001; start += 100) await Promise.all(Array.from({length:Math.min(100,2001-start)},(_,i)=>mkdir(join(home,'folder-'+String(start+i).padStart(4,'0')))));
  const found=await scanRepos(home,{now:()=>0});
  assert.equal(found.truncated,true,'the default 2,000-directory cap applies even with unlimited clock time');
  const view=await listFolders('',{home});
  assert.equal(view.folders.length,500);
  assert.equal(view.folders[0].name,'folder-0000');
  assert.equal(view.folders[499].name,'folder-0499');
});

test('the home scan includes a home repository and nested repositories through depth three', async t => {
  const home = await tempHome(t);
  await repo(home);
  const outer=await repo(join(home,'outer'));
  const inner=await repo(join(outer,'packages','inner'));
  const found=await scanRepos(home);
  assert.deepEqual(found.repos.sort(),[home,outer,inner].sort());
  assert.equal(found.truncated,false);
});
