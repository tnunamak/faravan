import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageSourceDirectory } from '../lib/source-package.mjs';
import { readArchiveEntries } from '../lib/archive.mjs';
import { filterSourceArchive } from '../lib/source-filter.mjs';
import { createTar } from '../lib/tar-writer.mjs';
import { sourceFileOmission, sourceOmissionLines } from '../lib/v1/secret-files.mjs';
import { workingTreeSource } from '../lib/v1/run.mjs';
import { inspectRepo } from '../lib/v1/repo-source.mjs';

const entries = paths => paths.map(name => ({name,type:'0',mode:0o755,data:Buffer.from('fixture '+name)}));
const names = tar => readArchiveEntries(tar,{preserveExecutable:true}).filter(e=>e.type==='0').map(e=>e.name);
const secrets = ['.env','upper/.ENV','nested/.env.production','.npmrc','.netrc','.git-credentials','a/.ssh/config','.aws/credentials','.kube/config','keys/private.PEM','private.key','keys/id_ed25519','credentials.json'];
const source = ['.env.example','.env.sample','.env.template','app/.ENV.EXAMPLE','id_rsa.pub','src/credentials-schema.json','build/index.js','dist/client.js','node_modules/local-fork.js'];

test('credentials are blocked independently of noise, including in committed trees', () => {
  const filtered=filterSourceArchive(createTar(entries([...secrets,...source])));
  assert.deepEqual(names(filtered.buffer),source);
  assert.deepEqual(filtered.omitted,secrets.map(path=>({path,reason:'credentials'})));
  assert.equal(sourceFileOmission('dist/client.js',{tracked:true}),null);
  assert.deepEqual(sourceFileOmission('dist/client.js'),{path:'dist/client.js',reason:'not_source'});
  assert.deepEqual(sourceOmissionLines([{reason:'credentials'},{reason:'not_source'},{reason:'not_source'}]), ['1 file not sent (looked like credentials)','2 files not sent (not source)']);
});

test('canonical tar filtering checks PAX paths, Unicode, padding, contents and executable modes', () => {
  const long='a/'.repeat(60);
  const input=entries([long+'.env',long+'main.js','src/سلام.js','src/has\nnewline.js']);
  input[1].data=Buffer.from([0,255,12,10]);
  const filtered=filterSourceArchive(createTar(input));
  assert.deepEqual(filtered.omitted,[{path:long+'.env',reason:'credentials'}]);
  const kept=readArchiveEntries(filtered.buffer,{preserveExecutable:true});
  assert.deepEqual(kept.map(e=>e.name),input.slice(1).map(e=>e.name));
  assert.deepEqual(kept[0].data,input[1].data);
  assert.equal(kept[0].mode,0o755);
});

test('malformed archives, traversal, links and special entries fail closed before upload', () => {
  assert.throws(()=>filterSourceArchive(Buffer.from('bad tar')));
  for(const path of ['../.env','/tmp/key','a/../../source']) assert.throws(()=>filterSourceArchive(createTar(entries([path]))));
  for(const type of ['1','2','3','6']) assert.throws(()=>filterSourceArchive(createTar([{name:'alias',type,mode:0o644,data:Buffer.alloc(0)}])));
});

