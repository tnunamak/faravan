import './helpers/no-browser.mjs';
import {mkdir,readFile,readdir,writeFile,stat,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {storedZip} from './helpers/source-zip-fixture.mjs';
import assert from 'node:assert/strict';
import {readArchiveEntries} from '../lib/archive.mjs';
import { gunzipSync } from 'node:zlib';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { isSecretFile } from '../lib/v1/secret-files.mjs';
import { excludedFile } from '../ui/v1/src/helpers.mjs';

const testOptions = {timeout: 120000};
const file = (path, text = 'x') => ({path, base64: Buffer.from(text).toString('base64')});
const SECRETS = ['.env', '.ENV', '.env.local', 'app/.Env.production', 'id_rsa', 'ID_RSA', 'a/id_ed25519', '.ssh/config',
  'home/.SSH/known_hosts', '.aws/credentials', 'x/.aws/config', 'cert.PEM', 'k.key', 'bundle.p12', 'bundle.PFX',
  '.npmrc', '.NETRC', '.git-credentials', '.pypirc', 'id_ecdsa', 'id_dsa', 'id_custom', 'kubeconfig', '.kube/config', '.YARNRC', 'nested/.YARNRC.YML', 'auth/_NETRC', 'keys/server.PPK'];
const FINE = ['src/main.js', 'README.md', 'id_rsa.pub', 'environment.md', 'envelope.txt', 'keyboard.js'];

test('secret-file rules are one list shared by the server and the UI, case-insensitively', () => {
  for (const name of SECRETS) {
    assert.equal(isSecretFile(name), true, name);
    assert.equal(excludedFile(name), true, 'ui ' + name);
  }
  for (const name of FINE) {
    assert.equal(isSecretFile(name), false, name);
    assert.equal(excludedFile(name), false, 'ui ' + name);
  }
});

test('POST /api/jobs rejects a local source path and drops secret uploads server-side', testOptions, async t => {
  const f = await appFixture(t), {owner, circle} = await f.connect();
  const base = {circle: circle.id, prompt: 'Review.', harness: 'codex'};
  await api(owner.app, '/api/jobs', {method: 'POST', status: 400, body: {...base, source: '/tmp'}});
  await api(owner.app, '/api/jobs', {method: 'POST', status: 400, body: {...base, source: '/tmp', files: [file('a.txt')]}});
  await api(owner.app, '/api/jobs', {method: 'POST', status: 400, body: {...base, files: [file('.env'), file('.SSH/id_rsa')]}});
  const submitted = await api(owner.app, '/api/jobs', {method: 'POST',
    body: {...base, files: [file('ok.txt', 'visible'), file('.ENV', 'TOKEN=1'), file('keys/server.PEM', 'KEY')]}});
  assert.deepEqual(submitted.excluded.sort(), ['.ENV', 'keys/server.PEM']);
  const view = f.jobs.get(submitted.jobDigest);
  const tar = gunzipSync(f.artifacts.get(view.job.payload.source.artifact.digest)).toString('latin1');
  assert.ok(tar.includes('visible'));
  assert.ok(!tar.includes('TOKEN=1') && !tar.includes('KEY'));
});

test('uploads reject Git metadata before any Git inspection and report noise separately', testOptions, async t => {
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Fixture only',files:[
    file('main.js','source fixture'),file('.git/config','[core]\nfsmonitor = touch PWNED\n'),file('build/cache.js','cache'),file('.env','DUMMY_ONLY=fixture'),file('.env.example','DUMMY_ONLY=replace-me'),
  ]}});
  assert.deepEqual(sent.excluded.sort(),['.env','.git/config','build/cache.js']);
  assert.deepEqual(sent.sourceOmissions.map(f=>f.reason).sort(),['credentials','not_source','not_source']);
  assert.ok(sent.warnings.includes('1 file not sent (looked like credentials)'));
  assert.ok(sent.warnings.includes('2 files not sent (not source)'));
  const view=f.jobs.get(sent.jobDigest), tar=gunzipSync(f.artifacts.get(view.job.payload.source.artifact.digest));
  assert.ok(!tar.includes(Buffer.from('PWNED')));
  assert.ok(tar.includes(Buffer.from('replace-me')));
});