test('plain folders omit noise; working trees preserve tracked generated source and omit untracked noise', async t => {
  const root=await mkdtemp(join(tmpdir(),'faravan-filter-'));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const path of ['main.js','.env','.env.example','dist/committed.js','build/cache.js','node_modules/pkg/index.js']) {
    await mkdir(join(root,path,'..'),{recursive:true}); await writeFile(join(root,path),'fixture '+path);
  }
  const plain=await packageSourceDirectory(root);
  assert.deepEqual(names(plain.buffer).sort(),['.env.example','main.js']);
  assert.equal(plain.omitted.filter(f=>f.reason==='not_source').length,3);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init','-q');git('add','main.js','.env','.env.example','dist/committed.js');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  const head=await packageSourceDirectory(root);
  assert.ok(names(head.buffer).includes('dist/committed.js'));
  const working=await workingTreeSource(root);
  assert.deepEqual(names(working.sourceTar).sort(),['.env.example','dist/committed.js','main.js']);
  const preview=await inspectRepo(root);
  assert.deepEqual(preview.sourceOmissions.head,head.omitted);
  assert.deepEqual(preview.sourceOmissions.workingTree.sort((a,b)=>a.path.localeCompare(b.path)),working.sourceOmissions.sort((a,b)=>a.path.localeCompare(b.path)));
  await writeFile(join(root,'.env'),'changed excluded');
  const changed=await inspectRepo(root);
  assert.ok(changed.changed_count>0);
  assert.equal(changed.changed.some(file=>file.path==='.env'),false);
  await symlink('.env',join(root,'innocent.txt'));
  await assert.rejects(()=>workingTreeSource(root),{code:'link_rejected'});
});

test('working-tree paths cannot read through a symlinked parent directory', async t => {
  const root=await mkdtemp(join(tmpdir(),'faravan-parent-link-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),outside=join(root,'outside');
  await mkdir(join(repo,'config'),{recursive:true});await mkdir(outside);
  await writeFile(join(repo,'config/settings.js'),'source fixture');
  await writeFile(join(outside,'settings.js'),'outside dummy credential');
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
  git('init','-q');git('add','.');await writeFile(join(repo,'.gitignore'),'config\n');git('add','.gitignore');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  await rm(join(repo,'config'),{recursive:true});await symlink(outside,join(repo,'config'));
  await assert.rejects(()=>workingTreeSource(repo),{code:'link_rejected'});
});

test('credential basenames do not remove source directories with the same names', () => {
  const paths=['pkg/credentials/creds.go','src/id_utils/index.js','lib/id_generator/gen.py'];
  assert.deepEqual(names(filterSourceArchive(createTar(entries(paths))).buffer),paths);
});

test('repository packaging does not execute fsmonitor or clean filters while finding uncommitted work', async t => {
  const root=await mkdtemp(join(tmpdir(),'faravan-git-commands-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init','-q');await writeFile(join(root,'main.js'),'safe');
  await writeFile(join(root,'.gitattributes'),'main.js filter=fixture\n');
  git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  await writeFile(join(root,'main.js'),'changed');
  git('config','core.fsmonitor','touch FS_MONITOR_EXECUTED');
  git('config','filter.fixture.clean','touch CLEAN_FILTER_EXECUTED; cat');
  git('config','filter.fixture.smudge','touch SMUDGE_FILTER_EXECUTED; cat');
  await packageSourceDirectory(root);
  const {stat}=await import('node:fs/promises');
  for(const marker of ['FS_MONITOR_EXECUTED','CLEAN_FILTER_EXECUTED','SMUDGE_FILTER_EXECUTED'])
    await assert.rejects(()=>stat(join(root,marker)),{code:'ENOENT'});
});


test('standard auth and private-key names never reach received bytes on any packaging path', async t => {
  const root=await mkdtemp(join(tmpdir(),'faravan-auth-names-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const blocked=['nested/.yarnrc.yml','nested/.YARNRC','auth/_NETRC','keys/server.PpK'];
  const templates=['.env.example','.env.sample','.env.template'];
  for(const path of [...blocked,...templates,'main.js']) {
    await mkdir(join(root,path,'..'),{recursive:true});
    await writeFile(join(root,path),blocked.includes(path)?'INERT_AUTH_CANARY_'+path:'SOURCE_FIXTURE_'+path);
  }
  const check=(label,buffer)=>{
    assert.equal(buffer.includes(Buffer.from('INERT_AUTH_CANARY_')),false,label);
    assert.deepEqual(names(buffer).sort(),[...templates,'main.js'].sort(),label);
  };
  check('plain tar',(await packageSourceDirectory(root,{allowGit:false})).buffer);
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','dummy fixture');
  check('git archive',(await packageSourceDirectory(root)).buffer);
  await writeFile(join(root,'nested/.yarnrc.yml'),'INERT_AUTH_CANARY_modified');
  check('working tree',(await workingTreeSource(root)).sourceTar);
});


test('metadata in actual archive bytes is rejected for working trees and removed committed folders', async t => {
  const root=await mkdtemp(join(tmpdir(),'faravan-metadata-bytes-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const paths=['vendor/fixture-meta/HEAD','vendor/fixture-meta/config','vendor/fixture-meta/objects/aa/'+'b'.repeat(38)];
  for(const path of [...paths,'main.js']) {
    await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),'INERT_METADATA_FIXTURE');
  }
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  git('init','-q');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');
  await assert.rejects(()=>workingTreeSource(root),/Git metadata.*source/i);
  await rm(join(root,'vendor'),{recursive:true});
  await assert.rejects(()=>packageSourceDirectory(root),/Git metadata.*source/i);
  assert.throws(()=>filterSourceArchive(createTar(entries(paths))),/Git metadata.*source/i);
  // Objects alone can recover blobs, without HEAD or config.
  assert.throws(()=>filterSourceArchive(createTar(entries(['aa/'+'b'.repeat(38)]))),/Git metadata.*source/i);
  // Excluded dependency fixtures are not sent and must not refuse the project.
  const filtered=filterSourceArchive(createTar(entries(paths.map(path=>'node_modules/'+path))),{tracked:false});
  assert.deepEqual(names(filtered.buffer),[]);
});

test('renamed Git packs and bundles are omitted by content on every source archive path', () => {
  const pack=Buffer.alloc(12);pack.write('PACK');pack.writeUInt32BE(2,4);pack.writeUInt32BE(1,8);
  const tar=createTar([{name:'renamed.dat',type:'0',mode:0o644,data:pack},{name:'notes.txt',type:'0',mode:0o644,data:Buffer.from('# v3 git bundle\n')},{name:'source.js',type:'0',mode:0o644,data:Buffer.from('const PACK = 1;')}]);
  const filtered=filterSourceArchive(tar);
  assert.deepEqual(names(filtered.buffer),['source.js']);
  assert.deepEqual(filtered.omitted.map(f=>f.path),['renamed.dat','notes.txt']);
});

test('HEAD preview uses the archive export rules for omission counts', async t => {
  const root=await mkdtemp(join(tmpdir(),'spk-export-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  await writeFile(join(root,'.env'),'synthetic fixture');
  await writeFile(join(root,'.gitattributes'),'.env export-ignore\n');
  await writeFile(join(root,'main.js'),'ok');
  git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  const preview=await inspectRepo(root), sent=await packageSourceDirectory(root);
  assert.deepEqual(preview.sourceOmissions.head,sent.omitted);
});

test('renamed bundle omission agrees between HEAD, working-tree preview, and source bytes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'spk-renamed-history-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'history.bin'),'# v3 git bundle\nsynthetic fixture');await writeFile(join(root,'main.js'),'ok');
 const git=(...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
 const preview=await inspectRepo(root),head=await packageSourceDirectory(root),working=await workingTreeSource(root);
 assert.deepEqual(preview.sourceOmissions.head,head.omitted);
 assert.deepEqual(preview.sourceOmissions.workingTree,working.sourceOmissions);
 assert.deepEqual(names(head.buffer),['main.js']);assert.deepEqual(names(working.sourceTar),['main.js']);
});

// Fake key material only: a real header plus filler, no actual key bytes.
const fakeBody = '\n' + 'A'.repeat(64) + '\n' + 'A'.repeat(64) + '\n';
const pem = label => Buffer.from(`-----BEGIN ${label}-----${fakeBody}-----END ${label}-----\n`);

test('a private key saved under an ordinary name is not sent', () => {
  const headers = {
    'PEM RSA': pem('RSA PRIVATE KEY'), 'PEM EC': pem('EC PRIVATE KEY'), 'PEM DSA': pem('DSA PRIVATE KEY'),
    'PEM plain': pem('PRIVATE KEY'), 'PEM encrypted': pem('ENCRYPTED PRIVATE KEY'), 'OpenSSH': pem('OPENSSH PRIVATE KEY'),
    'PGP': pem('PGP PRIVATE KEY BLOCK'), 'PuTTY': Buffer.from('PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n'),
    'leading whitespace': Buffer.concat([Buffer.from('\r\n  \t'), pem('OPENSSH PRIVATE KEY')]),
    'UTF-8 BOM': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), pem('RSA PRIVATE KEY')]),
  };
  for (const [kind, bytes] of Object.entries(headers))
    for (const path of ['deploy_key', 'server.txt', 'keys/prod'])
      assert.deepEqual(sourceFileOmission(path, {bytes}), {path, reason: 'credentials'}, `${kind} as ${path}`);
  const filtered = filterSourceArchive(createTar([{name:'keys/prod',type:'0',mode:0o600,data:pem('OPENSSH PRIVATE KEY')},{name:'src/a.js',type:'0',mode:0o644,data:Buffer.from('x')}]));
  assert.deepEqual(names(filtered.buffer), ['src/a.js']);
  assert.deepEqual(filtered.omitted, [{path:'keys/prod',reason:'credentials'}]);
});

test('private-key detection ignores public keys, certificates, mid-file mentions and empty files', () => {
  const header = '-----BEGIN RSA PRIVATE KEY-----';
  const ok = {
    'keys/pub': pem('PUBLIC KEY'), 'keys/cert': pem('CERTIFICATE'), 'keys/rsa-pub': pem('RSA PUBLIC KEY'),
    'keys/authorized': Buffer.from('ssh-ed25519 ' + 'A'.repeat(68) + ' me@host\n'),
    'src/detect.js': Buffer.from(`const re = /${header}/;\n// matches ${header}\n`),
    'docs/README.md': Buffer.from(`# Keys\n\nDo not commit files starting with\n${header}\n`),
    'src/late.js': Buffer.concat([Buffer.from('//'.padEnd(5000, 'x') + '\n'), Buffer.from(header + '\n')]),
    'empty': Buffer.alloc(0),
  };
  for (const [path, bytes] of Object.entries(ok)) assert.equal(sourceFileOmission(path, {bytes}), null, path);
});

test('git archive reports export-ignored committed paths without sending them', async t => {
  const root=await mkdtemp(join(tmpdir(),'spk-export-omitted-'));t.after(()=>rm(root,{recursive:true,force:true}));
  // Ignore the machine's global excludes so every fixture path is committed.
  const git=(...args)=>execFileSync('git',['-C',root,'-c','core.excludesFile=/dev/null',...args],{stdio:'pipe'});
  const hidden=['config.txt','hidden/child.txt','nested/config.txt'];
  for(const path of [...hidden,'main.js','nested/kept.txt']) {
    await mkdir(join(root,path,'..'),{recursive:true});
    await writeFile(join(root,path),hidden.includes(path)?'EXPORT_IGNORED_CANARY':'ordinary source');
  }
  await writeFile(join(root,'.gitattributes'),'config.txt export-ignore\nhidden export-ignore\n');
  await writeFile(join(root,'nested/.gitattributes'),'config.txt export-ignore\n');
  git('init','-q');git('add','.');git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  // Staged and working-tree attributes must not replace committed archive rules.
  await writeFile(join(root,'.gitattributes'),'main.js export-ignore\n');
  await writeFile(join(root,'nested/.gitattributes'),'kept.txt export-ignore\n');
  git('add','.gitattributes','nested/.gitattributes');
  for(const [dir,omitted,kept] of [[root,hidden,'main.js'],[join(root,'nested'),['config.txt'],'kept.txt']]) {
    const artifact=await packageSourceDirectory(dir);
    assert.equal(artifact.method,'git-archive');
    assert.equal(artifact.buffer.includes(Buffer.from('EXPORT_IGNORED_CANARY')),false);
    assert.ok(names(artifact.buffer).includes(kept));
    assert.deepEqual(artifact.omitted,omitted.map(path=>({path,reason:'not_source'})));
  }
});