test('bare-repository-shaped uploads reject committed credentials without executing Git', testOptions, async t => {
  const f=await appFixture(t),{owner,circle}=await f.connect();
  const repo=join(f.root,'planted-repo'), marker=join(f.root,'UPLOAD_FILTER_EXECUTED');await mkdir(repo);
  await writeFile(join(repo,'main.js'),'source fixture');await writeFile(join(repo,'.env'),'DUMMY_ONLY=committed-bare-fixture');await writeFile(join(repo,'.gitattributes'),'* filter=fixture\n');
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
  git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  git('config','core.bare','false');git('config','core.worktree','.');
  git('config','filter.fixture.smudge','touch '+marker+' && cat');
  const files=[file('main.js','source fixture'),file('.gitattributes','* filter=fixture\n')];
  const collect=async(relative='')=>{
    for(const entry of await readdir(join(repo,'.git',relative),{withFileTypes:true})) {
      const path=relative?relative+'/'+entry.name:entry.name;
      if(entry.isDirectory()) await collect(path);
      else files.push({path,base64:(await readFile(join(repo,'.git',path))).toString('base64')});
    }
  };
  await collect();
  // Positive control: the uploaded metadata alone recovers the dummy from its object database.
  assert.match(execFileSync('git',['--git-dir',join(repo,'.git'),'show','HEAD:.env'],{encoding:'utf8'}),/committed-bare-fixture/);
  const before=f.artifacts.size;
  for(const prefix of ['', 'wrapped/bare-meta/'])
    await api(owner.app,'/api/jobs',{method:'POST',status:400,body:{circle:circle.id,prompt:'Fixture only',
      files:files.map(file=>({...file,path:prefix+file.path}))}});
  assert.equal(f.artifacts.size,before,'no recoverable object database reaches the lender');
  await assert.rejects(()=>stat(marker),{code:'ENOENT'});
});

test('prompt-only jobs keep typed no-source results and non-Git folders use bounded archives',testOptions,async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const none=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Write a report',noSource:true,result:{kind:'message'}}});
 assert.equal(f.jobs.get(none.jobDigest).job.payload.source.kind,'none');
 assert.equal(f.jobs.get(none.jobDigest).job.payload.result.kind,'message');
 await api(owner.app,'/api/jobs',{method:'POST',status:400,body:{circle:circle.id,prompt:'Write a report',files:[]}});
 const folder=join(f.root,'plain-source');await mkdir(folder);await writeFile(join(folder,'note.txt'),'folder-visible');await writeFile(join(folder,'.env'),'DUMMY_ONLY=skip');await writeFile(join(folder,'check.sh'),'#!/bin/sh\necho ok\n');await chmod(join(folder,'check.sh'),0o755);
 const inspected=await api(owner.app,'/api/repo/inspect',{method:'POST',body:{path:folder}});assert.equal(inspected.kind,'folder');assert.equal(inspected.files,2);assert.equal(inspected.sourceManifest.file_count,2);
 const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Read folder',repo:{path:folder}}});
 const tar=gunzipSync(f.artifacts.get(f.jobs.get(sent.jobDigest).job.payload.source.artifact.digest));assert.ok(tar.includes(Buffer.from('folder-visible')));assert.ok(!tar.includes(Buffer.from('DUMMY_ONLY')));assert.equal(readArchiveEntries(tar,{preserveExecutable:true}).find(entry=>entry.name==='check.sh').mode&0o111,0o111);assert.equal(inspected.sourceManifest.archive_digest,f.jobs.get(sent.jobDigest).job.payload.source.artifact.digest);
});

test('upload preview reports exactly the filtered file names and exclusions',testOptions,async t=>{
 const f=await appFixture(t),{owner}=await f.connect();
 const preview=await api(owner.app,'/api/source/preview',{method:'POST',body:{files:[file('main.txt','hello'),file('.env','DUMMY_ONLY=skip')]}});
 assert.deepEqual(preview.sourceManifest.files,[{path:'main.txt',bytes:5}]);assert.deepEqual(preview.sourceManifest.not_sent,[{path:'.env',reason:'credentials'}]);
});

test('ZIP preview and submission use the same filtered snapshot and reject traversal',testOptions,async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const zip={name:'source.zip',base64:storedZip('notes.txt','zip-visible').toString('base64')};
 const preview=await api(owner.app,'/api/source/preview',{method:'POST',body:{zip}});
 const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{circle:circle.id,prompt:'Read ZIP',zip}});
 const tar=gunzipSync(f.artifacts.get(f.jobs.get(sent.jobDigest).job.payload.source.artifact.digest));
 assert.ok(tar.includes(Buffer.from('zip-visible')));assert.equal(preview.sourceManifest.file_count,1);
 const unsafe={base64:storedZip('../escape','x').toString('base64')};
 const refusal=await api(owner.app,'/api/jobs',{method:'POST',status:400,body:{circle:circle.id,prompt:'Read ZIP',zip:unsafe}});assert.equal(refusal.code,'invalid_source');
});

test('working directory is signed, capability-gated and bound to replayed drafts',testOptions,async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const body={circle:circle.id,prompt:'Work inside the app',files:[file('packages/app/README.md')],working_directory:'packages/app',draft_id:'workdir-draft-0001'};
 const sent=await api(owner.app,'/api/jobs',{method:'POST',body});
 const job=f.jobs.get(sent.jobDigest).job.payload;assert.equal(job.working_directory,'packages/app');assert.ok(job.requirements.capabilities.includes('working_directory_v1'));
 const changed=await api(owner.app,'/api/jobs',{method:'POST',status:409,body:{...body,working_directory:'other'}});assert.equal(changed.code,'draft_changed');
 await api(owner.app,'/api/jobs',{method:'POST',status:400,body:{...body,draft_id:undefined,working_directory:'../outside'}});
});

test('a ZIP with no sendable files is refused at preview and send with the same actionable reason',testOptions,async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect();
 const zip={name:'secret-only.zip',base64:storedZip('.env','DUMMY=excluded').toString('base64')};
 const preview=await api(owner.app,'/api/source/preview',{method:'POST',status:400,body:{zip}});
 const sent=await api(owner.app,'/api/jobs',{method:'POST',status:400,body:{circle:circle.id,prompt:'Read ZIP',zip}});
 assert.equal(preview.code,'invalid_source');assert.equal(sent.code,preview.code);assert.equal(sent.message,preview.message);
 assert.match(preview.message,/no files to send/i);
});

test('a changed folder snapshot needs a new preview before it can leave this computer',testOptions,async t=>{
 const f=await appFixture(t),{owner,circle}=await f.connect(),folder=join(f.root,'reviewed-source');await mkdir(folder);await writeFile(join(folder,'note.txt'),'reviewed');
 const preview=await api(owner.app,'/api/repo/inspect',{method:'POST',body:{path:folder}});
 const body={circle:circle.id,prompt:'Read the reviewed files',repo:{path:folder,expected_digest:preview.sourceManifest.archive_digest},draft_id:'preview-bound-draft'};
 await writeFile(join(folder,'note.txt'),'changed after review');const before=f.artifacts.size;
 const refused=await api(owner.app,'/api/jobs',{method:'POST',status:409,body});assert.equal(refused.code,'source_changed');assert.equal(f.artifacts.size,before);
 const next=await api(owner.app,'/api/repo/inspect',{method:'POST',body:{path:folder}});
 const sent=await api(owner.app,'/api/jobs',{method:'POST',body:{...body,repo:{...body.repo,expected_digest:next.sourceManifest.archive_digest}}});
 assert.equal(sent.sourceManifest.archive_digest,next.sourceManifest.archive_digest);
 await writeFile(join(folder,'note.txt'),'changed after send');
 const replay=await api(owner.app,'/api/jobs',{method:'POST',body:{...body,repo:{...body.repo,expected_digest:next.sourceManifest.archive_digest}}});assert.equal(replay.jobDigest,sent.jobDigest);
});
